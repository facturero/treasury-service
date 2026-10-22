import { describe, expect, it } from 'vitest';
import { defaultImportProfile, validateAdjustmentInput, validateBankAccountInput, type ImportProfile } from '../domain/bank.js';
import { computeReconciliation, registerBalanceOf, suggestMatches, type ReconLine, type ReconMovement } from '../domain/bank-reconciliation.js';
import { buildCashFlow } from '../domain/cash-flow.js';
import { ValidationError } from '../domain/errors.js';
import { normalizeReference, parseAmountToCents, parseDate, parseStatement, splitCsv } from '../domain/statement-import.js';

const profile = (over: Partial<ImportProfile> = {}): ImportProfile => ({ ...defaultImportProfile(), referenceColumn: 3, amountColumn: 4, balanceColumn: 5, ...over });

describe('importes del extracto: texto → centavos, sin pasar por coma flotante', () => {
  it('lee punto y coma decimal, miles, símbolo y negativos en sus formas', () => {
    expect(parseAmountToCents('1,234.56', '.')).toBe(123456);
    expect(parseAmountToCents('1.234,56', ',')).toBe(123456);
    expect(parseAmountToCents('$ 12.5', '.')).toBe(1250);
    expect(parseAmountToCents('-12.50', '.')).toBe(-1250);
    expect(parseAmountToCents('(12,50)', ',')).toBe(-1250);
    expect(parseAmountToCents('12,50-', ',')).toBe(-1250);
    expect(parseAmountToCents('0.10', '.') + parseAmountToCents('0.20', '.')!).toBe(30); // 0.1 + 0.2 sin error de flotante
  });
  it('rechaza lo que no es un importe y NO redondea más de dos decimales', () => {
    expect(parseAmountToCents('', '.')).toBeNull();
    expect(parseAmountToCents('abc', '.')).toBeNull();
    expect(parseAmountToCents('12.345', '.')).toBeNull();
    expect(parseAmountToCents('1.234,56', '.')).toBeNull(); // formato europeo con perfil de punto decimal
    expect(parseAmountToCents('1.2.3', '.')).toBeNull();
  });
});

describe('fechas del extracto', () => {
  it('respeta el formato y rechaza días que no existen', () => {
    expect(parseDate('13/10/2026', 'DD/MM/YYYY')).toBe('2026-10-13');
    expect(parseDate('10/13/2026', 'MM/DD/YYYY')).toBe('2026-10-13');
    expect(parseDate('2026-10-13', 'YYYY-MM-DD')).toBe('2026-10-13');
    expect(parseDate('13-10-2026', 'DD-MM-YYYY')).toBe('2026-10-13');
    expect(parseDate('31/02/2026', 'DD/MM/YYYY')).toBeNull();
    expect(parseDate('13/10/26', 'DD/MM/YYYY')).toBeNull();
    expect(parseDate('13/10/2026', 'YYYY-MM-DD')).toBeNull();
  });
});

describe('CSV', () => {
  it('respeta comillas, delimitador dentro de comillas y saltos de línea dentro de una celda', () => {
    expect(splitCsv('a,"b,c","d ""e""",f\n1,2,3,4\n', ',')).toEqual([['a', 'b,c', 'd "e"', 'f'], ['1', '2', '3', '4']]);
    expect(splitCsv('x;"l1\nl2";y', ';')).toEqual([['x', 'l1\nl2', 'y']]);
  });
});

