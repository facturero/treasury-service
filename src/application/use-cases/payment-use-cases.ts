import { randomUUID } from 'node:crypto';
import {
  PaymentAdvanceInUseError,
  PaymentApprovalRequiredError,
  PaymentNotFoundError,
  PaymentSelfApprovalError,
  PaymentStateError,
  ValidationError,
  type ErrorDetail,
} from '../../domain/errors.js';
import {
  defaultPaymentAccountRole,
  defaultPaymentSettings,
  paymentTotals,
  requiresApproval,
  validatePaymentInput,
  type Payment,
  type PaymentInput,
  type PaymentSettings,
} from '../../domain/payment.js';
import { derivePayableStatus, payableBalanceOf, supplierAdvanceBalanceOf, type Payable, type SupplierAdvance } from '../../domain/payable.js';
import type { Page, PaymentFilters, UnitOfWork } from '../../domain/repositories.js';
import {
  paymentApprovedEvent,
  paymentCreatedEvent,
  paymentPostedEvent,
  paymentSettingsUpdatedEvent,
  paymentUpdatedEvent,
  paymentVoidedEvent,
  payableCreditedEvent,
  supplierAdvanceOpenedEvent,
} from '../events.js';
import type { AccountingCatalogPort, Clock, SupplierCatalogPort, SupplierInfo, UnitOfWorkGateway } from '../ports.js';
import { inTransaction } from './transaction.js';
import { assertBankAccountChoice, recordBankMovement, reverseBankMovement } from './bank-register.js';

/** Mínimo de caracteres del motivo de una anulación (igual que en cobros y compras). */
export const MIN_PAYMENT_VOID_REASON = 5;

const LIVE: Payable['status'][] = ['open', 'partial'];
const pad = (n: number) => String(n).padStart(6, '0');

/**
 * Comprueba que las líneas y los anticipos del pago son pagables AHORA: cada deuda existe en la organización, es del proveedor, está viva,
 * está en la misma moneda y su saldo NETO (ya descontada la retención) alcanza; cada anticipo es del proveedor y alcanza. Devuelve TODOS
 * los errores con el índice de su línea. Lo llaman el borrador (lecturas, para avisar pronto) y la contabilización (filas bloqueadas, la
 * comprobación que vale).
 */
function checkApplications(
  payment: Pick<Payment, 'supplierId' | 'currencyCode' | 'lines' | 'advanceUses'>,
  payables: Map<string, Payable | null>,
  advances: Map<string, SupplierAdvance | null>,
): ErrorDetail[] {
  const errors: ErrorDetail[] = [];
  payment.lines.forEach((line, i) => {
    const p = payables.get(line.payableId);
    if (!p) return void errors.push({ field: `lines[${i}].payableId`, message: 'La factura no existe en esta organización.' });
    if (p.supplierId !== payment.supplierId) return void errors.push({ field: `lines[${i}].payableId`, message: 'La factura es de otro proveedor.' });
    if (!LIVE.includes(p.status)) return void errors.push({ field: `lines[${i}].payableId`, message: 'La factura ya no está abierta (está pagada o anulada).' });
    if (p.currencyCode !== payment.currencyCode) return void errors.push({ field: `lines[${i}].payableId`, message: 'La factura está en otra moneda.' });
    const balance = payableBalanceOf(p);
    if (line.appliedCents > balance) errors.push({ field: `lines[${i}].appliedCents`, message: `Lo aplicado supera el saldo de la factura (${balance} centavos).` });
  });
  payment.advanceUses.forEach((use, i) => {
    const a = advances.get(use.advanceId);
    if (!a || a.voidedAt) return void errors.push({ field: `advanceUses[${i}].advanceId`, message: 'El anticipo no existe.' });
    if (a.supplierId !== payment.supplierId) return void errors.push({ field: `advanceUses[${i}].advanceId`, message: 'El anticipo es de otro proveedor.' });
    if (a.currencyCode !== payment.currencyCode) return void errors.push({ field: `advanceUses[${i}].advanceId`, message: 'El anticipo está en otra moneda.' });
    const available = supplierAdvanceBalanceOf(a);
    if (use.usedCents > available) errors.push({ field: `advanceUses[${i}].usedCents`, message: `Lo que se consume supera el saldo del anticipo (${available} centavos).` });
  });
  return errors;
}

