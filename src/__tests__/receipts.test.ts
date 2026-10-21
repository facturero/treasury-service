import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CatalogUnavailableError } from '../domain/errors.js';
import { balanceOf } from '../domain/receivable.js';
import type { ReceiptInput } from '../domain/receipt.js';
import { buildWorld, CUSTOMER_1, CUSTOMER_2, ORG_A, ORG_B, USER_1, type World } from './helpers.js';

const USER_2 = '66666666-6666-4666-8666-666666666666';

/** Abre una deuda del cliente por la vía real (evento de facturación) y devuelve su id. */
async function debt(w: World, total = 11500, customerId = CUSTOMER_1, number?: string): Promise<string> {
  const inv = w.invoice({ total, customerId, number, customerSnapshot: { id: customerId, businessName: customerId === CUSTOMER_1 ? 'CLIENTE UNO S.A.' : 'CLIENTE DOS', identification: null } });
  await w.useCases.invoiceIssued.execute(inv);
  return w.receivables().find((r) => r.sourceId === inv.invoiceId)!.id;
}

const input = (overrides: Partial<ReceiptInput> = {}): ReceiptInput => ({
  receiptDate: '2026-10-21',
  method: 'cash',
  totalCents: 5000,
  lines: [],
  ...overrides,
});

const create = (w: World, receipt: ReceiptInput, customerId = CUSTOMER_1, organizationId = ORG_A) =>
  w.useCases.createReceipt.execute({ organizationId, customerId, userId: USER_1, receipt });
const post = (w: World, receiptId: string, organizationId = ORG_A, userId = USER_1) => w.useCases.postReceipt.execute({ organizationId, receiptId, userId });
const voidIt = (w: World, receiptId: string, reason = 'Cobro duplicado por error', organizationId = ORG_A) =>
  w.useCases.voidReceipt.execute({ organizationId, receiptId, userId: USER_2, reason });
const balance = async (w: World, id: string) => balanceOf(await w.useCases.getReceivable.execute({ organizationId: ORG_A, receivableId: id }));
const statusOf = async (w: World, id: string) => (await w.useCases.getReceivable.execute({ organizationId: ORG_A, receivableId: id })).status;

