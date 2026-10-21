// Verificación de los COBROS (bloque B) contra MySQL y RabbitMQ REALES, con tesorería Y contabilidad corriendo.
//
//   1. pila local arriba (mysql, rabbitmq, customer-service, gateway) y migraciones de treasury_db y accounting_db aplicadas
//   2. tesorería en :3018 (con CUSTOMER_SERVICE_URL y ACCOUNTING_SERVICE_URL) y contabilidad en :3016, AMBAS del árbol actual
//   3. node scripts/verify-receipts.mjs
//
// Qué comprueba que ninguna prueba unitaria puede ver:
//   · 30 cobros SIMULTÁNEOS a la misma deuda: solo cabe lo que cabe (nunca se cobra de más), sin interbloqueos (ningún 409/500) y con
//     la numeración RC-AAAA-NNNNNN sin saltos ni repetidos;
//   · anticipos: el excedente, su consumo desde otro cobro y que no se pueda anular mientras otro cobro lo use;
//   · LA PRUEBA DE ORO: lo que tesorería dice que debe cada cliente (neto del estado de cuenta) es EXACTAMENTE lo que contabilidad
//     tiene en «cuentas por cobrar» para ese cliente, y lo que tesorería dice de anticipos es lo que contabilidad tiene en «anticipos
//     de clientes». Las facturas llegan a los dos servicios por el MISMO evento; los cobros, de tesorería a contabilidad por RabbitMQ.
//
// Variables: GATEWAY, TREASURY, AMQP, ADMIN_EMAIL / ADMIN_PASSWORD (como verify-treasury.mjs).
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';

const require = createRequire(new URL('../node_modules/@facturero/outbox-relay/package.json', import.meta.url));
const amqp = require('amqplib');

const GATEWAY = process.env.GATEWAY ?? 'http://127.0.0.1:8080';
const BASE = process.env.TREASURY ?? 'http://127.0.0.1:3018';
const USER = '22222222-2222-4222-8222-222222222222';
const ALL = 'receivable:read,receipt:read,receipt:create,receipt:void,customer_terms:manage,opening_balance:load';
let failures = 0;
const check = (name, ok, detail = '') => { if (!ok) failures += 1; console.log(`${ok ? 'OK   ' : 'FALLO'} ${name}${detail !== '' ? ' — ' + String(detail).slice(0, 220) : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sql = (db, q) => execSync(`docker exec cmr-mysql mysql -uroot -proot123 -N -B ${db} -e "${q.replace(/"/g, '\\"')}"`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

const login = await (await fetch(`${GATEWAY}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: process.env.ADMIN_EMAIL ?? 'admin@admin.com', password: process.env.ADMIN_PASSWORD ?? 'Admin1234!' }) })).json();
if (!login.accessToken) throw new Error('No pude entrar con la cuenta de desarrollo.');
const ORG = JSON.parse(Buffer.from(login.accessToken.split('.')[1], 'base64url').toString()).org_id;
const sello = Date.now();
async function customer(name) {
  const r = await fetch(`${GATEWAY}/customers`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${login.accessToken}` }, body: JSON.stringify({ businessName: `${name} ${sello}`, type: 'company' }) });
  return (await r.json()).id;
}
async function api(method, path, body, perms = ALL) {
  const r = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', 'X-Organization-Id': ORG, 'X-User-Id': USER, 'X-Permissions': perms }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text(); let json = null; try { json = t ? JSON.parse(t) : null; } catch { json = t; }
  return { status: r.status, json };
}

