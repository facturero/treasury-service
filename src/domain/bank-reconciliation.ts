import { daysBetween, addDays } from './dates.js';
import { normalizeReference } from './statement-import.js';

/**
 * Emparejamiento y conciliación bancaria. Todo aquí es PURO (sin base de datos): las reglas que importan se prueban sin infraestructura.
 *
 * La igualdad que se concilia, a una fecha de corte D:
 *
 *     saldo del extracto  =  saldo del registro  −  movimientos pendientes
 *
 *  - saldo del registro: apertura + movimientos activos de la cuenta + renglones marcados «externos» (ya contabilizados fuera de tesorería).
 *  - pendientes: movimientos del registro que el banco todavía no refleja a D (un cheque sin cobrar, un depósito en tránsito).
 *  - diferencia = saldo del extracto − (registro − pendientes). Cero = conciliado.
 */

// ── Sugerencias ──────────────────────────────────────────────────────────────

export interface SuggestLine {
  id: string;
  date: string;
  amountCents: number;
  description: string;
  reference: string | null;
}

export interface SuggestMovement {
  id: string;
  date: string;
  amountCents: number;
  reference: string | null;
  description: string;
}

export interface Suggestion {
  lineId: string;
  movementId: string;
  /** Por qué se sugiere: la persona decide con eso a la vista. */
  reason: 'reference' | 'date';
  dayDiff: number;
}

export const SUGGEST_DATE_WINDOW_DAYS = 5;
/** Con la referencia coincidente se perdona más distancia: un cheque puede cobrarse semanas después. */
export const SUGGEST_REFERENCE_WINDOW_DAYS = 45;

function referenceMatches(line: SuggestLine, movement: SuggestMovement): boolean {
  const ref = normalizeReference(movement.reference);
  if (ref.length < 3) return false;
  const lineRef = normalizeReference(line.reference);
  if (lineRef && (lineRef === ref || lineRef.includes(ref) || ref.includes(lineRef)) && Math.min(lineRef.length, ref.length) >= 3) return true;
  return normalizeReference(line.description).includes(ref);
}

/**
 * Sugiere pares 1↔1: mismo importe con signo, y (referencia coincidente, o fecha cercana). SOLO se sugiere cuando es inequívoco: el
 * movimiento es el mejor candidato del renglón Y el renglón es el mejor del movimiento, sin empate. Dos transferencias iguales el mismo día
 * contra dos cobros iguales NO se emparejan solas: nada se asume.
 */
export function suggestMatches(lines: readonly SuggestLine[], movements: readonly SuggestMovement[], options: { dateWindowDays?: number } = {}): Suggestion[] {
  const window = options.dateWindowDays ?? SUGGEST_DATE_WINDOW_DAYS;
  interface Candidate { line: SuggestLine; movement: SuggestMovement; score: number; reason: 'reference' | 'date'; dayDiff: number }
  const candidates: Candidate[] = [];
  for (const line of lines) {
    for (const movement of movements) {
      if (movement.amountCents !== line.amountCents) continue;
      const dayDiff = Math.abs(daysBetween(movement.date, line.date));
      const byReference = referenceMatches(line, movement);
      if (byReference && dayDiff <= SUGGEST_REFERENCE_WINDOW_DAYS) {
        candidates.push({ line, movement, score: 1000 - dayDiff, reason: 'reference', dayDiff });
      } else if (dayDiff <= window) {
        candidates.push({ line, movement, score: 100 - dayDiff, reason: 'date', dayDiff });
      }
    }
  }
  const best = <K extends 'line' | 'movement'>(by: K): Map<string, Candidate[]> => {
    const groups = new Map<string, Candidate[]>();
    for (const c of candidates) {
      const key = c[by].id;
      const list = groups.get(key);
      if (list) list.push(c);
      else groups.set(key, [c]);
    }
    return groups;
  };
  const byLine = best('line');
  const byMovement = best('movement');
  const top = (list: Candidate[]): Candidate | null => {
    const sorted = [...list].sort((a, b) => b.score - a.score);
    if (sorted.length > 1 && sorted[0]!.score === sorted[1]!.score) return null;
    return sorted[0]!;
  };
  const out: Suggestion[] = [];
  for (const [lineId, list] of byLine) {
    const pick = top(list);
    if (!pick) continue;
    const back = top(byMovement.get(pick.movement.id) ?? []);
    if (!back || back.line.id !== lineId) continue;
    out.push({ lineId, movementId: pick.movement.id, reason: pick.reason, dayDiff: pick.dayDiff });
  }
  return out.sort((a, b) => a.lineId.localeCompare(b.lineId));
}

