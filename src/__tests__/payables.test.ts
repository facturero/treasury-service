import { describe, expect, it } from 'vitest';
import { CatalogUnavailableError, OpeningBalanceAlreadyLoadedError, PayableNotFoundError, ValidationError } from '../domain/errors.js';
import { normalizeDocumentNumber, payableBalanceOf } from '../domain/payable.js';
import { buildWorld, ORG_A, ORG_B, SUPPLIER_1, SUPPLIER_2, USER_1, type World } from './helpers.js';

const open = async (w: World, overrides: Parameters<World['bill']>[0] = {}) => {
  const bill = w.bill(overrides);
  const outcome = await w.useCases.billPosted.execute(bill);
  return { bill, outcome, payable: w.payableOf(bill.billId) };
};

describe('compras → deuda por pagar (purchasing.bill.posted)', () => {
  it('una factura contabilizada abre su deuda con el vencimiento QUE TRAE la factura y publica el evento', async () => {
    const w = buildWorld();
    const { bill, outcome, payable } = await open(w, { total: 11500, dueDate: '2026-11-30', supplierDocument: '001-002-000000555' });
    expect(outcome.outcome).toBe('opened');
    expect(payable).toMatchObject({ supplierId: SUPPLIER_1, supplierName: 'PROVEEDOR UNO S.A.', supplierIdentification: '1790011111001', documentNumber: '001-002-000000555', internalNumber: bill.internalNumber, issueDate: '2026-10-21', dueDate: '2026-11-30', originalCents: 11500, status: 'open' });
    const [event] = w.events('treasury.payable.opened');
    expect(event!.payload).toMatchObject({ organizationId: ORG_A, payableId: payable!.id, supplierId: SUPPLIER_1, amountCents: 11500, dueDate: '2026-11-30', documentNumber: '001-002-000000555' });
    expect(w.events()).toHaveLength(1);
  });

  it('idempotente: el mismo evento dos veces no abre dos deudas', async () => {
    const w = buildWorld();
    const bill = w.bill();
    await w.useCases.billPosted.execute(bill);
    expect((await w.useCases.billPosted.execute(bill)).outcome).toBe('duplicate');
    expect(w.payables()).toHaveLength(1);
    expect(w.events('treasury.payable.opened')).toHaveLength(1);
  });

  it.each([
    ['una liquidación de compra (03) se contabiliza desde fiscal', { docType: '03' }, /liquidación/],
    ['una factura en otra moneda que la base', { currencyCode: 'EUR' }, /moneda/],
    ['una factura anterior a la fecha de arranque de contabilidad', { issueDate: '2026-09-01' }, /anterior/],
    ['una factura sin importe', { total: 0, lines: [] }, /sin importe/],
    ['una factura que no cuadra subtotal + impuestos', { subtotalCents: 1, taxCents: 1, lines: [{ subtotalCents: 1000, vatCents: 0, iceCents: 0, irbpnrCents: 0 }] }, /cuadra/],
    ['una factura sin proveedor', { supplierId: null }, /sin proveedor/],
  ])('NO abre deuda: %s (mismos filtros que contabilidad)', async (_name, overrides, reason) => {
    const w = buildWorld({ settings: { autoPostingFrom: '2026-10-01' } });
    const outcome = await w.useCases.billPosted.execute(w.bill(overrides as never));
    expect(outcome).toMatchObject({ outcome: 'skipped' });
    expect((outcome as { reason: string }).reason).toMatch(reason);
    expect(w.payables()).toHaveLength(0);
    expect(w.events()).toHaveLength(0);
  });

  it('con la contabilización automática apagada o sin contabilidad no abre deuda', async () => {
    const off = buildWorld({ settings: { autoPosting: false } });
    expect((await off.useCases.billPosted.execute(off.bill())).outcome).toBe('skipped');
    const none = buildWorld({ settings: null });
    expect((await none.useCases.billPosted.execute(none.bill())).outcome).toBe('skipped');
  });

  it('contabilidad caída: el error SUBE (el consumidor reintenta), no abre una deuda a ciegas', async () => {
    const w = buildWorld({ accountingDown: true });
    await expect(w.useCases.billPosted.execute(w.bill())).rejects.toBeInstanceOf(CatalogUnavailableError);
    expect(w.payables()).toHaveLength(0);
  });

  it('un vencimiento anterior a la emisión se corrige a la emisión; sin vencimiento vence el día de emisión', async () => {
    const w = buildWorld();
    expect((await open(w, { dueDate: '2026-10-01' })).payable!.dueDate).toBe('2026-10-21');
    expect((await open(w, { dueDate: null })).payable!.dueDate).toBe('2026-10-21');
  });

  it('aislamiento: la deuda de una organización no existe para otra', async () => {
    const w = buildWorld();
    await open(w);
    expect(w.payables(ORG_B)).toHaveLength(0);
    const { items } = (await w.useCases.listPayables.execute({ organizationId: ORG_B, filters: { page: 1, pageSize: 25 } })).page;
    expect(items).toHaveLength(0);
  });
});