async function loadPayables(uow: UnitOfWork, organizationId: string, ids: string[], lock: boolean): Promise<Map<string, Payable | null>> {
  const out = new Map<string, Payable | null>();
  // Orden fijo por id: dos pagos simultáneos a las mismas facturas piden los bloqueos en el mismo orden y no se interbloquean.
  for (const id of [...new Set(ids)].sort()) out.set(id, await uow.payables.findById(organizationId, id, { lock }));
  return out;
}

async function loadAdvances(uow: UnitOfWork, organizationId: string, ids: string[], lock: boolean): Promise<Map<string, SupplierAdvance | null>> {
  const out = new Map<string, SupplierAdvance | null>();
  for (const id of [...new Set(ids)].sort()) out.set(id, await uow.supplierAdvances.findById(organizationId, id, { lock }));
  return out;
}

export interface PaymentDependencies {
  gateway: UnitOfWorkGateway;
  accounting: AccountingCatalogPort;
  suppliers: SupplierCatalogPort;
  clock: Clock;
}

/** Datos que se piden FUERA de la transacción (son llamadas HTTP): moneda de la contabilidad y datos del proveedor. */
async function externalData(deps: PaymentDependencies, organizationId: string, supplierId: string): Promise<{ currencyCode: string; supplier: SupplierInfo }> {
  const settings = await deps.accounting.getSettings(organizationId);
  if (!settings) throw new ValidationError([{ field: 'currencyCode', message: 'La organización no tiene contabilidad configurada: no se sabe la moneda del pago.' }]);
  const supplier = await deps.suppliers.findById(organizationId, supplierId);
  if (!supplier) throw new ValidationError([{ field: 'supplierId', message: 'El proveedor no existe en esta organización.' }]);
  return { currencyCode: settings.baseCurrency, supplier };
}

function buildDraft(
  base: Pick<Payment, 'id' | 'organizationId' | 'supplierId' | 'supplierName' | 'supplierIdentification' | 'currencyCode' | 'createdBy' | 'createdAt'> & Partial<Payment>,
  input: PaymentInput,
  now: Date,
): Payment {
  const totals = paymentTotals(input);
  // Orden: valores por defecto → lo que ya tenía (al editar) → lo que dice la entrada, que MANDA.
  const defaults = { number: null, status: 'draft' as const, voidReason: null, approvedBy: null, postedBy: null, voidedBy: null, approvedAt: null, postedAt: null, voidedAt: null, version: 1 };
  const fromInput = {
    paymentDate: input.paymentDate,
    method: input.method,
    accountRole: input.accountRole ?? defaultPaymentAccountRole(input.method),
    bankAccountId: input.bankAccountId ?? null,
    reference: input.reference?.trim() || null,
    totalCents: input.totalCents,
    ...totals,
    lines: input.lines.map((l) => ({ payableId: l.payableId, appliedCents: l.appliedCents })),
    advanceUses: (input.advanceUses ?? []).map((u) => ({ advanceId: u.advanceId, usedCents: u.usedCents })),
    notes: input.notes?.trim().slice(0, 500) || null,
    updatedAt: now,
  };
  return { ...defaults, ...base, ...fromInput } as Payment;
}

/**
 * Crea un pago en BORRADOR. No toca saldos ni gasta número: solo guarda lo que la persona va a pagar. Avisa pronto de lo que ya se sabe
 * que fallará (factura de otro proveedor, saldo insuficiente), pero la comprobación que vale es la de contabilizar, con las filas
 * bloqueadas: entre guardar y contabilizar otra persona pudo pagar lo mismo o llegar una retención.
 */
export class CreatePaymentUseCase {
  constructor(private readonly deps: PaymentDependencies) {}

  async execute(input: { organizationId: string; supplierId: string; userId: string; payment: PaymentInput }): Promise<Payment> {
    validatePaymentInput(input.payment);
    const { currencyCode, supplier } = await externalData(this.deps, input.organizationId, input.supplierId);
    const now = this.deps.clock();
    return inTransaction(this.deps.gateway, async (uow) => {
      const draft = buildDraft(
        { id: randomUUID(), organizationId: input.organizationId, supplierId: supplier.id, supplierName: supplier.legalName, supplierIdentification: supplier.identification, currencyCode, createdBy: input.userId, createdAt: now },
        input.payment,
        now,
      );
      const errors = checkApplications(
        draft,
        await loadPayables(uow, input.organizationId, draft.lines.map((l) => l.payableId), false),
        await loadAdvances(uow, input.organizationId, draft.advanceUses.map((u) => u.advanceId), false),
      );
      if (errors.length) throw new ValidationError(errors);
      await assertBankAccountChoice(uow, input.organizationId, draft);
      await uow.payments.save(draft);
      await uow.outbox.add(paymentCreatedEvent(draft));
      return draft;
    });
  }
}

