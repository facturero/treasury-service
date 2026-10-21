import { ValidationError } from './errors.js';

/**
 * Importes de tesorería: centavos ENTEROS, igual que facturación, compras y contabilidad.
 *
 * El saldo de una partida NUNCA es una columna que se reste a mano: se DERIVA sumando las aplicaciones (ver
 * `domain/receivable.ts`). Así, reintentar un evento que ya se aplicó no descuadra la cartera.
 */
export function assertCents(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ValidationError([{ field, message: 'El importe debe ser un número entero de centavos, sin signo.' }]);
  }
}

/**
 * Suma de centavos en `bigint`: el saldo de una cartera grande puede pasar de `Number.MAX_SAFE_INTEGER` antes que perder
 * un céntimo en el camino.
 */
export function sumCents(values: readonly number[]): number {
  return Number(values.reduce((acc, v) => acc + BigInt(v), 0n));
}
