import { randomUUID } from 'node:crypto';
import { addDays, localDateOf } from '../../domain/dates.js';
import {
  CREDIT_NOTE_DOCUMENT_TYPE,
  DEBT_DOCUMENT_TYPES,
  collectionRoleFor,
  isPostableInvoice,
} from '../../domain/accounting-rules.js';
import { deriveStatus } from '../../domain/receivable.js';
import type { CustomerAdvance, Receivable } from '../../domain/receivable.js';
import type { UnitOfWork } from '../../domain/repositories.js';
import {
  customerAdvanceOpenedEvent,
  receivableCancelledEvent,
  receivableCreditedEvent,
  receivableOpenedEvent,
} from '../events.js';
import type { AccountingCatalogPort, Clock, UnitOfWorkGateway } from '../ports.js';
import { inTransaction, isUniqueViolation } from './transaction.js';

/**
 * Lo que publica `billing-service` en `billing.invoice.issued` (ver `billing-service/src/application/use-cases/issue-invoice.ts`).
 * Solo se usan los campos que la cartera necesita; el resto se acepta y se ignora.
 */
export interface InvoiceIssuedPayload {
  organizationId: string;
  invoiceId: string;
  customerId?: string | null;
  number?: string | null;
  /** Instante ISO de emisión. La fecha de calendario se deriva con el huso de la contabilidad. */
  issueDate?: string | null;
  /** Tipo SRI del comprobante: `01` factura, `04` nota de crédito, `05` nota de débito. */
  documentTypeCode?: string;
  relatedInvoiceId?: string | null;
  posSaleId?: string | null;
  customerSnapshot?: { id?: string; businessName?: string; identification?: string | null } | null;
  subtotalCents?: number;
  taxTotalCents?: number;
  totalCents: number;
  currencyCode?: string;
  paymentMethodCode?: string | null;
  lines?: { subtotalCents?: number; taxes?: { kind: string; amountCents?: number }[] }[];
}

export interface InvoiceVoidedPayload {
  organizationId: string;
  invoiceId: string;
  number?: string | null;
  issueDate?: string | null;
  reason?: string | null;
  voidedAt?: string | null;
}

export type InvoiceIssuedOutcome =
  | { outcome: 'applied'; receivableIds: string[]; advanceIds: string[] }
  | { outcome: 'skipped'; reason: string }
  | { outcome: 'duplicate' };

export type InvoiceVoidedOutcome =
  | { outcome: 'cancelled'; receivableId: string }
  | { outcome: 'skipped'; reason: string }
  | { outcome: 'duplicate' };

/**
 * Alta de la partida de cartera a partir de `billing.invoice.issued`.
 *
 * Este caso de uso es la GEMELA de `draftFromInvoiceIssued` de contabilidad: aplica EXACTAMENTE los mismos filtros
 * (moneda, forma de pago, fecha de arranque de la contabilización, cuadre de ventas + IVA = total). Si tesorería
 * abriera una partida que contabilidad no asienta, la cartera y el libro mayor divergirían y la prueba de oro del
 * bloque A no cuadraría nunca.
 *
 * Por eso, cuando algo no cuadra, tesorería NO abre partida: se salta el documento y lo dice en el resultado.
 */
export class HandleInvoiceIssuedUseCase {
  constructor(
    private readonly gateway: UnitOfWorkGateway,
    private readonly accounting: AccountingCatalogPort,
    private readonly clock: Clock,
  ) {}

