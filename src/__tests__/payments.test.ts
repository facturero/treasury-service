import { describe, expect, it } from 'vitest';
import {
  CatalogUnavailableError,
  PaymentAdvanceInUseError,
  PaymentApprovalRequiredError,
  PaymentNotFoundError,
  PaymentSelfApprovalError,
  PaymentStateError,
  ValidationError,
} from '../domain/errors.js';
import { payableBalanceOf, type Payable } from '../domain/payable.js';
import type { PaymentInput } from '../domain/payment.js';
import { buildWorld, ORG_A, ORG_B, SUPPLIER_1, SUPPLIER_2, USER_1, USER_2, type World } from './helpers.js';

async function debt(w: World, overrides: Parameters<World['bill']>[0] = {}): Promise<Payable> {
  const bill = w.bill(overrides);
  await w.useCases.billPosted.execute(bill);
  return w.payableOf(bill.billId)!;
}

const input = (payableId: string, cents: number, extra: Partial<PaymentInput> = {}): PaymentInput => ({
  paymentDate: '2026-10-21',
  method: 'transfer',
  reference: 'TRX-1',
  totalCents: cents,
  lines: [{ payableId, appliedCents: cents }],
  ...extra,
});

const create = (w: World, payment: PaymentInput, userId = USER_1, supplierId = SUPPLIER_1, organizationId = ORG_A) => w.useCases.createPayment.execute({ organizationId, supplierId, userId, payment });
const post = (w: World, paymentId: string, userId = USER_1, organizationId = ORG_A) => w.useCases.postPayment.execute({ organizationId, paymentId, userId });
const balanceOf = async (w: World, id: string) => payableBalanceOf((await w.useCases.getPayableDetail.execute({ organizationId: ORG_A, payableId: id })).payable);

