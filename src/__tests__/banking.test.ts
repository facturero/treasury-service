import { describe, expect, it } from 'vitest';
import { defaultImportProfile, type BankAccountInput, type ImportProfile } from '../domain/bank.js';
import {
  BankAccountNotFoundError,
  BankMatchError,
  BankReconciledError,
  BankReconciliationStateError,
  BankStatementAlreadyImportedError,
  ValidationError,
} from '../domain/errors.js';
import { buildWorld, CUSTOMER_1, ORG_A, ORG_B, SUPPLIER_1, USER_1, USER_2, type World } from './helpers.js';

const profile = (): ImportProfile => ({ ...defaultImportProfile(), referenceColumn: 3, amountColumn: 4, balanceColumn: 5 });
const accountInput = (over: Partial<BankAccountInput> = {}): BankAccountInput => ({
  name: 'Pichincha',
  bankName: 'Banco Pichincha',
  accountType: 'checking',
  accountLast4: '1234',
  openingBalanceCents: 100000,
  openingDate: '2026-09-30',
  importProfile: profile(),
  ...over,
});

const csv = (rows: [string, string, string, string, string][]) => ['Fecha,Descripcion,Referencia,Monto,Saldo', ...rows.map((r) => r.map((c) => (c.includes(',') ? `"${c}"` : c)).join(','))].join('\n');

async function newAccount(w: World, over: Partial<BankAccountInput> = {}, organizationId = ORG_A) {
  return w.useCases.createBankAccount.execute({ organizationId, userId: USER_1, account: accountInput(over) });
}

/** Un cobro por banco contabilizado a una cuenta. */
async function collect(w: World, bankAccountId: string | null, cents: number, reference: string, date = '2026-10-05', method: 'transfer' | 'cash' = 'transfer') {
  const inv = w.invoice({ total: cents });
  await w.useCases.invoiceIssued.execute(inv);
  const receivable = w.receivables().find((r) => r.sourceId === inv.invoiceId)!;
  const draft = await w.useCases.createReceipt.execute({
    organizationId: ORG_A,
    customerId: CUSTOMER_1,
    userId: USER_1,
    receipt: { receiptDate: date, method, reference: method === 'cash' ? null : reference, bankAccountId, totalCents: cents, lines: [{ receivableId: receivable.id, appliedCents: cents }] },
  });
  return w.useCases.postReceipt.execute({ organizationId: ORG_A, receiptId: draft.id, userId: USER_1 });
}

/** Un pago por banco contabilizado a una cuenta. */
async function pay(w: World, bankAccountId: string | null, cents: number, reference: string, date = '2026-10-06') {
  const bill = w.bill({ total: cents });
  await w.useCases.billPosted.execute(bill);
  const payable = w.payableOf(bill.billId)!;
  const draft = await w.useCases.createPayment.execute({
    organizationId: ORG_A,
    supplierId: SUPPLIER_1,
    userId: USER_1,
    payment: { paymentDate: date, method: 'transfer', reference, bankAccountId, totalCents: cents, lines: [{ payableId: payable.id, appliedCents: cents }] },
  });
  return w.useCases.postPayment.execute({ organizationId: ORG_A, paymentId: draft.id, userId: USER_1 });
}

const movements = (w: World) => [...w.data.bankMovements.values()];
const movementOf = (w: World, sourceId: string) => movements(w).find((m) => m.sourceId === sourceId)!;
const importCsv = (w: World, bankAccountId: string, text: string, extra: { fileName?: string } = {}) => w.useCases.importStatement.execute({ organizationId: ORG_A, userId: USER_1, bankAccountId, csv: text, ...extra });
const lines = (w: World) => [...w.data.bankLines.values()].sort((a, b) => (a.lineDate < b.lineDate ? -1 : 1));
const match = (w: World, lineId: string, movementIds: string[]) => w.useCases.matchLine.execute({ organizationId: ORG_A, userId: USER_1, lineId, movementIds, method: 'manual' });

