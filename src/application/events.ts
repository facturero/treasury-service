import { randomUUID } from 'node:crypto';
import type { DomainEvent } from '../domain/repositories.js';
import type { CustomerAdvance, CustomerTerms, OpeningBalanceLoad, Receivable } from '../domain/receivable.js';
import type { Receipt } from '../domain/receipt.js';
import type { Payable, PayableOpeningLoad, SupplierAdvance } from '../domain/payable.js';
import type { Payment, PaymentSettings } from '../domain/payment.js';
import type { CustomerReminderPlan, ReminderSettings } from '../domain/reminder.js';
import type { BankAccount, BankMovement, BankReconciliation, BankStatement, BankStatementLine } from '../domain/bank.js';

/**
 * Construye un DomainEvent con el envelope de bitácora (eventId/type/occurredAt).
 *
 * Los tres segmentos del routing key son `treasury.<recurso>.<acción>` y la acción va en pasado: la bitácora se lee
 * como una lista de hechos («Cartera abierta», «Nota de crédito aplicada»), no como un registro de llamadas.
 */
export function domainEvent(params: {
  type: string;
  aggregateType: string;
  aggregateId: string;
  organizationId: string;
  payload: Record<string, unknown>;
}): DomainEvent {
  return {
    eventId: randomUUID(),
    aggregateType: params.aggregateType,
    aggregateId: params.aggregateId,
    type: params.type,
    // La bitácora exige organizationId en el payload de todo mensaje.
    payload: { ...params.payload, organizationId: params.organizationId },
    occurredAt: new Date(),
  };
}

/** Lo que lleva todo evento de una partida: qué es, de quién y cuánto. */
export function receivablePayload(r: Receivable): Record<string, unknown> {
  return {
    receivableId: r.id,
    sourceType: r.sourceType,
    sourceId: r.sourceId,
    invoiceNumber: r.documentNumber,
    customerId: r.customerId,
    customerName: r.customerName,
    amountCents: r.originalCents,
    currencyCode: r.currencyCode,
    issueDate: r.issueDate,
    dueDate: r.dueDate,
  };
}

/** Partida abierta: una factura (o nota de débito) que el cliente debe. */
export function receivableOpenedEvent(r: Receivable): DomainEvent {
  return domainEvent({
    type: 'treasury.receivable.opened',
    aggregateType: 'receivable',
    aggregateId: r.id,
    organizationId: r.organizationId,
    payload: receivablePayload(r),
  });
}

/**
 * Partida anulada: la factura se anuló y contabilidad revirtió su asiento.
 *
 * Lleva el motivo porque es la información que hace falta para entender por qué una deuda desapareció.
 */
export function receivableCancelledEvent(r: Receivable, reason: string | null): DomainEvent {
  return domainEvent({
    type: 'treasury.receivable.cancelled',
    aggregateType: 'receivable',
    aggregateId: r.id,
    organizationId: r.organizationId,
    payload: { ...receivablePayload(r), reason },
  });
}

/**
 * Una nota de crédito (o un cobro) redujo la deuda de una partida.
 *
 * `advanceId` viene cuando el saldo a favor se consumió: entonces la partida y el anticipo cambian a la vez y la
 * bitácora tiene que poder reconstruir las dos caras del movimiento.
 */
export function receivableCreditedEvent(params: {
  receivable: Receivable;
  sourceType: 'credit_note' | 'receipt';
  sourceId: string;
  documentNumber: string | null;
  appliedCents: number;
  advanceId: string | null;
}): DomainEvent {
  const r = params.receivable;
  return domainEvent({
    type: 'treasury.receivable.credited',
    aggregateType: 'receivable',
    aggregateId: r.id,
    organizationId: r.organizationId,
    payload: {
      ...receivablePayload(r),
      creditType: params.sourceType,
      creditSourceId: params.sourceId,
      creditDocumentNumber: params.documentNumber,
      appliedCents: params.appliedCents,
      advanceId: params.advanceId,
    },
  });
}