const conn = await amqp.connect(process.env.AMQP ?? 'amqp://127.0.0.1:5672');
const ch = await conn.createChannel();
await ch.assertExchange('crm.events', 'topic', { durable: true });
const publish = (key, payload) => ch.publish('crm.events', key, Buffer.from(JSON.stringify(payload)), { persistent: true, headers: { eventId: randomUUID() } });
const issueInvoice = (customerId, name, totalCents) => {
  const invoiceId = randomUUID();
  const subtotal = Math.round(totalCents / 1.15);
  publish('billing.invoice.issued', {
    organizationId: ORG, invoiceId, customerId, number: `001-001-${String(sello).slice(-6)}${Math.floor(Math.random() * 1000).toString().padStart(3, '0')}`, issueDate: new Date().toISOString(), documentTypeCode: '01', currencyCode: 'USD', totalCents,
    posSaleId: null, paymentMethodCode: null, relatedInvoiceId: null, customerSnapshot: { id: customerId, businessName: name, identification: null },
    lines: [{ subtotalCents: subtotal, taxes: [{ kind: 'vat', amountCents: totalCents - subtotal }] }],
  });
  return invoiceId;
};
const today = new Date().toISOString().slice(0, 10);
const receivableOf = async (customerId, invoiceId) => (await api('GET', `/treasury/receivables?customerId=${customerId}&pageSize=100`)).json.items.find((x) => x.sourceId === invoiceId);

// ── Datos: dos clientes reales y sus facturas (llegan a tesorería Y a contabilidad por el mismo evento) ──
const A = await customer('COBROS A'); const B = await customer('COBROS B');
const invA = issueInvoice(A, `COBROS A ${sello}`, 15000);
const invA2 = issueInvoice(A, `COBROS A ${sello}`, 4600);
const invB = issueInvoice(B, `COBROS B ${sello}`, 10000);
await sleep(5000);
const rA = await receivableOf(A, invA); const rA2 = await receivableOf(A, invA2); const rB = await receivableOf(B, invB);
check('las facturas abrieron sus deudas en tesorería', !!rA && !!rA2 && !!rB && rA.balanceCents === 15000, JSON.stringify(rA)?.slice(0, 100));

// ── 1. 30 cobros simultáneos a la MISMA deuda de 150,00: caben 15 de 10,00 ──
const drafts = [];
for (let i = 0; i < 30; i += 1) {
  const d = await api('POST', '/treasury/receipts', { customerId: A, receiptDate: today, method: 'cash', totalCents: 1000, lines: [{ receivableId: rA.id, appliedCents: 1000 }] });
  if (d.status !== 201) { check(`borrador ${i} creado`, false, d.status + ' ' + JSON.stringify(d.json)); break; }
  drafts.push(d.json.id);
}
check('30 borradores creados (no tocan saldos)', drafts.length === 30);
check('los borradores NO movieron el saldo', (await receivableOf(A, invA)).balanceCents === 15000);

const t0 = Date.now();
const results = await Promise.all(drafts.map((id) => api('POST', `/treasury/receipts/${id}/post`)));
const ok = results.filter((r) => r.status === 200);
const rejected = results.filter((r) => r.status === 422);
const other = results.filter((r) => ![200, 422].includes(r.status));
console.log(`   ${ok.length} contabilizados, ${rejected.length} rechazados por saldo, ${other.length} otros, en ${Date.now() - t0} ms`);
check('exactamente 15 caben (150,00 / 10,00) y los otros 15 se rechazan con 422', ok.length === 15 && rejected.length === 15, `${ok.length}/${rejected.length}`);
check('ningún interbloqueo ni error de servidor (nada de 409/500 entre las 30)', other.length === 0, other.map((r) => r.status + ' ' + JSON.stringify(r.json).slice(0, 80)).join(' | '));
const after = await receivableOf(A, invA);
check('NUNCA se cobró de más: la deuda quedó en cero y pagada', after.balanceCents === 0 && after.status === 'paid' && after.appliedCents === 15000, JSON.stringify({ b: after.balanceCents, s: after.status }));
const numbers = ok.map((r) => Number(r.json.number.split('-')[2])).sort((a, b) => a - b);
check('15 números distintos y SIN saltos (los rechazados no gastan número)', new Set(numbers).size === 15 && numbers[14] - numbers[0] === 14, `${numbers[0]}..${numbers[14]}`);
check('todos con el formato RC-AAAA-NNNNNN', ok.every((r) => /^RC-\d{4}-\d{6}$/.test(r.json.number)));
// Según quién llegue tarde, la deuda ya quedó pagada («ya no está abierta», en `receivableId`) o todavía vive pero no alcanza (`appliedCents`):
// las dos razones son válidas y las dos nombran la línea 0.
check('el rechazo nombra la línea que no cabe (saldo insuficiente o deuda ya pagada)', rejected.every((r) => ['lines[0].appliedCents', 'lines[0].receivableId'].includes(r.json?.details?.[0]?.field)), JSON.stringify(rejected[0]?.json).slice(0, 140));
const stillDrafts = (await api('GET', `/treasury/receipts?customerId=${A}&status=draft&pageSize=100`)).json.total;
check('los 15 rechazados siguen en borrador (se pueden corregir)', stillDrafts === 15, stillDrafts);

