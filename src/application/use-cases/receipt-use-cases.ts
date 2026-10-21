import { randomUUID } from 'node:crypto';
import {
  ReceiptAdvanceInUseError,
  ReceiptNotFoundError,
  ReceiptStateError,
  ValidationError,
  type ErrorDetail,
} from '../../domain/errors.js';
import {
  defaultAccountRole,
  receiptTotals,
  validateReceiptInput,
  type Receipt,
  type ReceiptInput,
} from '../../domain/receipt.js';
import { balanceOf, deriveStatus, type CustomerAdvance, type Receivable } from '../../domain/receivable.js';
import type { Page, ReceiptFilters, UnitOfWork } from '../../domain/repositories.js';
import {
  customerAdvanceOpenedEvent,
  receiptCreatedEvent,
  receiptPostedEvent,
  receiptUpdatedEvent,
  receiptVoidedEvent,
  receivableCreditedEvent,
} from '../events.js';
import type { AccountingCatalogPort, Clock, CustomerCatalogPort, CustomerInfo, UnitOfWorkGateway } from '../ports.js';
import { inTransaction } from './transaction.js';

/** Mínimo de caracteres del motivo de una anulación (igual que en compras). */
export const MIN_VOID_REASON = 5;

const PAYABLE_STATUSES: Receivable['status'][] = ['open', 'partial'];

const pad = (n: number) => String(n).padStart(6, '0');

/**
 * Comprueba que las líneas y los anticipos del recibo son cobrables AHORA: cada deuda existe en la organización, es del cliente, está
 * viva (abierta o parcial), está en la misma moneda y su saldo alcanza; cada anticipo es de un cobro anterior del cliente y alcanza.
 * Devuelve TODOS los errores con el índice de su línea (la persona corrige de una vez, no de uno en uno).
 *
 * Lo llaman el borrador (lecturas, para avisar pronto) y la contabilización (filas bloqueadas, la comprobación que vale).
 */
function checkApplications(
  receipt: Pick<Receipt, 'customerId' | 'currencyCode' | 'lines' | 'advanceUses'>,
  receivables: Map<string, Receivable | null>,
  advances: Map<string, CustomerAdvance | null>,
): ErrorDetail[] {
  const errors: ErrorDetail[] = [];
  receipt.lines.forEach((line, i) => {
    const r = receivables.get(line.receivableId);
    const field = `lines[${i}].appliedCents`;
    if (!r) return void errors.push({ field: `lines[${i}].receivableId`, message: 'La deuda no existe en esta organización.' });
    if (r.customerId !== receipt.customerId) return void errors.push({ field: `lines[${i}].receivableId`, message: 'La deuda es de otro cliente.' });
    if (!PAYABLE_STATUSES.includes(r.status)) return void errors.push({ field: `lines[${i}].receivableId`, message: 'La deuda ya no está abierta (está pagada o anulada).' });
    if (r.currencyCode !== receipt.currencyCode) return void errors.push({ field: `lines[${i}].receivableId`, message: 'La deuda está en otra moneda.' });
    const balance = balanceOf(r);
    if (line.appliedCents > balance) errors.push({ field, message: `Lo aplicado supera el saldo de la deuda (${balance} centavos).` });
  });
  receipt.advanceUses.forEach((use, i) => {
    const a = advances.get(use.advanceId);
    const field = `advanceUses[${i}].usedCents`;
    if (!a || a.voidedAt) return void errors.push({ field: `advanceUses[${i}].advanceId`, message: 'El anticipo no existe.' });
    if (a.customerId !== receipt.customerId) return void errors.push({ field: `advanceUses[${i}].advanceId`, message: 'El anticipo es de otro cliente.' });
    // Solo los anticipos de un COBRO se consumen aquí: el saldo a favor de una nota de crédito vive en las cuentas por cobrar y se aplica
    // solo a la próxima factura; consumirlo contra «anticipos de clientes» asentaría el mismo dinero en dos cuentas.
    if (a.origin !== 'receipt') return void errors.push({ field: `advanceUses[${i}].advanceId`, message: 'Solo se pueden consumir anticipos de cobros anteriores.' });
    if (a.currencyCode !== receipt.currencyCode) return void errors.push({ field: `advanceUses[${i}].advanceId`, message: 'El anticipo está en otra moneda.' });
    const available = a.originalCents - a.appliedCents;
    if (use.usedCents > available) errors.push({ field, message: `Lo que se consume supera el saldo del anticipo (${available} centavos).` });
  });
  return errors;
}

async function loadReceivables(uow: UnitOfWork, organizationId: string, ids: string[], lock: boolean): Promise<Map<string, Receivable | null>> {
  const out = new Map<string, Receivable | null>();
  // Orden fijo por id: dos cobros simultáneos a las mismas deudas piden los bloqueos en el mismo orden y no se interbloquean.
  for (const id of [...new Set(ids)].sort()) out.set(id, await uow.receivables.findById(organizationId, id, { lock }));
  return out;
}