describe('crear y editar un pago (borrador)', () => {
  it('un borrador no toca saldos, no gasta número y publica treasury.payment.created', async () => {
    const w = buildWorld();
    const p = await debt(w);
    const draft = await create(w, input(p.id, 5000));
    expect(draft).toMatchObject({ status: 'draft', number: null, supplierName: 'PROVEEDOR UNO S.A.', totalCents: 5000, appliedCents: 5000, advanceCents: 0, accountRole: 'bank', createdBy: USER_1 });
    expect(await balanceOf(w, p.id)).toBe(11500);
    expect(w.events('treasury.payment.created')[0]!.payload).toMatchObject({ paymentId: draft.id, supplierId: SUPPLIER_1, totalCents: 5000, lineCount: 1 });
    expect(w.data.paymentSequences.size).toBe(0);
  });

  it('el efectivo sale de caja y lo demás de bancos; la persona puede elegir otro rol', async () => {
    const w = buildWorld();
    const p = await debt(w);
    expect((await create(w, input(p.id, 100, { method: 'cash', reference: null }))).accountRole).toBe('cash');
    expect((await create(w, input(p.id, 100, { method: 'cash', reference: null, accountRole: 'bank' }))).accountRole).toBe('bank');
  });

  it.each([
    ['transferencia sin referencia', { method: 'transfer', reference: '  ' }, 'reference'],
    ['cheque sin referencia', { method: 'check', reference: null }, 'reference'],
    ['fecha inválida', { paymentDate: '2026-02-31' }, 'paymentDate'],
    ['medio desconocido', { method: 'bitcoin' }, 'method'],
    ['importe con decimales', { totalCents: 10.5 }, 'totalCents'],
    ['la misma factura dos veces', { lines: [{ payableId: 'a', appliedCents: 1 }, { payableId: 'a', appliedCents: 1 }] }, 'lines[1].payableId'],
    ['sin importe', { totalCents: 0, lines: [] }, 'totalCents'],
  ])('rechaza %s con el campo', async (_n, overrides, field) => {
    const w = buildWorld();
    const p = await debt(w);
    const err = await create(w, { ...input(p.id, 100), ...(overrides as Partial<PaymentInput>) }).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.details.map((d: { field: string }) => d.field)).toContain(field);
  });

  it('el proveedor tiene que existir (422) y compras caído es 502, nunca «no existe»', async () => {
    const w = buildWorld();
    const p = await debt(w);
    const err = await create(w, input(p.id, 100), USER_1, '99999999-9999-4999-8999-999999999999').catch((e) => e);
    expect(err.details[0].field).toBe('supplierId');
    w.suppliers.down = true;
    await expect(create(w, input(p.id, 100))).rejects.toBeInstanceOf(CatalogUnavailableError);
  });

  it('avisa pronto de lo que fallará: factura de otro proveedor, de otra organización, o saldo insuficiente (con índice de línea)', async () => {
    const w = buildWorld();
    const mine = await debt(w);
    const theirs = await debt(w, { supplier: w.knownSuppliers.get(SUPPLIER_2)! });
    const err = await create(w, { ...input(mine.id, 100), totalCents: 20100, lines: [{ payableId: theirs.id, appliedCents: 100 }, { payableId: mine.id, appliedCents: 20000 }] }).catch((e) => e);
    expect(err.details.map((d: { field: string }) => d.field)).toEqual(['lines[0].payableId', 'lines[1].appliedCents']);
    const other = await create(w, input(mine.id, 100), USER_1, SUPPLIER_1, ORG_B).catch((e) => e);
    expect(other.details[0].field).toBe('lines[0].payableId');
  });

  it('editar un borrador cambia lo escrito (la entrada manda) y exige la versión; uno contabilizado no se edita', async () => {
    const w = buildWorld();
    const p = await debt(w);
    const draft = await create(w, input(p.id, 5000));
    const edited = await w.useCases.updatePayment.execute({ organizationId: ORG_A, paymentId: draft.id, userId: USER_1, payment: input(p.id, 7000, { notes: 'ajustado' }), expectedVersion: draft.version });
    expect(edited).toMatchObject({ totalCents: 7000, appliedCents: 7000, notes: 'ajustado', version: draft.version + 1 });
    await expect(w.useCases.updatePayment.execute({ organizationId: ORG_A, paymentId: draft.id, userId: USER_1, payment: input(p.id, 1), expectedVersion: draft.version })).rejects.toBeInstanceOf(PaymentStateError);
    await post(w, draft.id);
    await expect(w.useCases.updatePayment.execute({ organizationId: ORG_A, paymentId: draft.id, userId: USER_1, payment: input(p.id, 1) })).rejects.toBeInstanceOf(PaymentStateError);
  });
});