describe('importar un extracto', () => {
  const csv = [
    'Fecha,Descripcion,Referencia,Monto,Saldo',
    '01/10/2026,"Transferencia ACME",TRX-100,"1,000.00","1,500.00"',
    '02/10/2026,Comision mensual,,-2.50,1497.50',
    '03/10/2026,Cheque 0045,45,-300.00,1197.50',
  ].join('\r\n');

  it('lee los renglones con su signo, el periodo y el saldo de cierre', () => {
    const r = parseStatement(csv, profile(), { openingDate: '2026-09-30' });
    expect(r.errors).toEqual([]);
    expect(r.lines.map((l) => [l.lineDate, l.amountCents, l.reference])).toEqual([
      ['2026-10-01', 100000, 'TRX-100'],
      ['2026-10-02', -250, null],
      ['2026-10-03', -30000, '45'],
    ]);
    expect(r.periodStart).toBe('2026-10-01');
    expect(r.periodEnd).toBe('2026-10-03');
    expect(r.closingBalanceCents).toBe(119750);
    expect(r.closingDate).toBe('2026-10-03');
  });

  it('un archivo del más nuevo al más viejo toma el saldo de cierre del primer renglón', () => {
    const desc = ['Fecha,Descripcion,Referencia,Monto,Saldo', '03/10/2026,B,,-300.00,1197.50', '01/10/2026,A,,1000.00,1500.00'].join('\n');
    expect(parseStatement(desc, profile(), { openingDate: '2026-09-30' }).closingBalanceCents).toBe(119750);
  });

  it('el mismo contenido tiene el mismo hash aunque cambie el fin de línea o el BOM', () => {
    const a = parseStatement(csv, profile(), { openingDate: '2026-09-30' }).contentHash;
    const b = parseStatement('﻿' + csv.replace(/\r\n/g, '\n') + '\n', profile(), { openingDate: '2026-09-30' }).contentHash;
    expect(a).toBe(b);
  });

  it('todo o nada: cada fila mala dice su número de fila y su campo', () => {
    const bad = ['Fecha,D,R,M,S', '32/10/2026,x,,5.00,', '02/10/2026,x,,5.555,', '03/10/2026,x,,0.00,', '04/10/2026,x,,5.00,abc'].join('\n');
    const r = parseStatement(bad, profile(), { openingDate: '2026-09-30' });
    expect(r.errors.map((e) => [e.row, e.field])).toEqual([[2, 'date'], [3, 'amount'], [4, 'amount'], [5, 'balance']]);
  });

  it('lo anterior a la fecha de apertura se omite y se cuenta, no es un error', () => {
    const r = parseStatement(csv, profile(), { openingDate: '2026-10-01' });
    expect(r.errors).toEqual([]);
    expect(r.skippedBeforeOpening).toBe(1);
    expect(r.lines).toHaveLength(2);
  });

  it('dos renglones idénticos del mismo archivo NO son uno: la huella lleva la ocurrencia', () => {
    const twice = ['Fecha,D,R,M,S', '02/10/2026,Comision,,-2.50,', '02/10/2026,Comision,,-2.50,'].join('\n');
    const r = parseStatement(twice, profile(), { openingDate: '2026-09-30' });
    expect(r.lines).toHaveLength(2);
    expect(new Set(r.lines.map((l) => l.fingerprint)).size).toBe(2);
  });

  it('débito/crédito en dos columnas, con coma decimal y el signo invertido', () => {
    const dc = ['Fecha;Desc;Ref;Debito;Credito', '01/10/2026;Pago luz;;"1.250,40";', '02/10/2026;Deposito;D1;;"300,00"'].join('\n');
    const p = profile({ delimiter: ';', decimalSeparator: ',', amountMode: 'debit_credit', amountColumn: null, debitColumn: 4, creditColumn: 5, balanceColumn: null });
    const r = parseStatement(dc, p, { openingDate: '2026-09-30' });
    expect(r.errors).toEqual([]);
    expect(r.lines.map((l) => l.amountCents)).toEqual([-125040, 30000]);
    const inverted = parseStatement('Fecha,D,R,M\n01/10/2026,x,,5.00', profile({ invertSign: true, balanceColumn: null }), { openingDate: '2026-09-30' });
    expect(inverted.lines[0]!.amountCents).toBe(-500);
  });

  it('un perfil incompleto es 422 y un archivo enorme también', () => {
    expect(() => parseStatement(csv, profile({ amountColumn: null }), { openingDate: '2026-09-30' })).toThrow(ValidationError);
    expect(() => parseStatement('x'.repeat(2 * 1024 * 1024 + 1), profile(), { openingDate: '2026-09-30' })).toThrow(ValidationError);
  });
});

