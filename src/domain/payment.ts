import { isLocalDate } from './dates.js';
import { ValidationError, type ErrorDetail } from './errors.js';

/**
 * Pago a un proveedor: dinero que SALE, aplicado a una o varias facturas del MISMO proveedor. Espejo de `receipt.ts`.
 *
 *     salió (caja/banco)  +  anticipos consumidos   =   aplicado a facturas  +  excedente (anticipo a proveedores)
 *
 * El excedente no se rechaza: queda como anticipo a proveedores (`supplier_advances`) y un pago posterior lo puede consumir. Lo que se
 * aplica a una factura nunca pasa de su saldo NETO (ya descontada la retención): lo comprueba el caso de uso con la fila bloqueada.
 *
 * Estados: `draft → (approved) → posted → voided`. `approved` solo existe si el pago llega al umbral de aprobación de la organización.
 */

export type PaymentStatus = 'draft' | 'approved' | 'posted' | 'voided';
export type PaymentMethod = 'cash' | 'transfer' | 'check' | 'other';
/** Rol contable de donde sale el dinero: contabilidad lo resuelve a la única cuenta de ese rol en la organización. */
export type PaymentAccountRole = 'cash' | 'bank';

export const PAYMENT_STATUSES: readonly PaymentStatus[] = ['draft', 'approved', 'posted', 'voided'];
export const PAYMENT_METHODS: readonly PaymentMethod[] = ['cash', 'transfer', 'check', 'other'];
/** En cheque y transferencia la referencia (n.º de cheque u operación) es obligatoria: sin ella el pago no se puede conciliar con el banco. */
export const PAYMENT_METHODS_REQUIRING_REFERENCE: readonly PaymentMethod[] = ['check', 'transfer'];

export interface PaymentLine {
  payableId: string;
  appliedCents: number;
}

/** Un anticipo anterior a este proveedor que el pago consume. */
export interface PaymentAdvanceUse {
  advanceId: string;
  usedCents: number;
}