describe('contabilizar', () => {
  it('aplica a la factura, asigna PG-AAAA-NNNNNN, publica payable.credited y payment.posted, y el saldo baja', async () => {
    const w = buildWorld();
    const p = await debt(w, { total: 11500, supplierDocument: '001-001-000000321' });
    const draft = await create(w, input(p.id, 5000));
    const posted = await post(w, draft.id, USER_2);
    expect(posted).toMatchObject({ status: 'posted', number: 'PG-2026-000001', postedBy: USER_2 });
    expect(await balanceOf(w, p.id)).toBe(6500);
    expect((await w.useCases.getPayableDetail.execute({ organizationId: ORG_A, payableId: p.id })).payable.status).toBe('partial');
    expect(w.events('treasury.payable.credited')[0]!.payload).toMatchObject({ creditType: 'payment', appliedCents: 5000, creditDocumentNumber: 'PG-2026-000001' });
    expect(w.events('treasury.payment.posted')[0]!.payload).toMatchObject({
      organizationId: ORG_A, paymentId: draft.id, number: 'PG-2026-000001', supplierId: SUPPLIER_1, paymentDate: '2026-10-21', accountRole: 'bank',
      totalCents: 5000, appliedCents: 5000, advanceCents: 0, advanceUsedCents: 0, currencyCode: 'USD', postedBy: USER_2,
    });
    expect((w.events('treasury.payment.posted')[0]!.payload.lines as { documentNumber: string }[])[0]!.documentNumber).toBe('001-001-000000321');
  });

  it('pagar todo deja la factura pagada; la numeración es secuencial por año y los borradores no gastan número', async () => {
    const w = buildWorld();
    const a = await debt(w, { total: 1150 });
    const b = await debt(w, { total: 2300 });
    await create(w, input(a.id, 1)); // un borrador que no se contabiliza
    const one = await post(w, (await create(w, input(a.id, 1150))).id);
    const two = await post(w, (await create(w, input(b.id, 2300))).id);
    expect([one.number, two.number]).toEqual(['PG-2026-000001', 'PG-2026-000002']);
    expect((await w.useCases.getPayableDetail.execute({ organizationId: ORG_A, payableId: a.id })).payable.status).toBe('paid');
  });

  it('NUNCA se paga de más: el saldo disponible ya descuenta la retención', async () => {
    const w = buildWorld();
    const p = await debt(w, { total: 11500, supplierDocument: '001-001-000000123' });
    await w.useCases.withholdingIssued.execute(w.withholding({ totalWithheldCents: 1000 }));
    const err = await create(w, input(p.id, 11000)).catch((e) => e);
    expect(err.details[0]).toMatchObject({ field: 'lines[0].appliedCents' });
    expect(err.details[0].message).toContain('10500');
    const ok = await post(w, (await create(w, input(p.id, 10500))).id);
    expect(ok.status).toBe('posted');
    expect(await balanceOf(w, p.id)).toBe(0);
  });

  it('entre guardar y contabilizar otra persona pudo pagar lo mismo: la comprobación que vale es la de contabilizar', async () => {
    const w = buildWorld();
    const p = await debt(w, { total: 1150 });
    const a = await create(w, input(p.id, 1000));
    const b = await create(w, input(p.id, 1000, { reference: 'TRX-2' }));
    await post(w, a.id);
    const err = await post(w, b.id).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.details[0].field).toBe('lines[0].appliedCents');
    expect(w.payments().find((x) => x.id === b.id)!.status).toBe('draft');
  });

  it('idempotente: contabilizar dos veces devuelve el mismo pago y no paga dos veces', async () => {
    const w = buildWorld();
    const p = await debt(w);
    const draft = await create(w, input(p.id, 5000));
    const first = await post(w, draft.id);
    const second = await post(w, draft.id);
    expect(second.number).toBe(first.number);
    expect(await balanceOf(w, p.id)).toBe(6500);
    expect(w.events('treasury.payment.posted')).toHaveLength(1);
  });

  it('un pago que no existe, o de otra organización, da 404', async () => {
    const w = buildWorld();
    const p = await debt(w);
    const draft = await create(w, input(p.id, 100));
    await expect(post(w, 'x')).rejects.toBeInstanceOf(PaymentNotFoundError);
    await expect(post(w, draft.id, USER_1, ORG_B)).rejects.toBeInstanceOf(PaymentNotFoundError);
  });

  it('una factura anulada ya no se puede pagar', async () => {
    const w = buildWorld();
    const bill = w.bill();
    await w.useCases.billPosted.execute(bill);
    const draft = await create(w, input(w.payableOf(bill.billId)!.id, 100));
    await w.useCases.billVoided.execute(bill);
    const err = await post(w, draft.id).catch((e) => e);
    expect(err.details[0].message).toMatch(/pagada o anulada/);
  });
});