describe('crear un cobro (borrador)', () => {
  it('guarda un borrador: sin número, sin tocar saldos, con los importes derivados y su evento', async () => {
    const w = buildWorld();
    const id = await debt(w, 11500);
    const r = await create(w, input({ totalCents: 11500, lines: [{ receivableId: id, appliedCents: 11500 }], reference: '  ', notes: ' pago de octubre ' }));

    expect(r).toMatchObject({ status: 'draft', number: null, customerId: CUSTOMER_1, customerName: 'CLIENTE UNO S.A.', totalCents: 11500, appliedCents: 11500, advanceCents: 0, advanceUsedCents: 0, currencyCode: 'USD', accountRole: 'cash', reference: null, notes: 'pago de octubre', version: 1 });
    expect(await balance(w, id)).toBe(11500); // un borrador no mueve el saldo
    expect(w.events('treasury.receipt.created')).toHaveLength(1);
    expect(w.events('treasury.receipt.created')[0]!.payload).toMatchObject({ receiptId: r.id, status: 'draft', totalCents: 11500, lineCount: 1 });
  });

  it('el rol contable sale del medio de cobro (efectivo → caja, lo demás → bancos) y se puede cambiar', async () => {
    const w = buildWorld();
    const id = await debt(w);
    expect((await create(w, input({ method: 'cash', lines: [{ receivableId: id, appliedCents: 100 }] }))).accountRole).toBe('cash');
    expect((await create(w, input({ method: 'card', lines: [{ receivableId: id, appliedCents: 100 }] }))).accountRole).toBe('bank');
    expect((await create(w, input({ method: 'check', reference: '001234', accountRole: 'cash', lines: [{ receivableId: id, appliedCents: 100 }] }))).accountRole).toBe('cash');
  });

  it('lo cobrado de más que las deudas es el excedente: queda como anticipo', async () => {
    const w = buildWorld();
    const id = await debt(w, 10000);
    const r = await create(w, input({ totalCents: 15000, lines: [{ receivableId: id, appliedCents: 10000 }] }));
    expect(r).toMatchObject({ appliedCents: 10000, advanceCents: 5000 });
  });

  it('un cobro sin deudas es válido: todo es anticipo (el cliente pagó por adelantado)', async () => {
    const w = buildWorld();
    expect(await create(w, input({ totalCents: 8000 }))).toMatchObject({ appliedCents: 0, advanceCents: 8000 });
  });

  it.each([
    ['cheque sin referencia', { method: 'check' as const, reference: '' }, 'reference'],
    ['transferencia sin referencia', { method: 'transfer' as const }, 'reference'],
    ['fecha inválida', { receiptDate: '2026-02-30' }, 'receiptDate'],
    ['medio inexistente', { method: 'bitcoin' as never }, 'method'],
    ['importe negativo', { totalCents: -1 }, 'totalCents'],
    ['importe con decimales', { totalCents: 10.5 }, 'totalCents'],
    ['cobro sin importe', { totalCents: 0 }, 'totalCents'],
  ])('%s → 422 con el campo', async (_name, overrides, field) => {
    const w = buildWorld();
    await expect(create(w, input(overrides))).rejects.toMatchObject({ httpStatus: 422, details: expect.arrayContaining([expect.objectContaining({ field })]) });
    expect(w.data.receipts.size).toBe(0);
    expect(w.data.events).toHaveLength(0);
  });

  it('aplicar más de lo cobrado más los anticipos es 422', async () => {
    const w = buildWorld();
    const id = await debt(w, 10000);
    await expect(create(w, input({ totalCents: 5000, lines: [{ receivableId: id, appliedCents: 10000 }] }))).rejects.toMatchObject({ httpStatus: 422, details: [{ field: 'lines' }] });
  });

  it('la misma deuda dos veces en el mismo cobro es 422', async () => {
    const w = buildWorld();
    const id = await debt(w, 10000);
    await expect(create(w, input({ totalCents: 6000, lines: [{ receivableId: id, appliedCents: 3000 }, { receivableId: id, appliedCents: 3000 }] }))).rejects.toMatchObject({ httpStatus: 422, details: [{ field: 'lines[1].receivableId' }] });
  });

  describe('qué deudas se pueden cobrar (con el índice de la línea)', () => {
    it('una deuda que no existe, o de OTRA organización', async () => {
      const w = buildWorld();
      const other = await debt(w, 5000);
      await expect(create(w, input({ lines: [{ receivableId: randomUUID(), appliedCents: 100 }] }))).rejects.toMatchObject({ details: [{ field: 'lines[0].receivableId' }] });
      await expect(create(w, input({ lines: [{ receivableId: other, appliedCents: 100 }] }), CUSTOMER_1, ORG_B)).rejects.toMatchObject({ details: [{ field: 'lines[0].receivableId' }] });
    });

    it('una deuda de OTRO cliente', async () => {
      const w = buildWorld();
      const theirs = await debt(w, 5000, CUSTOMER_2);
      await expect(create(w, input({ lines: [{ receivableId: theirs, appliedCents: 100 }] }))).rejects.toMatchObject({ details: [{ field: 'lines[0].receivableId', message: expect.stringContaining('otro cliente') }] });
    });

    it('una deuda anulada o ya pagada', async () => {
      const w = buildWorld();
      const inv = w.invoice({ total: 1000 });
      await w.useCases.invoiceIssued.execute(inv);
      const id = w.receivables()[0]!.id;
      await w.useCases.invoiceVoided.execute({ organizationId: ORG_A, invoiceId: inv.invoiceId, number: inv.number, issueDate: inv.issueDate });
      await expect(create(w, input({ lines: [{ receivableId: id, appliedCents: 100 }] }))).rejects.toMatchObject({ details: [{ message: expect.stringContaining('ya no está abierta') }] });
    });

    it('un importe mayor que el saldo, nombrando la línea que falla y no las demás', async () => {
      const w = buildWorld();
      const a = await debt(w, 5000);
      const b = await debt(w, 3000);
      await expect(create(w, input({ totalCents: 9000, lines: [{ receivableId: a, appliedCents: 5000 }, { receivableId: b, appliedCents: 4000 }] }))).rejects.toMatchObject({ details: [{ field: 'lines[1].appliedCents' }] });
    });

    it('un cliente que no existe es 422; contabilidad sin configurar es 422; contabilidad o clientes caídos son 502', async () => {
      const w = buildWorld();
      await expect(create(w, input(), randomUUID())).rejects.toMatchObject({ httpStatus: 422, details: [{ field: 'customerId' }] });
      await expect(create(buildWorld({ settings: null }), input())).rejects.toMatchObject({ httpStatus: 422, details: [{ field: 'currencyCode' }] });
      await expect(create(buildWorld({ accountingDown: true }), input())).rejects.toBeInstanceOf(CatalogUnavailableError);
      await expect(create(buildWorld({ customersDown: true }), input())).rejects.toBeInstanceOf(CatalogUnavailableError);
    });
  });
});