export interface Payment {
  id: string;
  organizationId: string;
  /** `PG-AAAA-NNNNNN`. `null` mientras es borrador: los borradores no gastan secuencial. */
  number: string | null;
  supplierId: string;
  supplierName: string;
  supplierIdentification: string | null;
  /** `AAAA-MM-DD`: fecha de calendario, nunca pasa por UTC. */
  paymentDate: string;
  method: PaymentMethod;
  accountRole: PaymentAccountRole;
  /** Cuenta bancaria de tesorería (solo con rol `bank`). `null` = efectivo o sin elegir. */
  bankAccountId: string | null;
  reference: string | null;
  currencyCode: string;
  /** Lo que salió de verdad de caja o banco. */
  totalCents: number;
  advanceUsedCents: number;
  appliedCents: number;
  /** Excedente: queda como anticipo a proveedores. */
  advanceCents: number;
  lines: PaymentLine[];
  advanceUses: PaymentAdvanceUse[];
  notes: string | null;
  status: PaymentStatus;
  voidReason: string | null;
  createdBy: string;
  approvedBy: string | null;
  postedBy: string | null;
  voidedBy: string | null;
  approvedAt: Date | null;
  postedAt: Date | null;
  voidedAt: Date | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/** Caja para el efectivo; bancos para todo lo demás. */
export function defaultPaymentAccountRole(method: PaymentMethod): PaymentAccountRole {
  return method === 'cash' ? 'cash' : 'bank';
}

export interface PaymentInput {
  paymentDate: string;
  method: PaymentMethod;
  accountRole?: PaymentAccountRole | null;
  /** Opcional: solo se admite si el rol contable es banco. */
  bankAccountId?: string | null;
  reference?: string | null;
  /** Lo que sale de caja o banco, en centavos. Puede ser 0 si el pago solo consume anticipos. */
  totalCents: number;
  lines: PaymentLine[];
  advanceUses?: PaymentAdvanceUse[];
  notes?: string | null;
}

/** Importes derivados y la igualdad. Lanza 422 con el campo que falla. */
export function paymentTotals(input: Pick<PaymentInput, 'totalCents' | 'lines' | 'advanceUses'>): { appliedCents: number; advanceUsedCents: number; advanceCents: number } {
  const appliedCents = input.lines.reduce((acc, l) => acc + l.appliedCents, 0);
  const advanceUsedCents = (input.advanceUses ?? []).reduce((acc, u) => acc + u.usedCents, 0);
  const advanceCents = input.totalCents + advanceUsedCents - appliedCents;
  if (advanceCents < 0) {
    throw new ValidationError([{ field: 'lines', message: 'Lo aplicado a las facturas es mayor que lo pagado más los anticipos que se consumen.' }]);
  }
  return { appliedCents, advanceUsedCents, advanceCents };
}

/** Valida la FORMA de un pago (sin consultar la base). Que cada factura exista, sea del proveedor y tenga saldo se comprueba después, con la fila bloqueada. */
export function validatePaymentInput(input: PaymentInput): void {
  const errors: ErrorDetail[] = [];
  if (!isLocalDate(input.paymentDate)) errors.push({ field: 'paymentDate', message: 'La fecha del pago no es válida (AAAA-MM-DD).' });
  if (!PAYMENT_METHODS.includes(input.method)) errors.push({ field: 'method', message: 'El medio de pago no es válido.' });
  if (!Number.isSafeInteger(input.totalCents) || input.totalCents < 0) {
    errors.push({ field: 'totalCents', message: 'Lo pagado debe ser un número entero de centavos, sin signo.' });
  }
  const reference = input.reference?.trim() ?? '';
  if (PAYMENT_METHODS_REQUIRING_REFERENCE.includes(input.method) && reference === '') {
    errors.push({ field: 'reference', message: 'En cheque y transferencia hay que indicar la referencia (número de cheque u operación).' });
  }
  const seen = new Set<string>();
  input.lines.forEach((line, i) => {
    if (!line.payableId) errors.push({ field: `lines[${i}].payableId`, message: 'Falta la factura a la que se aplica.' });
    if (seen.has(line.payableId)) errors.push({ field: `lines[${i}].payableId`, message: 'La misma factura no se puede aplicar dos veces en un pago.' });
    seen.add(line.payableId);
    if (!Number.isSafeInteger(line.appliedCents) || line.appliedCents <= 0) {
      errors.push({ field: `lines[${i}].appliedCents`, message: 'Lo aplicado a una factura debe ser mayor que cero.' });
    }
  });
  const seenAdvance = new Set<string>();
  (input.advanceUses ?? []).forEach((use, i) => {
    if (!use.advanceId) errors.push({ field: `advanceUses[${i}].advanceId`, message: 'Falta el anticipo.' });
    if (seenAdvance.has(use.advanceId)) errors.push({ field: `advanceUses[${i}].advanceId`, message: 'El mismo anticipo no se puede usar dos veces en un pago.' });
    seenAdvance.add(use.advanceId);
    if (!Number.isSafeInteger(use.usedCents) || use.usedCents <= 0) {
      errors.push({ field: `advanceUses[${i}].usedCents`, message: 'Lo que se consume de un anticipo debe ser mayor que cero.' });
    }
  });
  if (errors.length) throw new ValidationError(errors);
  const { advanceUsedCents } = paymentTotals(input);
  if (input.totalCents + advanceUsedCents <= 0) {
    throw new ValidationError([{ field: 'totalCents', message: 'El pago necesita un importe: lo pagado o un anticipo que se consuma.' }]);
  }
}

/** Configuración de pagos de la organización. */
export interface PaymentSettings {
  organizationId: string;
  /**
   * Desde qué importe (centavos) un pago exige que OTRA persona lo apruebe antes de contabilizarse. `null` = sin aprobación (nace así:
   * un umbral lo decide el dueño, no el código).
   */
  approvalThresholdCents: number | null;
  updatedBy: string | null;
  updatedAt: Date | null;
}

export const defaultPaymentSettings = (organizationId: string): PaymentSettings => ({ organizationId, approvalThresholdCents: null, updatedBy: null, updatedAt: null });

/** ¿Este pago necesita aprobación? Cuenta lo que SALE de caja o banco (un pago que solo consume anticipos no mueve dinero). */
export function requiresApproval(settings: Pick<PaymentSettings, 'approvalThresholdCents'>, payment: Pick<Payment, 'totalCents' | 'appliedCents'>): boolean {
  if (settings.approvalThresholdCents === null) return false;
  return Math.max(payment.totalCents, payment.appliedCents) >= settings.approvalThresholdCents;
}