/** Saldo a favor del cliente (una nota de crédito sin factura a la que aplicarla). */
export function customerAdvanceOpenedEvent(a: CustomerAdvance): DomainEvent {
  return domainEvent({
    type: 'treasury.customer_advance.opened',
    aggregateType: 'customer_advance',
    aggregateId: a.id,
    organizationId: a.organizationId,
    payload: {
      advanceId: a.id,
      customerId: a.customerId,
      customerName: a.customerName,
      origin: a.origin,
      originId: a.originId,
      documentNumber: a.documentNumber,
      amountCents: a.originalCents,
      currencyCode: a.currencyCode,
      relatedInvoiceId: a.relatedInvoiceId,
    },
  });
}

/**
 * Condiciones de crédito del cliente cambiadas.
 *
 * Lleva el valor ANTIGUO y el NUEVO: sin los dos, la bitácora no dice qué se cambió.
 */
export function customerTermsUpdatedEvent(
  terms: CustomerTerms,
  previous: { creditDays: number; creditLimitCents: number | null },
): DomainEvent {
  return domainEvent({
    type: 'treasury.customer_terms.updated',
    aggregateType: 'customer_terms',
    aggregateId: terms.customerId,
    organizationId: terms.organizationId,
    payload: {
      customerId: terms.customerId,
      customerName: terms.customerName,
      previousCreditDays: previous.creditDays,
      creditDays: terms.creditDays,
      previousCreditLimitCents: previous.creditLimitCents,
      creditLimitCents: terms.creditLimitCents,
      updatedBy: terms.updatedBy,
    },
  });
}

/** Carga de saldos iniciales de cartera: qué se cargó, cuánto y por qué. */
export function openingBalanceLoadedEvent(load: OpeningBalanceLoad, customerCount: number): DomainEvent {
  return domainEvent({
    type: 'treasury.opening_balance.loaded',
    aggregateType: 'opening_balance_load',
    aggregateId: load.id,
    organizationId: load.organizationId,
    payload: {
      loadId: load.id,
      cutoffDate: load.cutoffDate,
      customerCount,
      totalCents: load.totalCents,
      loadedBy: load.loadedBy,
      reason: load.reason,
    },
  });
}

// ── Cobros (bloque B) ────────────────────────────────────────────────────────

/** Máximo de líneas que viajan en el payload (la bitácora trunca a 8 KB; el total real va en `lineCount`). */
const MAX_PAYLOAD_LINES = 20;

/** Lo que lleva todo evento de un recibo: quién paga, cuánto entró, cuánto se aplicó y a dónde. */
export function receiptPayload(r: Receipt, invoiceNumbers: Map<string, string | null> = new Map()): Record<string, unknown> {
  return {
    receiptId: r.id,
    number: r.number,
    status: r.status,
    customerId: r.customerId,
    customerName: r.customerName,
    receiptDate: r.receiptDate,
    method: r.method,
    accountRole: r.accountRole,
    bankAccountId: r.bankAccountId,
    reference: r.reference,
    currencyCode: r.currencyCode,
    totalCents: r.totalCents,
    advanceUsedCents: r.advanceUsedCents,
    appliedCents: r.appliedCents,
    advanceCents: r.advanceCents,
    lineCount: r.lines.length,
    lines: r.lines.slice(0, MAX_PAYLOAD_LINES).map((l) => ({
      receivableId: l.receivableId,
      invoiceNumber: invoiceNumbers.get(l.receivableId) ?? null,
      appliedCents: l.appliedCents,
    })),
    advanceUses: r.advanceUses.slice(0, MAX_PAYLOAD_LINES),
  };
}

export function receiptCreatedEvent(r: Receipt): DomainEvent {
  return domainEvent({ type: 'treasury.receipt.created', aggregateType: 'receipt', aggregateId: r.id, organizationId: r.organizationId, payload: receiptPayload(r) });
}

export function receiptUpdatedEvent(r: Receipt): DomainEvent {
  return domainEvent({ type: 'treasury.receipt.updated', aggregateType: 'receipt', aggregateId: r.id, organizationId: r.organizationId, payload: receiptPayload(r) });
}

/**
 * Cobro contabilizado. Es el evento que lee contabilidad para asentar (Dr caja/banco y anticipos usados, Cr clientes y anticipo
 * nuevo), así que lleva TODO lo que la regla necesita y la fecha del cobro como fecha de calendario (`AAAA-MM-DD`, sin hora).
 */
