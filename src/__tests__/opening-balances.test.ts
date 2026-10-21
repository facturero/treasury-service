import { describe, expect, it } from 'vitest';
import { balanceOf } from '../domain/receivable.js';
import { buildWorld, CUSTOMER_1, CUSTOMER_2, ORG_A, ORG_B, USER_1 } from './helpers.js';

const load = (w: ReturnType<typeof buildWorld>, overrides: Record<string, unknown> = {}) =>
  w.useCases.loadOpeningBalances.execute({
    organizationId: ORG_A,
    cutoffDate: '2026-09-30',
    reason: 'Saldos al arranque',
    userId: USER_1,
    lines: [{ customerId: CUSTOMER_1, documentNumber: 'ANT-1', issueDate: '2026-08-15', amountCents: 50000 }],
    ...overrides,
  } as never);

describe('saldos iniciales de cartera', () => {
  it('abre una partida por línea, con el nombre y la identificación del CATÁLOGO, y publica la carga', async () => {
    const w = buildWorld();
    const result = await load(w, {
      lines: [
        { customerId: CUSTOMER_1, customerName: 'NOMBRE QUE MANDA EL CLIENTE', documentNumber: 'ANT-1', issueDate: '2026-08-15', amountCents: 50000 },
        { customerId: CUSTOMER_2, issueDate: '2026-09-01', dueDate: '2026-09-15', amountCents: 12000 },
      ],
    });

    expect(result).toMatchObject({ cutoffDate: '2026-09-30', totalCents: 62000, loadedBy: USER_1, reason: 'Saldos al arranque' });
    const rows = w.receivables();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ sourceType: 'initial_balance', customerName: 'CLIENTE UNO S.A.', customerIdentification: '1790012345001', originalCents: 50000, currencyCode: 'USD' });
    expect(rows[1]).toMatchObject({ customerName: 'CLIENTE DOS', dueDate: '2026-09-15' });
    expect(w.events('treasury.opening_balance.loaded')).toHaveLength(1);
    expect(w.events('treasury.opening_balance.loaded')[0]!.payload).toMatchObject({ cutoffDate: '2026-09-30', totalCents: 62000, customerCount: 2, reason: 'Saldos al arranque', loadedBy: USER_1 });
    expect(w.events('treasury.receivable.opened')).toHaveLength(2);
  });

  it('el vencimiento sin fecha sale de los días de crédito del cliente', async () => {
    const w = buildWorld();
    await w.useCases.setCustomerTerms.execute({ organizationId: ORG_A, customerId: CUSTOMER_1, creditDays: 30, creditLimitCents: null, userId: 'u' });
    await load(w);
    expect(w.receivables()[0]!.dueDate).toBe('2026-09-14');
  });

  it('una sola carga por fecha de corte: repetirla es 409 y no duplica nada', async () => {
    const w = buildWorld();
    await load(w);
    await expect(load(w)).rejects.toMatchObject({ code: 'OPENING_BALANCE_ALREADY_LOADED', httpStatus: 409 });
    expect(w.receivables()).toHaveLength(1);
    expect(w.data.loads).toHaveLength(1);
  });

  it('otra fecha de corte sí se puede cargar', async () => {
    const w = buildWorld();
    await load(w);
    await load(w, { cutoffDate: '2026-10-31' });
    expect(w.receivables()).toHaveLength(2);
  });

  it('cada organización tiene su propia carga para la misma fecha de corte', async () => {
    const w = buildWorld();
    await load(w);
    await load(w, { organizationId: ORG_B });
    expect(w.receivables(ORG_A)).toHaveLength(1);
    expect(w.receivables(ORG_B)).toHaveLength(1);
  });

  it('todo o nada: si una partida falla a mitad, no queda ninguna ni la cabecera ni los eventos', async () => {
    const w = buildWorld();
    const original = w.data.events.push.bind(w.data.events);
    let calls = 0;
    w.data.events.push = (...items) => {
      calls += 1;
      if (calls === 2) throw new Error('fallo simulado');
      return original(...items);
    };
    await expect(
      load(w, { lines: [
        { customerId: CUSTOMER_1, issueDate: '2026-08-15', amountCents: 100 },
        { customerId: CUSTOMER_1, issueDate: '2026-08-16', amountCents: 200 },
      ] }),
    ).rejects.toThrow('fallo simulado');
    w.data.events.push = original;

    expect(w.receivables()).toHaveLength(0);
    expect(w.data.loads).toHaveLength(0);
    expect(w.data.events).toHaveLength(0);
  });

  describe('validaciones (422 con el campo)', () => {
    it.each([
      ['fecha de corte vacía', { cutoffDate: '' }, 'cutoffDate'],
      ['motivo vacío', { reason: '  ' }, 'reason'],
      ['motivo demasiado corto', { reason: 'x' }, 'reason'],
      ['sin líneas', { lines: [] }, 'lines'],
      ['importe cero', { lines: [{ customerId: CUSTOMER_1, issueDate: '2026-08-15', amountCents: 0 }] }, 'lines[0].amountCents'],
      ['importe negativo', { lines: [{ customerId: CUSTOMER_1, issueDate: '2026-08-15', amountCents: -5 }] }, 'lines[0].amountCents'],
      ['importe con decimales', { lines: [{ customerId: CUSTOMER_1, issueDate: '2026-08-15', amountCents: 10.5 }] }, 'lines[0].amountCents'],
      ['vencimiento anterior a la emisión', { lines: [{ customerId: CUSTOMER_1, issueDate: '2026-08-15', dueDate: '2026-08-01', amountCents: 100 }] }, 'lines[0].dueDate'],
      ['línea sin cliente', { lines: [{ customerId: '', issueDate: '2026-08-15', amountCents: 100 }] }, 'lines[0].customerId'],
    ])('%s', async (_name, overrides, field) => {
      const w = buildWorld();
      await expect(load(w, overrides)).rejects.toMatchObject({ httpStatus: 422, details: [{ field }] });
      expect(w.receivables()).toHaveLength(0);
    });
  });

  describe('el cliente tiene que existir (en ESTA organización)', () => {
    it('un cliente desconocido es 422 con el índice de CADA línea afectada, y no se guarda nada', async () => {
      const w = buildWorld();
      const unknown = '99999999-9999-4999-8999-999999999999';
      await expect(
        load(w, { lines: [
          { customerId: CUSTOMER_1, issueDate: '2026-08-15', amountCents: 100 },
          { customerId: unknown, issueDate: '2026-08-15', amountCents: 200 },
          { customerId: unknown, issueDate: '2026-08-16', amountCents: 300 },
        ] }),
      ).rejects.toMatchObject({ httpStatus: 422, details: [{ field: 'lines[1].customerId' }, { field: 'lines[2].customerId' }] });
      expect(w.receivables()).toHaveLength(0);
      expect(w.data.loads).toHaveLength(0);
    });

    it('cada cliente se consulta UNA vez aunque tenga varias líneas', async () => {
      const w = buildWorld();
      await load(w, { lines: [
        { customerId: CUSTOMER_1, issueDate: '2026-08-15', amountCents: 100 },
        { customerId: CUSTOMER_1, issueDate: '2026-08-16', amountCents: 200 },
        { customerId: CUSTOMER_2, issueDate: '2026-08-17', amountCents: 300 },
      ] });
      expect(w.customers.calls.sort()).toEqual([CUSTOMER_1, CUSTOMER_2].sort());
    });

    it('customer-service caído es 502, NUNCA «el cliente no existe»', async () => {
      const w = buildWorld({ customersDown: true });
      await expect(load(w)).rejects.toMatchObject({ code: 'CATALOG_UNAVAILABLE', httpStatus: 502 });
      expect(w.receivables()).toHaveLength(0);
    });

    it('contabilidad caída también es 502; sin contabilidad configurada es 422 (no se sabe la moneda)', async () => {
      await expect(load(buildWorld({ accountingDown: true }))).rejects.toMatchObject({ httpStatus: 502 });
      await expect(load(buildWorld({ settings: null }))).rejects.toMatchObject({ httpStatus: 422 });
    });
  });

  it('los saldos iniciales entran al saldo del cliente y a la antigüedad (vencidos y corrientes)', async () => {
    const w = buildWorld();
    await load(w, { lines: [
      { customerId: CUSTOMER_1, issueDate: '2026-06-01', dueDate: '2026-06-30', amountCents: 10000 }, // 113 días vencida
      { customerId: CUSTOMER_1, issueDate: '2026-10-01', dueDate: '2026-11-30', amountCents: 5000 }, // corriente
    ] });
    const statement = await w.useCases.getStatement.execute({ organizationId: ORG_A, customerId: CUSTOMER_1 });
    expect(statement.netCents).toBe(15000);
    const aging = await w.useCases.getAging.execute({ organizationId: ORG_A });
    expect(aging.totals).toMatchObject({ daysOver90Cents: 10000, currentCents: 5000, totalCents: 15000 });
    expect(balanceOf(statement.receivables[0]!)).toBe(10000);
  });
});

