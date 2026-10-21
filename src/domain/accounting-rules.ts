/**
 * Reglas que tesorería COPIA de `accounting-service` para no abrir una partida que contabilidad no va a asentar.
 *
 * La prueba de oro del bloque A exige que la suma de saldos de la cartera cuadre al centavo con el saldo de
 * `receivables` del libro mayor. Contabilidad decide qué comprobantes asienta y con qué cuenta; si tesorería no
 * aplica exactamente los mismos filtros, cualquier diferencia entre los dosabre una brecha que nadie ve hasta que
 * se cuadran las cuentas.
 *
 * Por eso estas reglas son una COPIA, no una interpretación: si contabilidad cambia, hay que cambiar aquí.
 */

/** Rol contable que recibe el cobro: la caja, el banco o la cuenta por cobrar. */
export type CollectionRole = 'cash' | 'bank' | 'receivables';

/**
 * 01 sin utilización del sistema financiero (efectivo) → caja; 16 débito, 17 dinero electrónico, 18 prepago, 19 crédito y 20 otros
 * con utilización del sistema financiero → bancos; el resto (15 compensación, 21 endoso…) o ninguna → por cobrar.
 *
 * Copia literal de `accounting-service/src/domain/posting.ts` (`DEFAULT_PAYMENT_METHOD_ROLES`).
 */
export const DEFAULT_PAYMENT_METHOD_ROLES: Readonly<Record<string, CollectionRole>> = {
  '01': 'cash',
  '16': 'bank',
  '17': 'bank',
  '18': 'bank',
  '19': 'bank',
  '20': 'bank',
};

/**
 * Con qué cuenta se asienta el cobro de este comprobante. Copia de `collectionRoleFor` de contabilidad: sin forma de
 * pago, o con una que no usa el sistema financiero, la venta queda POR COBRAR.
 */
export function collectionRoleFor(code: string | null | undefined, overrides: Record<string, CollectionRole> | null): CollectionRole {
  if (!code) return 'receivables';
  return overrides?.[code] ?? DEFAULT_PAYMENT_METHOD_ROLES[code] ?? 'receivables';
}

/** Comprobantes que abren deuda con el cliente (factura y nota de débito). */
export const DEBT_DOCUMENT_TYPES: readonly string[] = ['01', '05'];
/** Nota de crédito: abona a la partida que la originó. */
export const CREDIT_NOTE_DOCUMENT_TYPE = '04';

/**
 * Verifica que el comprobante cuadra como lo exige contabilidad (`draftFromInvoiceIssued`): ventas + IVA = total.
 *
 * Contabilidad deja el comprobante en «Pendientes» (`UNBALANCED_SOURCE`) si no cuadra, y en «Pendientes»
 * (`UNMAPPED_TAX_KIND`) si lleva un impuesto que no sea IVA. Si tesoreríaabriera una partida en esos casos, la
 * cartera y el libro mayor divergirían. Se calcula con las LÍNEAS porque es lo que mira contabilidad (no con
 * `subtotalCents`/`taxTotalCents` del comprobante): si el evento no trae líneas, no se puede verificar y no se abre
 * partida, que es lo mismo que hace contabilidad.
 */
export function isPostableInvoice(lines: readonly { subtotalCents?: number; taxes?: { kind: string; amountCents?: number }[] }[] | undefined, totalCents: number): boolean {
  if (!lines || !lines.length) return false;
  let revenue = 0;
  let vat = 0;
  for (const line of lines) {
    revenue += Math.round(Number(line.subtotalCents ?? 0));
    for (const tax of line.taxes ?? []) {
      if (tax.kind !== 'vat') return false;
      vat += Math.round(Number(tax.amountCents ?? 0));
    }
  }
  return revenue + vat === Math.round(totalCents);
}
