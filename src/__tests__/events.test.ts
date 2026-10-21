import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildWorld, CUSTOMER_1, ORG_A, USER_1 } from './helpers.js';

/**
 * La bitácora audita TODO lo que sale por el outbox: estos tests fijan qué lleva cada evento. Si un campo desaparece, la
 * bitácora deja de poder decir quién, cuánto o por qué, y nadie lo nota hasta que hace falta.
 */
const PUBLICADOS = [
  'treasury.receivable.opened',
  'treasury.receivable.credited',
  'treasury.receivable.cancelled',
  'treasury.customer_advance.opened',
  'treasury.customer_terms.updated',
  'treasury.opening_balance.loaded',
  'treasury.receipt.created',
  'treasury.receipt.updated',
  'treasury.receipt.posted',
  'treasury.receipt.voided',
] as const;

const SENSIBLES = /token|secret|password|apikey|authorization|certificate/i;

async function escenarioCompleto() {
  const w = buildWorld();
  await w.useCases.setCustomerTerms.execute({ organizationId: ORG_A, customerId: CUSTOMER_1, customerName: 'CLIENTE UNO', creditDays: 30, creditLimitCents: 500000, userId: USER_1 });
  const inv = w.invoice({ total: 11500 });
  await w.useCases.invoiceIssued.execute(inv); // opened
  await w.useCases.invoiceIssued.execute(w.invoice({ documentTypeCode: '04', total: 2300, relatedInvoiceId: inv.invoiceId })); // credited
  await w.useCases.invoiceIssued.execute(w.invoice({ documentTypeCode: '04', total: 700, relatedInvoiceId: null })); // customer_advance.opened
  await w.useCases.invoiceVoided.execute({ organizationId: ORG_A, invoiceId: inv.invoiceId, number: inv.number, issueDate: inv.issueDate, reason: 'Error de digitación' }); // cancelled
  await w.useCases.loadOpeningBalances.execute({ organizationId: ORG_A, cutoffDate: '2026-09-30', reason: 'Saldos al arranque', userId: USER_1, lines: [{ customerId: CUSTOMER_1, issueDate: '2026-08-15', amountCents: 5000 }] }); // loaded (+ opened)

  // Un cobro de punta a punta: borrador, edición, contabilizado (con excedente) y anulado.
  const debtId = w.receivables().find((r) => r.sourceType === 'initial_balance')!.id;
  const draft = await w.useCases.createReceipt.execute({ organizationId: ORG_A, customerId: CUSTOMER_1, userId: USER_1, receipt: { receiptDate: '2026-10-21', method: 'transfer', reference: 'TRX-1', totalCents: 6000, lines: [{ receivableId: debtId, appliedCents: 2000 }] } });
  await w.useCases.updateReceipt.execute({ organizationId: ORG_A, receiptId: draft.id, userId: USER_1, receipt: { receiptDate: '2026-10-21', method: 'transfer', reference: 'TRX-2', totalCents: 6000, lines: [{ receivableId: debtId, appliedCents: 5000 }] } });
  await w.useCases.postReceipt.execute({ organizationId: ORG_A, receiptId: draft.id, userId: USER_1 });
  await w.useCases.voidReceipt.execute({ organizationId: ORG_A, receiptId: draft.id, userId: USER_1, reason: 'Transferencia rechazada' });
  return { w, inv, receiptId: draft.id };
}

describe('contrato de los eventos publicados', () => {
  it('todos los eventos del escenario tienen routing key de TRES segmentos, `treasury.` y la acción en pasado', async () => {
    const { w } = await escenarioCompleto();
    for (const event of w.data.events) {
      expect(event.type, event.type).toMatch(/^treasury\.[a-z_]+\.[a-z_]+$/);
      expect(PUBLICADOS).toContain(event.type);
      expect(event.type.split('.')[2], event.type).toMatch(/(ed|ured)$/); // opened, credited, cancelled, updated, loaded
    }
  });

  it('todo evento lleva organizationId, un id de evento y el id de lo afectado', async () => {
    const { w } = await escenarioCompleto();
    for (const event of w.data.events) {
      expect(event.payload.organizationId, event.type).toBe(ORG_A);
      expect(event.eventId).toBeTruthy();
      expect(event.aggregateId).toBeTruthy();
    }
  });

  it('ningún payload lleva claves sensibles ni pasa de 8 KB (la bitácora trunca lo que excede)', async () => {
    const { w } = await escenarioCompleto();
    for (const event of w.data.events) {
      expect(JSON.stringify(Object.keys(event.payload)), event.type).not.toMatch(SENSIBLES);
      expect(JSON.stringify(event.payload).length, event.type).toBeLessThan(8 * 1024);
    }
  });

  it('el escenario cubre TODOS los eventos publicados (si se añade uno, esta prueba obliga a probarlo)', async () => {
    const { w } = await escenarioCompleto();
    const vistos = new Set(w.data.events.map((e) => e.type));
    for (const type of PUBLICADOS) expect(vistos.has(type), `no se publicó ${type}`).toBe(true);
  });

  it('los eventos del código son exactamente los canales publicados en asyncapi.yaml', () => {
    const asyncapi = readFileSync(join(process.cwd(), 'asyncapi.yaml'), 'utf8');
    for (const type of PUBLICADOS) expect(asyncapi, `falta ${type} en asyncapi.yaml`).toContain(`${type}:`);
  });
});