describe('compras → anulación (purchasing.bill.voided)', () => {
  it('anula la deuda con el motivo y publica treasury.payable.cancelled; lo ya pagado queda a favor de la empresa', async () => {
    const w = buildWorld();
    const { bill, payable } = await open(w, { total: 11500 });
    // se pagan 100,00 antes de anular la factura
    const draft = await w.useCases.createPayment.execute({ organizationId: ORG_A, supplierId: SUPPLIER_1, userId: USER_1, payment: { paymentDate: '2026-10-21', method: 'cash', totalCents: 10000, lines: [{ payableId: payable!.id, appliedCents: 10000 }] } });
    await w.useCases.postPayment.execute({ organizationId: ORG_A, paymentId: draft.id, userId: USER_1 });

    expect((await w.useCases.billVoided.execute({ ...bill, voidReason: 'Factura duplicada' })).outcome).toBe('cancelled');
    const after = w.payableOf(bill.billId)!;
    expect(after.status).toBe('cancelled');
    const view = (await w.useCases.getPayableDetail.execute({ organizationId: ORG_A, payableId: after.id })).payable;
    expect(payableBalanceOf(view)).toBe(-10000);
    expect(w.events('treasury.payable.cancelled')[0]!.payload).toMatchObject({ reason: 'Factura duplicada', payableId: after.id });
  });

  it('idempotente, y una anulación que llega ANTES que la factura deja la factura sin deuda', async () => {
    const w = buildWorld();
    const early = w.bill();
    expect((await w.useCases.billVoided.execute(early)).outcome).toBe('skipped'); // fantasma
    expect(w.payables()).toHaveLength(0); // el fantasma no es cartera
    expect((await w.useCases.billPosted.execute(early)).outcome).toBe('duplicate'); // la factura posterior no abre nada
    expect(w.payables()).toHaveLength(0);

    const { bill } = await open(w);
    await w.useCases.billVoided.execute(bill);
    expect((await w.useCases.billVoided.execute(bill)).outcome).toBe('duplicate');
    expect(w.events('treasury.payable.cancelled')).toHaveLength(1);
  });
});

describe('retención (fiscal.ec.withholding.issued)', () => {
  it('reduce la deuda de la factura que cita (por RUC + número del sustento) y deja su evento', async () => {
    const w = buildWorld();
    const { payable } = await open(w, { total: 11500, supplierDocument: '001-001-000000123' });
    const result = await w.useCases.withholdingIssued.execute(w.withholding({ totalWithheldCents: 1000 }));
    expect(result).toMatchObject({ outcome: 'applied', payableId: payable!.id });
    const view = (await w.useCases.getPayableDetail.execute({ organizationId: ORG_A, payableId: payable!.id })).payable;
    expect(payableBalanceOf(view)).toBe(10500);
    expect(view.status).toBe('partial');
    expect(w.events('treasury.payable.credited')[0]!.payload).toMatchObject({ creditType: 'withholding', appliedCents: 1000, creditDocumentNumber: '001-001-000000007' });
  });

  it('idempotente: la misma retención dos veces se aplica una sola', async () => {
    const w = buildWorld();
    const { payable } = await open(w, { supplierDocument: '001-001-000000123' });
    const retention = w.withholding();
    await w.useCases.withholdingIssued.execute(retention);
    expect((await w.useCases.withholdingIssued.execute(retention)).outcome).toBe('duplicate');
    expect(payableBalanceOf((await w.useCases.getPayableDetail.execute({ organizationId: ORG_A, payableId: payable!.id })).payable)).toBe(10500);
  });

  it('llegó ANTES que la factura: espera y se aplica cuando la factura llega (RabbitMQ no ordena)', async () => {
    const w = buildWorld();
    const early = await w.useCases.withholdingIssued.execute(w.withholding({ totalWithheldCents: 1000 }));
    expect(early.outcome).toBe('pending');
    expect(w.data.unmatchedWithholdings).toHaveLength(1);
    const { payable } = await open(w, { total: 11500, supplierDocument: '001-001-000000123' });
    expect(w.data.unmatchedWithholdings).toHaveLength(0);
    const view = (await w.useCases.getPayableDetail.execute({ organizationId: ORG_A, payableId: payable!.id })).payable;
    expect(payableBalanceOf(view)).toBe(10500);
  });

  it('el número del sustento se compara normalizado (con o sin ceros y espacios)', () => {
    expect(normalizeDocumentNumber(' 1-1-123 ')).toBe('001-001-000000123');
    expect(normalizeDocumentNumber('001-001-000000123')).toBe('001-001-000000123');
    expect(normalizeDocumentNumber('abc')).toBe('ABC');
  });

  it.each([
    ['sin RUC', { supplier: null }],
    ['sin número de sustento', { support: { documentCode: '01', number: null } }],
    ['con un sustento que no es factura de compra', { support: { documentCode: '04', number: '001-001-000000123' } }],
    ['sin importe', { totalWithheldCents: 0 }],
  ])('se IGNORA una retención %s (no es de este módulo) y no ensucia la tabla de pendientes', async (_n, overrides) => {
    const w = buildWorld();
    await open(w, { supplierDocument: '001-001-000000123' });
    expect((await w.useCases.withholdingIssued.execute(w.withholding(overrides as never))).outcome).toBe('ignored');
    expect(w.data.unmatchedWithholdings).toHaveLength(0);
  });

  it('otro proveedor (otro RUC) o otro número NO se confunden con la factura', async () => {
    const w = buildWorld();
    const { payable } = await open(w, { supplierDocument: '001-001-000000123' });
    await w.useCases.withholdingIssued.execute(w.withholding({ supplier: { identification: '0992222222001' } }));
    await w.useCases.withholdingIssued.execute(w.withholding({ support: { documentCode: '01', number: '001-001-000000999' } }));
    expect(payableBalanceOf((await w.useCases.getPayableDetail.execute({ organizationId: ORG_A, payableId: payable!.id })).payable)).toBe(11500);
    expect(w.data.unmatchedWithholdings).toHaveLength(2);
  });

  it('aislamiento: la retención de una organización no toca la deuda de otra', async () => {
    const w = buildWorld();
    const { payable } = await open(w, { supplierDocument: '001-001-000000123' });
    await w.useCases.withholdingIssued.execute(w.withholding({ organizationId: ORG_B }));
    expect(payableBalanceOf((await w.useCases.getPayableDetail.execute({ organizationId: ORG_A, payableId: payable!.id })).payable)).toBe(11500);
  });
});

