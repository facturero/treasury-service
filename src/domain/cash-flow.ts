import { addDays, daysBetween } from './dates.js';

/**
 * Flujo de caja proyectado: DERIVADO, solo lectura. Parte del saldo del registro de bancos y suma lo que se espera cobrar (cartera) y resta lo
 * que se espera pagar (deuda) según su vencimiento, en semanas.
 *
 *  - Lo YA vencido cae en la primera columna («vencido»): se espera cobrar o pagar ya, no en una fecha pasada.
 *  - Lo que vence después del horizonte se junta en «después».
 *  - Es una proyección con las fechas de vencimiento, no un pronóstico: un cliente que paga tarde mueve su cobro. Por eso muestra
 *    también lo vencido por separado, para que se vea cuánto de lo proyectado depende de cobros atrasados.
 */

export const MIN_CASH_FLOW_WEEKS = 1;
export const MAX_CASH_FLOW_WEEKS = 26;
export const DEFAULT_CASH_FLOW_WEEKS = 13;

export interface DueItem {
  dueDate: string;
  /** Saldo vivo, siempre positivo. */
  balanceCents: number;
}

export interface CashFlowBucket {
  /** `overdue`, `w1`…`wN`, `later`. */
  key: string;
  from: string | null;
  to: string | null;
  inflowCents: number;
  outflowCents: number;
  netCents: number;
  /** Saldo proyectado al final de la columna. */
  closingCents: number;
}

export interface CashFlow {
  asOf: string;
  weeks: number;
  openingCents: number;
  buckets: CashFlowBucket[];
  totals: { inflowCents: number; outflowCents: number; overdueInflowCents: number; overdueOutflowCents: number; endingCents: number };
  /** Primera columna donde el saldo proyectado queda negativo (la alerta que importa), o `null`. */
  firstNegativeKey: string | null;
}

export function buildCashFlow(input: { asOf: string; weeks: number; openingCents: number; receivables: readonly DueItem[]; payables: readonly DueItem[] }): CashFlow {
  const { asOf, weeks } = input;
  const buckets: CashFlowBucket[] = [{ key: 'overdue', from: null, to: addDays(asOf, -1), inflowCents: 0, outflowCents: 0, netCents: 0, closingCents: 0 }];
  for (let w = 1; w <= weeks; w++) {
    buckets.push({ key: `w${w}`, from: addDays(asOf, (w - 1) * 7), to: addDays(asOf, w * 7 - 1), inflowCents: 0, outflowCents: 0, netCents: 0, closingCents: 0 });
  }
  buckets.push({ key: 'later', from: addDays(asOf, weeks * 7), to: null, inflowCents: 0, outflowCents: 0, netCents: 0, closingCents: 0 });

  const indexOf = (dueDate: string): number => {
    const days = daysBetween(asOf, dueDate);
    if (days < 0) return 0;
    const week = Math.floor(days / 7) + 1;
    return week > weeks ? buckets.length - 1 : week;
  };
  let overdueIn = 0;
  let overdueOut = 0;
  for (const r of input.receivables) {
    if (r.balanceCents <= 0) continue;
    const b = buckets[indexOf(r.dueDate)]!;
    b.inflowCents += r.balanceCents;
    if (b.key === 'overdue') overdueIn += r.balanceCents;
  }
  for (const p of input.payables) {
    if (p.balanceCents <= 0) continue;
    const b = buckets[indexOf(p.dueDate)]!;
    b.outflowCents += p.balanceCents;
    if (b.key === 'overdue') overdueOut += p.balanceCents;
  }
  let running = input.openingCents;
  let firstNegativeKey: string | null = null;
  let inflow = 0;
  let outflow = 0;
  for (const b of buckets) {
    b.netCents = b.inflowCents - b.outflowCents;
    running += b.netCents;
    b.closingCents = running;
    inflow += b.inflowCents;
    outflow += b.outflowCents;
    if (firstNegativeKey === null && running < 0) firstNegativeKey = b.key;
  }
  return {
    asOf,
    weeks,
    openingCents: input.openingCents,
    buckets,
    totals: { inflowCents: inflow, outflowCents: outflow, overdueInflowCents: overdueIn, overdueOutflowCents: overdueOut, endingCents: running },
    firstNegativeKey,
  };
}