describe('qué lleva cada evento (lo que la bitácora muestra)', () => {
  it('treasury.receivable.opened: la partida, el cliente, el importe y el vencimiento', async () => {
    const { w, inv } = await escenarioCompleto();
    const event = w.events('treasury.receivable.opened').find((e) => e.payload.sourceId === inv.invoiceId)!;
    expect(w.events('treasury.receivable.opened').filter((e) => e.payload.sourceId === inv.invoiceId)).toHaveLength(1);
    expect(event.payload).toMatchObject({ sourceType: 'invoice', invoiceNumber: inv.number, customerId: CUSTOMER_1, customerName: 'CLIENTE UNO S.A.', amountCents: 11500, currencyCode: 'USD', issueDate: '2026-10-21', dueDate: '2026-11-20' });
    expect(event.payload.receivableId).toBe(event.aggregateId);
  });

  it('treasury.receivable.credited: cuánto abonó y con qué comprobante (nota de crédito y cobro)', async () => {
    const { w } = await escenarioCompleto();
    const credited = w.events('treasury.receivable.credited');
    const byNote = credited.filter((e) => e.payload.creditType === 'credit_note');
    const byReceipt = credited.filter((e) => e.payload.creditType === 'receipt');
    expect(byNote).toHaveLength(1);
    expect(byNote[0]!.payload).toMatchObject({ appliedCents: 2300, amountCents: 11500, advanceId: null });
    expect(byNote[0]!.payload.creditSourceId).toBeTruthy();
    expect(byReceipt).toHaveLength(1);
    expect(byReceipt[0]!.payload).toMatchObject({ appliedCents: 5000, creditDocumentNumber: 'RC-2026-000001' });
  });

  it('treasury.receivable.cancelled: el MOTIVO de la anulación', async () => {
    const { w } = await escenarioCompleto();
    const [event] = w.events('treasury.receivable.cancelled');
    expect(w.events('treasury.receivable.cancelled')).toHaveLength(1);
    expect(event!.payload).toMatchObject({ reason: 'Error de digitación', customerId: CUSTOMER_1 });
  });

  it('treasury.customer_advance.opened: el saldo a favor y de dónde salió (nota de crédito y cobro)', async () => {
    const { w, receiptId } = await escenarioCompleto();
    const opened = w.events('treasury.customer_advance.opened');
    const byNote = opened.filter((e) => e.payload.origin === 'credit_note');
    const byReceipt = opened.filter((e) => e.payload.origin === 'receipt');
    expect(byNote).toHaveLength(1);
    expect(byNote[0]!.payload).toMatchObject({ amountCents: 700, customerId: CUSTOMER_1 });
    expect(byReceipt).toHaveLength(1);
    expect(byReceipt[0]!.payload).toMatchObject({ amountCents: 1000, originId: receiptId, documentNumber: 'RC-2026-000001' });
  });

  it('treasury.customer_terms.updated: valor ANTERIOR y NUEVO y quién lo cambió', async () => {
    const { w } = await escenarioCompleto();
    const [event] = w.events('treasury.customer_terms.updated');
    expect(w.events('treasury.customer_terms.updated')).toHaveLength(1);
    expect(event!.payload).toMatchObject({ previousCreditDays: 0, creditDays: 30, previousCreditLimitCents: null, creditLimitCents: 500000, updatedBy: USER_1, customerId: CUSTOMER_1 });
  });

  it('treasury.opening_balance.loaded: fecha de corte, total, nº de clientes, quién y POR QUÉ', async () => {
    const { w } = await escenarioCompleto();
    const [event] = w.events('treasury.opening_balance.loaded');
    expect(w.events('treasury.opening_balance.loaded')).toHaveLength(1);
    expect(event!.payload).toMatchObject({ cutoffDate: '2026-09-30', totalCents: 5000, customerCount: 1, loadedBy: USER_1, reason: 'Saldos al arranque' });
  });

  it('treasury.receipt.created / updated: el borrador con sus importes derivados', async () => {
    const { w, receiptId } = await escenarioCompleto();
    expect(w.events('treasury.receipt.created')).toHaveLength(1);
    expect(w.events('treasury.receipt.created')[0]!.payload).toMatchObject({ receiptId, status: 'draft', number: null, totalCents: 6000, appliedCents: 2000, advanceCents: 4000, method: 'transfer', accountRole: 'bank', reference: 'TRX-1' });
    expect(w.events('treasury.receipt.updated')).toHaveLength(1);
    expect(w.events('treasury.receipt.updated')[0]!.payload).toMatchObject({ reference: 'TRX-2', appliedCents: 5000, advanceCents: 1000 });
  });

  it('treasury.receipt.posted: lo que contabilidad necesita para asentar, con la fecha SIN hora', async () => {
    const { w, receiptId } = await escenarioCompleto();
    const [event] = w.events('treasury.receipt.posted');
    expect(w.events('treasury.receipt.posted')).toHaveLength(1);
    expect(event!.payload).toMatchObject({ receiptId, number: 'RC-2026-000001', status: 'posted', receiptDate: '2026-10-21', customerId: CUSTOMER_1, customerName: 'CLIENTE UNO S.A.', currencyCode: 'USD', accountRole: 'bank', totalCents: 6000, advanceUsedCents: 0, appliedCents: 5000, advanceCents: 1000, lineCount: 1, postedBy: USER_1 });
    expect(event!.payload.receiptDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // la igualdad que el esquema también exige: entró + anticipos usados = aplicado + excedente
    const p = event!.payload as Record<string, number>;
    expect(p.totalCents! + p.advanceUsedCents!).toBe(p.appliedCents! + p.advanceCents!);
  });

  it('treasury.receipt.voided: el MOTIVO, quién lo contabilizó y quién lo anuló', async () => {
    const { w, receiptId } = await escenarioCompleto();
    const [event] = w.events('treasury.receipt.voided');
    expect(w.events('treasury.receipt.voided')).toHaveLength(1);
    expect(event!.payload).toMatchObject({ receiptId, number: 'RC-2026-000001', status: 'voided', reason: 'Transferencia rechazada', postedBy: USER_1, voidedBy: USER_1 });
  });

  it('un cobro con más de 20 líneas no revienta el tope de 8 KB: el payload lleva 20 y el total en lineCount', async () => {
    const w = buildWorld();
    const ids: string[] = [];
    for (let i = 0; i < 25; i += 1) {
      const inv = w.invoice({ total: 1150 });
      await w.useCases.invoiceIssued.execute(inv);
      ids.push(w.receivables().find((r) => r.sourceId === inv.invoiceId)!.id);
    }
    const r = await w.useCases.createReceipt.execute({ organizationId: ORG_A, customerId: CUSTOMER_1, userId: USER_1, receipt: { receiptDate: '2026-10-21', method: 'cash', totalCents: 25 * 1150, lines: ids.map((id) => ({ receivableId: id, appliedCents: 1150 })) } });
    await w.useCases.postReceipt.execute({ organizationId: ORG_A, receiptId: r.id, userId: USER_1 });
    const payload = w.events('treasury.receipt.posted')[0]!.payload;
    expect(payload.lineCount).toBe(25);
    expect((payload.lines as unknown[]).length).toBe(20);
    expect(JSON.stringify(payload).length).toBeLessThan(8 * 1024);
  });

  it('un caso que no escribe nada no publica nada (ni un duplicado, ni un comprobante ignorado)', async () => {
    const w = buildWorld();
    const inv = w.invoice();
    await w.useCases.invoiceIssued.execute(inv);
    const before = w.data.events.length;
    await w.useCases.invoiceIssued.execute(inv); // duplicado
    await w.useCases.invoiceIssued.execute(w.invoice({ posSaleId: 'x' })); // POS
    await w.useCases.invoiceIssued.execute(w.invoice({ currencyCode: 'EUR' })); // moneda
    expect(w.data.events).toHaveLength(before);
  });
});