/**
 * Edita un pago en borrador o aprobado (uno contabilizado no se edita: se anula y se rehace). El proveedor no cambia. Editar un pago
 * aprobado le QUITA la aprobación: lo que se aprobó ya no es lo que se va a pagar.
 */
export class UpdatePaymentUseCase {
  constructor(private readonly deps: PaymentDependencies) {}

  async execute(input: { organizationId: string; paymentId: string; userId: string; payment: PaymentInput; expectedVersion?: number }): Promise<Payment> {
    validatePaymentInput(input.payment);
    const now = this.deps.clock();
    return inTransaction(this.deps.gateway, async (uow) => {
      const current = await uow.payments.findById(input.organizationId, input.paymentId, { lock: true });
      if (!current) throw new PaymentNotFoundError();
      if (current.status !== 'draft' && current.status !== 'approved') throw new PaymentStateError('Solo se puede editar un pago en borrador: uno contabilizado se anula y se rehace.');
      if (input.expectedVersion !== undefined && input.expectedVersion !== current.version) throw new PaymentStateError('Otra persona modificó este pago. Vuelve a cargarlo.');
      const next = buildDraft({ ...current, status: 'draft', approvedBy: null, approvedAt: null, updatedAt: now }, input.payment, now);
      next.version = current.version + 1;
      const errors = checkApplications(
        next,
        await loadPayables(uow, input.organizationId, next.lines.map((l) => l.payableId), false),
        await loadAdvances(uow, input.organizationId, next.advanceUses.map((u) => u.advanceId), false),
      );
      if (errors.length) throw new ValidationError(errors);
      await assertBankAccountChoice(uow, input.organizationId, next);
      await uow.payments.save(next, current.version);
      await uow.outbox.add(paymentUpdatedEvent(next));
      return next;
    });
  }
}

/**
 * Aprueba un pago (separación de funciones): solo si la organización definió un umbral y el pago lo alcanza, y NUNCA por quien lo creó.
 * Idempotente: aprobar uno ya aprobado lo devuelve sin tocar nada.
 */
export class ApprovePaymentUseCase {
  constructor(private readonly deps: PaymentDependencies) {}

  async execute(input: { organizationId: string; paymentId: string; userId: string }): Promise<Payment> {
    const now = this.deps.clock();
    return inTransaction(this.deps.gateway, async (uow) => {
      const payment = await uow.payments.findById(input.organizationId, input.paymentId, { lock: true });
      if (!payment) throw new PaymentNotFoundError();
      if (payment.status === 'approved') return payment;
      if (payment.status !== 'draft') throw new PaymentStateError('Solo se aprueba un pago en borrador.');
      if (payment.createdBy === input.userId) throw new PaymentSelfApprovalError();
      const settings = (await uow.paymentSettings.find(input.organizationId)) ?? defaultPaymentSettings(input.organizationId);
      if (!requiresApproval(settings, payment)) throw new PaymentStateError('Este pago no necesita aprobación: está por debajo del umbral (o no hay umbral definido).');
      const approved: Payment = { ...payment, status: 'approved', approvedBy: input.userId, approvedAt: now, version: payment.version + 1, updatedAt: now };
      await uow.payments.save(approved, payment.version);
      await uow.outbox.add(paymentApprovedEvent(approved));
      return approved;
    });
  }
}

/**
 * Contabiliza un pago: aplica a las facturas, consume anticipos, abre el anticipo del excedente, asigna `PG-AAAA-NNNNNN` y publica
 * `treasury.payment.posted` (de ahí sale el asiento en contabilidad).
 *
 * Idempotente: contabilizar uno ya contabilizado devuelve el mismo pago. `READ COMMITTED` + bloqueo de filas: la suma de lo aplicado se
 * lee DESPUÉS de esperar el bloqueo de la deuda. Orden de bloqueos: pago → deudas (por id) → anticipos (por id) → serie; el mismo orden
 * en `VoidPaymentUseCase`.
 *
 * Con umbral de aprobación definido y alcanzado, solo se contabiliza uno `approved` (por otra persona que su creador).
 */
export class PostPaymentUseCase {
  constructor(private readonly deps: PaymentDependencies) {}

