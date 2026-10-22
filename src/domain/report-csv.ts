import { daysBetween } from './dates.js';
import { payableBalanceOf, type Payable } from './payable.js';
import { balanceOf, type Receivable } from './receivable.js';

export type ReportLang = 'es' | 'en' | 'fr';
export const REPORT_LANGS: readonly ReportLang[] = ['es', 'en', 'fr'];

/** Un importe: siempre con dos decimales, aunque sea entero (`12.00`, no `12`), para que la columna se lea igual en cualquier fila. */
export class Amount {
  constructor(readonly cents: number) {}
}

type Cell = string | number | Amount | null;

/**
 * Una celda de CSV. Los textos que empiezan por `= + - @` (o tabulación/retorno) se vuelven FÓRMULAS al abrir el archivo en Excel o
 * Sheets: el nombre de un cliente lo escribe cualquiera, así que se les antepone un apóstrofo (la guía de OWASP contra la inyección de
 * fórmulas). Los números no se tocan: un saldo negativo es un número, no una fórmula.
 */
export function csvCell(value: Cell): string {
  if (value === null) return '';
  if (value instanceof Amount) return (Math.round(value.cents) / 100).toFixed(2);
  if (typeof value === 'number') return String(value);
  const guarded = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n;]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

/** Filas → texto CSV (coma, CRLF). El BOM lo pone quien lo sirve: es cosa del archivo, no de las filas. */
export function toCsv(rows: readonly (readonly Cell[])[]): string {
  return rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

/** Centavos → importe con dos decimales y punto (formato de máquina: la hoja de cálculo lo interpreta como número en cualquier idioma). */
export const money = (cents: number): Amount => new Amount(cents);

interface Labels {
  receivables: { document: string; customer: string; identification: string; issued: string; due: string; daysOverdue: string; original: string; applied: string; balance: string; status: string; currency: string };
  aging: { customer: string; current: string; d1: string; d2: string; d3: string; d4: string; total: string; totals: string };
  statement: { title: string; customer: string; asOf: string; owed: string; credit: string; advances: string; net: string; totalRow: string };
  status: Record<string, string>;
}

const LABELS: Record<ReportLang, Labels> = {
  es: {
    receivables: { document: 'Documento', customer: 'Cliente', identification: 'Identificación', issued: 'Emisión', due: 'Vencimiento', daysOverdue: 'Días de atraso', original: 'Importe original', applied: 'Aplicado', balance: 'Saldo', status: 'Estado', currency: 'Moneda' },
    aging: { customer: 'Cliente', current: 'Corriente', d1: '1 a 30 días', d2: '31 a 60 días', d3: '61 a 90 días', d4: 'Más de 90 días', total: 'Total', totals: 'TOTAL' },
    statement: { title: 'Estado de cuenta', customer: 'Cliente', asOf: 'Corte', owed: 'Debe', credit: 'Saldo a favor (notas de crédito)', advances: 'Anticipos de cobros', net: 'Neto', totalRow: 'TOTAL' },
    status: { open: 'Abierta', partial: 'Parcial', paid: 'Pagada', cancelled: 'Anulada' },
  },
  en: {
    receivables: { document: 'Document', customer: 'Customer', identification: 'Tax ID', issued: 'Issued', due: 'Due', daysOverdue: 'Days overdue', original: 'Original amount', applied: 'Applied', balance: 'Balance', status: 'Status', currency: 'Currency' },
    aging: { customer: 'Customer', current: 'Current', d1: '1-30 days', d2: '31-60 days', d3: '61-90 days', d4: 'Over 90 days', total: 'Total', totals: 'TOTAL' },
    statement: { title: 'Statement of account', customer: 'Customer', asOf: 'As of', owed: 'Owed', credit: 'Credit balance (credit notes)', advances: 'Receipt advances', net: 'Net', totalRow: 'TOTAL' },
    status: { open: 'Open', partial: 'Partial', paid: 'Paid', cancelled: 'Cancelled' },
  },
  fr: {
    receivables: { document: 'Document', customer: 'Client', identification: 'Identification', issued: 'Émission', due: 'Échéance', daysOverdue: 'Jours de retard', original: 'Montant initial', applied: 'Appliqué', balance: 'Solde', status: 'Statut', currency: 'Devise' },
    aging: { customer: 'Client', current: 'Courant', d1: '1 à 30 jours', d2: '31 à 60 jours', d3: '61 à 90 jours', d4: 'Plus de 90 jours', total: 'Total', totals: 'TOTAL' },
    statement: { title: 'Relevé de compte', customer: 'Client', asOf: 'Arrêté au', owed: 'Dû', credit: 'Solde créditeur (avoirs)', advances: 'Avances d\'encaissements', net: 'Net', totalRow: 'TOTAL' },
    status: { open: 'Ouverte', partial: 'Partielle', paid: 'Payée', cancelled: 'Annulée' },
  },
};

const statusLabel = (lang: ReportLang, status: string) => LABELS[lang].status[status] ?? status;

function receivableRow(lang: ReportLang, r: Receivable, asOf: string): Cell[] {
  const balance = balanceOf(r);
  const live = (r.status === 'open' || r.status === 'partial') && balance > 0;
  return [
    r.documentNumber,
    r.customerName,
    r.customerIdentification,
    r.issueDate,
    r.dueDate,
    live ? Math.max(0, daysBetween(r.dueDate, asOf)) : 0,
    money(r.originalCents),
    money(r.appliedCents),
    money(balance),
    statusLabel(lang, r.status),
    r.currencyCode,
  ];
}

/** La cartera tal como se ve en pantalla (mismos filtros), una fila por partida. */
export function receivablesCsv(lang: ReportLang, receivables: readonly Receivable[], asOf: string): { csv: string; rowCount: number } {
  const l = LABELS[lang].receivables;
  const rows: Cell[][] = [[l.document, l.customer, l.identification, l.issued, l.due, l.daysOverdue, l.original, l.applied, l.balance, l.status, l.currency]];
  for (const r of receivables) rows.push(receivableRow(lang, r, asOf));
  return { csv: toCsv(rows), rowCount: receivables.length };
}

export interface AgingCsvRow {
  customerName: string;
  currentCents: number;
  days1To30Cents: number;
  days31To60Cents: number;
  days61To90Cents: number;
  daysOver90Cents: number;
  totalCents: number;
}

/** Antigüedad por cliente con una fila final de totales. */
export function agingCsv(lang: ReportLang, customers: readonly AgingCsvRow[], totals: Omit<AgingCsvRow, 'customerName'>): { csv: string; rowCount: number } {
  const l = LABELS[lang].aging;
  const line = (name: string, r: Omit<AgingCsvRow, 'customerName'>): Cell[] => [name, money(r.currentCents), money(r.days1To30Cents), money(r.days31To60Cents), money(r.days61To90Cents), money(r.daysOver90Cents), money(r.totalCents)];
  const rows: Cell[][] = [[l.customer, l.current, l.d1, l.d2, l.d3, l.d4, l.total]];
  for (const c of customers) rows.push(line(c.customerName, c));
  rows.push(line(l.totals, totals));
  return { csv: toCsv(rows), rowCount: customers.length };
}

export interface StatementCsvInput {
  customerName: string;
  asOf: string;
  receivables: readonly Receivable[];
  receivableCents: number;
  advanceCents: number;
  customerAdvanceCents: number;
  netCents: number;
}

/** Estado de cuenta de un cliente: encabezado, sus partidas y los totales (debe, saldo a favor, anticipos y neto). */
export function statementCsv(lang: ReportLang, s: StatementCsvInput): { csv: string; rowCount: number } {
  const t = LABELS[lang].statement;
  const l = LABELS[lang].receivables;
  const rows: Cell[][] = [
    [t.title],
    [t.customer, s.customerName],
    [t.asOf, s.asOf],
    [],
    [l.document, l.issued, l.due, l.daysOverdue, l.original, l.applied, l.balance, l.status, l.currency],
  ];
  for (const r of s.receivables) {
    const full = receivableRow(lang, r, s.asOf);
    rows.push([full[0]!, full[3]!, full[4]!, full[5]!, full[6]!, full[7]!, full[8]!, full[9]!, full[10]!]);
  }
  rows.push([]);
  rows.push([t.owed, money(s.receivableCents)]);
  rows.push([t.credit, money(s.advanceCents)]);
  rows.push([t.net, money(s.netCents)]);
  rows.push([t.advances, money(s.customerAdvanceCents)]);
  return { csv: toCsv(rows), rowCount: s.receivables.length };
}

// ── Cuentas por pagar (bloque D) ─────────────────────────────────────────────

interface PayableLabels {
  document: string; internal: string; supplier: string; identification: string; issued: string; due: string; daysOverdue: string;
  original: string; applied: string; balance: string; status: string; currency: string;
  aging: { supplier: string; dueSoon: string; current: string; d1: string; d2: string; d3: string; d4: string; total: string; totals: string };
  statement: { title: string; supplier: string; asOf: string; owed: string; advances: string; net: string };
  status_: Record<string, string>;
}

const PAYABLE_LABELS: Record<ReportLang, PayableLabels> = {
  es: {
    document: 'Factura del proveedor', internal: 'N.º interno', supplier: 'Proveedor', identification: 'Identificación', issued: 'Emisión', due: 'Vencimiento', daysOverdue: 'Días de atraso',
    original: 'Importe original', applied: 'Pagado y retenido', balance: 'Saldo', status: 'Estado', currency: 'Moneda',
    aging: { supplier: 'Proveedor', dueSoon: 'Vence en 7 días', current: 'Corriente', d1: '1 a 30 días', d2: '31 a 60 días', d3: '61 a 90 días', d4: 'Más de 90 días', total: 'Total', totals: 'TOTAL' },
    statement: { title: 'Estado de cuenta del proveedor', supplier: 'Proveedor', asOf: 'Corte', owed: 'Se le debe', advances: 'Anticipos a proveedores', net: 'Neto' },
    status_: { open: 'Abierta', partial: 'Parcial', paid: 'Pagada', cancelled: 'Anulada' },
  },
  en: {
    document: 'Supplier invoice', internal: 'Internal no.', supplier: 'Supplier', identification: 'Tax ID', issued: 'Issued', due: 'Due', daysOverdue: 'Days overdue',
    original: 'Original amount', applied: 'Paid and withheld', balance: 'Balance', status: 'Status', currency: 'Currency',
    aging: { supplier: 'Supplier', dueSoon: 'Due in 7 days', current: 'Current', d1: '1-30 days', d2: '31-60 days', d3: '61-90 days', d4: 'Over 90 days', total: 'Total', totals: 'TOTAL' },
    statement: { title: 'Supplier statement', supplier: 'Supplier', asOf: 'As of', owed: 'Owed', advances: 'Supplier advances', net: 'Net' },
    status_: { open: 'Open', partial: 'Partial', paid: 'Paid', cancelled: 'Cancelled' },
  },
  fr: {
    document: 'Facture du fournisseur', internal: 'N° interne', supplier: 'Fournisseur', identification: 'Identification', issued: 'Émission', due: 'Échéance', daysOverdue: 'Jours de retard',
    original: 'Montant initial', applied: 'Payé et retenu', balance: 'Solde', status: 'Statut', currency: 'Devise',
    aging: { supplier: 'Fournisseur', dueSoon: 'Échéance sous 7 jours', current: 'Courant', d1: '1 à 30 jours', d2: '31 à 60 jours', d3: '61 à 90 jours', d4: 'Plus de 90 jours', total: 'Total', totals: 'TOTAL' },
    statement: { title: 'Relevé du fournisseur', supplier: 'Fournisseur', asOf: 'Arrêté au', owed: 'Dû', advances: 'Avances aux fournisseurs', net: 'Net' },
    status_: { open: 'Ouverte', partial: 'Partielle', paid: 'Payée', cancelled: 'Annulée' },
  },
};

function payableRow(lang: ReportLang, p: Payable, asOf: string): Cell[] {
  const balance = payableBalanceOf(p);
  const live = (p.status === 'open' || p.status === 'partial') && balance > 0;
  return [
    p.documentNumber, p.internalNumber, p.supplierName, p.supplierIdentification, p.issueDate, p.dueDate,
    live ? Math.max(0, daysBetween(p.dueDate, asOf)) : 0,
    money(p.originalCents), money(p.appliedCents), money(balance), PAYABLE_LABELS[lang].status_[p.status] ?? p.status, p.currencyCode,
  ];
}

/** Las deudas tal como se ven en pantalla (mismos filtros), una fila por deuda. */
export function payablesCsv(lang: ReportLang, payables: readonly Payable[], asOf: string): { csv: string; rowCount: number } {
  const l = PAYABLE_LABELS[lang];
  const rows: Cell[][] = [[l.document, l.internal, l.supplier, l.identification, l.issued, l.due, l.daysOverdue, l.original, l.applied, l.balance, l.status, l.currency]];
  for (const p of payables) rows.push(payableRow(lang, p, asOf));
  return { csv: toCsv(rows), rowCount: payables.length };
}

export interface PayablesAgingCsvRow {
  supplierName: string;
  dueSoonCents: number;
  currentCents: number;
  days1To30Cents: number;
  days31To60Cents: number;
  days61To90Cents: number;
  daysOver90Cents: number;
  totalCents: number;
}

/** Antigüedad de lo que se debe, por proveedor, con una fila final de totales. */
export function payablesAgingCsv(lang: ReportLang, suppliers: readonly PayablesAgingCsvRow[], totals: Omit<PayablesAgingCsvRow, 'supplierName'>): { csv: string; rowCount: number } {
  const l = PAYABLE_LABELS[lang].aging;
  const line = (name: string, r: Omit<PayablesAgingCsvRow, 'supplierName'>): Cell[] => [name, money(r.dueSoonCents), money(r.currentCents), money(r.days1To30Cents), money(r.days31To60Cents), money(r.days61To90Cents), money(r.daysOver90Cents), money(r.totalCents)];
  const rows: Cell[][] = [[l.supplier, l.dueSoon, l.current, l.d1, l.d2, l.d3, l.d4, l.total]];
  for (const s of suppliers) rows.push(line(s.supplierName, s));
  rows.push(line(l.totals, totals));
  return { csv: toCsv(rows), rowCount: suppliers.length };
}

export interface SupplierStatementCsvInput {
  supplierName: string;
  asOf: string;
  payables: readonly Payable[];
  payableCents: number;
  advanceCents: number;
  netCents: number;
}

/** Estado de cuenta de un proveedor: encabezado, sus deudas y los totales. */
export function supplierStatementCsv(lang: ReportLang, s: SupplierStatementCsvInput): { csv: string; rowCount: number } {
  const l = PAYABLE_LABELS[lang];
  const rows: Cell[][] = [
    [l.statement.title], [l.statement.supplier, s.supplierName], [l.statement.asOf, s.asOf], [],
    [l.document, l.internal, l.issued, l.due, l.daysOverdue, l.original, l.applied, l.balance, l.status, l.currency],
  ];
  for (const p of s.payables) {
    const full = payableRow(lang, p, s.asOf);
    rows.push([full[0]!, full[1]!, full[4]!, full[5]!, full[6]!, full[7]!, full[8]!, full[9]!, full[10]!, full[11]!]);
  }
  rows.push([]);
  rows.push([l.statement.owed, money(s.payableCents)]);
  rows.push([l.statement.net, money(s.netCents)]);
  rows.push([l.statement.advances, money(s.advanceCents)]);
  return { csv: toCsv(rows), rowCount: s.payables.length };
}
