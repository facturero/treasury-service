import { randomUUID } from 'node:crypto';
import { localDateOf } from '../../domain/dates.js';
import {
  derivePayableStatus,
  normalizeDocumentNumber,
  type Payable,
  type PayableApplication,
} from '../../domain/payable.js';
import type { UnitOfWork } from '../../domain/repositories.js';
import { payableCancelledEvent, payableCreditedEvent, payableOpenedEvent } from '../events.js';
import type { AccountingCatalogPort, Clock, UnitOfWorkGateway } from '../ports.js';
import { inTransaction, isUniqueViolation } from './transaction.js';

/**
 * Lo que publica `purchasing-service` en `purchasing.bill.posted` y `purchasing.bill.voided` (ver su `asyncapi.yaml`, `BillPayload`).
 * Solo se usan los campos que las cuentas por pagar necesitan; el resto se acepta y se ignora.
 */
export interface BillPostedPayload {
  organizationId: string;
  billId: string;
  internalNumber?: string | null;
  supplierId?: string | null;
  supplier?: { identification?: string | null; legalName?: string | null } | null;
  /** `01` factura, `03` liquidación de compra, `41` reembolso. */
  docType?: string | null;
  supplierDocument?: string | null;
  issueDate?: string | null;
  dueDate?: string | null;
  currencyCode?: string | null;
  subtotalCents?: number;
  taxCents?: number;
  totalCents: number;
  voidReason?: string | null;
  lines?: { subtotalCents?: number; vatCents?: number; iceCents?: number; irbpnrCents?: number }[];
}

/** `fiscal.ec.withholding.issued` tal como lo publica fiscal-ecuador (no trae id de factura de compra: se empareja por RUC y número). */
export interface WithholdingIssuedPayload {
  organizationId: string;
  withholdingId: string;
  number?: string | null;
  issueDate?: string | null;
  currencyCode?: string | null;
  supplier?: { identification?: string | null } | null;
  support?: { documentCode?: string | null; number?: string | null } | null;
  totalWithheldCents?: number;
}

export type BillPostedOutcome = { outcome: 'opened'; payableId: string } | { outcome: 'skipped'; reason: string } | { outcome: 'duplicate' };
export type BillVoidedOutcome = { outcome: 'cancelled'; payableId: string } | { outcome: 'skipped'; reason: string } | { outcome: 'duplicate' };
export type WithholdingOutcome =
  | { outcome: 'applied'; payableId: string }
  | { outcome: 'pending'; reason: string }
  | { outcome: 'ignored'; reason: string }
  | { outcome: 'duplicate' };

/** Facturas de compra a las que se puede aplicar una retención (la liquidación `03` se contabiliza desde fiscal, no desde compras). */
const BILL_DOC_TYPES: readonly string[] = ['01', '41'];

/**
 * Aplica una retención a una deuda. Compartido por el consumidor de la retención y por el de la factura (cuando la retención llegó antes).
 * Idempotente: `UNIQUE (payable, source_type, source_id)` hace que una retención repetida no se aplique dos veces.
 *
 * No recorta al saldo: contabilidad asienta `Dr payables` por el total retenido, así que si la deuda ya estaba pagada la retención deja el
 * saldo a favor de la empresa (negativo), que es lo que dice el libro mayor.
 */