export function receiptPostedEvent(r: Receipt, invoiceNumbers: Map<string, string | null>, postedBy: string): DomainEvent {
  return domainEvent({
    type: 'treasury.receipt.posted',
    aggregateType: 'receipt',
    aggregateId: r.id,
    organizationId: r.organizationId,
    payload: { ...receiptPayload(r, invoiceNumbers), postedBy },
  });
}

/** Cobro anulado: lleva el MOTIVO y quién lo contabilizó, que es lo que la bitácora tiene que poder contar. */
export function receiptVoidedEvent(r: Receipt, invoiceNumbers: Map<string, string | null>): DomainEvent {
  return domainEvent({
    type: 'treasury.receipt.voided',
    aggregateType: 'receipt',
    aggregateId: r.id,
    organizationId: r.organizationId,
    payload: { ...receiptPayload(r, invoiceNumbers), reason: r.voidReason, postedBy: r.postedBy, voidedBy: r.voidedBy, voidedAt: r.voidedAt ? r.voidedAt.toISOString() : null },
  });
}

/**
 * Recordatorio de cobro a UN cliente: todas sus partidas vencidas que tocan hoy, en un solo mensaje.
 *
 * Lo consume `notification-service` (correo al cliente) y lo registra la bitácora. Lleva el correo y el nombre de quien cobra porque
 * notificaciones no consulta a nadie: manda lo que el evento trae. `trigger`/`triggeredBy` dicen si salió del proceso diario o de
 * «enviar ahora» (y quién).
 */
export function receivableOverdueEvent(params: {
  organizationId: string;
  organizationName: string;
  plan: CustomerReminderPlan;
  email: string;
  runDate: string;
  trigger: 'scheduled' | 'manual';
  triggeredBy: string | null;
}): DomainEvent {
  const { plan } = params;
  return domainEvent({
    type: 'treasury.receivable.overdue',
    aggregateType: 'customer',
    aggregateId: plan.customerId,
    organizationId: params.organizationId,
    payload: {
      organizationName: params.organizationName,
      customerId: plan.customerId,
      customerName: plan.customerName,
      email: params.email,
      currencyCode: plan.currencyCode,
      runDate: params.runDate,
      totalOverdueCents: plan.totalCents,
      receivableCount: plan.receivableIds.length,
      extraItems: plan.extraItems,
      items: plan.items.map((i) => ({
        receivableId: i.receivableId,
        documentNumber: i.documentNumber,
        dueDate: i.dueDate,
        daysOverdue: i.daysOverdue,
        balanceCents: i.balanceCents,
      })),
      trigger: params.trigger,
      triggeredBy: params.triggeredBy,
    },
  });
}

/** La organización cambió cómo se avisa a sus clientes: el valor anterior y el nuevo (sin los dos la bitácora no dice qué cambió). */
export function reminderSettingsUpdatedEvent(next: ReminderSettings, previous: Pick<ReminderSettings, 'enabled' | 'firstAfterDays' | 'repeatEveryDays'>): DomainEvent {
  return domainEvent({
    type: 'treasury.reminder_settings.updated',
    aggregateType: 'reminder_settings',
    aggregateId: next.organizationId,
    organizationId: next.organizationId,
    payload: {
      enabled: next.enabled,
      firstAfterDays: next.firstAfterDays,
      repeatEveryDays: next.repeatEveryDays,
      previousEnabled: previous.enabled,
      previousFirstAfterDays: previous.firstAfterDays,
      previousRepeatEveryDays: previous.repeatEveryDays,
      updatedBy: next.updatedBy,
    },
  });
}

/**
 * Un reporte salió del sistema como archivo. Las lecturas no emiten evento, pero exportar sí: es dato sensible (la cartera de
 * clientes con sus saldos) que sale del sistema.
 */