  async execute(input: { organizationId: string; paymentId: string; userId: string }): Promise<Payment> {
    const now = this.deps.clock();
    return inTransaction(
      this.deps.gateway,
      async (uow) => {
        const payment = await uow.payments.findById(input.organizationId, input.paymentId, { lock: true });
        if (!payment) throw new PaymentNotFoundError();
        if (payment.status === 'posted') return payment;
        if (payment.status === 'voided') throw new PaymentStateError('Este pago está anulado: no se puede contabilizar.');
        const settings = (await uow.paymentSettings.find(input.organizationId)) ?? defaultPaymentSettings(input.organizationId);
        if (payment.status !== 'approved' && requiresApproval(settings, payment)) throw new PaymentApprovalRequiredError();

        const payables = await loadPayables(uow, input.organizationId, payment.lines.map((l) => l.payableId), true);
        const advances = await loadAdvances(uow, input.organizationId, payment.advanceUses.map((u) => u.advanceId), true);
        const errors = checkApplications(payment, payables, advances);
        if (errors.length) throw new ValidationError(errors);

        const year = Number(payment.paymentDate.slice(0, 4));
        const number = `PG-${year}-${pad(await uow.payments.nextSequence(input.organizationId, year))}`;
        const posted: Payment = { ...payment, number, status: 'posted', postedBy: input.userId, postedAt: now, version: payment.version + 1, updatedAt: now };
        const documentNumbers = new Map<string, string | null>();

        for (const line of posted.lines) {
          const p = payables.get(line.payableId)!;
          documentNumbers.set(p.id, p.documentNumber ?? p.internalNumber);
          await uow.payableApplications.add({
            id: randomUUID(),
            organizationId: input.organizationId,
            payableId: p.id,
            sourceType: 'payment',
            sourceId: posted.id,
            documentNumber: number,
            appliedCents: line.appliedCents,
            appliedAt: posted.paymentDate,
            createdAt: now,
          });
          const applied = p.appliedCents + line.appliedCents;
          const updated: Payable = { ...p, appliedCents: applied, status: derivePayableStatus(p.status, p.originalCents, applied), version: p.version + 1, updatedAt: now };
          await uow.payables.save(updated, p.version);
          await uow.outbox.add(payableCreditedEvent({ payable: updated, sourceType: 'payment', sourceId: posted.id, documentNumber: number, appliedCents: line.appliedCents }));
        }

        for (const use of posted.advanceUses) await uow.paymentAdvanceUses.add(input.organizationId, posted.id, use, now);

        if (posted.advanceCents > 0) {
          const advance: SupplierAdvance = {
            id: randomUUID(),
            organizationId: input.organizationId,
            supplierId: posted.supplierId,
            supplierName: posted.supplierName,
            supplierIdentification: posted.supplierIdentification,
            originId: posted.id,
            documentNumber: number,
            currencyCode: posted.currencyCode,
            originalCents: posted.advanceCents,
            version: 1,
            createdAt: now,
            updatedAt: now,
            appliedCents: 0,
            voidedAt: null,
          };
          await uow.supplierAdvances.save(advance);
          await uow.outbox.add(supplierAdvanceOpenedEvent(advance));
        }

        await uow.payments.save(posted, payment.version);
        await recordBankMovement(uow, {
          organizationId: input.organizationId,
          sourceType: 'payment',
          sourceId: posted.id,
          accountRole: posted.accountRole,
          bankAccountId: posted.bankAccountId,
          date: posted.paymentDate,
          amountCents: -posted.totalCents,
          reference: posted.reference,
          description: posted.supplierName,
          userId: input.userId,
          now,
        });
        await uow.outbox.add(paymentPostedEvent(posted, documentNumbers, input.userId));
        return posted;
      },
      { readCommitted: true },
    );
  }
}

/**
 * Anula un pago contabilizado, con motivo. Nada se borra: las aplicaciones y los consumos de anticipo se MARCAN anulados (el saldo de las
 * facturas vuelve a lo que era), el anticipo del excedente se marca anulado y contabilidad reversa su asiento. Si otro pago ya consumió el
 * anticipo de este, no se puede anular hasta anular ese (409). Idempotente.
 */
export class VoidPaymentUseCase {
  constructor(private readonly deps: PaymentDependencies) {}