async function applyWithholding(
  uow: UnitOfWork,
  payable: Payable,
  withholding: { withholdingId: string; number: string | null; issueDate: string; totalCents: number },
  now: Date,
): Promise<'applied' | 'duplicate'> {
  const application: PayableApplication = {
    id: randomUUID(),
    organizationId: payable.organizationId,
    payableId: payable.id,
    sourceType: 'withholding',
    sourceId: withholding.withholdingId,
    documentNumber: withholding.number,
    appliedCents: withholding.totalCents,
    appliedAt: withholding.issueDate,
    createdAt: now,
  };
  try {
    await uow.payableApplications.add(application);
  } catch (err) {
    if (isUniqueViolation(err)) return 'duplicate';
    throw err;
  }
  const locked = (await uow.payables.findById(payable.organizationId, payable.id, { lock: true }))!;
  const applied = locked.appliedCents; // ya incluye la aplicación recién insertada: el repositorio la deriva de la tabla
  const updated: Payable = { ...locked, status: derivePayableStatus(locked.status, locked.originalCents, applied), version: locked.version + 1, updatedAt: now };
  await uow.payables.save(updated, locked.version);
  await uow.outbox.add(payableCreditedEvent({ payable: updated, sourceType: 'withholding', sourceId: withholding.withholdingId, documentNumber: withholding.number, appliedCents: withholding.totalCents }));
  return 'applied';
}

/**
 * Alta de la deuda a partir de `purchasing.bill.posted`.
 *
 * Gemela de `draftFromPurchaseBillPosted` de contabilidad: aplica los MISMOS filtros (liquidación 03 fuera, moneda base, fecha de arranque,
 * contabilización automática encendida, total = subtotal + impuestos). Si tesorería abriera una deuda que contabilidad no asienta, las
 * cuentas por pagar y el libro mayor divergirían y la prueba de oro no cuadraría nunca. Cuando algo no cuadra NO abre deuda y lo dice.
 */
export class HandleBillPostedUseCase {
  constructor(
    private readonly gateway: UnitOfWorkGateway,
    private readonly accounting: AccountingCatalogPort,
    private readonly clock: Clock,
  ) {}

  async execute(payload: BillPostedPayload): Promise<BillPostedOutcome> {
    const organizationId = payload.organizationId;
    if (!organizationId || !payload.billId) return { outcome: 'skipped', reason: 'evento sin organización o sin id de factura' };
    if (payload.docType === '03') return { outcome: 'skipped', reason: 'liquidación de compra: se contabiliza desde fiscal' };
    const totalCents = Math.round(Number(payload.totalCents ?? 0));
    if (totalCents <= 0) return { outcome: 'skipped', reason: 'factura de compra sin importe' };
    if (!payload.supplierId) return { outcome: 'skipped', reason: 'factura de compra sin proveedor' };

    // La consulta a contabilidad va FUERA de la transacción (HTTP). Si no responde el error sube (502) y el consumidor reintenta.
    const settings = await this.accounting.getSettings(organizationId);
    if (!settings) return { outcome: 'skipped', reason: 'la organización no tiene contabilidad' };
    const currencyCode = payload.currencyCode ?? settings.baseCurrency;
    if (currencyCode !== settings.baseCurrency) return { outcome: 'skipped', reason: `moneda ${currencyCode} distinta de la base ${settings.baseCurrency}` };

    const issueDate = localDateOf(payload.issueDate ?? this.clock(), settings.timezone);
    if (settings.autoPostingFrom && issueDate < settings.autoPostingFrom) return { outcome: 'skipped', reason: `documento anterior al ${settings.autoPostingFrom}` };
    if (!settings.autoPosting) return { outcome: 'skipped', reason: 'la contabilización automática está apagada' };

    const lines = payload.lines ?? [];
    const linesTotal = lines.reduce((acc, l) => acc + Math.round(Number(l.subtotalCents ?? 0)) + Math.round(Number(l.vatCents ?? 0)) + Math.round(Number(l.iceCents ?? 0)) + Math.round(Number(l.irbpnrCents ?? 0)), 0);
    if (Math.abs(totalCents - linesTotal) > 1) return { outcome: 'skipped', reason: 'la factura no cuadra subtotal + impuestos = total' };

    const dueDate = payload.dueDate ? localDateOf(payload.dueDate, settings.timezone) : issueDate;
    const now = this.clock();
    const identification = payload.supplier?.identification?.trim() || null;

    return inTransaction(this.gateway, async (uow): Promise<BillPostedOutcome> => {
      // Idempotencia: `UNIQUE (organization_id, source_type, source_id)`. Si ya existe, este evento ya se aplicó (o la factura se anuló antes de llegar).
      const existing = await uow.payables.findBySource(organizationId, 'purchase_bill', payload.billId);
      if (existing) return { outcome: 'duplicate' };

      const payable: Payable = {
        id: randomUUID(),
        organizationId,
        supplierId: payload.supplierId!,
        supplierName: payload.supplier?.legalName ?? '',
        supplierIdentification: identification,
        sourceType: 'purchase_bill',
        sourceId: payload.billId,
        documentNumber: payload.supplierDocument?.trim() || null,
        internalNumber: payload.internalNumber ?? null,
        issueDate,
        dueDate: dueDate < issueDate ? issueDate : dueDate,
        currencyCode,
        originalCents: totalCents,
        status: 'open',
        version: 1,
        createdAt: now,
        updatedAt: now,
        appliedCents: 0,
      };
      try {
        await uow.payables.save(payable);
      } catch (err) {
        if (isUniqueViolation(err)) return { outcome: 'duplicate' };
        throw err;
      }
      await uow.outbox.add(payableOpenedEvent(payable));

      // Una retención que llegó ANTES que esta factura (RabbitMQ no ordena) espera en `unmatched_withholdings`: se aplica ahora.
      if (identification && BILL_DOC_TYPES.includes(payload.docType ?? '01')) {
        const wanted = normalizeDocumentNumber(payable.documentNumber);
        for (const w of await uow.unmatchedWithholdings.listBySupplierIdentification(organizationId, identification)) {
          if (w.supportNumber !== wanted) continue;
          const fresh = (await uow.payables.findById(organizationId, payable.id))!;
          await applyWithholding(uow, fresh, { withholdingId: w.withholdingId, number: w.number, issueDate: w.issueDate ?? issueDate, totalCents: w.totalWithheldCents }, now);
          await uow.unmatchedWithholdings.remove(organizationId, w.id);
        }
      }
      return { outcome: 'opened', payableId: payable.id };
    });
  }
}

