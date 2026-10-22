import { isLocalDate } from './dates.js';
import { ValidationError, type ErrorDetail } from './errors.js';

/**
 * Bancos de la organización y su registro de movimientos.
 *
 * El «registro de bancos» es de tesorería, no del libro mayor: cada cobro o pago contabilizado por BANCO deja un movimiento (con
 * signo: + entra, − sale) y cada ajuste bancario también. La conciliación compara ese registro con el extracto del banco.
 * Contabilidad resuelve el rol `bank` a UNA cuenta del plan, así que varias cuentas bancarias de tesorería suman en esa misma cuenta del mayor.
 */

export type BankAccountType = 'checking' | 'savings';
export const BANK_ACCOUNT_TYPES: readonly BankAccountType[] = ['checking', 'savings'];

export type CsvDelimiter = ',' | ';' | '\t';
export type CsvDateFormat = 'DD/MM/YYYY' | 'YYYY-MM-DD' | 'MM/DD/YYYY' | 'DD-MM-YYYY';
export type AmountMode = 'signed' | 'debit_credit';
export const CSV_DELIMITERS: readonly CsvDelimiter[] = [',', ';', '\t'];
export const CSV_DATE_FORMATS: readonly CsvDateFormat[] = ['DD/MM/YYYY', 'YYYY-MM-DD', 'MM/DD/YYYY', 'DD-MM-YYYY'];

/**
 * Cómo leer el CSV de un banco. No se inventa el formato de ningún banco: la persona dice qué columna es cada cosa y el sistema lo
 * comprueba con una vista previa antes de guardar nada. Las columnas se numeran desde 1.
 */
export interface ImportProfile {
  delimiter: CsvDelimiter;
  /** Filas que se saltan al principio (encabezados y ruido, incluida la fila con los nombres de columna). */
  skipRows: number;
  dateColumn: number;
  dateFormat: CsvDateFormat;
  descriptionColumn: number;
  referenceColumn: number | null;
  amountMode: AmountMode;
  /** `signed`: una sola columna, positivo = entra. */
  amountColumn: number | null;
  /** `debit_credit`: débito = sale, crédito = entra. */
  debitColumn: number | null;
  creditColumn: number | null;
  /** Algunos bancos muestran lo que SALE como positivo: invierte el signo de la columna única. */
  invertSign: boolean;
  decimalSeparator: '.' | ',';
  balanceColumn: number | null;
}

export const defaultImportProfile = (): ImportProfile => ({
  delimiter: ',',
  skipRows: 1,
  dateColumn: 1,
  dateFormat: 'DD/MM/YYYY',
  descriptionColumn: 2,
  referenceColumn: null,
  amountMode: 'signed',
  amountColumn: 3,
  debitColumn: null,
  creditColumn: null,
  invertSign: false,
  decimalSeparator: '.',
  balanceColumn: null,
});