export function reportExportedEvent(params: {
  organizationId: string;
  report: 'receivables' | 'aging' | 'statement' | 'payables' | 'payables_aging' | 'supplier_statement' | 'cash_flow';
  filters: Record<string, unknown>;
  rowCount: number;
  exportedBy: string;
  customerId?: string;
  supplierId?: string;
}): DomainEvent {
  return domainEvent({
    type: 'treasury.report.exported',
    aggregateType: 'report',
    aggregateId: params.customerId ?? params.supplierId ?? params.report,
    organizationId: params.organizationId,
    payload: {
      report: params.report,
      format: 'csv',
      filters: params.filters,
      rowCount: params.rowCount,
      exportedBy: params.exportedBy,
      ...(params.customerId ? { customerId: params.customerId } : {}),
      ...(params.supplierId ? { supplierId: params.supplierId } : {}),
    },
  });
}

// ── Cuentas por pagar y pagos (bloque D) ─────────────────────────────────────

/** Lo que lleva todo evento de una deuda: qué es, de quién y cuánto. */
export function payablePayload(p: Payable): Record<string, unknown> {
  return {
    payableId: p.id,
    sourceType: p.sourceType,
    sourceId: p.sourceId,
    documentNumber: p.documentNumber,
    internalNumber: p.internalNumber,
    supplierId: p.supplierId,
    supplierName: p.supplierName,
    supplierIdentification: p.supplierIdentification,
    amountCents: p.originalCents,
    currencyCode: p.currencyCode,
    issueDate: p.issueDate,
    dueDate: p.dueDate,
  };
}

/** Deuda abierta: una factura de compra contabilizada (o un saldo inicial) que la empresa debe. */
export function payableOpenedEvent(p: Payable): DomainEvent {
  return domainEvent({ type: 'treasury.payable.opened', aggregateType: 'payable', aggregateId: p.id, organizationId: p.organizationId, payload: payablePayload(p) });
}

/** Deuda anulada: la factura de compra se anuló. Lleva el motivo, que es lo que explica por qué la deuda desapareció. */
export function payableCancelledEvent(p: Payable, reason: string | null): DomainEvent {
  return domainEvent({ type: 'treasury.payable.cancelled', aggregateType: 'payable', aggregateId: p.id, organizationId: p.organizationId, payload: { ...payablePayload(p), reason } });
}

/** Un pago o una retención redujo la deuda. Un evento por cada importe aplicado, con SU importe. */
export function payableCreditedEvent(params: {
  payable: Payable;
  sourceType: 'payment' | 'withholding';
  sourceId: string;
  documentNumber: string | null;
  appliedCents: number;
}): DomainEvent {
  const p = params.payable;
  return domainEvent({
    type: 'treasury.payable.credited',
    aggregateType: 'payable',
    aggregateId: p.id,
    organizationId: p.organizationId,
    payload: {
      ...payablePayload(p),
      creditType: params.sourceType,
      creditSourceId: params.sourceId,
      creditDocumentNumber: params.documentNumber,
      appliedCents: params.appliedCents,
    },
  });
}

/** Anticipo a un proveedor: lo pagado de más, que un pago posterior puede consumir. */
export function supplierAdvanceOpenedEvent(a: SupplierAdvance): DomainEvent {
  return domainEvent({
    type: 'treasury.supplier_advance.opened',
    aggregateType: 'supplier_advance',
    aggregateId: a.id,
    organizationId: a.organizationId,
    payload: {
      advanceId: a.id,
      supplierId: a.supplierId,
      supplierName: a.supplierName,
      supplierIdentification: a.supplierIdentification,
      originId: a.originId,
      documentNumber: a.documentNumber,
      amountCents: a.originalCents,
      currencyCode: a.currencyCode,
    },
  });
}

/** Carga de saldos iniciales de deudas a proveedores: qué se cargó, cuánto y por qué. */
export function payableOpeningLoadedEvent(load: PayableOpeningLoad, supplierCount: number): DomainEvent {
  return domainEvent({
    type: 'treasury.payable_opening_balance.loaded',
    aggregateType: 'payable_opening_load',
    aggregateId: load.id,
    organizationId: load.organizationId,
    payload: { loadId: load.id, cutoffDate: load.cutoffDate, supplierCount, totalCents: load.totalCents, loadedBy: load.loadedBy, reason: load.reason },
  });
}