describe('editar un borrador', () => {
  it('cambia importes y líneas, sube la versión y publica el evento', async () => {
    const w = buildWorld();
    const id = await debt(w, 10000);
    const draft = await create(w, input({ totalCents: 2000, lines: [{ receivableId: id, appliedCents: 2000 }] }));
    const next = await w.useCases.updateReceipt.execute({ organizationId: ORG_A, receiptId: draft.id, userId: USER_1, receipt: input({ totalCents: 7000, method: 'transfer', reference: 'TRX-9', lines: [{ receivableId: id, appliedCents: 7000 }] }), expectedVersion: 1 });
    expect(next).toMatchObject({ totalCents: 7000, appliedCents: 7000, method: 'transfer', accountRole: 'bank', reference: 'TRX-9', version: 2, customerId: CUSTOMER_1 });
    expect(w.events('treasury.receipt.updated')).toHaveLength(1);
    expect((await w.useCases.getReceipt.execute({ organizationId: ORG_A, receiptId: draft.id })).lines).toEqual([{ receivableId: id, appliedCents: 7000 }]);
  });

  it('una versión vieja es 409; uno contabilizado no se edita; otra organización no lo ve', async () => {
    const w = buildWorld();
    const id = await debt(w, 10000);
    const draft = await create(w, input({ totalCents: 2000, lines: [{ receivableId: id, appliedCents: 2000 }] }));
    const edit = (version?: number, org = ORG_A) => w.useCases.updateReceipt.execute({ organizationId: org, receiptId: draft.id, userId: USER_1, receipt: input({ totalCents: 3000, lines: [{ receivableId: id, appliedCents: 3000 }] }), expectedVersion: version });
    await expect(edit(5)).rejects.toMatchObject({ httpStatus: 409 });
    await expect(edit(1, ORG_B)).rejects.toMatchObject({ code: 'RECEIPT_NOT_FOUND' });
    await post(w, draft.id);
    await expect(edit(2)).rejects.toMatchObject({ code: 'INVALID_RECEIPT_STATE' });
  });
});