  async execute(payload: InvoiceIssuedPayload): Promise<InvoiceIssuedOutcome> {
    const organizationId = payload.organizationId;
    if (!organizationId || !payload.invoiceId) {
      return { outcome: 'skipped', reason: 'evento sin organización o sin id de comprobante' };
    }
    const totalCents = Math.round(Number(payload.totalCents ?? 0));
    if (totalCents <= 0) return { outcome: 'skipped', reason: 'comprobante sin importe' };

    const doc = payload.documentTypeCode ?? '01';
    if (!DEBT_DOCUMENT_TYPES.includes(doc) && doc !== CREDIT_NOTE_DOCUMENT_TYPE) {
      return { outcome: 'skipped', reason: `comprobante ${doc} sin regla` };
    }

    // La consulta a contabilidad va FUERA de la transacción: es una llamada HTTP y no debe bloquear la base de datos
    // mientras espera. Si contabilidad no responde, el error sube (502) y el consumidor reintenta: mejor que abrir una
    // partida a ciegas.
    const settings = await this.accounting.getSettings(organizationId);
    if (!settings) return { outcome: 'skipped', reason: 'la organización no tiene contabilidad' };

    const issueDate = localDateOf(payload.issueDate ?? this.clock(), settings.timezone);
    const currencyCode = payload.currencyCode ?? settings.baseCurrency;
    if (currencyCode !== settings.baseCurrency) {
      return { outcome: 'skipped', reason: `moneda ${currencyCode} distinta de la base ${settings.baseCurrency}` };
    }
    if (collectionRoleFor(payload.paymentMethodCode, settings.paymentMethodRoles) !== 'receivables') {
      return { outcome: 'skipped', reason: 'cobro inmediato: no queda nada por cobrar' };
    }
    if (settings.autoPostingFrom && issueDate < settings.autoPostingFrom) {
      return { outcome: 'skipped', reason: `documento anterior al ${settings.autoPostingFrom}` };
    }
    if (!settings.autoPosting) {
      return { outcome: 'skipped', reason: 'la contabilización automática está apagada' };
    }
    if (payload.posSaleId) {
      return { outcome: 'skipped', reason: 'venta de POS ya cobrada' };
    }
    if (!isPostableInvoice(payload.lines, totalCents)) {
      return { outcome: 'skipped', reason: 'el comprobante no cuadra ventas + IVA = total' };
    }
    const customerId = payload.customerId ?? payload.customerSnapshot?.id ?? null;
    if (!customerId) return { outcome: 'skipped', reason: 'comprobante sin cliente' };

    const now = this.clock();
    const customerName = payload.customerSnapshot?.businessName ?? '';
    const customerIdentification = payload.customerSnapshot?.identification ?? null;

    return inTransaction(
      this.gateway,
      async (uow): Promise<InvoiceIssuedOutcome> => {
        // Idempotencia: `UNIQUE (organization_id, source_type, source_id)`. Si la partida ya existe, este evento ya
        // se aplicó (o la factura se anuló antes de llegar): no se vuelve a abrir.
        const existing = await uow.receivables.findBySource(organizationId, 'invoice', payload.invoiceId);
        if (existing) return { outcome: 'duplicate' };

        if (doc === CREDIT_NOTE_DOCUMENT_TYPE) {
          return await this.applyCreditNote(uow, {
            organizationId,
            invoiceId: payload.invoiceId,
            documentNumber: payload.number ?? null,
            issueDate,
            currencyCode,
            totalCents,
            relatedInvoiceId: payload.relatedInvoiceId ?? null,
            customerId,
            customerName,
            customerIdentification,
            now,
          });
        }

        // Factura (`01`) o nota de débito (`05`): el cliente debe ese importe.
        const terms = await uow.customerTerms.find(organizationId, customerId);
        // Los días de crédito se LEEN en el momento de la factura: cambiarlos después no reescribe partidas ya
        // creadas (si lo hiciera, la antigüedad mentiría hacia atrás).
        const creditDays = terms?.creditDays ?? 0;
        const receivable: Receivable = {
          id: randomUUID(),
          organizationId,
          customerId,
          customerName,
          customerIdentification,
          sourceType: 'invoice',
          sourceId: payload.invoiceId,
          documentNumber: payload.number ?? null,
          issueDate,
          dueDate: addDays(issueDate, creditDays),
          currencyCode,
          originalCents: totalCents,
          status: 'open',
          version: 1,
          createdAt: now,
          updatedAt: now,
          appliedCents: 0,
        };
        await uow.receivables.save(receivable);
        await uow.outbox.add(receivableOpenedEvent(receivable));

        // Una nota de crédito puede haber llegado ANTES que su factura: el saldo a favor del cliente se aplica ahora.
        const applied = await this.applyPendingAdvances(uow, receivable, now);
        return { outcome: 'applied', receivableIds: [receivable.id], advanceIds: applied.advanceIds };
      },
      // READ COMMITTED: la suma de lo aplicado se lee DESPUÉS de esperar el bloqueo de la partida. Con REPEATABLE READ
      // saldría de una instantánea anterior a la espera y no vería lo que confirmó quien tenía el bloqueo.
      { readCommitted: true },
    );
  }