/**
 * Anulación de la factura de compra (`purchasing.bill.voided`).
 *
 * La deuda pasa a `cancelled` (terminal). Lo que ya se había pagado NO se revierte: queda como saldo a favor de la empresa (negativo), que
 * es lo que dice el libro mayor. Si la anulación llega ANTES que la factura (RabbitMQ no ordena) se guarda una deuda «fantasma» ya anulada
 * para que la factura posterior no abra nada. Idempotente.
 */
export class HandleBillVoidedUseCase {
  constructor(private readonly gateway: UnitOfWorkGateway, private readonly clock: Clock) {}

  async execute(payload: BillPostedPayload): Promise<BillVoidedOutcome> {
    const organizationId = payload.organizationId;
    if (!organizationId || !payload.billId) return { outcome: 'skipped', reason: 'evento sin organización o sin id de factura' };
    const now = this.clock();

    return inTransaction(this.gateway, async (uow): Promise<BillVoidedOutcome> => {
      const existing = await uow.payables.findBySource(organizationId, 'purchase_bill', payload.billId);
      if (!existing) {
        const today = localDateOf(now, 'UTC');
        const ghost: Payable = {
          id: randomUUID(),
          organizationId,
          supplierId: '',
          supplierName: '',
          supplierIdentification: null,
          sourceType: 'purchase_bill',
          sourceId: payload.billId,
          documentNumber: null,
          internalNumber: null,
          issueDate: today,
          dueDate: today,
          currencyCode: payload.currencyCode ?? 'USD',
          originalCents: 0,
          status: 'cancelled',
          version: 1,
          createdAt: now,
          updatedAt: now,
          appliedCents: 0,
        };
        try {
          await uow.payables.save(ghost);
        } catch (err) {
          if (isUniqueViolation(err)) return { outcome: 'duplicate' };
          throw err;
        }
        return { outcome: 'skipped', reason: 'la anulación llegó antes que la factura: se deja constancia para que no abra deuda' };
      }
      if (existing.status === 'cancelled') return { outcome: 'duplicate' };

      const locked = (await uow.payables.findById(organizationId, existing.id, { lock: true }))!;
      const cancelled: Payable = { ...locked, status: 'cancelled', version: locked.version + 1, updatedAt: now };
      await uow.payables.save(cancelled, locked.version);
      await uow.outbox.add(payableCancelledEvent(cancelled, payload.voidReason ?? null));
      return { outcome: 'cancelled', payableId: cancelled.id };
    });
  }
}