describe('contabilizar un cobro', () => {
  it('aplica a la deuda, asigna RC-AAAA-NNNNNN, deja la deuda pagada y publica los eventos', async () => {
    const w = buildWorld();
    const id = await debt(w, 11500, CUSTOMER_1, '001-001-000000123');
    const draft = await create(w, input({ totalCents: 11500, method: 'transfer', reference: 'TRX-1', lines: [{ receivableId: id, appliedCents: 11500 }] }));
    const posted = await post(w, draft.id);

    expect(posted).toMatchObject({ status: 'posted', number: 'RC-2026-000001', postedBy: USER_1, version: 2 });
    expect(await statusOf(w, id)).toBe('paid');
    expect(await balance(w, id)).toBe(0);
    const [event] = w.events('treasury.receipt.posted');
    expect(w.events('treasury.receipt.posted')).toHaveLength(1);
    expect(event!.payload).toMatchObject({ number: 'RC-2026-000001', receiptDate: '2026-10-21', totalCents: 11500, appliedCents: 11500, advanceCents: 0, accountRole: 'bank', method: 'transfer', reference: 'TRX-1', postedBy: USER_1, lineCount: 1 });
    expect((event!.payload.lines as { invoiceNumber: string }[])[0]!.invoiceNumber).toBe('001-001-000000123');
    const credited = w.events('treasury.receivable.credited').filter((e) => e.payload.creditType === 'receipt');
    expect(credited).toHaveLength(1);
    expect(credited[0]!.payload).toMatchObject({ appliedCents: 11500, creditDocumentNumber: 'RC-2026-000001' });
  });

  it('un cobro parcial deja la deuda en «parcial» con su saldo', async () => {
    const w = buildWorld();
    const id = await debt(w, 11500);
    await post(w, (await create(w, input({ totalCents: 4000, lines: [{ receivableId: id, appliedCents: 4000 }] }))).id);
    expect(await statusOf(w, id)).toBe('partial');
    expect(await balance(w, id)).toBe(7500);
  });

  it('un cobro a varias deudas las aplica todas, y las que ya cubrió una nota de crédito suman', async () => {
    const w = buildWorld();
    const a = await debt(w, 10000);
    const b = await debt(w, 5000);
    await post(w, (await create(w, input({ totalCents: 12000, lines: [{ receivableId: a, appliedCents: 10000 }, { receivableId: b, appliedCents: 2000 }] }))).id);
    expect(await statusOf(w, a)).toBe('paid');
    expect(await balance(w, b)).toBe(3000);
    expect(w.events('treasury.receivable.credited').filter((e) => e.payload.creditType === 'receipt')).toHaveLength(2);
  });

  it('numeración por organización y año, sin saltos', async () => {
    const w = buildWorld();
    const id = await debt(w, 100000);
    const numbers: string[] = [];
    for (let i = 0; i < 3; i += 1) numbers.push((await post(w, (await create(w, input({ totalCents: 100, lines: [{ receivableId: id, appliedCents: 100 }] }))).id)).number!);
    expect(numbers).toEqual(['RC-2026-000001', 'RC-2026-000002', 'RC-2026-000003']);
    // otro año (por la fecha del cobro) y otra organización llevan su propia serie
    const early = await post(w, (await create(w, input({ receiptDate: '2025-12-31', totalCents: 100, lines: [{ receivableId: id, appliedCents: 100 }] }))).id);
    expect(early.number).toBe('RC-2025-000001');
    const other = buildWorld();
    const oid = await debt(other);
    expect((await post(other, (await create(other, input({ totalCents: 100, lines: [{ receivableId: oid, appliedCents: 100 }] }))).id)).number).toBe('RC-2026-000001');
  });

  it('es idempotente: contabilizar dos veces no cobra dos veces ni publica dos veces', async () => {
    const w = buildWorld();
    const id = await debt(w, 11500);
    const draft = await create(w, input({ totalCents: 5000, lines: [{ receivableId: id, appliedCents: 5000 }] }));
    const first = await post(w, draft.id);
    const second = await post(w, draft.id);
    expect(second.number).toBe(first.number);
    expect(await balance(w, id)).toBe(6500);
    expect(w.events('treasury.receipt.posted')).toHaveLength(1);
    expect(w.data.creditApplications.filter((a) => a.sourceType === 'receipt')).toHaveLength(1);
  });

  it('NUNCA cobra más que el saldo: si entre el borrador y contabilizar otra persona cobró, falla con la línea y no deja nada', async () => {
    const w = buildWorld();
    const id = await debt(w, 10000);
    const first = await create(w, input({ totalCents: 8000, lines: [{ receivableId: id, appliedCents: 8000 }] }));
    const second = await create(w, input({ totalCents: 8000, lines: [{ receivableId: id, appliedCents: 8000 }] }));
    await post(w, first.id);
    const eventsBefore = w.data.events.length;
    await expect(post(w, second.id)).rejects.toMatchObject({ httpStatus: 422, details: [{ field: 'lines[0].appliedCents' }] });
    expect(await balance(w, id)).toBe(2000);
    expect(w.data.events).toHaveLength(eventsBefore);
    expect(w.data.sequences.get(`${ORG_A}:2026`)).toBe(1); // el número del segundo no se gastó
    expect((await w.useCases.getReceipt.execute({ organizationId: ORG_A, receiptId: second.id })).status).toBe('draft');
  });

  it('una deuda anulada entre el borrador y contabilizar bloquea el cobro', async () => {
    const w = buildWorld();
    const inv = w.invoice({ total: 5000 });
    await w.useCases.invoiceIssued.execute(inv);
    const id = w.receivables()[0]!.id;
    const draft = await create(w, input({ totalCents: 5000, lines: [{ receivableId: id, appliedCents: 5000 }] }));
    await w.useCases.invoiceVoided.execute({ organizationId: ORG_A, invoiceId: inv.invoiceId, number: inv.number, issueDate: inv.issueDate });
    await expect(post(w, draft.id)).rejects.toMatchObject({ httpStatus: 422, details: [{ message: expect.stringContaining('ya no está abierta') }] });
  });

  it('otra organización no puede contabilizar un cobro ajeno', async () => {
    const w = buildWorld();
    const id = await debt(w);
    const draft = await create(w, input({ totalCents: 100, lines: [{ receivableId: id, appliedCents: 100 }] }));
    await expect(post(w, draft.id, ORG_B)).rejects.toMatchObject({ code: 'RECEIPT_NOT_FOUND' });
  });

  it('un cobro anulado no se contabiliza', async () => {
    const w = buildWorld();
    const id = await debt(w);
    const draft = await create(w, input({ totalCents: 100, lines: [{ receivableId: id, appliedCents: 100 }] }));
    await post(w, draft.id);
    await voidIt(w, draft.id);
    await expect(post(w, draft.id)).rejects.toMatchObject({ code: 'INVALID_RECEIPT_STATE' });
  });
});

