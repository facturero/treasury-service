import { isLocalDate } from './dates.js';
import { ValidationError, type ErrorDetail } from './errors.js';

/**
 * Cobro (recibo) a un cliente: dinero que entra, aplicado a una o varias deudas del MISMO cliente.
 *
 * Tres importes y una igualdad (la fija un CHECK en la base y la comprueba `receiptTotals`):
 *
 *     entró (caja/banco)  +  anticipos consumidos   =   aplicado a deudas  +  excedente (anticipo nuevo)
 *
 * El excedente no se rechaza: queda como anticipo del cliente (`customer_advances`, origen `receipt`) y un recibo posterior lo
 * puede consumir. Lo que se aplica a una deuda nunca pasa de su saldo (lo comprueba el caso de uso con la fila bloqueada).
 */

export type ReceiptStatus = 'draft' | 'posted' | 'voided';
export type ReceiptMethod = 'cash' | 'transfer' | 'check' | 'card' | 'other';
/** Rol contable que recibe el dinero: contabilidad lo resuelve a la única cuenta de ese rol en la organización. */
export type ReceiptAccountRole = 'cash' | 'bank';

export const RECEIPT_STATUSES: readonly ReceiptStatus[] = ['draft', 'posted', 'voided'];
export const RECEIPT_METHODS: readonly ReceiptMethod[] = ['cash', 'transfer', 'check', 'card', 'other'];

/** En cheque y transferencia la referencia (n.º de cheque u operación) es obligatoria: sin ella el cobro no se puede conciliar con el banco. */
export const METHODS_REQUIRING_REFERENCE: readonly ReceiptMethod[] = ['check', 'transfer'];

export interface ReceiptLine {
  receivableId: string;
  appliedCents: number;
}

/** Un anticipo anterior del cliente que este recibo consume. */
export interface ReceiptAdvanceUse {
  advanceId: string;
  usedCents: number;
}

export interface Receipt {
  id: string;
  organizationId: string;
  /** `RC-AAAA-NNNNNN`. `null` mientras es borrador: los borradores no gastan secuencial. */
  number: string | null;
  customerId: string;
  customerName: string;
  customerIdentification: string | null;
  /** `AAAA-MM-DD`: fecha de calendario, nunca pasa por UTC. */
  receiptDate: string;
  method: ReceiptMethod;
  accountRole: ReceiptAccountRole;
  reference: string | null;
  currencyCode: string;
  /** Lo que entró de verdad a caja o banco. */
  totalCents: number;
  advanceUsedCents: number;
  appliedCents: number;
  /** Excedente: queda como anticipo nuevo del cliente. */
  advanceCents: number;
  lines: ReceiptLine[];
  advanceUses: ReceiptAdvanceUse[];
  notes: string | null;
  status: ReceiptStatus;
  voidReason: string | null;
  createdBy: string;
  postedBy: string | null;
  voidedBy: string | null;
  postedAt: Date | null;
  voidedAt: Date | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/** Caja para el efectivo; bancos para todo lo demás. La persona puede elegir otro rol (p. ej. cheque que se guarda en caja). */
export function defaultAccountRole(method: ReceiptMethod): ReceiptAccountRole {
  return method === 'cash' ? 'cash' : 'bank';
}

export interface ReceiptInput {
  receiptDate: string;
  method: ReceiptMethod;
  accountRole?: ReceiptAccountRole | null;
  reference?: string | null;
  /** Lo que entró a caja o banco, en centavos. Puede ser 0 si el recibo solo consume anticipos. */
  totalCents: number;
  lines: ReceiptLine[];
  advanceUses?: ReceiptAdvanceUse[];
  notes?: string | null;
}

/** Calcula los importes derivados de un recibo y verifica la igualdad. Lanza 422 con el campo que falla. */
export function receiptTotals(input: Pick<ReceiptInput, 'totalCents' | 'lines' | 'advanceUses'>): {
  appliedCents: number;
  advanceUsedCents: number;
  advanceCents: number;
} {
  const appliedCents = input.lines.reduce((acc, l) => acc + l.appliedCents, 0);
  const advanceUsedCents = (input.advanceUses ?? []).reduce((acc, u) => acc + u.usedCents, 0);
  const advanceCents = input.totalCents + advanceUsedCents - appliedCents;
  if (advanceCents < 0) {
    throw new ValidationError([
      {
        field: 'lines',
        message: 'Lo aplicado a las deudas es mayor que lo cobrado más los anticipos que se consumen.',
      },
    ]);
  }
  return { appliedCents, advanceUsedCents, advanceCents };
}

/**
 * Valida la FORMA de un recibo (sin consultar la base): importes enteros, líneas sin repetir, referencia obligatoria donde toca.
 * Que cada deuda exista, sea del cliente y tenga saldo se comprueba después, con la fila bloqueada.
 */
export function validateReceiptInput(input: ReceiptInput): void {
  const errors: ErrorDetail[] = [];
  if (!isLocalDate(input.receiptDate)) errors.push({ field: 'receiptDate', message: 'La fecha del cobro no es válida (AAAA-MM-DD).' });
  if (!RECEIPT_METHODS.includes(input.method)) errors.push({ field: 'method', message: 'El medio de cobro no es válido.' });
  if (!Number.isSafeInteger(input.totalCents) || input.totalCents < 0) {
    errors.push({ field: 'totalCents', message: 'Lo cobrado debe ser un número entero de centavos, sin signo.' });
  }
  const reference = input.reference?.trim() ?? '';
  if (METHODS_REQUIRING_REFERENCE.includes(input.method) && reference === '') {
    errors.push({ field: 'reference', message: 'En cheque y transferencia hay que indicar la referencia (número de cheque u operación).' });
  }

  const seen = new Set<string>();
  input.lines.forEach((line, i) => {
    if (!line.receivableId) errors.push({ field: `lines[${i}].receivableId`, message: 'Falta la deuda a la que se aplica.' });
    if (seen.has(line.receivableId)) errors.push({ field: `lines[${i}].receivableId`, message: 'La misma deuda no se puede aplicar dos veces en un cobro.' });
    seen.add(line.receivableId);
    if (!Number.isSafeInteger(line.appliedCents) || line.appliedCents <= 0) {
      errors.push({ field: `lines[${i}].appliedCents`, message: 'Lo aplicado a una deuda debe ser mayor que cero.' });
    }
  });
  const seenAdvance = new Set<string>();
  (input.advanceUses ?? []).forEach((use, i) => {
    if (!use.advanceId) errors.push({ field: `advanceUses[${i}].advanceId`, message: 'Falta el anticipo.' });
    if (seenAdvance.has(use.advanceId)) errors.push({ field: `advanceUses[${i}].advanceId`, message: 'El mismo anticipo no se puede usar dos veces en un cobro.' });
    seenAdvance.add(use.advanceId);
    if (!Number.isSafeInteger(use.usedCents) || use.usedCents <= 0) {
      errors.push({ field: `advanceUses[${i}].usedCents`, message: 'Lo que se consume de un anticipo debe ser mayor que cero.' });
    }
  });
  if (errors.length) throw new ValidationError(errors);

  const { advanceUsedCents } = receiptTotals(input);
  if (input.totalCents + advanceUsedCents <= 0) {
    throw new ValidationError([{ field: 'totalCents', message: 'El cobro necesita un importe: lo cobrado o un anticipo que se consuma.' }]);
  }
}