export interface BankAccount {
  id: string;
  organizationId: string;
  name: string;
  bankName: string;
  accountType: BankAccountType;
  /** Últimos dígitos, para distinguir cuentas. Nunca se guarda el número completo. */
  accountLast4: string | null;
  currencyCode: string;
  /** Saldo del registro a `openingDate`: solo cuenta lo POSTERIOR a esa fecha (movimientos y renglones de extracto). */
  openingBalanceCents: number;
  openingDate: string;
  isActive: boolean;
  importProfile: ImportProfile | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface BankAccountInput {
  name: string;
  bankName: string;
  accountType: BankAccountType;
  accountLast4?: string | null;
  openingBalanceCents: number;
  openingDate: string;
  importProfile?: ImportProfile | null;
}

export type BankMovementSource = 'receipt' | 'payment' | 'adjustment';
export type BankMovementStatus = 'active' | 'reversed';
export type AdjustmentKind = 'bank_fee' | 'interest' | 'other_in' | 'other_out';
export const ADJUSTMENT_KINDS: readonly AdjustmentKind[] = ['bank_fee', 'interest', 'other_in', 'other_out'];

/** Comisión y otros egresos salen del banco; intereses y otros ingresos entran. */
export const adjustmentSign = (kind: AdjustmentKind): 1 | -1 => (kind === 'interest' || kind === 'other_in' ? 1 : -1);

export interface BankMovement {
  id: string;
  organizationId: string;
  /** `null` = sin cuenta asignada (cobros y pagos anteriores a este módulo, o elegidos sin cuenta): no entra en ninguna conciliación hasta asignarla. */
  bankAccountId: string | null;
  sourceType: BankMovementSource;
  sourceId: string;
  /** `AAAA-MM-DD`. */
  movementDate: string;
  /** Con signo: + entra, − sale. */
  amountCents: number;
  reference: string | null;
  /** Quién paga o cobra, o el motivo del ajuste. */
  description: string;
  /** Solo los ajustes. */
  kind: AdjustmentKind | null;
  status: BankMovementStatus;
  createdBy: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export type LineStatus = 'unmatched' | 'matched' | 'external';

export interface BankStatement {
  id: string;
  organizationId: string;
  bankAccountId: string;
  fileName: string | null;
  /** Hash del contenido normalizado: el mismo archivo no entra dos veces en la misma cuenta. */
  contentHash: string;
  periodStart: string;
  periodEnd: string;
  lineCount: number;
  /** Solo si el archivo trae la columna de saldo. */
  closingBalanceCents: number | null;
  closingDate: string | null;
  importedBy: string;
  importedAt: Date;
}

export interface BankStatementLine {
  id: string;
  organizationId: string;
  bankAccountId: string;
  statementId: string;
  lineDate: string;
  description: string;
  reference: string | null;
  /** Con signo: + entra, − sale. */
  amountCents: number;
  balanceCents: number | null;
  /** Huella (fecha, importe, referencia, descripción) + ocurrencia: es lo que impide duplicar renglones entre extractos que se solapan. */
  fingerprint: string;
  status: LineStatus;
  externalReason: string | null;
  reconciliationId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface BankMatch {
  id: string;
  organizationId: string;
  bankAccountId: string;
  lineId: string;
  movementId: string;
  amountCents: number;
  method: 'manual' | 'suggested';
  matchedBy: string;
  matchedAt: Date;
  reconciliationId: string | null;
}

/** `reopened`: se cerró y se reabrió (queda como historia); la vigente es la última `closed`. */
export type ReconciliationStatus = 'closed' | 'reopened';

export interface BankReconciliation {
  id: string;
  organizationId: string;
  bankAccountId: string;
  /** Fecha de corte: se concilia todo lo de esa fecha hacia atrás. */
  cutoffDate: string;
  statementBalanceCents: number;
  registerBalanceCents: number;
  pendingCents: number;
  differenceCents: number;
  status: ReconciliationStatus;
  closedBy: string | null;
  closedAt: Date | null;
  reopenedBy: string | null;
  reopenedAt: Date | null;
  notes: string | null;
  version: number;
  createdAt: Date;
}

const LAST4 = /^[A-Za-z0-9]{1,4}$/;

/** Valida la FORMA de una cuenta bancaria. */
export function validateBankAccountInput(input: BankAccountInput): void {
  const errors: ErrorDetail[] = [];
  if (!input.name.trim()) errors.push({ field: 'name', message: 'La cuenta necesita un nombre.' });
  if (input.name.trim().length > 80) errors.push({ field: 'name', message: 'El nombre no puede pasar de 80 caracteres.' });
  if (!input.bankName.trim()) errors.push({ field: 'bankName', message: 'Indica el banco.' });
  if (!BANK_ACCOUNT_TYPES.includes(input.accountType)) errors.push({ field: 'accountType', message: 'El tipo de cuenta no es válido.' });
  if (input.accountLast4 != null && input.accountLast4 !== '' && !LAST4.test(input.accountLast4)) {
    errors.push({ field: 'accountLast4', message: 'Pon solo los últimos 4 dígitos de la cuenta (nunca el número completo).' });
  }
  if (!Number.isSafeInteger(input.openingBalanceCents)) errors.push({ field: 'openingBalanceCents', message: 'El saldo de apertura debe ser un número entero de centavos.' });
  if (!isLocalDate(input.openingDate)) errors.push({ field: 'openingDate', message: 'La fecha de apertura no es válida (AAAA-MM-DD).' });
  if (input.importProfile) errors.push(...validateImportProfile(input.importProfile));
  if (errors.length) throw new ValidationError(errors);
}

/** Valida un perfil de importación. Devuelve los problemas (vacío = válido) con la ruta del campo. */
export function validateImportProfile(p: ImportProfile, prefix = 'importProfile'): ErrorDetail[] {
  const errors: ErrorDetail[] = [];
  const col = (value: number | null, field: string, required: boolean) => {
    if (value === null) {
      if (required) errors.push({ field: `${prefix}.${field}`, message: 'Falta indicar la columna.' });
      return;
    }
    if (!Number.isInteger(value) || value < 1 || value > 50) errors.push({ field: `${prefix}.${field}`, message: 'La columna es un número desde 1.' });
  };
  if (!CSV_DELIMITERS.includes(p.delimiter)) errors.push({ field: `${prefix}.delimiter`, message: 'El delimitador no es válido.' });
  if (!Number.isInteger(p.skipRows) || p.skipRows < 0 || p.skipRows > 50) errors.push({ field: `${prefix}.skipRows`, message: 'Las filas a saltar van de 0 a 50.' });
  if (!CSV_DATE_FORMATS.includes(p.dateFormat)) errors.push({ field: `${prefix}.dateFormat`, message: 'El formato de fecha no es válido.' });
  if (p.decimalSeparator !== '.' && p.decimalSeparator !== ',') errors.push({ field: `${prefix}.decimalSeparator`, message: 'El separador decimal es punto o coma.' });
  col(p.dateColumn, 'dateColumn', true);
  col(p.descriptionColumn, 'descriptionColumn', true);
  col(p.referenceColumn, 'referenceColumn', false);
  col(p.balanceColumn, 'balanceColumn', false);
  if (p.amountMode === 'signed') {
    col(p.amountColumn, 'amountColumn', true);
  } else if (p.amountMode === 'debit_credit') {
    col(p.debitColumn, 'debitColumn', true);
    col(p.creditColumn, 'creditColumn', true);
    if (p.debitColumn !== null && p.debitColumn === p.creditColumn) errors.push({ field: `${prefix}.creditColumn`, message: 'Débito y crédito no pueden ser la misma columna.' });
  } else {
    errors.push({ field: `${prefix}.amountMode`, message: 'El modo de importe no es válido.' });
  }
  return errors;
}

export const ADJUSTMENT_DESCRIPTION_MAX = 200;

export interface AdjustmentInput {
  bankAccountId: string;
  kind: AdjustmentKind;
  date: string;
  /** Siempre positivo: el signo lo da el tipo. */
  amountCents: number;
  description: string;
  reference?: string | null;
}

export function validateAdjustmentInput(input: AdjustmentInput): void {
  const errors: ErrorDetail[] = [];
  if (!input.bankAccountId) errors.push({ field: 'bankAccountId', message: 'Indica la cuenta bancaria.' });
  if (!ADJUSTMENT_KINDS.includes(input.kind)) errors.push({ field: 'kind', message: 'El tipo de ajuste no es válido.' });
  if (!isLocalDate(input.date)) errors.push({ field: 'date', message: 'La fecha no es válida (AAAA-MM-DD).' });
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) errors.push({ field: 'amountCents', message: 'El importe debe ser mayor que cero (el tipo de ajuste decide si entra o sale).' });
  const description = input.description.trim();
  if (description.length < 3) errors.push({ field: 'description', message: 'Describe el ajuste (mínimo 3 caracteres): contabilidad lo usa como glosa del asiento.' });
  if (description.length > ADJUSTMENT_DESCRIPTION_MAX) errors.push({ field: 'description', message: `La descripción no puede pasar de ${ADJUSTMENT_DESCRIPTION_MAX} caracteres.` });
  if (errors.length) throw new ValidationError(errors);
}