/** Lo que lleva todo evento de un pago: a quién se paga, cuánto salió, cuánto se aplicó y a qué facturas. */
export function paymentPayload(p: Payment, documentNumbers: Map<string, string | null> = new Map()): Record<string, unknown> {
  return {
    paymentId: p.id,
    number: p.number,
    status: p.status,
    supplierId: p.supplierId,
    supplierName: p.supplierName,
    supplierIdentification: p.supplierIdentification,
    paymentDate: p.paymentDate,
    method: p.method,
    accountRole: p.accountRole,
    bankAccountId: p.bankAccountId,
    reference: p.reference,
    currencyCode: p.currencyCode,
    totalCents: p.totalCents,
    advanceUsedCents: p.advanceUsedCents,
    appliedCents: p.appliedCents,
    advanceCents: p.advanceCents,
    lineCount: p.lines.length,
    lines: p.lines.slice(0, MAX_PAYLOAD_LINES).map((l) => ({ payableId: l.payableId, documentNumber: documentNumbers.get(l.payableId) ?? null, appliedCents: l.appliedCents })),
    advanceUses: p.advanceUses.slice(0, MAX_PAYLOAD_LINES),
  };
}

export function paymentCreatedEvent(p: Payment): DomainEvent {
  return domainEvent({ type: 'treasury.payment.created', aggregateType: 'payment', aggregateId: p.id, organizationId: p.organizationId, payload: paymentPayload(p) });
}

export function paymentUpdatedEvent(p: Payment): DomainEvent {
  return domainEvent({ type: 'treasury.payment.updated', aggregateType: 'payment', aggregateId: p.id, organizationId: p.organizationId, payload: paymentPayload(p) });
}

/** Pago aprobado por otra persona (separación de funciones): lleva quién lo creó y quién lo aprobó. */
export function paymentApprovedEvent(p: Payment): DomainEvent {
  return domainEvent({
    type: 'treasury.payment.approved',
    aggregateType: 'payment',
    aggregateId: p.id,
    organizationId: p.organizationId,
    payload: { ...paymentPayload(p), createdBy: p.createdBy, approvedBy: p.approvedBy },
  });
}

/**
 * Pago contabilizado. Es el evento que lee contabilidad para asentar (Dr proveedores y anticipo a proveedores, Cr caja/banco y anticipo
 * consumido), así que lleva TODO lo que la regla necesita y la fecha del pago como fecha de calendario (`AAAA-MM-DD`, sin hora).
 */
export function paymentPostedEvent(p: Payment, documentNumbers: Map<string, string | null>, postedBy: string): DomainEvent {
  return domainEvent({
    type: 'treasury.payment.posted',
    aggregateType: 'payment',
    aggregateId: p.id,
    organizationId: p.organizationId,
    payload: { ...paymentPayload(p, documentNumbers), createdBy: p.createdBy, approvedBy: p.approvedBy, postedBy },
  });
}

/** Pago anulado: lleva el MOTIVO y quién lo contabilizó. */
export function paymentVoidedEvent(p: Payment, documentNumbers: Map<string, string | null>): DomainEvent {
  return domainEvent({
    type: 'treasury.payment.voided',
    aggregateType: 'payment',
    aggregateId: p.id,
    organizationId: p.organizationId,
    payload: { ...paymentPayload(p, documentNumbers), reason: p.voidReason, postedBy: p.postedBy, voidedBy: p.voidedBy, voidedAt: p.voidedAt ? p.voidedAt.toISOString() : null },
  });
}

/** El umbral de aprobación de pagos cambió: valor anterior y nuevo (sin los dos la bitácora no dice qué cambió). */
export function paymentSettingsUpdatedEvent(next: PaymentSettings, previous: Pick<PaymentSettings, 'approvalThresholdCents'>): DomainEvent {
  return domainEvent({
    type: 'treasury.payment_settings.updated',
    aggregateType: 'payment_settings',
    aggregateId: next.organizationId,
    organizationId: next.organizationId,
    payload: { approvalThresholdCents: next.approvalThresholdCents, previousApprovalThresholdCents: previous.approvalThresholdCents, updatedBy: next.updatedBy },
  });
}

// ── Bancos, extractos y conciliación (bloque E) ──────────────────────────────