async function loadAdvances(uow: UnitOfWork, organizationId: string, ids: string[], lock: boolean): Promise<Map<string, CustomerAdvance | null>> {
  const out = new Map<string, CustomerAdvance | null>();
  for (const id of [...new Set(ids)].sort()) out.set(id, await uow.advances.findById(organizationId, id, { lock }));
  return out;
}

export interface ReceiptDependencies {
  gateway: UnitOfWorkGateway;
  accounting: AccountingCatalogPort;
  customers: CustomerCatalogPort;
  clock: Clock;
}

/** Datos que se piden FUERA de la transacción (son llamadas HTTP): moneda de la contabilidad y datos del cliente. */
async function externalData(deps: ReceiptDependencies, organizationId: string, customerId: string): Promise<{ currencyCode: string; customer: CustomerInfo }> {
  const settings = await deps.accounting.getSettings(organizationId);
  if (!settings) {
    throw new ValidationError([{ field: 'currencyCode', message: 'La organización no tiene contabilidad configurada: no se sabe la moneda del cobro.' }]);
  }
  const customer = await deps.customers.findById(organizationId, customerId);
  if (!customer) throw new ValidationError([{ field: 'customerId', message: 'El cliente no existe en esta organización.' }]);
  return { currencyCode: settings.baseCurrency, customer };
}

function buildDraft(
  base: Pick<Receipt, 'id' | 'organizationId' | 'customerId' | 'customerName' | 'customerIdentification' | 'currencyCode' | 'createdBy' | 'createdAt'> & Partial<Receipt>,
  input: ReceiptInput,
  now: Date,
): Receipt {
  const totals = receiptTotals(input);
  // Orden: valores por defecto de un borrador nuevo → lo que ya tenía (al editar) → lo que dice la entrada, que MANDA. Con la base
  // al final (como estuvo antes) editar un borrador devolvía los valores viejos y descartaba lo escrito.
  const defaults = { number: null, status: 'draft' as const, voidReason: null, postedBy: null, voidedBy: null, postedAt: null, voidedAt: null, version: 1 };
  const fromInput = {
    receiptDate: input.receiptDate,
    method: input.method,
    accountRole: input.accountRole ?? defaultAccountRole(input.method),
    reference: input.reference?.trim() || null,
    totalCents: input.totalCents,
    ...totals,
    lines: input.lines.map((l) => ({ receivableId: l.receivableId, appliedCents: l.appliedCents })),
    advanceUses: (input.advanceUses ?? []).map((u) => ({ advanceId: u.advanceId, usedCents: u.usedCents })),
    notes: input.notes?.trim().slice(0, 500) || null,
    updatedAt: now,
  };
  return { ...defaults, ...base, ...fromInput } as Receipt;
}

/**
 * Crea un cobro en BORRADOR. No toca saldos ni gasta número: solo guarda lo que la persona va a cobrar. Avisa pronto de lo que ya se
 * sabe que fallará (deuda de otro cliente, saldo insuficiente), pero la comprobación que vale es la de contabilizar, con las filas
 * bloqueadas: entre guardar y contabilizar otra persona pudo cobrar lo mismo.
 */
export class CreateReceiptUseCase {
  constructor(private readonly deps: ReceiptDependencies) {}

  async execute(input: { organizationId: string; customerId: string; userId: string; receipt: ReceiptInput }): Promise<Receipt> {
    validateReceiptInput(input.receipt);
    const { currencyCode, customer } = await externalData(this.deps, input.organizationId, input.customerId);
    const now = this.deps.clock();

    return inTransaction(this.deps.gateway, async (uow) => {
      const draft = buildDraft(
        {
          id: randomUUID(),
          organizationId: input.organizationId,
          customerId: customer.id,
          customerName: customer.businessName,
          customerIdentification: customer.identification,
          currencyCode,
          createdBy: input.userId,
          createdAt: now,
        },
        input.receipt,
        now,
      );
      const errors = checkApplications(
        draft,
        await loadReceivables(uow, input.organizationId, draft.lines.map((l) => l.receivableId), false),
        await loadAdvances(uow, input.organizationId, draft.advanceUses.map((u) => u.advanceId), false),
      );
      if (errors.length) throw new ValidationError(errors);
      await uow.receipts.save(draft);
      await uow.outbox.add(receiptCreatedEvent(draft));
      return draft;
    });
  }
}

/** Edita un borrador (uno contabilizado no se edita: se anula y se rehace). El cliente no cambia. */
export class UpdateReceiptUseCase {
  constructor(private readonly deps: ReceiptDependencies) {}