  /**
   * Nota de crédito: abona a la partida que origina. Si esa partida todavía no existe (o ya está cubierta), el
   * sobrante queda como SALDO A FAVOR del cliente (`customer_advances`) y se aplica a su próxima factura.
   */
  private async applyCreditNote(
    uow: UnitOfWork,
    ctx: {
      organizationId: string;
      invoiceId: string;
      documentNumber: string | null;
      issueDate: string;
      currencyCode: string;
      totalCents: number;
      relatedInvoiceId: string | null;
      customerId: string;
      customerName: string;
      customerIdentification: string | null;
      now: Date;
    },
  ): Promise<InvoiceIssuedOutcome> {
    let remaining = ctx.totalCents;
    const advanceIds: string[] = [];

    if (ctx.relatedInvoiceId) {
      const found = await uow.receivables.findBySource(ctx.organizationId, 'invoice', ctx.relatedInvoiceId);
      if (found) {
        const receivable = await uow.receivables.findById(ctx.organizationId, found.id, { lock: true });
        if (receivable) {
          // Una partida anulada tiene el débito revertido: el crédito la deja en contra, que es lo que dice el libro
          // mayor (la nota de crédito no se anula con la factura).
          const room =
            receivable.status === 'cancelled'
              ? remaining
              : Math.max(0, receivable.originalCents - receivable.appliedCents);
          const applied = Math.min(room, remaining);
          if (applied > 0) {
            try {
              await uow.creditApplications.add({
                id: randomUUID(),
                organizationId: ctx.organizationId,
                receivableId: receivable.id,
                sourceId: ctx.invoiceId,
                sourceType: 'credit_note',
                documentNumber: ctx.documentNumber,
                appliedCents: applied,
                appliedAt: ctx.issueDate,
                createdAt: ctx.now,
              });
            } catch (err) {
              // La misma nota de crédito ya abonó a esta partida (el evento se republicó con otro id): no se abona dos veces.
              // Es lo único que hizo la transacción hasta aquí, así que no queda nada a medias.
              if (isUniqueViolation(err)) return { outcome: 'duplicate' };
              throw err;
            }
            const updated: Receivable = {
              ...receivable,
              appliedCents: receivable.appliedCents + applied,
              status: deriveStatus(receivable.status, receivable.originalCents, receivable.appliedCents + applied),
              version: receivable.version + 1,
              updatedAt: ctx.now,
            };
            await uow.receivables.save(updated, receivable.version);
            await uow.outbox.add(
              receivableCreditedEvent({
                receivable: updated,
                sourceType: 'credit_note',
                sourceId: ctx.invoiceId,
                documentNumber: ctx.documentNumber,
                appliedCents: applied,
                advanceId: null,
              }),
            );
            remaining -= applied;
          }
        }
      }
    }

    if (remaining > 0) {
      const advance = await this.openAdvance(uow, {
        organizationId: ctx.organizationId,
        customerId: ctx.customerId,
        customerName: ctx.customerName,
        customerIdentification: ctx.customerIdentification,
        originId: ctx.invoiceId,
        relatedInvoiceId: ctx.relatedInvoiceId,
        documentNumber: ctx.documentNumber,
        currencyCode: ctx.currencyCode,
        amountCents: remaining,
        now: ctx.now,
      });
      if (advance) advanceIds.push(advance.id);
    }

    return { outcome: 'applied', receivableIds: [], advanceIds };
  }

