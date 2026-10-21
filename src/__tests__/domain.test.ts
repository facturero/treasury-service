import { describe, expect, it } from 'vitest';
import { collectionRoleFor, isPostableInvoice } from '../domain/accounting-rules.js';
import { addDays, daysBetween, isLocalDate, localDateOf } from '../domain/dates.js';
import { ValidationError } from '../domain/errors.js';
import { assertCents, sumCents } from '../domain/money.js';
import { advanceBalanceOf, balanceOf, deriveStatus } from '../domain/receivable.js';

describe('fechas de calendario (sin hora, sin UTC)', () => {
  it('una fecha sin hora se devuelve tal cual, no se corre un día', () => {
    // Era el bug de la Fase 2: `new Date('2026-10-20')` es medianoche UTC y en Guayaquil (UTC-5) sale el 19.
    expect(localDateOf('2026-10-20', 'America/Guayaquil')).toBe('2026-10-20');
    expect(localDateOf('2026-11-01', 'America/Guayaquil')).toBe('2026-11-01');
  });

  it('un instante a las 23:30 hora de Ecuador sigue siendo ese día aunque en UTC ya sea el siguiente', () => {
    // 2026-10-20 23:30 en Guayaquil = 2026-10-21 04:30 UTC
    expect(localDateOf('2026-10-21T04:30:00.000Z', 'America/Guayaquil')).toBe('2026-10-20');
    // y a las 00:30 locales ya es el día siguiente
    expect(localDateOf('2026-10-21T05:30:00.000Z', 'America/Guayaquil')).toBe('2026-10-21');
  });

  it('acepta un Date y rechaza fechas imposibles', () => {
    expect(localDateOf(new Date('2026-10-21T15:00:00.000Z'), 'America/Guayaquil')).toBe('2026-10-21');
    expect(() => localDateOf('2026-02-30', 'America/Guayaquil')).toThrow();
    expect(() => localDateOf('no es fecha', 'America/Guayaquil')).toThrow();
  });

  it('isLocalDate valida el calendario real', () => {
    expect(isLocalDate('2028-02-29')).toBe(true); // bisiesto
    expect(isLocalDate('2026-02-29')).toBe(false);
    expect(isLocalDate('2026-13-01')).toBe(false);
    expect(isLocalDate('2026-1-1')).toBe(false);
  });

  it('addDays cruza fin de mes, de año y de febrero bisiesto', () => {
    expect(addDays('2026-10-20', 30)).toBe('2026-11-19');
    expect(addDays('2026-12-15', 30)).toBe('2027-01-14');
    expect(addDays('2028-02-15', 30)).toBe('2028-03-16');
    expect(addDays('2026-10-20', 0)).toBe('2026-10-20');
  });

  it('daysBetween cuenta días de calendario, con signo', () => {
    expect(daysBetween('2026-10-01', '2026-10-31')).toBe(30);
    expect(daysBetween('2026-10-31', '2026-10-01')).toBe(-30);
    expect(daysBetween('2026-10-01', '2026-10-01')).toBe(0);
  });
});