  async execute(input: { organizationId: string; receiptId: string; userId: string; receipt: ReceiptInput; expectedVersion?: number }): Promise<Receipt> {
    validateReceiptInput(input.receipt);
    const now = this.deps.clock();
    return inTransaction(this.deps.gateway, async (uow) => {
      const current = await uow.receipts.findById(input.organizationId, input.receiptId, { lock: true });
      if (!current) throw new ReceiptNotFoundError();
      if (current.status !== 'draft') throw new ReceiptStateError('Solo se puede editar un cobro en borrador: uno contabilizado se anula y se rehace.');
      if (input.expectedVersion !== undefined && input.expectedVersion !== current.version) {
        throw new ReceiptStateError('Otra persona modificó este cobro. Vuelve a cargarlo.');
      }
      const next = buildDraft({ ...current, updatedAt: now }, input.receipt, now);
      next.version = current.version + 1;
      const errors = checkApplications(
        next,
        await loadReceivables(uow, input.organizationId, next.lines.map((l) => l.receivableId), false),
        await loadAdvances(uow, input.organizationId, next.advanceUses.map((u) => u.advanceId), false),
      );
      if (errors.length) throw new ValidationError(errors);
      await uow.receipts.save(next, current.version);
      await uow.outbox.add(receiptUpdatedEvent(next));
      return next;
    });
  }
}

/**
 * Contabiliza un cobro: aplica a las deudas, consume anticipos, abre el anticipo del excedente, asigna `RC-AAAA-NNNNNN` y publica
 * `treasury.receipt.posted` (de ahí sale el asiento en contabilidad).
 *
 * Idempotente: contabilizar uno ya contabilizado devuelve el mismo cobro sin tocar nada (un doble clic o un reintento de red no
 * cobra dos veces).
 *
 * `READ COMMITTED` + bloqueo de filas: la suma de lo aplicado se lee DESPUÉS de esperar el bloqueo de la deuda; con una instantánea
 * anterior dos cobros simultáneos pasarían del saldo. Orden de bloqueos: cobro → deudas (por id) → anticipos (por id) → serie. El
 * mismo orden en `VoidReceiptUseCase`, para que dos operaciones sobre las mismas filas no se interbloqueen.
 */
export class PostReceiptUseCase {
  constructor(private readonly deps: ReceiptDependencies) {}

  async execute(input: { organizationId: string; receiptId: string; userId: string }): Promise<Receipt> {
    const now = this.deps.clock();
    return inTransaction(
      this.deps.gateway,
      async (uow) => {
        const receipt = await uow.receipts.findById(input.organizationId, input.receiptId, { lock: true });
        if (!receipt) throw new ReceiptNotFoundError();
        if (receipt.status === 'posted') return receipt;
        if (receipt.status === 'voided') throw new ReceiptStateError('Este cobro está anulado: no se puede contabilizar.');

        const receivables = await loadReceivables(uow, input.organizationId, receipt.lines.map((l) => l.receivableId), true);
        const advances = await loadAdvances(uow, input.organizationId, receipt.advanceUses.map((u) => u.advanceId), true);
        const errors = checkApplications(receipt, receivables, advances);
        if (errors.length) throw new ValidationError(errors);

        const year = Number(receipt.receiptDate.slice(0, 4));
        const number = `RC-${year}-${pad(await uow.receipts.nextSequence(input.organizationId, year))}`;
        const posted: Receipt = { ...receipt, number, status: 'posted', postedBy: input.userId, postedAt: now, version: receipt.version + 1, updatedAt: now };
        const invoiceNumbers = new Map<string, string | null>();

        for (const line of posted.lines) {
          const r = receivables.get(line.receivableId)!;
          invoiceNumbers.set(r.id, r.documentNumber);
          await uow.creditApplications.add({
            id: randomUUID(),
            organizationId: input.organizationId,
            receivableId: r.id,
            sourceId: posted.id,
            sourceType: 'receipt',
            documentNumber: number,
            appliedCents: line.appliedCents,
            appliedAt: posted.receiptDate,
            createdAt: now,
          });
          const applied = r.appliedCents + line.appliedCents;
          const updated: Receivable = { ...r, appliedCents: applied, status: deriveStatus(r.status, r.originalCents, applied), version: r.version + 1, updatedAt: now };
          await uow.receivables.save(updated, r.version);
          await uow.outbox.add(
            receivableCreditedEvent({ receivable: updated, sourceType: 'receipt', sourceId: posted.id, documentNumber: number, appliedCents: line.appliedCents, advanceId: null }),
          );
        }

        for (const use of posted.advanceUses) await uow.receiptAdvanceUses.add(input.organizationId, posted.id, use, now);

        if (posted.advanceCents > 0) {
          const advance: CustomerAdvance = {
            id: randomUUID(),
            organizationId: input.organizationId,
            customerId: posted.customerId,
            customerName: posted.customerName,
            customerIdentification: posted.customerIdentification,
            origin: 'receipt',
            originId: posted.id,
            relatedInvoiceId: null,
            documentNumber: number,
            currencyCode: posted.currencyCode,
            originalCents: posted.advanceCents,
            version: 1,
            createdAt: now,
            updatedAt: now,
            appliedCents: 0,
            voidedAt: null,
          };
          await uow.advances.save(advance);
          await uow.outbox.add(customerAdvanceOpenedEvent(advance));
        }

        await uow.receipts.save(posted, receipt.version);
        await uow.outbox.add(receiptPostedEvent(posted, invoiceNumbers, input.userId));
        return posted;
      },
      { readCommitted: true },
    );
  }
}