  /**
   * Abre un saldo a favor del cliente. Devuelve `null` si ya existía (nota de crédito reintentada): el saldo a favor
   * no se duplica.
   */
  private async openAdvance(
    uow: UnitOfWork,
    ctx: {
      organizationId: string;
      customerId: string;
      customerName: string;
      customerIdentification: string | null;
      originId: string;
      relatedInvoiceId: string | null;
      documentNumber: string | null;
      currencyCode: string;
      amountCents: number;
      now: Date;
    },
  ): Promise<CustomerAdvance | null> {
    const existing = await uow.advances.findByOrigin(ctx.organizationId, 'credit_note', ctx.originId);
    if (existing) return null;
    const advance: CustomerAdvance = {
      id: randomUUID(),
      organizationId: ctx.organizationId,
      customerId: ctx.customerId,
      customerName: ctx.customerName,
      customerIdentification: ctx.customerIdentification,
      origin: 'credit_note',
      originId: ctx.originId,
      relatedInvoiceId: ctx.relatedInvoiceId,
      documentNumber: ctx.documentNumber,
      currencyCode: ctx.currencyCode,
      originalCents: ctx.amountCents,
      version: 1,
      createdAt: ctx.now,
      updatedAt: ctx.now,
      appliedCents: 0,
    };
    try {
      await uow.advances.save(advance);
    } catch (err) {
      if (isUniqueViolation(err)) return null;
      throw err;
    }
    await uow.outbox.add(customerAdvanceOpenedEvent(advance));
    return advance;
  }

  /**
   * Aplica los saldos a favor del cliente a una partida recién abierta (notas de crédito que llegaron antes que su
   * factura). Se recorre en orden de creación (el más antiguo primero) y cada saldo a favor se consume una sola vez.
   */
  private async applyPendingAdvances(
    uow: UnitOfWork,
    receivable: Receivable,
    now: Date,
  ): Promise<{ advanceIds: string[] }> {
    const advanceIds: string[] = [];
    // Solo el saldo a favor de una NOTA DE CRÉDITO se aplica solo: ya está en cuentas por cobrar (su asiento acreditó al cliente), así
    // que basta con anotar que cubre la nueva deuda. El de un COBRO vive en «anticipos de clientes» y se consume desde un cobro
    // (`PostReceiptUseCase`), que es lo que genera el asiento que lo mueve a cuentas por cobrar.
    const candidates = (
      await uow.advances.listApplicable(receivable.organizationId, receivable.customerId, receivable.sourceId)
    ).filter((a) => a.origin === 'credit_note');
    if (!candidates.length) return { advanceIds };

    let appliedCents = receivable.appliedCents;
    let room = receivable.originalCents - appliedCents;
    // Un evento por saldo a favor consumido: cada uno lleva SU importe aplicado. Si se emitiera uno solo con la suma,
    // la bitácora no podría decir cuánto entró de cada nota de crédito.
    const consumptions: { advanceId: string; sourceId: string; documentNumber: string | null; appliedCents: number }[] = [];

    for (const candidate of candidates) {
      if (room <= 0) break;
      const locked = await uow.advances.findById(receivable.organizationId, candidate.id, { lock: true });
      if (!locked) continue;
      const available = locked.originalCents - locked.appliedCents;
      if (available <= 0) continue;
      const applied = Math.min(available, room);
      if (applied <= 0) break;

      await uow.creditApplications.add({
        id: randomUUID(),
        organizationId: receivable.organizationId,
        receivableId: receivable.id,
        sourceId: locked.originId,
        sourceType: 'credit_note',
        documentNumber: locked.documentNumber,
        appliedCents: applied,
        appliedAt: receivable.issueDate,
        createdAt: now,
      });
      await uow.advanceApplications.add({
        id: randomUUID(),
        organizationId: receivable.organizationId,
        advanceId: locked.id,
        receivableId: receivable.id,
        appliedCents: applied,
        createdAt: now,
      });
      const updatedAdvance: CustomerAdvance = {
        ...locked,
        appliedCents: locked.appliedCents + applied,
        version: locked.version + 1,
        updatedAt: now,
      };
      await uow.advances.save(updatedAdvance, locked.version);
      advanceIds.push(locked.id);
      consumptions.push({
        advanceId: locked.id,
        sourceId: locked.originId,
        documentNumber: locked.documentNumber,
        appliedCents: applied,
      });
      appliedCents += applied;
      room -= applied;
    }

    if (appliedCents !== receivable.appliedCents) {
      const updated: Receivable = {
        ...receivable,
        appliedCents,
        status: deriveStatus(receivable.status, receivable.originalCents, appliedCents),
        version: receivable.version + 1,
        updatedAt: now,
      };
      await uow.receivables.save(updated, receivable.version);
      for (const consumption of consumptions) {
        await uow.outbox.add(
          receivableCreditedEvent({
            receivable: updated,
            sourceType: 'credit_note',
            sourceId: consumption.sourceId,
            documentNumber: consumption.documentNumber,
            appliedCents: consumption.appliedCents,
            advanceId: consumption.advanceId,
          }),
        );
      }
    }
    return { advanceIds };
  }
}