describe('sugerencias de emparejamiento', () => {
  const line = (id: string, date: string, amountCents: number, reference: string | null = null, description = '') => ({ id, date, amountCents, reference, description });
  const mov = (id: string, date: string, amountCents: number, reference: string | null = null) => ({ id, date, amountCents, reference, description: '' });

  it('importe exacto + referencia coincidente (aunque pasen semanas) o fecha cercana', () => {
    const s = suggestMatches(
      [line('l1', '2026-10-20', -30000, '000451'), line('l2', '2026-10-03', 5000)],
      [mov('m1', '2026-10-01', -30000, '451'), mov('m2', '2026-10-02', 5000)],
    );
    expect(s).toEqual([
      { lineId: 'l1', movementId: 'm1', reason: 'reference', dayDiff: 19 },
      { lineId: 'l2', movementId: 'm2', reason: 'date', dayDiff: 1 },
    ]);
  });

  it('el signo cuenta: un depósito de 50 no se empareja con un pago de 50', () => {
    expect(suggestMatches([line('l1', '2026-10-03', 5000)], [mov('m1', '2026-10-03', -5000)])).toEqual([]);
  });

  it('fuera de la ventana y sin referencia no se sugiere nada', () => {
    expect(suggestMatches([line('l1', '2026-10-20', 5000)], [mov('m1', '2026-10-01', 5000)])).toEqual([]);
  });

  it('dos iguales sin forma de distinguirlos NO se emparejan solos; con referencia, sí', () => {
    const lines = [line('l1', '2026-10-03', 5000), line('l2', '2026-10-03', 5000)];
    expect(suggestMatches(lines, [mov('m1', '2026-10-03', 5000), mov('m2', '2026-10-03', 5000)])).toEqual([]);
    expect(suggestMatches([line('l1', '2026-10-03', 5000, 'AAA111'), line('l2', '2026-10-03', 5000, 'BBB222')], [mov('m1', '2026-10-03', 5000, 'BBB222'), mov('m2', '2026-10-03', 5000, 'AAA111')])).toEqual([
      { lineId: 'l1', movementId: 'm2', reason: 'reference', dayDiff: 0 },
      { lineId: 'l2', movementId: 'm1', reason: 'reference', dayDiff: 0 },
    ]);
  });

  it('un movimiento que dos renglones se disputan no se sugiere a ninguno', () => {
    expect(suggestMatches([line('l1', '2026-10-03', 5000), line('l2', '2026-10-04', 5000)], [mov('m1', '2026-10-03', 5000)])).toEqual([
      { lineId: 'l1', movementId: 'm1', reason: 'date', dayDiff: 0 },
    ]); // l1 es estrictamente mejor (0 días vs 1) y m1 también la prefiere: es inequívoco
    expect(suggestMatches([line('l1', '2026-10-02', 5000), line('l2', '2026-10-04', 5000)], [mov('m1', '2026-10-03', 5000)])).toEqual([]); // empate de distancia
  });

  it('la referencia se compara sin espacios, símbolos ni ceros a la izquierda; una referencia corta no vale', () => {
    expect(normalizeReference(' 000-45 ')).toBe('45');
    expect(suggestMatches([line('l1', '2026-12-01', 5000, '45')], [mov('m1', '2026-10-01', 5000, '45')])).toEqual([]); // «45» tiene 2 caracteres: no basta
  });
});

describe('conciliación', () => {
  const account = { openingBalanceCents: 100000, openingDate: '2026-09-30' };
  const base = { ...account, cutoffDate: '2026-10-31' };

  it('el caso de manual: un depósito cobrado y un cheque sin cobrar concilian con diferencia cero', () => {
    const movements: ReconMovement[] = [
      { id: 'm1', date: '2026-10-01', amountCents: 50000, clearedOn: '2026-10-02' },
      { id: 'm2', date: '2026-10-05', amountCents: -4000, clearedOn: null }, // cheque en circulación
    ];
    const lines: ReconLine[] = [{ id: 'l1', date: '2026-10-02', amountCents: 50000, status: 'matched' }];
    const r = computeReconciliation({ ...base, statementBalanceCents: 150000, movements, lines });
    expect(r).toMatchObject({ registerBalanceCents: 146000, pendingCents: -4000, pendingCount: 1, unresolvedLines: 0, differenceCents: 0, canClose: true });
  });

  it('un renglón del banco sin resolver (una comisión) deja diferencia y no deja cerrar', () => {
    const lines: ReconLine[] = [{ id: 'l1', date: '2026-10-10', amountCents: -250, status: 'unmatched' }];
    const r = computeReconciliation({ ...base, statementBalanceCents: 99750, movements: [], lines });
    expect(r).toMatchObject({ differenceCents: -250, unresolvedLines: 1, unresolvedCents: -250, canClose: false });
  });

  it('marcar el renglón como externo (ya está en el mayor) lo mete en el registro y cuadra', () => {
    const lines: ReconLine[] = [{ id: 'l1', date: '2026-10-10', amountCents: 20000, status: 'external' }];
    expect(computeReconciliation({ ...base, statementBalanceCents: 120000, movements: [], lines })).toMatchObject({ differenceCents: 0, canClose: true });
  });

  it('un movimiento que el banco cobró DESPUÉS del corte sigue pendiente a esa fecha', () => {
    const movements: ReconMovement[] = [{ id: 'm1', date: '2026-10-28', amountCents: -1000, clearedOn: '2026-11-02' }];
    const r = computeReconciliation({ ...base, statementBalanceCents: 100000, movements, lines: [{ id: 'l1', date: '2026-11-02', amountCents: -1000, status: 'matched' }] });
    expect(r).toMatchObject({ registerBalanceCents: 99000, pendingCents: -1000, differenceCents: 0, canClose: true });
  });

  it('lo posterior al corte y lo anterior a la apertura no cuentan', () => {
    const movements: ReconMovement[] = [
      { id: 'm1', date: '2026-09-15', amountCents: 999, clearedOn: null },
      { id: 'm2', date: '2026-11-15', amountCents: 888, clearedOn: null },
    ];
    expect(computeReconciliation({ ...base, statementBalanceCents: 100000, movements, lines: [] })).toMatchObject({ registerBalanceCents: 100000, pendingCount: 0, canClose: true });
  });

  it('un saldo de extracto equivocado se ve como diferencia', () => {
    const r = computeReconciliation({ ...base, statementBalanceCents: 100500, movements: [], lines: [] });
    expect(r).toMatchObject({ differenceCents: 500, canClose: false });
  });

  it('el saldo actual del registro: apertura + movimientos y externos posteriores', () => {
    expect(registerBalanceOf(account, [{ date: '2026-10-01', amountCents: 500 }, { date: '2026-09-01', amountCents: 9999 }], [{ date: '2026-10-02', amountCents: -100 }])).toBe(100400);
  });
});

