/**
 * Fechas de calendario de la cartera: `AAAA-MM-DD`, sin hora y sin zona.
 *
 * En la Fase 2 una fecha sin hora pasó por `new Date()` y quedó un día antes en el huso de Ecuador: el asiento caía un día
 * antes (en otro periodo si era el 1.º de mes) y no se asentó nada. Aquí las fechas se manipulan como texto de calendario:
 * nunca se construyen instantes con ellas ni se convierten a UTC.
 */

const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isLocalDate(value: string): boolean {
  if (!LOCAL_DATE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  // `Date.UTC` aquí es aritmética de calendario pura: no convierte ningún instante, solo suma días a un día del calendario.
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

/** `2026-10-20` + 30 días → `2026-11-19`. Aritmética de calendario: no toca husos ni horas. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const shifted = new Date(Date.UTC(y, m - 1, d + days));
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

/** Días entre dos fechas de calendario (`b - a`). Negativo si `b` es anterior. */
export function daysBetween(a: string, b: string): number {
  const toDay = (value: string): number => {
    const [y, m, d] = value.split('-').map(Number) as [number, number, number];
    return Date.UTC(y, m - 1, d) / 86_400_000;
  };
  return toDay(b) - toDay(a);
}

/**
 * Fecha local `YYYY-MM-DD` de un instante en una zona horaria: una venta a las 20:00 en Guayaquil ya es «mañana» en UTC.
 *
 * Una fecha SIN hora (`2026-10-20`) ya ES una fecha local: no se convierte. Pasarla por `new Date()` la toma como medianoche
 * UTC y en Guayaquil (UTC-5) sale el día ANTERIOR. Es el mismo criterio que aplica `accounting-service` en `localDateOf`.
 */
export function localDateOf(instant: string | Date, timeZone: string): string {
  if (typeof instant === 'string' && LOCAL_DATE.test(instant)) {
    if (!isLocalDate(instant)) throw new Error(`fecha inválida: ${instant}`);
    return instant;
  }
  const d = typeof instant === 'string' ? new Date(instant) : instant;
  if (Number.isNaN(d.getTime())) throw new Error(`fecha inválida: ${String(instant)}`);
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
