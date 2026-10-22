/**
 * Cuentas por pagar: lo que la empresa le debe a sus proveedores.
 *
 * Es el espejo de `receivable.ts` (cartera): el saldo de una partida NUNCA es una columna que se reste a mano, se DERIVA de las
 * aplicaciones vigentes que la cubren (pagos y retenciones). Así reintentar un evento no descuadra nada y el saldo que ve la persona
 * es el mismo que ve el libro mayor (`payables`).
 *
 * A diferencia de la cartera, el vencimiento NO se calcula con días de crédito: la factura de compra ya trae su `dueDate`.
 */

export type PayableStatus = 'open' | 'partial' | 'paid' | 'cancelled';
export const PAYABLE_STATUSES: readonly PayableStatus[] = ['open', 'partial', 'paid', 'cancelled'];

/** De dónde salió la deuda: una factura de compra contabilizada, o un saldo inicial cargado a mano. */
export type PayableSourceType = 'purchase_bill' | 'initial_balance';
export const PAYABLE_SOURCE_TYPES: readonly PayableSourceType[] = ['purchase_bill', 'initial_balance'];

export interface Payable {
  id: string;
  organizationId: string;
  supplierId: string;
  supplierName: string;
  supplierIdentification: string | null;
  sourceType: PayableSourceType;
  sourceId: string;
  /** Número de la factura del PROVEEDOR (`001-001-000000123`): con él y el RUC se empareja la retención. */
  documentNumber: string | null;
  /** Número interno de la factura de compra (`FC-AAAA-NNNNNN`). */
  internalNumber: string | null;
  /** `AAAA-MM-DD`: fecha de calendario, nunca pasa por UTC. */
  issueDate: string;
  dueDate: string;
  currencyCode: string;
  originalCents: number;
  status: PayableStatus;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  /** Suma de lo aplicado vigente (pagos + retenciones). NO es una columna: la calcula el repositorio al leer. */
  appliedCents: number;
}

/** Algo que reduce una deuda: un pago o una retención. */
export interface PayableApplication {
  id: string;
  organizationId: string;
  payableId: string;
  sourceType: 'payment' | 'withholding';
  /** Id del pago, o de la retención en fiscal-ecuador. */
  sourceId: string;
  /** `PG-AAAA-NNNNNN` o número del comprobante de retención. */
  documentNumber: string | null;
  appliedCents: number;
  /** `AAAA-MM-DD`. */
  appliedAt: string;
  createdAt: Date;
  /** Pago anulado: la aplicación NO se borra (queda la historia) pero ya no cuenta en el saldo. */
  reversedAt?: Date | null;
}

/** Saldo a favor de la EMPRESA con un proveedor: lo pagado de más, o un pago sin factura (anticipo a proveedores). */
export interface SupplierAdvance {
  id: string;
  organizationId: string;
  supplierId: string;
  supplierName: string;
  supplierIdentification: string | null;
  /** Id del pago que lo originó. */
  originId: string;
  documentNumber: string | null;
  currencyCode: string;
  originalCents: number;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  /** Suma de lo consumido por pagos posteriores. Derivado, como el saldo de la partida. */
  appliedCents: number;
  /** Pago anulado: el anticipo ya no existe (no se borra). */
  voidedAt?: Date | null;
}

/** Cabecera de una carga de saldos iniciales de deudas a proveedores. */
export interface PayableOpeningLoad {
  id: string;
  organizationId: string;
  cutoffDate: string;
  loadedBy: string;
  reason: string;
  totalCents: number;
  createdAt: Date;
}

/** Una retención que llegó antes que su factura de compra (RabbitMQ no ordena): espera a que la factura aparezca. */
export interface UnmatchedWithholding {
  id: string;
  organizationId: string;
  withholdingId: string;
  number: string | null;
  supplierIdentification: string;
  /** Número del documento sustento (la factura del proveedor), normalizado. */
  supportNumber: string;
  issueDate: string | null;
  totalWithheldCents: number;
  createdAt: Date;
}

/**
 * Saldo de una partida por pagar.
 *
 * - `cancelled`: la factura de compra se anuló y contabilidad revirtió su crédito; lo que ya se había pagado NO se revierte, así que el
 *   saldo queda a favor de la empresa (negativo), que es justo lo que dice el libro mayor.
 * - resto: lo que se abrió menos lo aplicado.
 */
export function payableBalanceOf(p: Pick<Payable, 'status' | 'originalCents' | 'appliedCents'>): number {
  // `0 - x` y no `-x`: sin aplicaciones daría `-0`.
  if (p.status === 'cancelled') return 0 - p.appliedCents;
  return p.originalCents - p.appliedCents;
}

/** Estado derivado: `cancelled` es terminal; el resto sale de lo aplicado. */
export function derivePayableStatus(current: PayableStatus, originalCents: number, appliedCents: number): PayableStatus {
  if (current === 'cancelled') return current;
  if (appliedCents <= 0) return 'open';
  if (appliedCents >= originalCents) return 'paid';
  return 'partial';
}

export const supplierAdvanceBalanceOf = (a: Pick<SupplierAdvance, 'originalCents' | 'appliedCents'>): number => a.originalCents - a.appliedCents;

/**
 * Normaliza un número de documento para emparejar la retención con la factura: la retención cita `001-002-000000123` y la factura
 * puede traerlo con espacios o sin ceros a la izquierda. Se comparan los tres bloques numéricos.
 */
export function normalizeDocumentNumber(value: string | null | undefined): string {
  const parts = String(value ?? '').trim().split(/[^0-9]+/).filter(Boolean);
  if (parts.length === 3) return `${parts[0]!.padStart(3, '0')}-${parts[1]!.padStart(3, '0')}-${parts[2]!.padStart(9, '0')}`;
  return String(value ?? '').replace(/\s+/g, '').toUpperCase();
}