describe('anticipos', () => {
  it('el excedente abre un anticipo del cliente (origen cobro) y NO entra en el neto del estado de cuenta', async () => {
    const w = buildWorld();
    const id = await debt(w, 10000);
    const posted = await post(w, (await create(w, input({ totalCents: 15000, lines: [{ receivableId: id, appliedCents: 10000 }] }))).id);
    const [advance] = [...w.data.advances.values()];
    expect(advance).toMatchObject({ origin: 'receipt', originId: posted.id, originalCents: 5000, customerId: CUSTOMER_1, documentNumber: posted.number });
    expect(w.events('treasury.customer_advance.opened')).toHaveLength(1);

    const statement = await w.useCases.getStatement.execute({ organizationId: ORG_A, customerId: CUSTOMER_1 });
    expect(statement).toMatchObject({ receivableCents: 0, advanceCents: 0, customerAdvanceCents: 5000, netCents: 0 });
  });

  it('un anticipo de un cobro NO se aplica solo a la próxima factura (eso solo vale para notas de crédito)', async () => {
    const w = buildWorld();
    await post(w, (await create(w, input({ totalCents: 5000 }))).id); // todo anticipo
    const id = await debt(w, 11500);
    expect(await balance(w, id)).toBe(11500);
  });

  it('un cobro posterior consume el anticipo: no entra dinero, y el anticipo baja', async () => {
    const w = buildWorld();
    await post(w, (await create(w, input({ totalCents: 6000 }))).id);
    const advance = [...w.data.advances.values()][0]!;
    const id = await debt(w, 4000);
    const posted = await post(w, (await create(w, input({ totalCents: 0, lines: [{ receivableId: id, appliedCents: 4000 }], advanceUses: [{ advanceId: advance.id, usedCents: 4000 }] }))).id);

    expect(posted).toMatchObject({ totalCents: 0, advanceUsedCents: 4000, appliedCents: 4000, advanceCents: 0 });
    expect(await statusOf(w, id)).toBe('paid');
    const statement = await w.useCases.getStatement.execute({ organizationId: ORG_A, customerId: CUSTOMER_1 });
    expect(statement.customerAdvanceCents).toBe(2000);
    expect(w.events('treasury.receipt.posted')[1]!.payload).toMatchObject({ totalCents: 0, advanceUsedCents: 4000, appliedCents: 4000 });
  });

  it('se puede mezclar dinero nuevo con un anticipo, y el excedente abre otro anticipo', async () => {
    const w = buildWorld();
    await post(w, (await create(w, input({ totalCents: 3000 }))).id);
    const advance = [...w.data.advances.values()][0]!;
    const id = await debt(w, 5000);
    const posted = await post(w, (await create(w, input({ totalCents: 4000, lines: [{ receivableId: id, appliedCents: 5000 }], advanceUses: [{ advanceId: advance.id, usedCents: 3000 }] }))).id);
    expect(posted).toMatchObject({ totalCents: 4000, advanceUsedCents: 3000, appliedCents: 5000, advanceCents: 2000 });
  });

  it('no se puede consumir más de lo que queda del anticipo', async () => {
    const w = buildWorld();
    await post(w, (await create(w, input({ totalCents: 3000 }))).id);
    const advance = [...w.data.advances.values()][0]!;
    const id = await debt(w, 9000);
    await expect(create(w, input({ totalCents: 0, lines: [{ receivableId: id, appliedCents: 5000 }], advanceUses: [{ advanceId: advance.id, usedCents: 5000 }] }))).rejects.toMatchObject({ details: [{ field: 'advanceUses[0].usedCents' }] });
  });

  it('dos cobros que juntos pasan del anticipo: el segundo falla al contabilizar', async () => {
    const w = buildWorld();
    await post(w, (await create(w, input({ totalCents: 3000 }))).id);
    const advance = [...w.data.advances.values()][0]!;
    const id = await debt(w, 9000);
    const draft = (n: number) => create(w, input({ totalCents: 0, lines: [{ receivableId: id, appliedCents: n }], advanceUses: [{ advanceId: advance.id, usedCents: n }] }));
    const a = await draft(2000);
    const b = await draft(2000);
    await post(w, a.id);
    await expect(post(w, b.id)).rejects.toMatchObject({ httpStatus: 422, details: [{ field: 'advanceUses[0].usedCents' }] });
  });

  it('el saldo a favor de una NOTA DE CRÉDITO no se consume desde un cobro (asentaría el dinero en dos cuentas)', async () => {
    const w = buildWorld();
    await w.useCases.invoiceIssued.execute(w.invoice({ documentTypeCode: '04', total: 3000, relatedInvoiceId: null }));
    const creditNoteAdvance = [...w.data.advances.values()][0]!;
    const id = await debt(w, 9000);
    await expect(create(w, input({ totalCents: 0, lines: [{ receivableId: id, appliedCents: 3000 }], advanceUses: [{ advanceId: creditNoteAdvance.id, usedCents: 3000 }] }))).rejects.toMatchObject({ details: [{ message: expect.stringContaining('cobros anteriores') }] });
  });

  it('el anticipo de otro cliente no se puede usar', async () => {
    const w = buildWorld();
    await post(w, (await create(w, input({ totalCents: 3000 }), CUSTOMER_2)).id);
    const theirs = [...w.data.advances.values()][0]!;
    const id = await debt(w, 5000);
    await expect(create(w, input({ totalCents: 0, lines: [{ receivableId: id, appliedCents: 1000 }], advanceUses: [{ advanceId: theirs.id, usedCents: 1000 }] }))).rejects.toMatchObject({ details: [{ message: expect.stringContaining('otro cliente') }] });
  });
});