/**
 * Anula un cobro contabilizado, con motivo. Nada se borra: las aplicaciones y los consumos de anticipo se MARCAN anulados (el saldo
 * de las deudas vuelve a lo que era), el anticipo que abrió el excedente se marca anulado, y contabilidad reversa su asiento.
 *
 * Si otro cobro ya consumió el anticipo de este, no se puede anular hasta anular ese (409): si no, ese cobro quedaría apoyado en un
 * anticipo que ya no existe. Idempotente: anular uno ya anulado devuelve el mismo cobro.
 */
export class VoidReceiptUseCase {
  constructor(private readonly deps: ReceiptDependencies) {}

  async execute(input: { organizationId: string; receiptId: string; userId: string; reason: string }): Promise<Receipt> {
    const reason = input.reason?.trim() ?? '';
    if (reason.length < MIN_VOID_REASON) {
      throw new ValidationError([{ field: 'reason', message: `Indica el motivo de la anulación (mínimo ${MIN_VOID_REASON} caracteres).` }]);
    }
    const now = this.deps.clock();
    return inTransaction(
      this.deps.gateway,
      async (uow) => {
        const receipt = await uow.receipts.findById(input.organizationId, input.receiptId, { lock: true });
        if (!receipt) throw new ReceiptNotFoundError();
        if (receipt.status === 'voided') return receipt;
        if (receipt.status === 'draft') throw new ReceiptStateError('Un borrador no se anula: no se contabilizó. Edítalo o déjalo.');

        // Mismo orden de bloqueos que al contabilizar: primero las deudas (por id), luego los anticipos.
        const receivables = await loadReceivables(uow, input.organizationId, receipt.lines.map((l) => l.receivableId), true);
        const createdAdvance = receipt.advanceCents > 0 ? await uow.advances.findByOrigin(input.organizationId, 'receipt', receipt.id) : null;
        if (createdAdvance) {
          const locked = await uow.advances.findById(input.organizationId, createdAdvance.id, { lock: true });
          if (locked && locked.appliedCents > 0) throw new ReceiptAdvanceInUseError();
          if (locked) await uow.advances.save({ ...locked, voidedAt: now, version: locked.version + 1, updatedAt: now }, locked.version);
        }

        await uow.creditApplications.reverseBySource(input.organizationId, 'receipt', receipt.id, now);
        await uow.receiptAdvanceUses.reverseByReceipt(input.organizationId, receipt.id, now);

        const invoiceNumbers = new Map<string, string | null>();
        for (const id of [...receivables.keys()].sort()) {
          const before = receivables.get(id);
          if (!before) continue;
          invoiceNumbers.set(id, before.documentNumber);
          // Se vuelve a leer: el repositorio deriva lo aplicado de las aplicaciones VIGENTES (la de este cobro ya no cuenta).
          const fresh = (await uow.receivables.findById(input.organizationId, id, { lock: true }))!;
          const reopened: Receivable = { ...fresh, status: deriveStatus(fresh.status, fresh.originalCents, fresh.appliedCents), version: fresh.version + 1, updatedAt: now };
          await uow.receivables.save(reopened, fresh.version);
        }

        const voided: Receipt = { ...receipt, status: 'voided', voidReason: reason, voidedBy: input.userId, voidedAt: now, version: receipt.version + 1, updatedAt: now };
        await uow.receipts.save(voided, receipt.version);
        await uow.outbox.add(receiptVoidedEvent(voided, invoiceNumbers));
        return voided;
      },
      { readCommitted: true },
    );
  }
}

export class GetReceiptUseCase {
  constructor(private readonly reads: UnitOfWork) {}

  async execute(input: { organizationId: string; receiptId: string }): Promise<Receipt> {
    const receipt = await this.reads.receipts.findById(input.organizationId, input.receiptId);
    if (!receipt) throw new ReceiptNotFoundError();
    return receipt;
  }
}

export class ListReceiptsUseCase {
  constructor(private readonly reads: UnitOfWork) {}

  async execute(input: { organizationId: string; filters: ReceiptFilters }): Promise<Page<Receipt>> {
    return this.reads.receipts.list(input.organizationId, input.filters);
  }
}