describe('antigüedad y estado de cuenta de proveedores', () => {
  it('reparte por vencer (7 días), corriente y los tramos vencidos, por proveedor y en total', async () => {
    const w = buildWorld();
    const u2 = w.knownSuppliers.get(SUPPLIER_2)!;
    await open(w, { total: 1150, dueDate: '2026-10-25' }); // vence en 4 días → por vencer
    await open(w, { total: 2300, dueDate: '2026-12-31' }); // corriente
    await open(w, { total: 3450, issueDate: '2026-10-01', dueDate: '2026-10-11' }); // 10 días vencida
    await open(w, { total: 4600, issueDate: '2026-08-01', dueDate: '2026-09-01', supplier: u2 }); // 50 días: 31-60
    const report = await w.useCases.getPayablesAging.execute({ organizationId: ORG_A });
    expect(report.totals).toMatchObject({ dueSoonCents: 1150, currentCents: 2300, days1To30Cents: 3450, days31To60Cents: 4600, totalCents: 11500 });
    expect(report.suppliers.map((s) => [s.supplierId, s.totalCents])).toEqual([[SUPPLIER_1, 6900], [SUPPLIER_2, 4600]].sort((a, b) => (b[1] as number) - (a[1] as number)));
  });

  it('no cuenta lo anulado ni lo pagado, y lo vencido lo decide el SERVIDOR (no quien pregunta)', async () => {
    const w = buildWorld();
    const { bill } = await open(w, { dueDate: '2026-10-01', issueDate: '2026-09-25' });
    await open(w, { total: 2300, dueDate: '2026-12-01' });
    await w.useCases.billVoided.execute(bill);
    const report = await w.useCases.getPayablesAging.execute({ organizationId: ORG_A });
    expect(report.totals.totalCents).toBe(2300);
    const overdue = await w.useCases.listPayables.execute({ organizationId: ORG_A, filters: { overdueOnly: true, page: 1, pageSize: 25 } });
    expect(overdue.page.total).toBe(0); // lo anulado no está «vencido»
    expect(overdue.asOf).toBe('2026-10-21');
  });

  it('«por vencer» lista solo lo vivo que vence en los próximos 7 días', async () => {
    const w = buildWorld();
    await open(w, { dueDate: '2026-10-25' });
    await open(w, { dueDate: '2026-12-25' });
    await open(w, { dueDate: '2026-10-10', issueDate: '2026-10-01' });
    const soon = await w.useCases.listPayables.execute({ organizationId: ORG_A, filters: { page: 1, pageSize: 25 }, dueSoon: true });
    expect(soon.page.items.map((p) => p.dueDate)).toEqual(['2026-10-25']);
  });

  it('estado de cuenta: lo que se debe es deuda − pagos − retenciones, y los anticipos van aparte', async () => {
    const w = buildWorld();
    const { payable } = await open(w, { total: 11500, supplierDocument: '001-001-000000123' });
    await w.useCases.withholdingIssued.execute(w.withholding({ totalWithheldCents: 1000 }));
    const draft = await w.useCases.createPayment.execute({ organizationId: ORG_A, supplierId: SUPPLIER_1, userId: USER_1, payment: { paymentDate: '2026-10-21', method: 'cash', totalCents: 12000, lines: [{ payableId: payable!.id, appliedCents: 10500 }] } });
    await w.useCases.postPayment.execute({ organizationId: ORG_A, paymentId: draft.id, userId: USER_1 });
    const statement = await w.useCases.getSupplierStatement.execute({ organizationId: ORG_A, supplierId: SUPPLIER_1 });
    expect(statement).toMatchObject({ payableCents: 0, advanceCents: 1500, netCents: 0 });
    expect(statement.applications.map((a) => a.sourceType).sort()).toEqual(['payment', 'withholding']);
  });

  it('una deuda que no existe da 404', async () => {
    const w = buildWorld();
    await expect(w.useCases.getPayableDetail.execute({ organizationId: ORG_A, payableId: 'x' })).rejects.toBeInstanceOf(PayableNotFoundError);
  });
});