describe('anular un cobro', () => {
  it('devuelve el saldo, marca la aplicación como anulada (no la borra) y publica el evento con el MOTIVO', async () => {
    const w = buildWorld();
    const id = await debt(w, 11500);
    const posted = await post(w, (await create(w, input({ totalCents: 11500, lines: [{ receivableId: id, appliedCents: 11500 }] }))).id);
    expect(await statusOf(w, id)).toBe('paid');

    const voided = await voidIt(w, posted.id, 'El banco devolvió la transferencia');
    expect(voided).toMatchObject({ status: 'voided', voidReason: 'El banco devolvió la transferencia', voidedBy: USER_2, number: posted.number });
    expect(await statusOf(w, id)).toBe('open');
    expect(await balance(w, id)).toBe(11500);
    // nada se borró: la aplicación sigue, marcada como anulada
    const application = w.data.creditApplications.find((a) => a.sourceType === 'receipt')!;
    expect(application.reversedAt).toBeInstanceOf(Date);
    const [event] = w.events('treasury.receipt.voided');
    expect(w.events('treasury.receipt.voided')).toHaveLength(1);
    expect(event!.payload).toMatchObject({ reason: 'El banco devolvió la transferencia', number: posted.number, postedBy: USER_1, voidedBy: USER_2, appliedCents: 11500 });
  });

  it('un parcial anulado vuelve a «abierta»; con otro cobro vigente queda «parcial»', async () => {
    const w = buildWorld();
    const id = await debt(w, 10000);
    const a = await post(w, (await create(w, input({ totalCents: 3000, lines: [{ receivableId: id, appliedCents: 3000 }] }))).id);
    await post(w, (await create(w, input({ totalCents: 2000, lines: [{ receivableId: id, appliedCents: 2000 }] }))).id);
    await voidIt(w, a.id);
    expect(await statusOf(w, id)).toBe('partial');
    expect(await balance(w, id)).toBe(8000);
  });

  it('el estado de cuenta ya no cuenta el cobro anulado, pero el detalle de la deuda lo conserva en su historia', async () => {
    const w = buildWorld();
    const id = await debt(w, 5000);
    const posted = await post(w, (await create(w, input({ totalCents: 5000, lines: [{ receivableId: id, appliedCents: 5000 }] }))).id);
    await voidIt(w, posted.id);
    const statement = await w.useCases.getStatement.execute({ organizationId: ORG_A, customerId: CUSTOMER_1 });
    expect(statement.applications).toHaveLength(0);
    expect(statement.netCents).toBe(5000);
    const detail = await w.useCases.getReceivableDetail.execute({ organizationId: ORG_A, receivableId: id });
    expect(detail.applications).toHaveLength(1);
    expect(detail.applications[0]!.reversedAt).toBeInstanceOf(Date);
  });

  it('anula el anticipo que abrió el excedente; y el cliente ya no lo tiene', async () => {
    const w = buildWorld();
    const id = await debt(w, 10000);
    const posted = await post(w, (await create(w, input({ totalCents: 15000, lines: [{ receivableId: id, appliedCents: 10000 }] }))).id);
    await voidIt(w, posted.id);
    expect([...w.data.advances.values()][0]!.voidedAt).toBeInstanceOf(Date);
    expect((await w.useCases.getStatement.execute({ organizationId: ORG_A, customerId: CUSTOMER_1 })).customerAdvanceCents).toBe(0);
  });

  it('devuelve el anticipo que el cobro había consumido', async () => {
    const w = buildWorld();
    await post(w, (await create(w, input({ totalCents: 6000 }))).id);
    const advance = [...w.data.advances.values()][0]!;
    const id = await debt(w, 4000);
    const used = await post(w, (await create(w, input({ totalCents: 0, lines: [{ receivableId: id, appliedCents: 4000 }], advanceUses: [{ advanceId: advance.id, usedCents: 4000 }] }))).id);
    expect((await w.useCases.getStatement.execute({ organizationId: ORG_A, customerId: CUSTOMER_1 })).customerAdvanceCents).toBe(2000);
    await voidIt(w, used.id);
    expect((await w.useCases.getStatement.execute({ organizationId: ORG_A, customerId: CUSTOMER_1 })).customerAdvanceCents).toBe(6000);
    expect(await statusOf(w, id)).toBe('open');
  });

  it('si otro cobro ya consumió el anticipo de este, no se puede anular (409) hasta anular ese', async () => {
    const w = buildWorld();
    const first = await post(w, (await create(w, input({ totalCents: 6000 }))).id);
    const advance = [...w.data.advances.values()][0]!;
    const id = await debt(w, 4000);
    const second = await post(w, (await create(w, input({ totalCents: 0, lines: [{ receivableId: id, appliedCents: 4000 }], advanceUses: [{ advanceId: advance.id, usedCents: 4000 }] }))).id);

    await expect(voidIt(w, first.id)).rejects.toMatchObject({ code: 'RECEIPT_ADVANCE_IN_USE', httpStatus: 409 });
    expect((await w.useCases.getReceipt.execute({ organizationId: ORG_A, receiptId: first.id })).status).toBe('posted');
    await voidIt(w, second.id);
    await expect(voidIt(w, first.id)).resolves.toMatchObject({ status: 'voided' });
  });

  it('exige motivo de al menos 5 caracteres', async () => {
    const w = buildWorld();
    const id = await debt(w);
    const posted = await post(w, (await create(w, input({ totalCents: 100, lines: [{ receivableId: id, appliedCents: 100 }] }))).id);
    for (const reason of ['', '  ', 'x', 'abcd']) await expect(voidIt(w, posted.id, reason)).rejects.toMatchObject({ httpStatus: 422, details: [{ field: 'reason' }] });
    expect((await w.useCases.getReceipt.execute({ organizationId: ORG_A, receiptId: posted.id })).status).toBe('posted');
  });

  it('es idempotente: anular dos veces no devuelve el saldo dos veces ni publica dos veces', async () => {
    const w = buildWorld();
    const id = await debt(w, 5000);
    const posted = await post(w, (await create(w, input({ totalCents: 5000, lines: [{ receivableId: id, appliedCents: 5000 }] }))).id);
    await voidIt(w, posted.id);
    await voidIt(w, posted.id);
    expect(await balance(w, id)).toBe(5000);
    expect(w.events('treasury.receipt.voided')).toHaveLength(1);
  });

  it('un borrador no se anula (no se contabilizó); otra organización no puede anular', async () => {
    const w = buildWorld();
    const id = await debt(w);
    const draft = await create(w, input({ totalCents: 100, lines: [{ receivableId: id, appliedCents: 100 }] }));
    await expect(voidIt(w, draft.id)).rejects.toMatchObject({ code: 'INVALID_RECEIPT_STATE' });
    const posted = await post(w, draft.id);
    await expect(voidIt(w, posted.id, 'Intento desde otra organización', ORG_B)).rejects.toMatchObject({ code: 'RECEIPT_NOT_FOUND' });
  });

  it('si la factura se anuló después del cobro, anular el cobro deja la partida anulada (no la reabre)', async () => {
    const w = buildWorld();
    const inv = w.invoice({ total: 5000 });
    await w.useCases.invoiceIssued.execute(inv);
    const id = w.receivables()[0]!.id;
    const posted = await post(w, (await create(w, input({ totalCents: 5000, lines: [{ receivableId: id, appliedCents: 5000 }] }))).id);
    await w.useCases.invoiceVoided.execute({ organizationId: ORG_A, invoiceId: inv.invoiceId, number: inv.number, issueDate: inv.issueDate });
    // la partida anulada con un cobro encima queda con saldo en contra (el cliente pagó una factura que ya no existe)
    expect(await balance(w, id)).toBe(-5000);
    await voidIt(w, posted.id);
    expect(await statusOf(w, id)).toBe('cancelled');
    expect(await balance(w, id)).toBe(0);
  });
});