/**
 * Anulación de una factura: cierra la partida (`cancelled`).
 *
 * Contabilidad revierte el asiento de la factura (su débito a `receivables` desaparece), así que la partida se
 * cancela. Lo que se le había acreditado (una nota de crédito) NO se revierte con ella: por eso el saldo de una
 * partida anulada es el SALDO A FAVOR del cliente, no cero. Es lo que hace el libro mayor, y es lo que hace la
 * prueba de oro.
 *
 * Si la anulación llega antes que la emisión, se deja una partida anulada de importe cero: así la emisión posterior
 * no abre una deuda que ya no existe (los eventos no llegan en orden garantizado).
 */
export class HandleInvoiceVoidedUseCase {
  constructor(
    private readonly gateway: UnitOfWorkGateway,
    private readonly accounting: AccountingCatalogPort,
    private readonly clock: Clock,
  ) {}

  async execute(payload: InvoiceVoidedPayload): Promise<InvoiceVoidedOutcome> {
    const organizationId = payload.organizationId;
    if (!organizationId || !payload.invoiceId) {
      return { outcome: 'skipped', reason: 'evento sin organización o sin id de comprobante' };
    }
    const settings = await this.accounting.getSettings(organizationId);
    if (!settings) return { outcome: 'skipped', reason: 'la organización no tiene contabilidad' };

    const now = this.clock();
    const issueDate = payload.issueDate ? localDateOf(payload.issueDate, settings.timezone) : localDateOf(now, settings.timezone);

    return inTransaction(
      this.gateway,
      async (uow): Promise<InvoiceVoidedOutcome> => {
        const existing = await uow.receivables.findBySource(organizationId, 'invoice', payload.invoiceId);
        if (existing) {
          if (existing.status === 'cancelled') return { outcome: 'duplicate' };
          const receivable = await uow.receivables.findById(organizationId, existing.id, { lock: true });
          if (!receivable) return { outcome: 'skipped', reason: 'la partida ya no existe' };
          if (receivable.status === 'cancelled') return { outcome: 'duplicate' };
          const updated: Receivable = {
            ...receivable,
            status: 'cancelled',
            version: receivable.version + 1,
            updatedAt: now,
          };
          await uow.receivables.save(updated, receivable.version);
          await uow.outbox.add(receivableCancelledEvent(updated, payload.reason ?? null));
          return { outcome: 'cancelled', receivableId: updated.id };
        }

        // La anulación llegó antes que la emisión: se deja la partida anulada para que la emisión no abra nada.
        const ghost: Receivable = {
          id: randomUUID(),
          organizationId,
          customerId: '',
          customerName: '',
          customerIdentification: null,
          sourceType: 'invoice',
          sourceId: payload.invoiceId,
          documentNumber: payload.number ?? null,
          issueDate,
          dueDate: issueDate,
          currencyCode: settings.baseCurrency,
          originalCents: 0,
          status: 'cancelled',
          version: 1,
          createdAt: now,
          updatedAt: now,
          appliedCents: 0,
        };
        try {
          await uow.receivables.save(ghost);
        } catch (err) {
          if (isUniqueViolation(err)) return { outcome: 'duplicate' };
          throw err;
        }
        await uow.outbox.add(receivableCancelledEvent(ghost, payload.reason ?? null));
        return { outcome: 'cancelled', receivableId: ghost.id };
      },
      { readCommitted: true },
    );
  }
}