describe('anticipos a proveedores', () => {
  it('pagar de más abre un anticipo (con evento) que otro pago consume; el anticipo no se consume dos veces', async () => {
    const w = buildWorld();
    const first = await debt(w, { total: 1150 });
    const second = await debt(w, { total: 5750 });
    const over = await post(w, (await create(w, input(first.id, 1150, { totalCents: 2000 }))).id);
    expect(over).toMatchObject({ appliedCents: 1150, advanceCents: 850 });
    expect(w.events('treasury.supplier_advance.opened')[0]!.payload).toMatchObject({ amountCents: 850, supplierId: SUPPLIER_1, documentNumber: over.number });
    const advance = (await w.useCases.getSupplierStatement.execute({ organizationId: ORG_A, supplierId: SUPPLIER_1 })).advances[0]!;
    expect(advance.originalCents - advance.appliedCents).toBe(850);

    // el segundo pago no mueve dinero: consume el anticipo
    const used = await post(w, (await create(w, { paymentDate: '2026-10-21', method: 'cash', totalCents: 0, lines: [{ payableId: second.id, appliedCents: 850 }], advanceUses: [{ advanceId: advance.id, usedCents: 850 }] })).id);
    expect(used).toMatchObject({ totalCents: 0, advanceUsedCents: 850, appliedCents: 850, advanceCents: 0 });
    expect(await balanceOf(w, second.id)).toBe(4900);
    const err = await create(w, { paymentDate: '2026-10-21', method: 'cash', totalCents: 0, lines: [{ payableId: second.id, appliedCents: 1 }], advanceUses: [{ advanceId: advance.id, usedCents: 1 }] }).catch((e) => e);
    expect(err.details[0].field).toBe('advanceUses[0].usedCents');
  });

  it('un anticipo de OTRO proveedor no se puede consumir', async () => {
    const w = buildWorld();
    const mine = await debt(w, { total: 1150 });
    const other = await debt(w, { total: 1150, supplier: w.knownSuppliers.get(SUPPLIER_2)! });
    await post(w, (await create(w, input(other.id, 1150, { totalCents: 2000 }), USER_1, SUPPLIER_2)).id);
    const foreign = (await w.useCases.getSupplierStatement.execute({ organizationId: ORG_A, supplierId: SUPPLIER_2 })).advances[0]!;
    const err = await create(w, { paymentDate: '2026-10-21', method: 'cash', totalCents: 0, lines: [{ payableId: mine.id, appliedCents: 100 }], advanceUses: [{ advanceId: foreign.id, usedCents: 100 }] }).catch((e) => e);
    expect(err.details[0]).toMatchObject({ field: 'advanceUses[0].advanceId', message: expect.stringContaining('otro proveedor') });
  });
});

describe('anular', () => {
  it('devuelve el saldo, marca (no borra) las aplicaciones y publica payment.voided con el motivo', async () => {
    const w = buildWorld();
    const p = await debt(w, { total: 11500 });
    const posted = await post(w, (await create(w, input(p.id, 5000))).id);
    const voided = await w.useCases.voidPayment.execute({ organizationId: ORG_A, paymentId: posted.id, userId: USER_2, reason: 'Pago duplicado por error' });
    expect(voided).toMatchObject({ status: 'voided', voidReason: 'Pago duplicado por error', voidedBy: USER_2 });
    expect(await balanceOf(w, p.id)).toBe(11500);
    expect((await w.useCases.getPayableDetail.execute({ organizationId: ORG_A, payableId: p.id })).payable.status).toBe('open');
    expect(w.data.payableApplications).toHaveLength(1); // sigue en la historia
    expect(w.data.payableApplications[0]!.reversedAt).not.toBeNull();
    expect(w.events('treasury.payment.voided')[0]!.payload).toMatchObject({ reason: 'Pago duplicado por error', number: posted.number, postedBy: USER_1 });
    // la factura se puede volver a pagar y la numeración no reutiliza el número
    const again = await post(w, (await create(w, input(p.id, 11500))).id);
    expect(again.number).toBe('PG-2026-000002');
  });

  it('idempotente; el motivo exige 5 caracteres; un borrador no se anula', async () => {
    const w = buildWorld();
    const p = await debt(w);
    const draft = await create(w, input(p.id, 100));
    await expect(w.useCases.voidPayment.execute({ organizationId: ORG_A, paymentId: draft.id, userId: USER_1, reason: 'no hace falta' })).rejects.toBeInstanceOf(PaymentStateError);
    const posted = await post(w, draft.id);
    await expect(w.useCases.voidPayment.execute({ organizationId: ORG_A, paymentId: posted.id, userId: USER_1, reason: 'abc' })).rejects.toBeInstanceOf(ValidationError);
    await w.useCases.voidPayment.execute({ organizationId: ORG_A, paymentId: posted.id, userId: USER_1, reason: 'Motivo suficiente' });
    const second = await w.useCases.voidPayment.execute({ organizationId: ORG_A, paymentId: posted.id, userId: USER_1, reason: 'Motivo suficiente' });
    expect(second.status).toBe('voided');
    expect(w.events('treasury.payment.voided')).toHaveLength(1);
    await expect(post(w, posted.id)).rejects.toBeInstanceOf(PaymentStateError);
  });

  it('no se anula un pago cuyo anticipo ya consumió otro pago; al anular ese, sí', async () => {
    const w = buildWorld();
    const a = await debt(w, { total: 1150 });
    const b = await debt(w, { total: 5750 });
    const over = await post(w, (await create(w, input(a.id, 1150, { totalCents: 2000 }))).id);
    const advance = (await w.useCases.getSupplierStatement.execute({ organizationId: ORG_A, supplierId: SUPPLIER_1 })).advances[0]!;
    const consumer = await post(w, (await create(w, { paymentDate: '2026-10-21', method: 'cash', totalCents: 0, lines: [{ payableId: b.id, appliedCents: 850 }], advanceUses: [{ advanceId: advance.id, usedCents: 850 }] })).id);
    await expect(w.useCases.voidPayment.execute({ organizationId: ORG_A, paymentId: over.id, userId: USER_1, reason: 'Pago equivocado' })).rejects.toBeInstanceOf(PaymentAdvanceInUseError);
    await w.useCases.voidPayment.execute({ organizationId: ORG_A, paymentId: consumer.id, userId: USER_1, reason: 'Se rehace el pago' });
    await w.useCases.voidPayment.execute({ organizationId: ORG_A, paymentId: over.id, userId: USER_1, reason: 'Pago equivocado' });
    expect((await w.useCases.getSupplierStatement.execute({ organizationId: ORG_A, supplierId: SUPPLIER_1 })).advances).toHaveLength(0);
  });
});