describe('listado y lectura', () => {
  it('filtra por cliente, estado, fechas y búsqueda; pagina; y el detalle trae sus líneas', async () => {
    const w = buildWorld();
    const a = await debt(w, 50000);
    const b = await debt(w, 50000, CUSTOMER_2);
    await post(w, (await create(w, input({ totalCents: 1000, reference: 'CHQ-77', method: 'check', lines: [{ receivableId: a, appliedCents: 1000 }] }))).id);
    await create(w, input({ totalCents: 2000, receiptDate: '2026-09-01', lines: [{ receivableId: b, appliedCents: 2000 }] }), CUSTOMER_2);

    const list = (filters: Record<string, unknown>) => w.useCases.listReceipts.execute({ organizationId: ORG_A, filters: { page: 1, pageSize: 25, ...filters } as never });
    expect((await list({})).total).toBe(2);
    expect((await list({ customerId: CUSTOMER_2 })).total).toBe(1);
    expect((await list({ status: ['posted'] })).total).toBe(1);
    expect((await list({ status: ['draft'] })).items[0]!.status).toBe('draft');
    expect((await list({ from: '2026-10-01' })).total).toBe(1);
    expect((await list({ q: 'CHQ-77' })).total).toBe(1);
    expect((await list({ q: 'RC-2026-000001' })).total).toBe(1);
    expect((await list({ q: 'DOS' })).total).toBe(1);
    expect((await list({ pageSize: 1, page: 2 })).items).toHaveLength(1);
    const first = (await list({ customerId: CUSTOMER_1 })).items[0]!;
    expect((await w.useCases.getReceipt.execute({ organizationId: ORG_A, receiptId: first.id })).lines).toHaveLength(1);
  });

  it('otra organización no ve nada', async () => {
    const w = buildWorld();
    const id = await debt(w);
    const r = await create(w, input({ totalCents: 100, lines: [{ receivableId: id, appliedCents: 100 }] }));
    expect((await w.useCases.listReceipts.execute({ organizationId: ORG_B, filters: { page: 1, pageSize: 25 } })).total).toBe(0);
    await expect(w.useCases.getReceipt.execute({ organizationId: ORG_B, receiptId: r.id })).rejects.toMatchObject({ httpStatus: 404 });
  });
});