describe('condiciones de crédito del cliente', () => {
  it('guarda días y cupo, y se leen de vuelta', async () => {
    const w = buildWorld();
    await w.useCases.setCustomerTerms.execute({ organizationId: ORG_A, customerId: CUSTOMER_1, customerName: 'CLIENTE UNO', creditDays: 30, creditLimitCents: 500000, userId: USER_1 });
    expect(await w.useCases.getCustomerTerms.execute({ organizationId: ORG_A, customerId: CUSTOMER_1 })).toMatchObject({ creditDays: 30, creditLimitCents: 500000, updatedBy: USER_1 });
  });

  it('el evento lleva el valor ANTERIOR y el NUEVO (sin los dos la bitácora no dice qué cambió)', async () => {
    const w = buildWorld();
    await w.useCases.setCustomerTerms.execute({ organizationId: ORG_A, customerId: CUSTOMER_1, creditDays: 30, creditLimitCents: 500000, userId: USER_1 });
    await w.useCases.setCustomerTerms.execute({ organizationId: ORG_A, customerId: CUSTOMER_1, creditDays: 45, creditLimitCents: null, userId: USER_1 });
    const [first, second] = w.events('treasury.customer_terms.updated');
    expect(first!.payload).toMatchObject({ previousCreditDays: 0, creditDays: 30, previousCreditLimitCents: null, creditLimitCents: 500000 });
    expect(second!.payload).toMatchObject({ previousCreditDays: 30, creditDays: 45, previousCreditLimitCents: 500000, creditLimitCents: null });
  });

  it('si no se manda el nombre se conserva el que ya estaba', async () => {
    const w = buildWorld();
    await w.useCases.setCustomerTerms.execute({ organizationId: ORG_A, customerId: CUSTOMER_1, customerName: 'CLIENTE UNO', creditDays: 10, creditLimitCents: null, userId: USER_1 });
    await w.useCases.setCustomerTerms.execute({ organizationId: ORG_A, customerId: CUSTOMER_1, creditDays: 20, creditLimitCents: null, userId: USER_1 });
    expect((await w.useCases.getCustomerTerms.execute({ organizationId: ORG_A, customerId: CUSTOMER_1 }))!.customerName).toBe('CLIENTE UNO');
  });

  it.each([
    ['días negativos', { creditDays: -1, creditLimitCents: null }, 'creditDays'],
    ['más de 365 días', { creditDays: 366, creditLimitCents: null }, 'creditDays'],
    ['días con decimales', { creditDays: 1.5, creditLimitCents: null }, 'creditDays'],
    ['cupo negativo', { creditDays: 10, creditLimitCents: -1 }, 'creditLimitCents'],
  ])('%s → 422 con el campo', async (_name, input, field) => {
    const w = buildWorld();
    await expect(w.useCases.setCustomerTerms.execute({ organizationId: ORG_A, customerId: CUSTOMER_1, userId: USER_1, ...input })).rejects.toMatchObject({ httpStatus: 422, details: [{ field }] });
    expect(w.data.events).toHaveLength(0);
  });

  it('las condiciones de una organización no se ven en otra', async () => {
    const w = buildWorld();
    await w.useCases.setCustomerTerms.execute({ organizationId: ORG_A, customerId: CUSTOMER_1, creditDays: 30, creditLimitCents: null, userId: USER_1 });
    expect(await w.useCases.getCustomerTerms.execute({ organizationId: ORG_B, customerId: CUSTOMER_1 })).toBeNull();
  });
});