// ── 2. contabilizar dos veces el mismo cobro a la vez: un solo cobro ──
const dup = (await api('POST', '/treasury/receipts', { customerId: A, receiptDate: today, method: 'cash', totalCents: 2000, lines: [{ receivableId: rA2.id, appliedCents: 2000 }] })).json;
const twice = await Promise.all([api('POST', `/treasury/receipts/${dup.id}/post`), api('POST', `/treasury/receipts/${dup.id}/post`), api('POST', `/treasury/receipts/${dup.id}/post`)]);
check('el mismo cobro contabilizado 3 veces a la vez: los 3 responden 200 y con el MISMO número', twice.every((r) => r.status === 200) && new Set(twice.map((r) => r.json.number)).size === 1, twice.map((r) => r.status + ' ' + r.json?.number).join(' | '));
check('… y cobró UNA sola vez', (await receivableOf(A, invA2)).balanceCents === 2600);

// ── 3. anular: devuelve el saldo ──
const toVoid = ok[0].json;
const v = await api('POST', `/treasury/receipts/${toVoid.id}/void`, { reason: 'Cobro registrado dos veces por error' });
check('anular con motivo (200)', v.status === 200 && v.json.status === 'voided', v.status);
const reopened = await receivableOf(A, invA);
check('el saldo de la deuda vuelve (10,00) y pasa a «parcial»', reopened.balanceCents === 1000 && reopened.status === 'partial', JSON.stringify({ b: reopened.balanceCents, s: reopened.status }));
check('anular otra vez es idempotente (200, mismo estado)', (await api('POST', `/treasury/receipts/${toVoid.id}/void`, { reason: 'Reintento de la anulación' })).status === 200);
check('sin permiso de anular → 403', (await api('POST', `/treasury/receipts/${ok[1].json.id}/void`, { reason: 'No debería poder' }, 'receipt:read,receipt:create')).status === 403);

// ── 4. anticipos: excedente, consumo y bloqueo de la anulación ──
const adv = (await api('POST', '/treasury/receipts', { customerId: B, receiptDate: today, method: 'transfer', reference: `TRX-${sello}`, totalCents: 15000, lines: [{ receivableId: rB.id, appliedCents: 10000 }] })).json;
const advPosted = (await api('POST', `/treasury/receipts/${adv.id}/post`)).json;
check('cobro con excedente: 50,00 quedan como anticipo del cliente', advPosted.status === 'posted' && advPosted.advanceCents === 5000, JSON.stringify({ s: advPosted.status, a: advPosted.advanceCents }));
const stB = (await api('GET', `/treasury/customers/${B}/statement`)).json;
check('el estado de cuenta separa el anticipo del neto', stB.customerAdvanceCents === 5000 && stB.netCents === 0, JSON.stringify({ a: stB.customerAdvanceCents, n: stB.netCents }));
const invB2 = issueInvoice(B, `COBROS B ${sello}`, 3000);
await sleep(3500);
const rB2 = await receivableOf(B, invB2);
check('el anticipo de un COBRO no se aplicó solo a la factura nueva', rB2?.balanceCents === 3000, rB2?.balanceCents);
const advanceId = stB.advances.find((x) => x.origin === 'receipt').id;
const use = (await api('POST', '/treasury/receipts', { customerId: B, receiptDate: today, method: 'cash', totalCents: 0, lines: [{ receivableId: rB2.id, appliedCents: 3000 }], advanceUses: [{ advanceId, usedCents: 3000 }] })).json;
const usePosted = await api('POST', `/treasury/receipts/${use.id}/post`);
check('un cobro consume el anticipo, sin dinero nuevo', usePosted.status === 200 && usePosted.json.advanceUsedCents === 3000 && usePosted.json.totalCents === 0, usePosted.status + ' ' + JSON.stringify(usePosted.json).slice(0, 100));
const blocked = await api('POST', `/treasury/receipts/${adv.id}/void`, { reason: 'Anular el cobro que dio el anticipo' });
check('no se puede anular el cobro cuyo anticipo ya se consumió (409 RECEIPT_ADVANCE_IN_USE)', blocked.status === 409 && blocked.json.code === 'RECEIPT_ADVANCE_IN_USE', blocked.status + ' ' + blocked.json?.code);
check('dos cobros que juntos pasan del anticipo: el segundo se rechaza', await (async () => {
  const inv = issueInvoice(B, `COBROS B ${sello}`, 9000); await sleep(3000);
  const r = await receivableOf(B, inv);
  const d = (await api('POST', '/treasury/receipts', { customerId: B, receiptDate: today, method: 'cash', totalCents: 0, lines: [{ receivableId: r.id, appliedCents: 2500 }], advanceUses: [{ advanceId, usedCents: 2500 }] }));
  return d.status === 422; // en borrador ya se avisa: del anticipo de 50,00 quedan 20,00
})());