describe('flujo de caja', () => {
  it('reparte por semanas, junta lo vencido en la primera columna y lo lejano en «después»', () => {
    const cf = buildCashFlow({
      asOf: '2026-10-22',
      weeks: 2,
      openingCents: 100000,
      receivables: [
        { dueDate: '2026-10-01', balanceCents: 30000 }, // vencido
        { dueDate: '2026-10-22', balanceCents: 10000 }, // hoy → semana 1
        { dueDate: '2026-11-04', balanceCents: 5000 }, // día 13 → semana 2
        { dueDate: '2026-12-31', balanceCents: 7000 }, // después
      ],
      payables: [
        { dueDate: '2026-10-28', balanceCents: 50000 }, // día 6 → semana 1
        { dueDate: '2026-11-05', balanceCents: 200000 }, // día 14 → semana 3 = «después»
        { dueDate: '2026-10-25', balanceCents: -5 }, // un saldo negativo no es deuda
      ],
    });
    expect(cf.buckets.map((b) => [b.key, b.inflowCents, b.outflowCents, b.closingCents])).toEqual([
      ['overdue', 30000, 0, 130000],
      ['w1', 10000, 50000, 90000],
      ['w2', 5000, 0, 95000],
      ['later', 7000, 200000, -98000],
    ]);
    expect(cf.totals).toMatchObject({ inflowCents: 52000, outflowCents: 250000, overdueInflowCents: 30000, endingCents: -98000 });
    expect(cf.firstNegativeKey).toBe('later');
    expect(cf.buckets[1]).toMatchObject({ from: '2026-10-22', to: '2026-10-28' });
  });
});

describe('formularios', () => {
  it('cuenta bancaria: solo los últimos 4 dígitos, nunca el número completo', () => {
    const ok = { name: 'Pichincha', bankName: 'Banco Pichincha', accountType: 'checking' as const, accountLast4: '1234', openingBalanceCents: 0, openingDate: '2026-09-30' };
    expect(() => validateBankAccountInput(ok)).not.toThrow();
    expect(() => validateBankAccountInput({ ...ok, accountLast4: '2200123456789' })).toThrow(ValidationError);
    expect(() => validateBankAccountInput({ ...ok, openingDate: '2026-02-31' })).toThrow(ValidationError);
    expect(() => validateBankAccountInput({ ...ok, name: ' ' })).toThrow(ValidationError);
  });
  it('ajuste: importe positivo y glosa', () => {
    const ok = { bankAccountId: 'b', kind: 'bank_fee' as const, date: '2026-10-02', amountCents: 250, description: 'Comisión mensual' };
    expect(() => validateAdjustmentInput(ok)).not.toThrow();
    expect(() => validateAdjustmentInput({ ...ok, amountCents: -250 })).toThrow(ValidationError);
    expect(() => validateAdjustmentInput({ ...ok, description: 'x' })).toThrow(ValidationError);
  });
});