describe('listados y reportes', () => {
  it('«vencidas» solo trae deuda VIVA: una partida pagada o anulada con vencimiento pasado no está vencida', async () => {
    const w = buildWorld();
    // viva y vencida
    await load(w, { lines: [{ customerId: CUSTOMER_1, issueDate: '2026-06-01', dueDate: '2026-06-30', amountCents: 1000, documentNumber: 'VIVA' }] });
    // vencida pero pagada por una nota de crédito por el total
    const paid = w.invoice({ total: 2300, issueDate: '2026-05-01' });
    await w.useCases.invoiceIssued.execute(paid);
    await w.useCases.invoiceIssued.execute(w.invoice({ documentTypeCode: '04', total: 2300, relatedInvoiceId: paid.invoiceId }));
    // vencida pero anulada
    const voided = w.invoice({ total: 3450, issueDate: '2026-05-01' });
    await w.useCases.invoiceIssued.execute(voided);
    await w.useCases.invoiceVoided.execute({ organizationId: ORG_A, invoiceId: voided.invoiceId });

    const overdue = await w.useCases.listReceivables.execute({ organizationId: ORG_A, filters: { overdueOnly: true, page: 1, pageSize: 25 } });
    expect(overdue.page.items.map((r) => r.documentNumber)).toEqual(['VIVA']);
  });

  it('filtra por cliente, estado, rango de fechas y búsqueda; pagina', async () => {
    const w = buildWorld();
    for (let i = 0; i < 5; i += 1) await w.useCases.invoiceIssued.execute(w.invoice({ number: `001-001-00000000${i}` }));
    await w.useCases.invoiceIssued.execute(w.invoice({ customerId: CUSTOMER_2, customerSnapshot: { id: CUSTOMER_2, businessName: 'CLIENTE DOS', identification: '0912345678' } }));

    const list = (filters: Record<string, unknown>) => w.useCases.listReceivables.execute({ organizationId: ORG_A, filters: { page: 1, pageSize: 25, ...filters } as never });
    expect((await list({})).page.total).toBe(6);
    expect((await list({ customerId: CUSTOMER_2 })).page.total).toBe(1);
    expect((await list({ status: ['paid'] })).page.total).toBe(0);
    expect((await list({ q: '000000003' })).page.total).toBe(1);
    expect((await list({ q: 'dos' })).page.total).toBe(1);
    expect((await list({ from: '2026-10-22' })).page.total).toBe(0);
    const second = await list({ pageSize: 4, page: 2 });
    expect(second.page).toMatchObject({ total: 6, page: 2, pageSize: 4 });
    expect(second.page.items).toHaveLength(2);
  });

  it('el estado de cuenta resta el saldo a favor: deuda − anticipo = neto', async () => {
    const w = buildWorld();
    await w.useCases.invoiceIssued.execute(w.invoice({ total: 11500 }));
    await w.useCases.invoiceIssued.execute(w.invoice({ documentTypeCode: '04', total: 3000, relatedInvoiceId: null }));
    // la nota de crédito sin factura previa: como hay una factura abierta del cliente, se aplica a ella al llegar la SIGUIENTE
    const s = await w.useCases.getStatement.execute({ organizationId: ORG_A, customerId: CUSTOMER_1 });
    expect(s.receivableCents).toBe(11500);
    expect(s.advanceCents).toBe(3000);
    expect(s.netCents).toBe(8500);
  });

  it('la antigüedad reparte por tramos y deja fuera lo que no es deuda (saldo ≤ 0)', async () => {
    const w = buildWorld();
    w.setNow('2026-10-21T15:00:00.000Z');
    const days = (n: number) => `2026-10-21`.replace('2026-10-21', new Date(Date.UTC(2026, 9, 21 - n)).toISOString().slice(0, 10));
    for (const [n, cents] of [[0, 100], [10, 200], [45, 400], [75, 800], [120, 1600]] as const) {
      await load(w, { cutoffDate: `2026-01-${String(n + 1).padStart(2, '0')}`, lines: [{ customerId: CUSTOMER_1, issueDate: days(n), dueDate: days(n), amountCents: cents }] });
    }
    const aging = await w.useCases.getAging.execute({ organizationId: ORG_A });
    expect(aging.totals).toEqual({ currentCents: 100, days1To30Cents: 200, days31To60Cents: 400, days61To90Cents: 800, daysOver90Cents: 1600, totalCents: 3100 });
    expect(aging.customers).toHaveLength(1);
  });
});