describe('cuentas bancarias', () => {
  it('se crea con la moneda de la contabilidad, deja un evento y no guarda más que los últimos 4 dígitos', async () => {
    const w = buildWorld();
    const account = await newAccount(w);
    expect(account).toMatchObject({ name: 'Pichincha', currencyCode: 'USD', openingBalanceCents: 100000, openingDate: '2026-09-30', isActive: true, accountLast4: '1234' });
    expect(w.events('treasury.bank_account.created')[0]!.payload).toMatchObject({ bankAccountId: account.id, name: 'Pichincha', accountLast4: '1234', hasImportProfile: true });
    await expect(newAccount(w, { name: 'Otra', accountLast4: '2200123456789' })).rejects.toBeInstanceOf(ValidationError);
  });

  it('el nombre es único por organización (otra organización puede repetirlo)', async () => {
    const w = buildWorld();
    await newAccount(w);
    await expect(newAccount(w)).rejects.toBeInstanceOf(ValidationError);
    await expect(newAccount(w, {}, ORG_B)).resolves.toBeTruthy();
  });

  it('sin contabilidad configurada no hay moneda y no se crea', async () => {
    const w = buildWorld({ settings: null });
    await expect(newAccount(w)).rejects.toBeInstanceOf(ValidationError);
  });

  it('editar deja en el evento qué cambió; la apertura solo cambia mientras no haya extractos', async () => {
    const w = buildWorld();
    const account = await newAccount(w);
    const renamed = await w.useCases.updateBankAccount.execute({ organizationId: ORG_A, userId: USER_1, bankAccountId: account.id, patch: { name: 'Pichincha corriente', openingBalanceCents: 120000 } });
    expect(renamed).toMatchObject({ name: 'Pichincha corriente', openingBalanceCents: 120000, version: 2 });
    expect(w.events('treasury.bank_account.updated')[0]!.payload).toMatchObject({ changes: { name: { from: 'Pichincha', to: 'Pichincha corriente' }, openingBalanceCents: { from: 100000, to: 120000 } } });

    await importCsv(w, account.id, csv([['01/10/2026', 'Deposito', 'D1', '50.00', '1700.00']]));
    await expect(w.useCases.updateBankAccount.execute({ organizationId: ORG_A, userId: USER_1, bankAccountId: account.id, patch: { openingBalanceCents: 5 } })).rejects.toBeInstanceOf(ValidationError);
    await expect(w.useCases.updateBankAccount.execute({ organizationId: ORG_A, userId: USER_1, bankAccountId: account.id, patch: { name: 'Otro nombre' } })).resolves.toBeTruthy(); // el nombre sí
  });

  it('una cuenta de otra organización no existe', async () => {
    const w = buildWorld();
    const account = await newAccount(w);
    await expect(w.useCases.getBankAccount.execute({ organizationId: ORG_B, bankAccountId: account.id })).rejects.toBeInstanceOf(BankAccountNotFoundError);
  });
});

describe('el registro de bancos: cobros y pagos', () => {
  it('un cobro por banco deja un movimiento que ENTRA (+) en su cuenta; un pago uno que SALE (−)', async () => {
    const w = buildWorld();
    const account = await newAccount(w);
    const receipt = await collect(w, account.id, 5000, 'TRX-1');
    const payment = await pay(w, account.id, 3000, 'TRX-2');
    expect(movementOf(w, receipt.id)).toMatchObject({ bankAccountId: account.id, sourceType: 'receipt', amountCents: 5000, reference: 'TRX-1', description: 'CLIENTE UNO S.A.', status: 'active', movementDate: '2026-10-05' });
    expect(movementOf(w, payment.id)).toMatchObject({ bankAccountId: account.id, sourceType: 'payment', amountCents: -3000, description: 'PROVEEDOR UNO S.A.' });
  });

  it('el efectivo no es un movimiento de banco', async () => {
    const w = buildWorld();
    await collect(w, null, 5000, '', '2026-10-05', 'cash');
    expect(movements(w)).toHaveLength(0);
  });

  it('un borrador no es movimiento; sin cuenta elegida queda «sin asignar» y se asigna después', async () => {
    const w = buildWorld();
    const account = await newAccount(w);
    const receipt = await collect(w, null, 5000, 'TRX-1');
    const m = movementOf(w, receipt.id);
    expect(m.bankAccountId).toBeNull();
    expect((await w.useCases.listBankAccounts.execute({ organizationId: ORG_A })).unassignedMovements).toBe(1);
    const assigned = await w.useCases.assignMovementAccount.execute({ organizationId: ORG_A, userId: USER_2, movementId: m.id, bankAccountId: account.id });
    expect(assigned.bankAccountId).toBe(account.id);
    expect(w.events('treasury.bank_movement.assigned')[0]!.payload).toMatchObject({ movementId: m.id, bankAccountId: account.id, previousBankAccountId: null, assignedBy: USER_2 });
  });

  it('elegir una cuenta que no existe, desactivada, con rol caja o de otra organización es 422', async () => {
    const w = buildWorld();
    const account = await newAccount(w);
    const other = await newAccount(w, { name: 'Guayaquil' }, ORG_B);
    const inv = w.invoice({ total: 5000 });
    await w.useCases.invoiceIssued.execute(inv);
    const r = w.receivables().find((x) => x.sourceId === inv.invoiceId)!;
    const base = { organizationId: ORG_A, customerId: CUSTOMER_1, userId: USER_1 };
    const receipt = (extra: object) => ({ receiptDate: '2026-10-05', method: 'transfer' as const, reference: 'T1', totalCents: 5000, lines: [{ receivableId: r.id, appliedCents: 5000 }], ...extra });
    await expect(w.useCases.createReceipt.execute({ ...base, receipt: receipt({ bankAccountId: other.id }) })).rejects.toBeInstanceOf(ValidationError);
    await expect(w.useCases.createReceipt.execute({ ...base, receipt: receipt({ bankAccountId: '99999999-9999-4999-8999-999999999999' }) })).rejects.toBeInstanceOf(ValidationError);
    await expect(w.useCases.createReceipt.execute({ ...base, receipt: receipt({ method: 'cash', reference: null, bankAccountId: account.id }) })).rejects.toBeInstanceOf(ValidationError);
    await w.useCases.updateBankAccount.execute({ organizationId: ORG_A, userId: USER_1, bankAccountId: account.id, patch: { isActive: false } });
    await expect(w.useCases.createReceipt.execute({ ...base, receipt: receipt({ bankAccountId: account.id }) })).rejects.toBeInstanceOf(ValidationError);
  });

  it('anular el cobro o el pago revierte el movimiento', async () => {
    const w = buildWorld();
    const account = await newAccount(w);
    const receipt = await collect(w, account.id, 5000, 'TRX-1');
    await w.useCases.voidReceipt.execute({ organizationId: ORG_A, receiptId: receipt.id, userId: USER_1, reason: 'Transferencia rechazada' });
    expect(movementOf(w, receipt.id).status).toBe('reversed');
    const payment = await pay(w, account.id, 3000, 'TRX-2');
    await w.useCases.voidPayment.execute({ organizationId: ORG_A, paymentId: payment.id, userId: USER_1, reason: 'Pago duplicado' });
    expect(movementOf(w, payment.id).status).toBe('reversed');
    const summary = await w.useCases.getBankAccount.execute({ organizationId: ORG_A, bankAccountId: account.id });
    expect(summary.registerBalanceCents).toBe(100000); // vuelve a la apertura
  });

  it('el saldo del registro es apertura + lo que entró − lo que salió', async () => {
    const w = buildWorld();
    const account = await newAccount(w);
    await collect(w, account.id, 5000, 'TRX-1');
    await pay(w, account.id, 3000, 'TRX-2');
    expect((await w.useCases.getBankAccount.execute({ organizationId: ORG_A, bankAccountId: account.id })).registerBalanceCents).toBe(102000);
  });
});