describe('saldos iniciales de deudas', () => {
  const load = (w: World, overrides: Record<string, unknown> = {}) =>
    w.useCases.loadPayableOpeningBalances.execute({
      organizationId: ORG_A,
      cutoffDate: '2026-09-30',
      reason: 'Migración',
      userId: USER_1,
      lines: [{ supplierId: SUPPLIER_1, issueDate: '2026-08-01', dueDate: '2026-09-01', amountCents: 5000, documentNumber: 'F-1' }],
      ...overrides,
    } as never);

  it('abre una deuda por línea (sin asiento) y deja UN evento con el total', async () => {
    const w = buildWorld();
    const loaded = await load(w, { lines: [{ supplierId: SUPPLIER_1, issueDate: '2026-08-01', amountCents: 5000 }, { supplierId: SUPPLIER_2, issueDate: '2026-08-02', dueDate: '2026-10-01', amountCents: 2500 }] });
    expect(loaded.totalCents).toBe(7500);
    expect(w.payables().map((p) => [p.sourceType, p.dueDate])).toEqual([['initial_balance', '2026-08-01'], ['initial_balance', '2026-10-01']]);
    expect(w.events('treasury.payable.opened')).toHaveLength(2);
    expect(w.events('treasury.payable_opening_balance.loaded')[0]!.payload).toMatchObject({ totalCents: 7500, supplierCount: 2, cutoffDate: '2026-09-30' });
  });

  it('una sola carga por fecha de corte (409) y todo o nada', async () => {
    const w = buildWorld();
    await load(w);
    await expect(load(w)).rejects.toBeInstanceOf(OpeningBalanceAlreadyLoadedError);
    expect(w.payables()).toHaveLength(1);
  });

  it('un proveedor que no existe → 422 con el índice; compras caído → 502 y no se carga nada', async () => {
    const w = buildWorld();
    const err = await load(w, { lines: [{ supplierId: SUPPLIER_1, issueDate: '2026-08-01', amountCents: 1 }, { supplierId: '99999999-9999-4999-8999-999999999999', issueDate: '2026-08-01', amountCents: 1 }] }).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.details[0].field).toBe('lines[1].supplierId');
    w.suppliers.down = true;
    await expect(load(w)).rejects.toBeInstanceOf(CatalogUnavailableError);
    expect(w.payables()).toHaveLength(0);
  });

  it.each([
    ['sin fecha de corte', { cutoffDate: '' }, 'cutoffDate'],
    ['sin motivo', { reason: '' }, 'reason'],
    ['sin líneas', { lines: [] }, 'lines'],
    ['importe cero', { lines: [{ supplierId: SUPPLIER_1, issueDate: '2026-08-01', amountCents: 0 }] }, 'lines[0].amountCents'],
    ['vencimiento anterior a la emisión', { lines: [{ supplierId: SUPPLIER_1, issueDate: '2026-08-01', dueDate: '2026-07-01', amountCents: 1 }] }, 'lines[0].dueDate'],
  ])('rechaza %s con el campo', async (_n, overrides, field) => {
    const w = buildWorld();
    const err = await load(w, overrides).catch((e) => e);
    expect(err.details[0].field).toBe(field);
  });
});