/** Qué de una cuenta bancaria viaja a la bitácora: nunca el perfil de importación completo (no aporta) ni más que los últimos 4 dígitos. */
export function bankAccountPayload(a: BankAccount): Record<string, unknown> {
  return {
    bankAccountId: a.id,
    name: a.name,
    bankName: a.bankName,
    accountType: a.accountType,
    accountLast4: a.accountLast4,
    currencyCode: a.currencyCode,
    openingBalanceCents: a.openingBalanceCents,
    openingDate: a.openingDate,
    isActive: a.isActive,
    hasImportProfile: a.importProfile !== null,
  };
}

export function bankAccountCreatedEvent(a: BankAccount, userId: string): DomainEvent {
  return domainEvent({ type: 'treasury.bank_account.created', aggregateType: 'bank_account', aggregateId: a.id, organizationId: a.organizationId, payload: { ...bankAccountPayload(a), createdBy: userId } });
}

/** `changes` dice qué campos cambiaron (con el valor anterior): sin eso la bitácora no explica un saldo de apertura que se movió. */
export function bankAccountUpdatedEvent(a: BankAccount, changes: Record<string, { from: unknown; to: unknown }>, userId: string): DomainEvent {
  return domainEvent({ type: 'treasury.bank_account.updated', aggregateType: 'bank_account', aggregateId: a.id, organizationId: a.organizationId, payload: { ...bankAccountPayload(a), changes, updatedBy: userId } });
}

export function bankStatementImportedEvent(s: BankStatement, params: { bankAccountName: string; skippedDuplicates: number; skippedBeforeOpening: number; importedLines: number }): DomainEvent {
  return domainEvent({
    type: 'treasury.bank_statement.imported',
    aggregateType: 'bank_statement',
    aggregateId: s.id,
    organizationId: s.organizationId,
    payload: {
      statementId: s.id,
      bankAccountId: s.bankAccountId,
      bankAccountName: params.bankAccountName,
      fileName: s.fileName,
      periodStart: s.periodStart,
      periodEnd: s.periodEnd,
      lineCount: params.importedLines,
      skippedDuplicates: params.skippedDuplicates,
      skippedBeforeOpening: params.skippedBeforeOpening,
      closingBalanceCents: s.closingBalanceCents,
      importedBy: s.importedBy,
    },
  });
}

/** Un movimiento sin cuenta (cobro o pago anterior a este módulo) se asignó a una cuenta bancaria. */
export function bankMovementAssignedEvent(m: BankMovement, previousBankAccountId: string | null, userId: string): DomainEvent {
  return domainEvent({
    type: 'treasury.bank_movement.assigned',
    aggregateType: 'bank_movement',
    aggregateId: m.id,
    organizationId: m.organizationId,
    payload: { movementId: m.id, sourceType: m.sourceType, sourceId: m.sourceId, bankAccountId: m.bankAccountId, previousBankAccountId, amountCents: m.amountCents, movementDate: m.movementDate, assignedBy: userId },
  });
}

/** El movimiento se revirtió porque se anuló el cobro, pago o ajuste que lo originó; `unmatched` dice si deshizo un emparejamiento. */
export function bankMovementReversedEvent(m: BankMovement, unmatched: boolean): DomainEvent {
  return domainEvent({
    type: 'treasury.bank_movement.reversed',
    aggregateType: 'bank_movement',
    aggregateId: m.id,
    organizationId: m.organizationId,
    payload: { movementId: m.id, sourceType: m.sourceType, sourceId: m.sourceId, bankAccountId: m.bankAccountId, amountCents: m.amountCents, movementDate: m.movementDate, unmatched },
  });
}

/** Lo que lee contabilidad para asentar un ajuste bancario: el signo lo da `direction`, el importe es siempre positivo. */
export function bankAdjustmentPayload(m: BankMovement, bankAccount: { name: string; currencyCode: string }): Record<string, unknown> {
  return {
    adjustmentId: m.id,
    bankAccountId: m.bankAccountId,
    bankAccountName: bankAccount.name,
    kind: m.kind,
    direction: m.amountCents >= 0 ? 'in' : 'out',
    amountCents: Math.abs(m.amountCents),
    currencyCode: bankAccount.currencyCode,
    adjustmentDate: m.movementDate,
    description: m.description,
    reference: m.reference,
    createdBy: m.createdBy,
  };
}