/**
 * Retención emitida (`fiscal.ec.withholding.issued`): reduce la deuda de la factura que cita.
 *
 * Se empareja por RUC del proveedor + número del documento sustento (la retención no trae ningún id de factura de compra). Nunca lanza por
 * «no encuentro la deuda»: casi todas las retenciones son de compras que no pasaron por este módulo, y lanzar mandaría el mensaje a
 * reintentos. Se distingue entre:
 *  - sin RUC o número de sustento, o sustento que no es una factura de compra → se IGNORA (no es de este módulo);
 *  - con RUC y número válidos pero sin deuda todavía → queda en `unmatched_withholdings` y se aplica cuando llegue la factura.
 */
export class HandleWithholdingIssuedUseCase {
  constructor(private readonly gateway: UnitOfWorkGateway, private readonly clock: Clock) {}

  async execute(payload: WithholdingIssuedPayload): Promise<WithholdingOutcome> {
    const { organizationId, withholdingId } = payload;
    if (!organizationId || !withholdingId) return { outcome: 'ignored', reason: 'evento sin organización o sin id de retención' };
    const identification = payload.supplier?.identification?.trim();
    const supportNumber = normalizeDocumentNumber(payload.support?.number);
    if (!identification || !/^\d{3}-\d{3}-\d{9}$/.test(supportNumber)) return { outcome: 'ignored', reason: 'la retención no cita proveedor y número de documento sustento' };
    const documentCode = payload.support?.documentCode?.trim();
    if (!documentCode || ![...BILL_DOC_TYPES, '03'].includes(documentCode)) return { outcome: 'ignored', reason: `el documento sustento (${documentCode ?? 'sin código'}) no es una factura de compra` };
    const totalCents = Math.round(Number(payload.totalWithheldCents ?? 0));
    if (totalCents <= 0) return { outcome: 'ignored', reason: 'retención sin importe' };
    const now = this.clock();
    const issueDate = payload.issueDate ? localDateOf(payload.issueDate, 'America/Guayaquil') : localDateOf(now, 'America/Guayaquil');

    return inTransaction(this.gateway, async (uow): Promise<WithholdingOutcome> => {
      const candidates = (await uow.payables.listBySupplierIdentification(organizationId, identification)).filter(
        (p) => p.sourceType === 'purchase_bill' && p.status !== 'cancelled' && normalizeDocumentNumber(p.documentNumber) === supportNumber,
      );
      if (candidates.length === 0) {
        try {
          await uow.unmatchedWithholdings.add({
            id: randomUUID(),
            organizationId,
            withholdingId,
            number: payload.number ?? null,
            supplierIdentification: identification,
            supportNumber,
            issueDate,
            totalWithheldCents: totalCents,
            createdAt: now,
          });
        } catch (err) {
          if (isUniqueViolation(err)) return { outcome: 'duplicate' };
          throw err;
        }
        return { outcome: 'pending', reason: 'todavía no hay una deuda con ese proveedor y documento: se aplicará cuando llegue la factura' };
      }
      const target = candidates[0]!;
      const result = await applyWithholding(uow, target, { withholdingId, number: payload.number ?? null, issueDate, totalCents }, now);
      return result === 'duplicate' ? { outcome: 'duplicate' } : { outcome: 'applied', payableId: target.id };
    });
  }
}
