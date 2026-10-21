import { advanceBalanceOf, balanceOf } from '../../domain/receivable.js';
import type { ReminderSettings } from '../../domain/reminder.js';
import type { ReminderPreview, ReminderRunResult } from '../../application/use-cases/reminder-use-cases.js';
import type {
  CreditApplication,
  CustomerAdvance,
  CustomerTerms,
  OpeningBalanceLoad,
  Receivable,
} from '../../domain/receivable.js';
import type { AgingReport, CustomerStatement } from '../../application/use-cases/list-use-cases.js';
import type { Receipt } from '../../domain/receipt.js';

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/**
 * Una partida de cartera.
 *
 * Los tres importes que se exponen son el original, lo aplicado y el SALDO. El saldo no se guarda: se deriva aquí
 * con la misma regla del dominio, de modo que la API nunca puede devolver un saldo que no cuadre con las
 * aplicaciones que la respalden.
 */
export const toReceivableJSON = (r: Receivable) => ({
  id: r.id,
  customerId: r.customerId,
  customerName: r.customerName,
  customerIdentification: r.customerIdentification,
  sourceType: r.sourceType,
  sourceId: r.sourceId,
  documentNumber: r.documentNumber,
  issueDate: r.issueDate,
  dueDate: r.dueDate,
  currencyCode: r.currencyCode,
  originalCents: r.originalCents,
  appliedCents: r.appliedCents,
  balanceCents: balanceOf(r),
  status: r.status,
  version: r.version,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
});

export const toCreditApplicationJSON = (a: CreditApplication) => ({
  id: a.id,
  receivableId: a.receivableId,
  sourceType: a.sourceType,
  sourceId: a.sourceId,
  documentNumber: a.documentNumber,
  appliedCents: a.appliedCents,
  appliedAt: a.appliedAt,
  createdAt: a.createdAt.toISOString(),
  /** Un cobro anulado deja su aplicación en la historia con la fecha de anulación; no cuenta en el saldo. */
  reversedAt: a.reversedAt ? a.reversedAt.toISOString() : null,
});

export const toCustomerAdvanceJSON = (a: CustomerAdvance) => ({
  id: a.id,
  customerId: a.customerId,
  customerName: a.customerName,
  customerIdentification: a.customerIdentification,
  origin: a.origin,
  originId: a.originId,
  relatedInvoiceId: a.relatedInvoiceId,
  documentNumber: a.documentNumber,
  currencyCode: a.currencyCode,
  originalCents: a.originalCents,
  appliedCents: a.appliedCents,
  balanceCents: advanceBalanceOf(a),
  version: a.version,
  createdAt: a.createdAt.toISOString(),
  updatedAt: a.updatedAt.toISOString(),
});

export const toCustomerTermsJSON = (t: CustomerTerms | null) =>
  t
    ? {
        customerId: t.customerId,
        customerName: t.customerName,
        creditDays: t.creditDays,
        creditLimitCents: t.creditLimitCents,
        updatedBy: t.updatedBy,
        updatedAt: t.updatedAt.toISOString(),
      }
    : null;

export const toOpeningBalanceLoadJSON = (l: OpeningBalanceLoad) => ({
  id: l.id,
  cutoffDate: l.cutoffDate,
  totalCents: l.totalCents,
  loadedBy: l.loadedBy,
  reason: l.reason,
  createdAt: l.createdAt.toISOString(),
});

/**
 * Estado de cuenta del cliente.
 *
 * `netCents` es el número que tiene que cuadrar con el saldo de cuentas por cobrar del libro mayor: la deuda de las
 * partidas menos el saldo a favor que todavía no se aplicó.
 */
export const toStatementJSON = (s: CustomerStatement) => ({
  customerId: s.customerId,
  asOf: s.asOf,
  receivableCents: s.receivableCents,
  advanceCents: s.advanceCents,
  customerAdvanceCents: s.customerAdvanceCents,
  netCents: s.netCents,
  receivables: s.receivables.map(toReceivableJSON),
  applications: s.applications.map(toCreditApplicationJSON),
  advances: s.advances.map(toCustomerAdvanceJSON),
});

export const toAgingJSON = (r: AgingReport) => ({
  asOf: r.asOf,
  totals: r.totals,
  customers: r.customers,
});

/**
 * Detalle de una partida con su historial de aplicaciones: lo que se ve al abrir una partida en la pantalla.
 *
 * Una nota de crédito que llegó como saldo a favor y se aplicó después también aparece aquí: al aplicarse se escribe
 * su `credit_application`, así que la lista de aplicaciones cuenta toda la historia de la partida.
 */
export const toReceivableDetailJSON = (r: Receivable, applications: CreditApplication[]) => ({
  ...toReceivableJSON(r),
  applications: applications.map(toCreditApplicationJSON),
});

export { iso };

/** Un cobro. `lineCount` es el número de deudas a las que se aplicó (el listado lo muestra, por eso se calcula aquí). */
export const toReceiptJSON = (r: Receipt) => ({
  id: r.id,
  number: r.number,
  status: r.status,
  customerId: r.customerId,
  customerName: r.customerName,
  customerIdentification: r.customerIdentification,
  receiptDate: r.receiptDate,
  method: r.method,
  accountRole: r.accountRole,
  reference: r.reference,
  currencyCode: r.currencyCode,
  totalCents: r.totalCents,
  advanceUsedCents: r.advanceUsedCents,
  appliedCents: r.appliedCents,
  advanceCents: r.advanceCents,
  lineCount: r.lines.length,
  lines: r.lines,
  advanceUses: r.advanceUses,
  notes: r.notes,
  voidReason: r.voidReason,
  createdBy: r.createdBy,
  postedBy: r.postedBy,
  voidedBy: r.voidedBy,
  postedAt: iso(r.postedAt),
  voidedAt: iso(r.voidedAt),
  version: r.version,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
});

export const toReminderSettingsJSON = (s: ReminderSettings) => ({
  enabled: s.enabled,
  firstAfterDays: s.firstAfterDays,
  repeatEveryDays: s.repeatEveryDays,
  lastRunOn: s.lastRunOn,
  updatedBy: s.updatedBy,
  updatedAt: s.updatedAt ? s.updatedAt.toISOString() : null,
});

export const toReminderPreviewJSON = (p: ReminderPreview) => ({
  asOf: p.asOf,
  enabled: p.enabled,
  receivableCount: p.receivableCount,
  withoutEmailCount: p.withoutEmailCount,
  customers: p.customers.map((c) => ({
    customerId: c.plan.customerId,
    customerName: c.plan.customerName,
    currencyCode: c.plan.currencyCode,
    // El correo completo no viaja: la pantalla solo necesita saber si TIENE uno (y cuál, parcialmente, para reconocerlo).
    hasEmail: c.email !== null,
    emailHint: c.email ? maskEmail(c.email) : null,
    totalCents: c.plan.totalCents,
    receivableCount: c.plan.receivableIds.length,
    items: c.plan.items,
    extraItems: c.plan.extraItems,
  })),
});

/** `maria.lopez@empresa.com` → `ma***@empresa.com`: se reconoce, pero la lista no es un volcado de correos. */
export function maskEmail(email: string): string {
  const [user = '', domain = ''] = email.split('@');
  return `${user.slice(0, 2)}***@${domain}`;
}

export const toReminderRunJSON = (r: ReminderRunResult) => ({ ...r });
