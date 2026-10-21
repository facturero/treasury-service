/**
 * Cartera: partidas por cobrar, notas de crédito aplicadas y saldos a favor (anticipos).
 *
 * El saldo de una partida NUNCA es una columna que se reste a mano: se DERIVA de las aplicaciones que la cubren
 * (`domain/money.ts`). Así, reintentar un evento que ya se aplicó no descuadra la cartera, y el saldo que ve la
 * persona es siempre el mismo que ve el libro mayor.
 */

export type ReceivableStatus = 'open' | 'partial' | 'paid' | 'written_off' | 'cancelled';

export const RECEIVABLE_STATUSES: readonly ReceivableStatus[] = ['open', 'partial', 'paid', 'written_off', 'cancelled'];

/**
 * De dónde salió la partida.
 *
 * `credit_note` está en el catálogo por completitud del contrato, pero una nota de crédito NUNCA abre partida: abona a
 * la partida que la originó y, si esa partida todavía no existe, queda como saldo a favor (`customer_advances`).
 */
export type ReceivableSourceType = 'invoice' | 'credit_note' | 'initial_balance';

export const RECEIVABLE_SOURCE_TYPES: readonly ReceivableSourceType[] = ['invoice', 'credit_note', 'initial_balance'];

export interface Receivable {
  id: string;
  organizationId: string;
  customerId: string;
  customerName: string;
  customerIdentification: string | null;
  sourceType: ReceivableSourceType;
  sourceId: string;
  documentNumber: string | null;
  /** `AAAA-MM-DD`. Fecha de calendario: nunca pasa por conversión UTC. */
  issueDate: string;
  dueDate: string;
  currencyCode: string;
  originalCents: number;
  status: ReceivableStatus;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  /**
   * Suma de lo aplicado (cobros + notas de crédito). NO es una columna: lo calcula el repositorio al leer.
   * Es lo que permite derivar el saldo sin guardar un número que se pueda desincronizar.
   */
  appliedCents: number;
}

/** Una nota de crédito (o un cobro) que reduce la deuda de una partida. */
export interface CreditApplication {
  id: string;
  organizationId: string;
  receivableId: string;
  /** Id del comprobante que reduce la partida: la nota de crédito (o el recibo, en el bloque B). */
  sourceId: string;
  sourceType: 'credit_note' | 'receipt';
  documentNumber: string | null;
  appliedCents: number;
  appliedAt: string;
  createdAt: Date;
  /** Recibo anulado: la aplicación NO se borra (la historia queda) pero ya no cuenta en el saldo. `null`/ausente = vigente. */
  reversedAt?: Date | null;
}

/** Origen de un saldo a favor del cliente. */
export type CustomerAdvanceOrigin = 'credit_note' | 'receipt';

export interface CustomerAdvance {
  id: string;
  organizationId: string;
  customerId: string;
  customerName: string;
  customerIdentification: string | null;
  origin: CustomerAdvanceOrigin;
  /** Id del comprobante que lo originó (la nota de crédito o el recibo). */
  originId: string;
  /**
   * Factura a la que se refiere el saldo a favor. `null` cuando la nota de crédito no traía una factura conocida:
   * entonces el saldo se aplica a la próxima factura del cliente.
   */
  relatedInvoiceId: string | null;
  documentNumber: string | null;
  currencyCode: string;
  originalCents: number;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  /** Suma de lo consumido por este saldo a favor. Derivado, como el saldo de la partida. */
  appliedCents: number;
  /** Anticipo de un recibo anulado: ya no existe para el saldo del cliente (no se borra). `null`/ausente = vigente. */
  voidedAt?: Date | null;
}

/** Consumo de un saldo a favor contra una partida. */
export interface CustomerAdvanceApplication {
  id: string;
  organizationId: string;
  advanceId: string;
  receivableId: string;
  appliedCents: number;
  createdAt: Date;
}

/** Condiciones de crédito de un cliente: días de plazo y cupo (informativo, no bloquea la facturación). */
export interface CustomerTerms {
  organizationId: string;
  customerId: string;
  customerName: string;
  creditDays: number;
  /** `null`: sin cupo. El cupo se guarda y se muestra; bloquear la facturación es decisión del dueño (fase 7). */
  creditLimitCents: number | null;
  updatedBy: string;
  updatedAt: Date;
}

/** Cabecera de una carga de saldos iniciales de cartera. */
export interface OpeningBalanceLoad {
  id: string;
  organizationId: string;
  /** `AAAA-MM-DD`. Una carga por (organización, fecha de corte): repetirla duplicaría la cartera. */
  cutoffDate: string;
  loadedBy: string;
  reason: string;
  totalCents: number;
  createdAt: Date;
}

/**
 * Saldo de una partida.
 *
 * - `cancelled`: la factura se anuló y contabilidad revirtió su débito; lo que se le había acreditado (una nota de
 *   crédito) NO se revierte, así que el saldo queda en contra, que es justo lo que dice el libro mayor.
 * - `written_off`: la deuda se castigó; el saldo es cero (el castigo necesita su contrapartida en contabilidad, que es
 *   una fase posterior).
 * - resto: lo que se abrió originalmente menos lo aplicado.
 */
export function balanceOf(receivable: Pick<Receivable, 'status' | 'originalCents' | 'appliedCents'>): number {
  // `0 - x` y no `-x`: sin aplicaciones daría `-0`, que se imprime y se compara distinto de cero.
  if (receivable.status === 'cancelled') return 0 - receivable.appliedCents;
  if (receivable.status === 'written_off') return 0;
  return receivable.originalCents - receivable.appliedCents;
}

/**
 * Estado DERIVADO de una partida.
 *
 * `cancelled` y `written_off` son terminales: se quedan como estaban aunque el saldo cambie. El resto se deduce de
 * lo aplicado: sin aplicaciones `open`, con parte `partial`, con todo `paid`.
 */
export function deriveStatus(
  current: ReceivableStatus,
  originalCents: number,
  appliedCents: number,
): ReceivableStatus {
  if (current === 'cancelled' || current === 'written_off') return current;
  if (appliedCents <= 0) return 'open';
  if (appliedCents >= originalCents) return 'paid';
  return 'partial';
}

/** Saldo pendiente de un saldo a favor: lo que queda por aplicar. */
export function advanceBalanceOf(advance: Pick<CustomerAdvance, 'originalCents' | 'appliedCents'>): number {
  return advance.originalCents - advance.appliedCents;
}