describe('importar un extracto', () => {
  const sample = csv([
    ['01/10/2026', 'Transferencia ACME', 'TRX-1', '1000.00', '2000.00'],
    ['02/10/2026', 'Comision mensual', '', '-2.50', '1997.50'],
  ]);

  it('la vista previa dice qué entraría sin guardar nada', async () => {
    const w = buildWorld();
    const account = await newAccount(w);
    const preview = await w.useCases.previewStatement.execute({ organizationId: ORG_A, bankAccountId: account.id, csv: sample });
    expect(preview).toMatchObject({ newLines: 2, duplicates: 0, errorCount: 0, canImport: true, periodStart: '2026-10-01', periodEnd: '2026-10-02', closingBalanceCents: 199750, inCents: 100000, outCents: -250 });
    expect(w.data.bankLines.size).toBe(0);
  });

  it('importa los renglones, guarda el saldo de cierre y deja un evento', async () => {
    const w = buildWorld();
    const account = await newAccount(w);
    const out = await importCsv(w, account.id, sample, { fileName: 'octubre.csv' });
    expect(out).toMatchObject({ importedLines: 2, skippedDuplicates: 0 });
    expect(out.statement).toMatchObject({ fileName: 'octubre.csv', periodStart: '2026-10-01', periodEnd: '2026-10-02', closingBalanceCents: 199750, closingDate: '2026-10-02' });
    expect(lines(w).map((l) => [l.lineDate, l.amountCents, l.status])).toEqual([['2026-10-01', 100000, 'unmatched'], ['2026-10-02', -250, 'unmatched']]);
    expect(w.events('treasury.bank_statement.imported')[0]!.payload).toMatchObject({ bankAccountName: 'Pichincha', lineCount: 2, closingBalanceCents: 199750 });
  });

  it('el mismo archivo no entra dos veces (409), ni con otro fin de línea', async () => {
    const w = buildWorld();
    const account = await newAccount(w);
    await importCsv(w, account.id, sample);
    await expect(importCsv(w, account.id, sample)).rejects.toBeInstanceOf(BankStatementAlreadyImportedError);
    await expect(importCsv(w, account.id, sample.replace(/\n/g, '\r\n') + '\r\n')).rejects.toBeInstanceOf(BankStatementAlreadyImportedError);
    expect(w.data.bankLines.size).toBe(2);
  });

  it('un extracto que se solapa omite los renglones ya importados y cuenta cuántos', async () => {
    const w = buildWorld();
    const account = await newAccount(w);
    await importCsv(w, account.id, sample);
    const overlap = csv([
      ['02/10/2026', 'Comision mensual', '', '-2.50', '1997.50'],
      ['03/10/2026', 'Cheque 45', '45', '-300.00', '1697.50'],
    ]);
    const out = await importCsv(w, account.id, overlap);
    expect(out).toMatchObject({ importedLines: 1, skippedDuplicates: 1 });
    expect(w.data.bankLines.size).toBe(3);
  });

  it('todo o nada: una fila mala no importa nada y el error dice la fila', async () => {
    const w = buildWorld();
    const account = await newAccount(w);
    const bad = csv([['01/10/2026', 'Bien', '', '10.00', ''], ['32/10/2026', 'Mal', '', '5.00', '']]);
    await expect(importCsv(w, account.id, bad)).rejects.toMatchObject({ details: [{ field: 'rows[3].date' }] });
    expect(w.data.bankLines.size).toBe(0);
    expect(w.data.bankStatements).toHaveLength(0);
  });

  it('lo anterior a la apertura se omite; un archivo que no trae nada nuevo es 422', async () => {
    const w = buildWorld();
    const account = await newAccount(w);
    const out = await importCsv(w, account.id, csv([['29/09/2026', 'Viejo', '', '10.00', ''], ['05/10/2026', 'Nuevo', '', '20.00', '']]));
    expect(out).toMatchObject({ importedLines: 1, skippedBeforeOpening: 1 });
    await expect(importCsv(w, account.id, csv([['28/09/2026', 'Viejo', '', '10.00', '']]))).rejects.toBeInstanceOf(ValidationError);
  });

  it('sin perfil guardado ni enviado no se sabe leer el archivo; se puede mandar el perfil y guardarlo', async () => {
    const w = buildWorld();
    const account = await newAccount(w, { importProfile: null });
    await expect(importCsv(w, account.id, sample)).rejects.toBeInstanceOf(ValidationError);
    await w.useCases.importStatement.execute({ organizationId: ORG_A, userId: USER_1, bankAccountId: account.id, csv: sample, profile: profile(), saveProfile: true });
    expect((await w.useCases.getBankAccount.execute({ organizationId: ORG_A, bankAccountId: account.id })).account.importProfile).toMatchObject({ dateFormat: 'DD/MM/YYYY', amountColumn: 4 });
  });

  it('una cuenta desactivada no recibe extractos', async () => {
    const w = buildWorld();
    const account = await newAccount(w);
    await w.useCases.updateBankAccount.execute({ organizationId: ORG_A, userId: USER_1, bankAccountId: account.id, patch: { isActive: false } });
    await expect(importCsv(w, account.id, sample)).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('emparejar', () => {
  async function scenario() {
    const w = buildWorld();
    const account = await newAccount(w);
    const receipt = await collect(w, account.id, 5000, 'TRX-1', '2026-10-05');
    const payment = await pay(w, account.id, 3000, 'CHQ-77', '2026-10-06');
    await importCsv(w, account.id, csv([
      ['06/10/2026', 'Transferencia recibida TRX-1', 'TRX-1', '50.00', '1050.00'],
      ['09/10/2026', 'Cheque pagado', 'CHQ-77', '-30.00', '1020.00'],
      ['10/10/2026', 'Comision', '', '-2.50', '1017.50'],
    ]));
    return { w, account, receipt, payment, mReceipt: movementOf(w, receipt.id), mPayment: movementOf(w, payment.id), l: lines(w) };
  }

  it('sugiere por referencia o por fecha, nunca escribe nada, y se confirman en lote', async () => {
    const { w, account, mReceipt, mPayment, l } = await scenario();
    const { suggestions } = await w.useCases.suggestMatches.execute({ organizationId: ORG_A, bankAccountId: account.id });
    expect(suggestions.map((s) => [s.lineId, s.movementId, s.reason])).toEqual(
      expect.arrayContaining([[l[0]!.id, mReceipt.id, 'reference'], [l[1]!.id, mPayment.id, 'reference']]),
    );
    expect(w.data.bankMatches).toHaveLength(0);
    const done = await w.useCases.matchMany.execute({ organizationId: ORG_A, userId: USER_1, method: 'suggested', pairs: suggestions.map((s) => ({ lineId: s.lineId, movementIds: [s.movementId] })) });
    expect(done.failed).toEqual([]);
    expect(w.data.bankMatches).toHaveLength(2);
    expect(lines(w).filter((x) => x.status === 'matched')).toHaveLength(2);
    expect(w.events('treasury.bank_line.matched')[0]!.payload).toMatchObject({ method: 'suggested', matchedBy: USER_1 });
  });

  it('un renglón se empareja con VARIOS movimientos si suman exacto (un depósito de varios cobros)', async () => {
    const w = buildWorld();
    const account = await newAccount(w);
    const r1 = await collect(w, account.id, 2000, 'A1');
    const r2 = await collect(w, account.id, 3000, 'A2');
    await importCsv(w, account.id, csv([['08/10/2026', 'Deposito', 'DEP-1', '50.00', '1050.00']]));
    const line = lines(w)[0]!;
    const out = await match(w, line.id, [movementOf(w, r1.id).id, movementOf(w, r2.id).id]);
    expect(out.line.status).toBe('matched');
    expect(w.data.bankMatches).toHaveLength(2);
  });

  it('la suma debe ser exacta, el signo igual y la cuenta la misma', async () => {
    const { w, account, mReceipt, mPayment, l } = await scenario();
    await expect(match(w, l[0]!.id, [mPayment.id])).rejects.toBeInstanceOf(BankMatchError); // salida contra entrada
    await expect(match(w, l[2]!.id, [mReceipt.id])).rejects.toBeInstanceOf(BankMatchError); // importe distinto
    const other = await newAccount(w, { name: 'Guayaquil' });
    const strayReceipt = await collect(w, other.id, 5000, 'TRX-9');
    await expect(match(w, l[0]!.id, [movementOf(w, strayReceipt.id).id])).rejects.toBeInstanceOf(BankMatchError); // de otra cuenta
    expect(account.id).toBeTruthy();
    expect(w.data.bankMatches).toHaveLength(0);
  });

  it('un movimiento solo se empareja una vez; un renglón emparejado no se vuelve a emparejar', async () => {
    const { w, mReceipt, l } = await scenario();
    await match(w, l[0]!.id, [mReceipt.id]);
    await expect(match(w, l[0]!.id, [mReceipt.id])).rejects.toBeInstanceOf(BankMatchError);
    const twin = await collect(w, mReceipt.bankAccountId, 5000, 'TRX-1B');
    await importCsv(w, mReceipt.bankAccountId!, csv([['07/10/2026', 'Otra', 'TRX-1B', '50.00', '']]));
    const second = lines(w).find((x) => x.reference === 'TRX-1B')!;
    await expect(match(w, second.id, [mReceipt.id])).rejects.toBeInstanceOf(BankMatchError); // ya está tomado por la primera
    await expect(match(w, second.id, [movementOf(w, twin.id).id])).resolves.toBeTruthy();
  });

  it('el lote tolera un par que falla sin tumbar a los demás', async () => {
    const { w, mReceipt, mPayment, l } = await scenario();
    const done = await w.useCases.matchMany.execute({
      organizationId: ORG_A,
      userId: USER_1,
      method: 'suggested',
      pairs: [{ lineId: l[0]!.id, movementIds: [mPayment.id] }, { lineId: l[1]!.id, movementIds: [mPayment.id] }, { lineId: l[0]!.id, movementIds: [mReceipt.id] }],
    });
    expect(done.matched).toEqual([l[1]!.id, l[0]!.id]);
    expect(done.failed).toEqual([expect.objectContaining({ lineId: l[0]!.id, code: 'BANK_MATCH_INVALID' })]);
  });

  it('deshacer devuelve el renglón y los movimientos a «pendientes»', async () => {
    const { w, mReceipt, l } = await scenario();
    await match(w, l[0]!.id, [mReceipt.id]);
    const back = await w.useCases.unmatchLine.execute({ organizationId: ORG_A, userId: USER_1, lineId: l[0]!.id });
    expect(back.status).toBe('unmatched');
    expect(w.data.bankMatches).toHaveLength(0);
    await expect(w.useCases.unmatchLine.execute({ organizationId: ORG_A, userId: USER_1, lineId: l[0]!.id })).rejects.toBeInstanceOf(BankMatchError);
  });

  it('anular un cobro que estaba emparejado deshace el emparejamiento COMPLETO del renglón', async () => {
    const w = buildWorld();
    const account = await newAccount(w);
    const r1 = await collect(w, account.id, 2000, 'A1');
    const r2 = await collect(w, account.id, 3000, 'A2');
    await importCsv(w, account.id, csv([['08/10/2026', 'Deposito', 'DEP-1', '50.00', '']]));
    const line = lines(w)[0]!;
    await match(w, line.id, [movementOf(w, r1.id).id, movementOf(w, r2.id).id]);
    await w.useCases.voidReceipt.execute({ organizationId: ORG_A, receiptId: r1.id, userId: USER_1, reason: 'Error de digitación' });
    expect(w.data.bankMatches).toHaveLength(0); // r2 también queda libre: la suma ya no cuadra
    expect(w.data.bankLines.get(line.id)!.status).toBe('unmatched');
    expect(w.events('treasury.bank_movement.reversed')[0]!.payload).toMatchObject({ unmatched: true });
  });

  it('«ya contabilizado fuera de tesorería» pide motivo y se puede deshacer', async () => {
    const { w, l } = await scenario();
    await expect(w.useCases.markLineExternal.execute({ organizationId: ORG_A, userId: USER_1, lineId: l[2]!.id, reason: 'no' })).rejects.toBeInstanceOf(ValidationError);
    const ext = await w.useCases.markLineExternal.execute({ organizationId: ORG_A, userId: USER_1, lineId: l[2]!.id, reason: 'Venta cobrada con tarjeta' });
    expect(ext).toMatchObject({ status: 'external', externalReason: 'Venta cobrada con tarjeta' });
    expect(w.events('treasury.bank_line.marked_external')[0]!.payload).toMatchObject({ reason: 'Venta cobrada con tarjeta', markedBy: USER_1 });
    await expect(w.useCases.markLineExternal.execute({ organizationId: ORG_A, userId: USER_1, lineId: l[2]!.id, reason: 'Otra vez más' })).rejects.toBeInstanceOf(BankMatchError);
    expect((await w.useCases.unmarkLineExternal.execute({ organizationId: ORG_A, userId: USER_1, lineId: l[2]!.id })).status).toBe('unmatched');
  });
});

describe('ajustes bancarios', () => {
  async function withFeeLine() {
    const w = buildWorld();
    const account = await newAccount(w);
    await importCsv(w, account.id, csv([['10/10/2026', 'Comision mantenimiento', '', '-2.50', '997.50'], ['11/10/2026', 'Interes ganado', '', '1.20', '998.70']]));
    return { w, account, l: lines(w) };
  }

  it('desde un renglón nace emparejado, con el importe y la fecha del renglón, y publica el evento que asienta contabilidad', async () => {
    const { w, account, l } = await withFeeLine();
    const m = await w.useCases.postBankAdjustment.execute({
      organizationId: ORG_A,
      userId: USER_1,
      lineId: l[0]!.id,
      adjustment: { bankAccountId: account.id, kind: 'bank_fee', date: '2026-01-01', amountCents: 250, description: 'Comisión de mantenimiento' },
    });
    expect(m).toMatchObject({ sourceType: 'adjustment', amountCents: -250, movementDate: '2026-10-10', kind: 'bank_fee', status: 'active' });
    expect(w.data.bankLines.get(l[0]!.id)!.status).toBe('matched');
    expect(w.events('treasury.bank_adjustment.posted')[0]!.payload).toMatchObject({ adjustmentId: m.id, kind: 'bank_fee', direction: 'out', amountCents: 250, adjustmentDate: '2026-10-10', bankAccountName: 'Pichincha', currencyCode: 'USD' });
  });

  it('el interés entra; el tipo y el importe deben coincidir con el renglón', async () => {
    const { w, account, l } = await withFeeLine();
    await expect(
      w.useCases.postBankAdjustment.execute({ organizationId: ORG_A, userId: USER_1, lineId: l[1]!.id, adjustment: { bankAccountId: account.id, kind: 'bank_fee', date: '2026-10-11', amountCents: 120, description: 'Tipo equivocado' } }),
    ).rejects.toBeInstanceOf(ValidationError); // un interés (entra) no es una comisión (sale)
    await expect(
      w.useCases.postBankAdjustment.execute({ organizationId: ORG_A, userId: USER_1, lineId: l[1]!.id, adjustment: { bankAccountId: account.id, kind: 'interest', date: '2026-10-11', amountCents: 999, description: 'Importe equivocado' } }),
    ).rejects.toBeInstanceOf(ValidationError);
    const ok = await w.useCases.postBankAdjustment.execute({ organizationId: ORG_A, userId: USER_1, lineId: l[1]!.id, adjustment: { bankAccountId: account.id, kind: 'interest', date: '2026-10-11', amountCents: 120, description: 'Interés ganado' } });
    expect(ok.amountCents).toBe(120);
    expect(w.events('treasury.bank_adjustment.posted')[0]!.payload).toMatchObject({ direction: 'in' });
  });

  it('sin renglón es un ajuste suelto (posterior a la apertura); anularlo lo revierte y lo publica', async () => {
    const { w, account } = await withFeeLine();
    await expect(
      w.useCases.postBankAdjustment.execute({ organizationId: ORG_A, userId: USER_1, adjustment: { bankAccountId: account.id, kind: 'other_out', date: '2026-09-30', amountCents: 500, description: 'Antes de la apertura' } }),
    ).rejects.toBeInstanceOf(ValidationError);
    const m = await w.useCases.postBankAdjustment.execute({ organizationId: ORG_A, userId: USER_1, adjustment: { bankAccountId: account.id, kind: 'other_out', date: '2026-10-12', amountCents: 500, description: 'Cargo por chequera' } });
    await expect(w.useCases.voidBankAdjustment.execute({ organizationId: ORG_A, userId: USER_1, movementId: m.id, reason: 'x' })).rejects.toBeInstanceOf(ValidationError);
    const voided = await w.useCases.voidBankAdjustment.execute({ organizationId: ORG_A, userId: USER_2, movementId: m.id, reason: 'Se cargó por error' });
    expect(voided.status).toBe('reversed');
    expect(w.events('treasury.bank_adjustment.voided')[0]!.payload).toMatchObject({ adjustmentId: m.id, reason: 'Se cargó por error', voidedBy: USER_2, direction: 'out', amountCents: 500 });
    expect((await w.useCases.voidBankAdjustment.execute({ organizationId: ORG_A, userId: USER_2, movementId: m.id, reason: 'Se cargó por error' })).status).toBe('reversed'); // idempotente
  });

  it('un movimiento de cobro no se anula como ajuste', async () => {
    const w = buildWorld();
    const account = await newAccount(w);
    const receipt = await collect(w, account.id, 5000, 'TRX-1');
    await expect(w.useCases.voidBankAdjustment.execute({ organizationId: ORG_A, userId: USER_1, movementId: movementOf(w, receipt.id).id, reason: 'No es un ajuste' })).rejects.toThrow();
  });
});

describe('conciliar', () => {
  /** Cobro de 50, pago (cheque) de 30 sin cobrar, comisión de 2,50 del banco. Saldo del extracto al 31/10: 1000 + 50 − 2,50 = 1047,50. */
  async function ready() {
    const w = buildWorld();
    const account = await newAccount(w, { openingBalanceCents: 100000 });
    const receipt = await collect(w, account.id, 5000, 'TRX-1', '2026-10-05');
    const payment = await pay(w, account.id, 3000, 'CHQ-77', '2026-10-28'); // en circulación: el banco aún no lo cobra
    await importCsv(w, account.id, csv([
      ['06/10/2026', 'Transferencia recibida', 'TRX-1', '50.00', '1050.00'],
      ['10/10/2026', 'Comision', '', '-2.50', '1047.50'],
    ]));
    const [lReceipt, lFee] = lines(w);
    await match(w, lReceipt!.id, [movementOf(w, receipt.id).id]);
    return { w, account, receipt, payment, lReceipt: lReceipt!, lFee: lFee! };
  }
  const preview = (w: World, accountId: string, cutoff = '2026-10-31', balance?: number) => w.useCases.previewReconciliation.execute({ organizationId: ORG_A, bankAccountId: accountId, cutoffDate: cutoff, statementBalanceCents: balance });

  it('con una comisión sin resolver hay diferencia y no se puede cerrar', async () => {
    const { w, account } = await ready();
    const p = await preview(w, account.id);
    expect(p.suggestedStatementBalance).toEqual({ cents: 104750, date: '2026-10-10' });
    expect(p.result).toMatchObject({ unresolvedLines: 1, unresolvedCents: -250, canClose: false });
    expect(p.unresolvedLines).toHaveLength(1);
    await expect(w.useCases.closeReconciliation.execute({ organizationId: ORG_A, userId: USER_1, bankAccountId: account.id, cutoffDate: '2026-10-31', statementBalanceCents: 104750 })).rejects.toBeInstanceOf(BankReconciliationStateError);
  });

  it('registrada la comisión, el cheque en circulación queda como pendiente y la diferencia es cero', async () => {
    const { w, account, lFee } = await ready();
    await w.useCases.postBankAdjustment.execute({ organizationId: ORG_A, userId: USER_1, lineId: lFee.id, adjustment: { bankAccountId: account.id, kind: 'bank_fee', date: '2026-10-10', amountCents: 250, description: 'Comisión mensual' } });
    const p = await preview(w, account.id);
    expect(p.result).toMatchObject({ registerBalanceCents: 100000 + 5000 - 250 - 3000, pendingCents: -3000, pendingCount: 1, unresolvedLines: 0, differenceCents: 0, canClose: true });
    expect(p.pendingMovements.map((m) => m.reference)).toEqual(['CHQ-77']);
  });

  it('un saldo de extracto equivocado se ve como diferencia', async () => {
    const { w, account, lFee } = await ready();
    await w.useCases.markLineExternal.execute({ organizationId: ORG_A, userId: USER_1, lineId: lFee.id, reason: 'Ya asentada a mano en contabilidad' });
    expect((await preview(w, account.id, '2026-10-31', 104750)).result).toMatchObject({ differenceCents: 0, canClose: true }); // el externo entra en el registro
    const wrong = await preview(w, account.id, '2026-10-31', 104800);
    expect(wrong.result).toMatchObject({ differenceCents: 50, canClose: false });
  });

  it('cerrar congela: el renglón no se desempareja y el cobro conciliado no se anula; reabrir lo libera', async () => {
    const { w, account, receipt, lReceipt, lFee } = await ready();
    await w.useCases.postBankAdjustment.execute({ organizationId: ORG_A, userId: USER_1, lineId: lFee.id, adjustment: { bankAccountId: account.id, kind: 'bank_fee', date: '2026-10-10', amountCents: 250, description: 'Comisión mensual' } });
    const rec = await w.useCases.closeReconciliation.execute({ organizationId: ORG_A, userId: USER_2, bankAccountId: account.id, cutoffDate: '2026-10-31', statementBalanceCents: 104750 });
    expect(rec).toMatchObject({ status: 'closed', differenceCents: 0, pendingCents: -3000, closedBy: USER_2, cutoffDate: '2026-10-31' });
    expect(w.events('treasury.bank_reconciliation.closed')[0]!.payload).toMatchObject({ bankAccountName: 'Pichincha', differenceCents: 0, closedBy: USER_2 });

    await expect(w.useCases.unmatchLine.execute({ organizationId: ORG_A, userId: USER_1, lineId: lReceipt.id })).rejects.toBeInstanceOf(BankReconciledError);
    await expect(w.useCases.voidReceipt.execute({ organizationId: ORG_A, receiptId: receipt.id, userId: USER_1, reason: 'Quiero anularlo' })).rejects.toBeInstanceOf(BankReconciledError);
    expect(w.data.receipts.get(receipt.id)!.status).toBe('posted'); // la transacción se deshizo entera

    const reopened = await w.useCases.reopenReconciliation.execute({ organizationId: ORG_A, userId: USER_2, reconciliationId: rec.id, reason: 'Faltaba un depósito' });
    expect(reopened.status).toBe('reopened');
    expect(w.events('treasury.bank_reconciliation.reopened')[0]!.payload).toMatchObject({ reason: 'Faltaba un depósito' });
    await expect(w.useCases.voidReceipt.execute({ organizationId: ORG_A, receiptId: receipt.id, userId: USER_1, reason: 'Ahora sí se puede' })).resolves.toBeTruthy();
  });

  it('las conciliaciones se encadenan: el corte debe ser posterior; solo se reabre la última; lo conciliado no recibe renglones nuevos', async () => {
    const { w, account, lFee } = await ready();
    await w.useCases.postBankAdjustment.execute({ organizationId: ORG_A, userId: USER_1, lineId: lFee.id, adjustment: { bankAccountId: account.id, kind: 'bank_fee', date: '2026-10-10', amountCents: 250, description: 'Comisión mensual' } });
    const first = await w.useCases.closeReconciliation.execute({ organizationId: ORG_A, userId: USER_1, bankAccountId: account.id, cutoffDate: '2026-10-31', statementBalanceCents: 104750 });
    await expect(w.useCases.closeReconciliation.execute({ organizationId: ORG_A, userId: USER_1, bankAccountId: account.id, cutoffDate: '2026-10-31', statementBalanceCents: 104750 })).rejects.toBeInstanceOf(ValidationError);
    // un renglón nuevo de un periodo ya conciliado no entra
    await expect(importCsv(w, account.id, csv([['15/10/2026', 'Olvidado', '', '10.00', '']]))).rejects.toBeInstanceOf(ValidationError);
    // un ajuste fechado dentro de lo conciliado tampoco
    await expect(
      w.useCases.postBankAdjustment.execute({ organizationId: ORG_A, userId: USER_1, adjustment: { bankAccountId: account.id, kind: 'other_out', date: '2026-10-20', amountCents: 100, description: 'Atrasado' } }),
    ).rejects.toBeInstanceOf(ValidationError);
    // el siguiente mes: el cheque se cobra y se concilia
    await importCsv(w, account.id, csv([['03/11/2026', 'Cheque pagado', 'CHQ-77', '-30.00', '1017.50']]));
    const cheque = lines(w).find((l) => l.reference === 'CHQ-77')!;
    await match(w, cheque.id, [movementOf(w, [...w.data.payments.keys()][0]!).id]);
    const second = await w.useCases.closeReconciliation.execute({ organizationId: ORG_A, userId: USER_1, bankAccountId: account.id, cutoffDate: '2026-11-30', statementBalanceCents: 101750 });
    expect(second).toMatchObject({ differenceCents: 0, pendingCents: 0 });
    await expect(w.useCases.reopenReconciliation.execute({ organizationId: ORG_A, userId: USER_1, reconciliationId: first.id, reason: 'Quiero la anterior' })).rejects.toBeInstanceOf(BankReconciliationStateError);
    await expect(w.useCases.reopenReconciliation.execute({ organizationId: ORG_A, userId: USER_1, reconciliationId: second.id, reason: 'x' })).rejects.toBeInstanceOf(ValidationError);
    await expect(w.useCases.reopenReconciliation.execute({ organizationId: ORG_A, userId: USER_1, reconciliationId: second.id, reason: 'Reabro la última' })).resolves.toBeTruthy();
    expect((await w.useCases.listReconciliations.execute({ organizationId: ORG_A, bankAccountId: account.id })).map((r) => r.status).sort()).toEqual(['closed', 'reopened']);
  });

  it('sin saldo de extracto (ni escrito ni importado) no hay resultado que mostrar', async () => {
    const w = buildWorld();
    const account = await newAccount(w);
    const p = await preview(w, account.id);
    expect(p.result).toBeNull();
    await expect(preview(w, account.id, 'no-es-fecha')).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('flujo de caja', () => {
  it('parte del saldo del registro y reparte cartera y deuda por semana', async () => {
    const w = buildWorld();
    w.setNow('2026-10-22T15:00:00.000Z');
    const account = await newAccount(w, { openingBalanceCents: 50000 });
    await collect(w, null, 1000, 'SIN-CUENTA'); // sin cuenta: igual es dinero en bancos
    // por cobrar: una factura a 30 días, otra ya vencida
    await w.useCases.setCustomerTerms.execute({ organizationId: ORG_A, customerId: CUSTOMER_1, customerName: 'CLIENTE UNO', creditDays: 30, creditLimitCents: 0, userId: USER_1 });
    await w.useCases.invoiceIssued.execute(w.invoice({ total: 20000, issueDate: '2026-10-22T15:00:00.000Z' })); // vence 2026-11-21 → semana 5
    await w.useCases.billPosted.execute(w.bill({ total: 8000, issueDate: '2026-10-20', dueDate: '2026-10-25' })); // semana 1
    const flow = await w.useCases.getCashFlow.execute({ organizationId: ORG_A, weeks: 6, asOf: '2026-10-22' });
    expect(flow.accounts).toEqual([{ id: account.id, name: 'Pichincha', balanceCents: 50000 }]);
    expect(flow.unassignedCents).toBe(1000);
    expect(flow.openingCents).toBe(51000);
    const by = Object.fromEntries(flow.buckets.map((b) => [b.key, b]));
    expect(by.w1).toMatchObject({ outflowCents: 8000 });
    expect(by.w5).toMatchObject({ inflowCents: 20000 });
    expect(flow.totals.endingCents).toBe(51000 + flow.totals.inflowCents - flow.totals.outflowCents);
  });

  it('las semanas van de 1 a 26', async () => {
    const w = buildWorld();
    await expect(w.useCases.getCashFlow.execute({ organizationId: ORG_A, weeks: 0 })).rejects.toBeInstanceOf(ValidationError);
    await expect(w.useCases.getCashFlow.execute({ organizationId: ORG_A, weeks: 27 })).rejects.toBeInstanceOf(ValidationError);
  });
});