describe('importes', () => {
  it('assertCents exige centavos enteros y sin signo', () => {
    expect(() => assertCents(100, 'x')).not.toThrow();
    expect(() => assertCents(0, 'x')).not.toThrow();
    expect(() => assertCents(10.5, 'x')).toThrow(ValidationError);
    expect(() => assertCents(-1, 'x')).toThrow(ValidationError);
    expect(() => assertCents(Number.NaN, 'x')).toThrow(ValidationError);
  });

  it('sumCents suma sin perder un centavo', () => {
    expect(sumCents([1150, 2300, 1])).toBe(3451);
    expect(sumCents([])).toBe(0);
    expect(sumCents([Number.MAX_SAFE_INTEGER, 0])).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe('saldo y estado: se derivan, no se guardan', () => {
  const base = { originalCents: 10000 };

  it('el saldo es lo original menos lo aplicado', () => {
    expect(balanceOf({ ...base, status: 'open', appliedCents: 0 })).toBe(10000);
    expect(balanceOf({ ...base, status: 'partial', appliedCents: 2500 })).toBe(7500);
    expect(balanceOf({ ...base, status: 'paid', appliedCents: 10000 })).toBe(0);
  });

  it('una partida anulada deja el saldo EN CONTRA si se le había acreditado algo (lo que dice el libro mayor)', () => {
    expect(balanceOf({ ...base, status: 'cancelled', appliedCents: 0 })).toBe(0);
    expect(balanceOf({ ...base, status: 'cancelled', appliedCents: 2300 })).toBe(-2300);
  });

  it('una partida castigada tiene saldo cero', () => {
    expect(balanceOf({ ...base, status: 'written_off', appliedCents: 1000 })).toBe(0);
  });

  it('deriveStatus: open, partial y paid según lo aplicado', () => {
    expect(deriveStatus('open', 10000, 0)).toBe('open');
    expect(deriveStatus('open', 10000, 1)).toBe('partial');
    expect(deriveStatus('partial', 10000, 9999)).toBe('partial');
    expect(deriveStatus('partial', 10000, 10000)).toBe('paid');
    expect(deriveStatus('open', 10000, 12000)).toBe('paid');
  });

  it('cancelled y written_off son terminales: no cambian aunque cambie lo aplicado', () => {
    expect(deriveStatus('cancelled', 10000, 10000)).toBe('cancelled');
    expect(deriveStatus('written_off', 10000, 0)).toBe('written_off');
  });

  it('el saldo a favor pendiente es lo original menos lo consumido', () => {
    expect(advanceBalanceOf({ originalCents: 2300, appliedCents: 800 })).toBe(1500);
  });
});

describe('reglas copiadas de contabilidad', () => {
  it('collectionRoleFor: sin forma de pago o con una que no usa el sistema financiero queda POR COBRAR', () => {
    expect(collectionRoleFor(null, null)).toBe('receivables');
    expect(collectionRoleFor(undefined, null)).toBe('receivables');
    expect(collectionRoleFor('15', null)).toBe('receivables'); // compensación de deudas
    expect(collectionRoleFor('21', null)).toBe('receivables'); // endoso de títulos
  });

  it('collectionRoleFor: efectivo es caja y las tarjetas/transferencias son bancos', () => {
    expect(collectionRoleFor('01', null)).toBe('cash');
    for (const code of ['16', '17', '18', '19', '20']) expect(collectionRoleFor(code, null)).toBe('bank');
  });

  it('collectionRoleFor: la organización puede cambiar el rol de una forma de pago', () => {
    expect(collectionRoleFor('01', { '01': 'receivables' })).toBe('receivables');
    expect(collectionRoleFor('20', { '01': 'cash' })).toBe('bank');
  });

  it('isPostableInvoice: ventas + IVA debe dar el total', () => {
    const ok = [{ subtotalCents: 10000, taxes: [{ kind: 'vat', amountCents: 1500 }] }];
    expect(isPostableInvoice(ok, 11500)).toBe(true);
    expect(isPostableInvoice(ok, 11499)).toBe(false);
  });

  it('isPostableInvoice: sin líneas, o con un impuesto que no es IVA, no se puede asentar', () => {
    expect(isPostableInvoice(undefined, 100)).toBe(false);
    expect(isPostableInvoice([], 100)).toBe(false);
    expect(isPostableInvoice([{ subtotalCents: 10000, taxes: [{ kind: 'ice', amountCents: 1500 }] }], 11500)).toBe(false);
  });

  it('isPostableInvoice: suma varias líneas y varios IVA', () => {
    const lines = [
      { subtotalCents: 5000, taxes: [{ kind: 'vat', amountCents: 750 }] },
      { subtotalCents: 5000, taxes: [{ kind: 'vat', amountCents: 0 }] },
    ];
    expect(isPostableInvoice(lines, 10750)).toBe(true);
  });
});