export function bankAdjustmentPostedEvent(m: BankMovement, bankAccount: { name: string; currencyCode: string }): DomainEvent {
  return domainEvent({ type: 'treasury.bank_adjustment.posted', aggregateType: 'bank_adjustment', aggregateId: m.id, organizationId: m.organizationId, payload: bankAdjustmentPayload(m, bankAccount) });
}

export function bankAdjustmentVoidedEvent(m: BankMovement, bankAccount: { name: string; currencyCode: string }, reason: string, voidedBy: string): DomainEvent {
  return domainEvent({
    type: 'treasury.bank_adjustment.voided',
    aggregateType: 'bank_adjustment',
    aggregateId: m.id,
    organizationId: m.organizationId,
    payload: { ...bankAdjustmentPayload(m, bankAccount), reason, voidedBy },
  });
}

/** Un renglón del extracto se emparejó con uno o varios movimientos. */
export function bankLineMatchedEvent(line: BankStatementLine, movements: { id: string; sourceType: string; sourceId: string; amountCents: number }[], method: 'manual' | 'suggested', userId: string): DomainEvent {
  return domainEvent({
    type: 'treasury.bank_line.matched',
    aggregateType: 'bank_line',
    aggregateId: line.id,
    organizationId: line.organizationId,
    payload: { lineId: line.id, bankAccountId: line.bankAccountId, lineDate: line.lineDate, amountCents: line.amountCents, method, movements, matchedBy: userId },
  });
}

export function bankLineUnmatchedEvent(line: BankStatementLine, movementIds: string[], userId: string): DomainEvent {
  return domainEvent({
    type: 'treasury.bank_line.unmatched',
    aggregateType: 'bank_line',
    aggregateId: line.id,
    organizationId: line.organizationId,
    payload: { lineId: line.id, bankAccountId: line.bankAccountId, lineDate: line.lineDate, amountCents: line.amountCents, movementIds, unmatchedBy: userId },
  });
}

/** El renglón se marcó «ya contabilizado fuera de tesorería»: es una afirmación de la persona, por eso lleva el motivo. */
export function bankLineMarkedExternalEvent(line: BankStatementLine, userId: string): DomainEvent {
  return domainEvent({
    type: 'treasury.bank_line.marked_external',
    aggregateType: 'bank_line',
    aggregateId: line.id,
    organizationId: line.organizationId,
    payload: { lineId: line.id, bankAccountId: line.bankAccountId, lineDate: line.lineDate, amountCents: line.amountCents, reason: line.externalReason, markedBy: userId },
  });
}

export function bankLineUnmarkedExternalEvent(line: BankStatementLine, userId: string): DomainEvent {
  return domainEvent({
    type: 'treasury.bank_line.unmarked_external',
    aggregateType: 'bank_line',
    aggregateId: line.id,
    organizationId: line.organizationId,
    payload: { lineId: line.id, bankAccountId: line.bankAccountId, lineDate: line.lineDate, amountCents: line.amountCents, unmarkedBy: userId },
  });
}

function reconciliationPayload(r: BankReconciliation): Record<string, unknown> {
  return {
    reconciliationId: r.id,
    bankAccountId: r.bankAccountId,
    cutoffDate: r.cutoffDate,
    statementBalanceCents: r.statementBalanceCents,
    registerBalanceCents: r.registerBalanceCents,
    pendingCents: r.pendingCents,
    differenceCents: r.differenceCents,
  };
}

export function bankReconciliationClosedEvent(r: BankReconciliation, bankAccountName: string): DomainEvent {
  return domainEvent({
    type: 'treasury.bank_reconciliation.closed',
    aggregateType: 'bank_reconciliation',
    aggregateId: r.id,
    organizationId: r.organizationId,
    payload: { ...reconciliationPayload(r), bankAccountName, closedBy: r.closedBy },
  });
}

export function bankReconciliationReopenedEvent(r: BankReconciliation, bankAccountName: string, reason: string, userId: string): DomainEvent {
  return domainEvent({
    type: 'treasury.bank_reconciliation.reopened',
    aggregateType: 'bank_reconciliation',
    aggregateId: r.id,
    organizationId: r.organizationId,
    payload: { ...reconciliationPayload(r), bankAccountName, reason, reopenedBy: userId },
  });
}