// ── 5. LA PRUEBA DE ORO: tesorería = contabilidad, por cliente ──
console.log('   esperando a que contabilidad asiente los cobros (RabbitMQ)…');
await sleep(9000);
const ledger = (customerId, role) => Number(sql('accounting_db', `select ifnull(sum(l.debit_cents - l.credit_cents),0) from journal_lines l join journal_entries e on e.id = l.entry_id join accounts a on a.id = l.account_id where a.system_role = '${role}' and l.party_id = '${customerId}' and e.status = 'posted' and e.organization_id = '${ORG}'`));
for (const [name, id] of [['A', A], ['B', B]]) {
  const st = (await api('GET', `/treasury/customers/${id}/statement`)).json;
  const receivablesLedger = ledger(id, 'receivables');
  check(`ORO cliente ${name}: neto de tesorería (${st.netCents}) = «cuentas por cobrar» del libro mayor (${receivablesLedger})`, st.netCents === receivablesLedger);
  const advancesLedger = -ledger(id, 'customer_advances');
  check(`ORO cliente ${name}: anticipos de tesorería (${st.customerAdvanceCents}) = «anticipos de clientes» del libro mayor (${advancesLedger})`, st.customerAdvanceCents === advancesLedger);
}
const posted = sql('accounting_db', `select count(*) from journal_entries where organization_id='${ORG}' and source_type='receipt' and kind='automatic' and source_id in (${[...ok.map((r) => r.json.id), dup.id, adv.id, use.id].map((x) => `'${x}'`).join(',')})`);
check(`contabilidad asentó los ${ok.length + 3} cobros contabilizados`, Number(posted) === ok.length + 3, posted);
const reversals = sql('accounting_db', `select count(*) from journal_entries where organization_id='${ORG}' and source_type='receipt' and kind='reversal' and source_id='${toVoid.id}'`);
check('contabilidad reversó el cobro anulado', Number(reversals) === 1, reversals);
const pending = sql('accounting_db', `select count(*) from pending_postings where organization_id='${ORG}' and status='pending' and source_type in ('receipt','receipt_void')`);
check('ningún cobro quedó pendiente en contabilidad', Number(pending) === 0, pending);
const unbalanced = sql('accounting_db', `select count(*) from journal_entries e where e.organization_id='${ORG}' and e.source_type='receipt' and e.total_debit_cents <> e.total_credit_cents`);
check('todos los asientos de cobros cuadran (debe = haber)', Number(unbalanced) === 0, unbalanced);

// ── 6. bitácora: cada paso con su evento ──
const events = sql('treasury_db', `select type, count(*) from outbox_messages where JSON_UNQUOTE(JSON_EXTRACT(payload,'$.organizationId'))='${ORG}' and type like 'treasury.receipt.%' group by type`);
for (const t of ['treasury.receipt.created', 'treasury.receipt.posted', 'treasury.receipt.voided']) check(`el outbox publicó ${t}`, events.includes(t));

await ch.close(); await conn.close();
console.log(failures ? `\n${failures} verificaciones FALLARON` : '\nTODO OK');
process.exit(failures ? 1 : 0);