  async execute(input: { organizationId: string; paymentId: string; userId: string; reason: string }): Promise<Payment> {
    const reason = input.reason?.trim() ?? '';
    if (reason.length < MIN_PAYMENT_VOID_REASON) {
      throw new ValidationError([{ field: 'reason', message: `Indica el motivo de la anulación (mínimo ${MIN_PAYMENT_VOID_REASON} caracteres).` }]);
    }
    const now = this.deps.clock();
    return inTransaction(
      this.deps.gateway,
      async (uow) => {
        const payment = await uow.payments.findById(input.organizationId, input.paymentId, { lock: true });
        if (!payment) throw new PaymentNotFoundError();
        if (payment.status === 'voided') return payment;
        if (payment.status !== 'posted') throw new PaymentStateError('Solo se anula un pago contabilizado: un borrador se edita o se deja.');

        const payables = await loadPayables(uow, input.organizationId, payment.lines.map((l) => l.payableId), true);
        const created = payment.advanceCents > 0 ? await uow.supplierAdvances.findByOrigin(input.organizationId, payment.id) : null;
        if (created) {
          const locked = await uow.supplierAdvances.findById(input.organizationId, created.id, { lock: true });
          if (locked && locked.appliedCents > 0) throw new PaymentAdvanceInUseError();
          if (locked) await uow.supplierAdvances.save({ ...locked, voidedAt: now, version: locked.version + 1, updatedAt: now }, locked.version);
        }

        await uow.payableApplications.reverseBySource(input.organizationId, 'payment', payment.id, now);
        await uow.paymentAdvanceUses.reverseByPayment(input.organizationId, payment.id, now);

        const documentNumbers = new Map<string, string | null>();
        for (const id of [...payables.keys()].sort()) {
          const before = payables.get(id);
          if (!before) continue;
          documentNumbers.set(id, before.documentNumber ?? before.internalNumber);
          // Se vuelve a leer: el repositorio deriva lo aplicado de las aplicaciones VIGENTES (la de este pago ya no cuenta).
          const fresh = (await uow.payables.findById(input.organizationId, id, { lock: true }))!;
          await uow.payables.save({ ...fresh, status: derivePayableStatus(fresh.status, fresh.originalCents, fresh.appliedCents), version: fresh.version + 1, updatedAt: now }, fresh.version);
        }

        const voided: Payment = { ...payment, status: 'voided', voidReason: reason, voidedBy: input.userId, voidedAt: now, version: payment.version + 1, updatedAt: now };
        await uow.payments.save(voided, payment.version);
        const unmatched = await reverseBankMovement(uow, { organizationId: input.organizationId, sourceType: 'payment', sourceId: payment.id, now });
        if (unmatched) await uow.outbox.add(unmatched);
        await uow.outbox.add(paymentVoidedEvent(voided, documentNumbers));
        return voided;
      },
      { readCommitted: true },
    );
  }
}

export class GetPaymentUseCase {
  constructor(private readonly reads: UnitOfWork) {}

  async execute(input: { organizationId: string; paymentId: string }): Promise<Payment> {
    const payment = await this.reads.payments.findById(input.organizationId, input.paymentId);
    if (!payment) throw new PaymentNotFoundError();
    return payment;
  }
}

export class ListPaymentsUseCase {
  constructor(private readonly reads: UnitOfWork) {}

  async execute(input: { organizationId: string; filters: PaymentFilters }): Promise<Page<Payment>> {
    return this.reads.payments.list(input.organizationId, input.filters);
  }
}

/** Lee la configuración de pagos. Sin fila guardada rige el valor por defecto: SIN aprobación. */
export class GetPaymentSettingsUseCase {
  constructor(private readonly reads: UnitOfWork) {}

  async execute(input: { organizationId: string }): Promise<PaymentSettings> {
    return (await this.reads.paymentSettings.find(input.organizationId)) ?? defaultPaymentSettings(input.organizationId);
  }
}

/** Fija el umbral de aprobación de pagos (`null` = sin aprobación). Deja valor anterior y nuevo en la bitácora. */
export class SetPaymentSettingsUseCase {
  constructor(private readonly gateway: UnitOfWorkGateway, private readonly clock: Clock) {}

  async execute(input: { organizationId: string; approvalThresholdCents: number | null; userId: string }): Promise<PaymentSettings> {
    const t = input.approvalThresholdCents;
    if (t !== null && (!Number.isSafeInteger(t) || t <= 0)) {
      throw new ValidationError([{ field: 'approvalThresholdCents', message: 'El umbral debe ser un importe mayor que cero (o vacío para no pedir aprobación).' }]);
    }
    return inTransaction(this.gateway, async (uow) => {
      const previous = (await uow.paymentSettings.find(input.organizationId)) ?? defaultPaymentSettings(input.organizationId);
      const next: PaymentSettings = { ...previous, approvalThresholdCents: t, updatedBy: input.userId, updatedAt: this.clock() };
      await uow.paymentSettings.save(next);
      await uow.outbox.add(paymentSettingsUpdatedEvent(next, previous));
      return next;
    });
  }
}