describe('aprobación (separación de funciones)', () => {
  const setThreshold = (w: World, approvalThresholdCents: number | null) => w.useCases.setPaymentSettings.execute({ organizationId: ORG_A, approvalThresholdCents, userId: USER_1 });

  it('sin umbral (nace así) nadie necesita aprobar: contabiliza el mismo que lo creó', async () => {
    const w = buildWorld();
    expect((await w.useCases.getPaymentSettings.execute({ organizationId: ORG_A })).approvalThresholdCents).toBeNull();
    const p = await debt(w, { total: 1150000 });
    expect((await post(w, (await create(w, input(p.id, 1000000))).id)).status).toBe('posted');
  });

  it('fijar el umbral deja el valor anterior y el nuevo en la bitácora y valida el importe', async () => {
    const w = buildWorld();
    await setThreshold(w, 100000);
    await setThreshold(w, null);
    const [first, second] = w.events('treasury.payment_settings.updated');
    expect(first!.payload).toMatchObject({ approvalThresholdCents: 100000, previousApprovalThresholdCents: null, updatedBy: USER_1 });
    expect(second!.payload).toMatchObject({ approvalThresholdCents: null, previousApprovalThresholdCents: 100000 });
    for (const bad of [0, -5, 1.5]) await expect(setThreshold(w, bad)).rejects.toBeInstanceOf(ValidationError);
  });

  it('con umbral, un pago que lo alcanza NO se contabiliza sin aprobación; uno por debajo, sí', async () => {
    const w = buildWorld();
    await setThreshold(w, 50000);
    const p = await debt(w, { total: 115000 });
    const big = await create(w, input(p.id, 60000));
    await expect(post(w, big.id)).rejects.toBeInstanceOf(PaymentApprovalRequiredError);
    expect(w.payments().find((x) => x.id === big.id)!.status).toBe('draft');
    expect((await post(w, (await create(w, input(p.id, 10000, { reference: 'T2' }))).id)).status).toBe('posted');
  });

  it('quien creó el pago NO lo aprueba (403); otra persona sí, y entonces se contabiliza', async () => {
    const w = buildWorld();
    await setThreshold(w, 50000);
    const p = await debt(w, { total: 115000 });
    const draft = await create(w, input(p.id, 60000), USER_1);
    await expect(w.useCases.approvePayment.execute({ organizationId: ORG_A, paymentId: draft.id, userId: USER_1 })).rejects.toBeInstanceOf(PaymentSelfApprovalError);
    const approved = await w.useCases.approvePayment.execute({ organizationId: ORG_A, paymentId: draft.id, userId: USER_2 });
    expect(approved).toMatchObject({ status: 'approved', approvedBy: USER_2 });
    expect(w.events('treasury.payment.approved')[0]!.payload).toMatchObject({ createdBy: USER_1, approvedBy: USER_2 });
    // idempotente
    expect((await w.useCases.approvePayment.execute({ organizationId: ORG_A, paymentId: draft.id, userId: USER_2 })).version).toBe(approved.version);
    const posted = await post(w, draft.id, USER_1);
    expect(posted).toMatchObject({ status: 'posted', approvedBy: USER_2, postedBy: USER_1 });
    expect(w.events('treasury.payment.posted')[0]!.payload).toMatchObject({ createdBy: USER_1, approvedBy: USER_2 });
  });

  it('un pago por debajo del umbral no necesita aprobación (409 si se intenta)', async () => {
    const w = buildWorld();
    await setThreshold(w, 50000);
    const p = await debt(w, { total: 115000 });
    const small = await create(w, input(p.id, 1000));
    await expect(w.useCases.approvePayment.execute({ organizationId: ORG_A, paymentId: small.id, userId: USER_2 })).rejects.toBeInstanceOf(PaymentStateError);
  });

  it('editar un pago aprobado le QUITA la aprobación: lo aprobado ya no es lo que se va a pagar', async () => {
    const w = buildWorld();
    await setThreshold(w, 50000);
    const p = await debt(w, { total: 115000 });
    const draft = await create(w, input(p.id, 60000));
    await w.useCases.approvePayment.execute({ organizationId: ORG_A, paymentId: draft.id, userId: USER_2 });
    const edited = await w.useCases.updatePayment.execute({ organizationId: ORG_A, paymentId: draft.id, userId: USER_1, payment: input(p.id, 90000) });
    expect(edited).toMatchObject({ status: 'draft', approvedBy: null, approvedAt: null });
    await expect(post(w, draft.id)).rejects.toBeInstanceOf(PaymentApprovalRequiredError);
  });

  it('si el umbral se BAJA después de aprobar, lo aprobado sigue valiendo; si se sube, lo pendiente ya no necesita aprobación', async () => {
    const w = buildWorld();
    const p = await debt(w, { total: 115000 });
    await setThreshold(w, 50000);
    const draft = await create(w, input(p.id, 60000));
    await setThreshold(w, 500000);
    expect((await post(w, draft.id)).status).toBe('posted');
  });
});

describe('listado y aislamiento', () => {
  it('filtra por proveedor, estado y texto, y no mezcla organizaciones', async () => {
    const w = buildWorld();
    const p = await debt(w);
    const other = await debt(w, { supplier: w.knownSuppliers.get(SUPPLIER_2)! });
    await post(w, (await create(w, input(p.id, 100, { reference: 'ABC-1' }))).id);
    await create(w, input(other.id, 100, { reference: 'XYZ-9' }), USER_1, SUPPLIER_2);
    const list = (filters: object) => w.useCases.listPayments.execute({ organizationId: ORG_A, filters: { page: 1, pageSize: 25, ...filters } });
    expect((await list({})).total).toBe(2);
    expect((await list({ supplierId: SUPPLIER_2 })).items.map((x) => x.reference)).toEqual(['XYZ-9']);
    expect((await list({ status: ['posted'] })).total).toBe(1);
    expect((await list({ q: 'abc' })).items[0]!.number).toBe('PG-2026-000001');
    expect((await w.useCases.listPayments.execute({ organizationId: ORG_B, filters: { page: 1, pageSize: 25 } })).total).toBe(0);
  });
});