// ── Conciliación ─────────────────────────────────────────────────────────────

export interface ReconMovement {
  id: string;
  date: string;
  amountCents: number;
  /** Fecha del renglón del extracto con el que está emparejado (el más tardío si son varios); `null` si no lo está. */
  clearedOn: string | null;
}

export interface ReconLine {
  id: string;
  date: string;
  amountCents: number;
  status: 'unmatched' | 'matched' | 'external';
}

export interface ReconciliationInput {
  openingBalanceCents: number;
  openingDate: string;
  cutoffDate: string;
  statementBalanceCents: number;
  /** Solo los movimientos ACTIVOS de la cuenta (los revertidos no cuentan). */
  movements: readonly ReconMovement[];
  lines: readonly ReconLine[];
}

export interface ReconciliationResult {
  registerBalanceCents: number;
  /** Suma con signo de los movimientos que el banco aún no refleja a la fecha de corte. */
  pendingCents: number;
  pendingCount: number;
  /** Renglones del extracto hasta el corte que nadie ha resuelto (ni emparejado ni marcado externo). */
  unresolvedLines: number;
  unresolvedCents: number;
  differenceCents: number;
  /** Se puede cerrar: diferencia cero y nada sin resolver. */
  canClose: boolean;
}

export function computeReconciliation(input: ReconciliationInput): ReconciliationResult {
  let register = input.openingBalanceCents;
  let pending = 0;
  let pendingCount = 0;
  for (const m of input.movements) {
    if (m.date <= input.openingDate) continue; // forma parte del saldo de apertura
    const cleared = m.clearedOn !== null && m.clearedOn <= input.cutoffDate;
    // Entra en el registro a la fecha de corte si es de esa fecha o anterior, o si el banco ya lo reflejó antes de ella.
    if (m.date <= input.cutoffDate || cleared) {
      register += m.amountCents;
      if (!cleared) {
        pending += m.amountCents;
        pendingCount++;
      }
    }
  }
  let unresolvedLines = 0;
  let unresolvedCents = 0;
  for (const l of input.lines) {
    if (l.date <= input.openingDate || l.date > input.cutoffDate) continue;
    if (l.status === 'external') register += l.amountCents;
    else if (l.status === 'unmatched') {
      unresolvedLines++;
      unresolvedCents += l.amountCents;
    }
  }
  const differenceCents = input.statementBalanceCents - (register - pending);
  // Un renglón sin resolver no está en el registro, así que la diferencia lo refleja: cerrar exige cero Y nada sin resolver.
  return {
    registerBalanceCents: register,
    pendingCents: pending,
    pendingCount,
    unresolvedLines,
    unresolvedCents,
    differenceCents,
    canClose: differenceCents === 0 && unresolvedLines === 0,
  };
}

/** Saldo actual del registro de una cuenta: apertura + movimientos activos posteriores + renglones externos posteriores. */
export function registerBalanceOf(
  account: { openingBalanceCents: number; openingDate: string },
  movements: readonly { date: string; amountCents: number }[],
  externalLines: readonly { date: string; amountCents: number }[],
): number {
  let total = account.openingBalanceCents;
  for (const m of movements) if (m.date > account.openingDate) total += m.amountCents;
  for (const l of externalLines) if (l.date > account.openingDate) total += l.amountCents;
  return total;
}

/** Último día del mes de una fecha: útil para proponer la fecha de corte de una conciliación mensual. */
export function monthEnd(date: string): string {
  const [y, m] = date.split('-').map(Number) as [number, number];
  const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
  return addDays(next, -1);
}
