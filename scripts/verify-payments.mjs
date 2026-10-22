// Verificación de CUENTAS POR PAGAR y PAGOS (bloque D) contra MySQL y RabbitMQ REALES, con tesorería, contabilidad y compras corriendo.
//
//   1. pila local arriba (mysql, rabbitmq, auth, organization, purchasing, plugin-catalog, audit-log) y migraciones aplicadas
//      (treasury_db: 20261023100000-create-payables; auth_db: 20261023100000-add-treasury-payable-permissions)
//   2. tesorería (:3018, con PURCHASING_SERVICE_URL y ACCOUNTING_SERVICE_URL), contabilidad (:3016) y gateway (:8080), del árbol actual
//   3. node scripts/verify-payments.mjs
//
// Qué comprueba que ninguna prueba unitaria puede ver:
//   · las facturas de compra y las retenciones llegan por RabbitMQ y abren / reducen deudas (en cualquier orden, repetidas o no);
//   · 30 pagos SIMULTÁNEOS a la misma deuda: solo cabe lo que cabe (nunca se paga de más), sin interbloqueos (ningún 409/500) y con la
//     numeración PG-AAAA-NNNNNN sin saltos ni repetidos;
//   · la aprobación entre DOS personas (quien crea no aprueba) y el umbral, por el gateway y por el servicio;
//   · anticipos a proveedores: el excedente, su consumo desde otro pago y que no se pueda anular mientras otro pago lo use;
//   · LA PRUEBA DE ORO: lo que tesorería dice que se le debe a cada proveedor (neto del estado de cuenta) es EXACTAMENTE lo que
//     contabilidad tiene en «proveedores» para ese proveedor (la retención se asienta sin tercero: se compara descontándola), y lo de
//     anticipos es lo que contabilidad tiene en «anticipos a proveedores». Las facturas llegan a los dos servicios por el MISMO evento;
//     los pagos, de tesorería a contabilidad por RabbitMQ.
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';

const require = createRequire(new URL('../node_modules/@facturero/outbox-relay/package.json', import.meta.url));
const amqp = require('amqplib');

const GATEWAY = process.env.GATEWAY ?? 'http://127.0.0.1:8080';
const BASE = process.env.TREASURY ?? 'http://127.0.0.1:3018';
const USER_2 = '22222222-2222-4222-8222-222222222222';
let failures = 0;
const check = (name, ok, detail = '') => { if (!ok) failures += 1; console.log(`${ok ? 'OK   ' : 'FALLO'} ${name}${detail !== '' ? ' — ' + String(detail).slice(0, 240) : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sql = (db, q) => execSync(`docker exec cmr-mysql mysql -uroot -proot123 -N -B ${db} -e "${q.replace(/"/g, '\\"')}"`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

const login = await (await fetch(`${GATEWAY}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: process.env.ADMIN_EMAIL ?? 'admin@admin.com', password: process.env.ADMIN_PASSWORD ?? 'Admin1234!' }) })).json();
if (!login.accessToken) throw new Error('No pude entrar con la cuenta de desarrollo.');
const claims = JSON.parse(Buffer.from(login.accessToken.split('.')[1], 'base64url').toString());
const ORG = claims.org_id;
const ADMIN = claims.sub ?? claims.user_id ?? claims.userId;
const sello = Date.now();

/** Por el gateway real, con el token (como la interfaz). */
async function gw(method, path, body, raw = false) {
  const r = await fetch(GATEWAY + path, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${login.accessToken}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (raw) return r;
  const t = await r.text(); let json = null; try { json = t ? JSON.parse(t) : null; } catch { json = t; }
  return { status: r.status, json };
}
/** Directo a tesorería con otra persona: la separación de funciones necesita DOS usuarios distintos. */
async function direct(method, path, body, user, perms) {
  const r = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', 'X-Organization-Id': ORG, 'X-User-Id': user, 'X-Permissions': perms }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text(); let json = null; try { json = t ? JSON.parse(t) : null; } catch { json = t; }
  return { status: r.status, json };
}
const ruc = (n) => `1${String(n).padStart(9, '0')}001`;
async function supplier(name, n) {
  const r = await gw('POST', '/purchasing/suppliers', { identificationType: 'RUC', identification: ruc(n), legalName: `${name} ${sello}` });
  if (r.status !== 201 && r.status !== 200) throw new Error(`no pude crear el proveedor ${name}: ${r.status} ${JSON.stringify(r.json)}`);
  return { id: r.json.id, ruc: ruc(n), name: `${name} ${sello}` };
}

const conn = await amqp.connect(process.env.AMQP ?? 'amqp://127.0.0.1:5672');
const ch = await conn.createChannel();
await ch.assertExchange('crm.events', 'topic', { durable: true });
const publish = (key, payload) => ch.publish('crm.events', key, Buffer.from(JSON.stringify(payload)), { persistent: true, headers: { eventId: randomUUID() } });
const today = new Date().toLocaleDateString('en-CA');
const plus = (days) => new Date(Date.now() + days * 86_400_000).toLocaleDateString('en-CA');
/** Una factura de compra contabilizada tal como la publica compras. */
const postBill = (s, totalCents, document, dueDate = plus(30), billId = randomUUID(), issueDate = today) => {
  const subtotal = Math.round(totalCents / 1.15);
  publish('purchasing.bill.posted', {
    organizationId: ORG, billId, internalNumber: `FC-${sello}-${document.slice(-3)}`, supplierId: s.id, supplier: { identification: s.ruc, legalName: s.name }, docType: '01',
    supplierDocument: document, issueDate, dueDate, currencyCode: 'USD', subtotalCents: subtotal, taxCents: totalCents - subtotal, totalCents, matchStatus: 'not_applicable',
    lines: [{ kind: 'expense', subtotalCents: subtotal, vatCents: totalCents - subtotal, iceCents: 0, irbpnrCents: 0, priceVarianceCents: 0 }],
  });
  return billId;
};
const withholding = (s, support, totalCents) => {
  const withholdingId = randomUUID();
  publish('fiscal.ec.withholding.issued', { organizationId: ORG, withholdingId, number: `001-001-${String(sello).slice(-9)}`, issueDate: today, currencyCode: 'USD', supplier: { identification: s.ruc, businessName: s.name }, support: { documentCode: '01', number: support }, incomeTaxWithheldCents: totalCents, vatWithheldCents: 0, totalWithheldCents: totalCents });
  return withholdingId;
};
const debtOf = async (supplierId, billId) => (await gw('GET', `/treasury/payables?supplierId=${supplierId}&pageSize=100`)).json.items.find((x) => x.sourceId === billId);
const statementOf = async (supplierId) => (await gw('GET', `/treasury/suppliers/${supplierId}/statement`)).json;
const doc = (n) => `001-001-${String(n).padStart(9, '0')}`;

// ── Datos: dos proveedores reales y sus facturas (llegan a tesorería Y a contabilidad por el mismo evento) ──
const base = Number(String(sello).slice(-6));
const S1 = await supplier('PAGOS UNO', base);
const S2 = await supplier('PAGOS DOS', base + 1);
const dA = doc(base % 900000 + 1), dB = doc(base % 900000 + 2), dC = doc(base % 900000 + 3), dD = doc(base % 900000 + 4);
const bA = postBill(S1, 15000, dA);
// Emitida hace 2 días y vencida desde entonces: nace vencida porque el vencimiento lo trae la factura (no puede ser anterior a la emisión).
const bB = postBill(S1, 4600, dB, plus(-2), randomUUID(), plus(-2));
const bC = postBill(S2, 10000, dC);
const bDup = randomUUID();
postBill(S2, 5000, dD, plus(10), bDup);
postBill(S2, 5000, dD, plus(10), bDup); // el MISMO evento repetido
await sleep(6000);
const rA = await debtOf(S1.id, bA), rB = await debtOf(S1.id, bB), rC = await debtOf(S2.id, bC), rD = await debtOf(S2.id, bDup);
check('las facturas de compra abrieron sus deudas en tesorería', !!rA && !!rB && !!rC && !!rD && rA.balanceCents === 15000, JSON.stringify(rA)?.slice(0, 120));
check('el vencimiento es el de la factura (no se calcula)', rA.dueDate === plus(30) && rB.dueDate === plus(-2), `${rA?.dueDate} / ${rB?.dueDate}`);
check('el mismo evento repetido abrió UNA sola deuda', (await gw('GET', `/treasury/payables?supplierId=${S2.id}&pageSize=100`)).json.items.filter((x) => x.sourceId === bDup).length === 1);
const overdue = (await gw('GET', '/treasury/payables?overdueOnly=true&pageSize=100')).json.items;
check('«vencidas» trae la que ya venció y no las que aún no vencen', overdue.some((x) => x.id === rB.id) && !overdue.some((x) => x.id === rA.id));

// ── 1. Retención: antes y después de la factura ──
withholding(S1, dA, 1000);
await sleep(4000);
check('la retención reduce la deuda de la factura que cita (150,00 − 10,00)', (await debtOf(S1.id, bA)).balanceCents === 14000, (await debtOf(S1.id, bA)).balanceCents);
const dLate = doc(base % 900000 + 5);
withholding(S1, dLate, 500); // llega ANTES que su factura
await sleep(3000);
const bLate = postBill(S1, 2300, dLate);
await sleep(4500);
check('una retención que llegó ANTES que su factura se aplica cuando la factura llega', (await debtOf(S1.id, bLate))?.balanceCents === 1800, (await debtOf(S1.id, bLate))?.balanceCents);
const stray = withholding(S1, doc(base % 900000 + 99), 100); // sin factura en este módulo: no debe romper nada
void stray;

// ── 2. 30 pagos simultáneos a la MISMA deuda de 100,00 (S2/C): caben 10 de 10,00 ──
const drafts = [];
for (let i = 0; i < 30; i += 1) {
  const d = await gw('POST', '/treasury/payments', { supplierId: S2.id, paymentDate: today, method: 'cash', totalCents: 1000, lines: [{ payableId: rC.id, appliedCents: 1000 }] });
  if (d.status !== 201) { check(`borrador ${i} creado`, false, d.status + ' ' + JSON.stringify(d.json)); break; }
  drafts.push(d.json.id);
}
check('30 borradores creados (no tocan saldos)', drafts.length === 30);
check('los borradores NO movieron el saldo ni gastaron número', (await debtOf(S2.id, bC)).balanceCents === 10000 && drafts.length === 30 && !(await gw('GET', `/treasury/payments/${drafts[0]}`)).json.number);

const t0 = Date.now();
const results = await Promise.all(drafts.map((id) => gw('POST', `/treasury/payments/${id}/post`)));
const ok = results.filter((r) => r.status === 200);
const rejected = results.filter((r) => r.status === 422);
const other = results.filter((r) => ![200, 422].includes(r.status));
console.log(`   ${ok.length} contabilizados, ${rejected.length} rechazados por saldo, ${other.length} otros, en ${Date.now() - t0} ms`);
check('exactamente 10 caben (100,00 / 10,00) y los otros 20 se rechazan con 422', ok.length === 10 && rejected.length === 20, `${ok.length}/${rejected.length}`);
check('ningún interbloqueo ni error de servidor (nada de 409/500 entre las 30)', other.length === 0, other.map((r) => r.status + ' ' + JSON.stringify(r.json).slice(0, 80)).join(' | '));
const afterC = await debtOf(S2.id, bC);
check('NUNCA se pagó de más: la deuda quedó en cero y pagada', afterC.balanceCents === 0 && afterC.status === 'paid' && afterC.appliedCents === 10000, JSON.stringify({ b: afterC.balanceCents, s: afterC.status }));
const numbers = ok.map((r) => Number(r.json.number.split('-')[2])).sort((a, b) => a - b);
check('10 números distintos y SIN saltos (los rechazados no gastan número)', new Set(numbers).size === 10 && numbers[9] - numbers[0] === 9, `${numbers[0]}..${numbers[9]}`);
check('todos con el formato PG-AAAA-NNNNNN', ok.every((r) => /^PG-\d{4}-\d{6}$/.test(r.json.number)));
check('el rechazo nombra la línea que no cabe', rejected.every((r) => ['lines[0].appliedCents', 'lines[0].payableId'].includes(r.json?.details?.[0]?.field)), JSON.stringify(rejected[0]?.json).slice(0, 140));
check('los 20 rechazados siguen en borrador (se pueden corregir)', (await gw('GET', `/treasury/payments?supplierId=${S2.id}&status=draft&pageSize=100`)).json.total === 20);

// ── 3. el mismo pago contabilizado 3 veces a la vez: uno solo ──
const dup = (await gw('POST', '/treasury/payments', { supplierId: S1.id, paymentDate: today, method: 'transfer', reference: 'DUP-1', totalCents: 2000, lines: [{ payableId: rB.id, appliedCents: 2000 }] })).json;
const twice = await Promise.all([gw('POST', `/treasury/payments/${dup.id}/post`), gw('POST', `/treasury/payments/${dup.id}/post`), gw('POST', `/treasury/payments/${dup.id}/post`)]);
check('el mismo pago contabilizado 3 veces a la vez: los 3 responden 200 y con el MISMO número', twice.every((r) => r.status === 200) && new Set(twice.map((r) => r.json.number)).size === 1, twice.map((r) => r.status + ' ' + r.json?.number).join(' | '));
check('… y pagó UNA sola vez (46,00 − 20,00)', (await debtOf(S1.id, bB)).balanceCents === 2600);

// ── 4. aprobación entre DOS personas ──
const thr = await gw('PUT', '/treasury/payments/settings', { approvalThresholdCents: 5000 });
check('fijar el umbral de aprobación (50,00)', thr.status === 200 && thr.json.approvalThresholdCents === 5000);
const big = (await gw('POST', '/treasury/payments', { supplierId: S1.id, paymentDate: today, method: 'transfer', reference: 'GRANDE-1', totalCents: 5000, lines: [{ payableId: rA.id, appliedCents: 5000 }] })).json;
const blocked = await gw('POST', `/treasury/payments/${big.id}/post`);
check('un pago que llega al umbral NO se contabiliza sin aprobación (409 PAYMENT_APPROVAL_REQUIRED)', blocked.status === 409 && blocked.json?.code === 'PAYMENT_APPROVAL_REQUIRED', `${blocked.status} ${blocked.json?.code}`);
const self = await gw('POST', `/treasury/payments/${big.id}/approve`);
check('quien lo creó NO lo aprueba (403 PAYMENT_SELF_APPROVAL)', self.status === 403 && self.json?.code === 'PAYMENT_SELF_APPROVAL', `${self.status} ${self.json?.code}`);
const approved = await direct('POST', `/treasury/payments/${big.id}/approve`, undefined, USER_2, 'payment:approve');
check('otra persona sí lo aprueba', approved.status === 200 && approved.json.status === 'approved' && approved.json.approvedBy === USER_2, approved.status);
const bigPosted = await gw('POST', `/treasury/payments/${big.id}/post`);
check('aprobado, se contabiliza', bigPosted.status === 200 && bigPosted.json.status === 'posted' && /^PG-/.test(bigPosted.json.number));
const edited = await gw('POST', '/treasury/payments', { supplierId: S1.id, paymentDate: today, method: 'transfer', reference: 'GRANDE-2', totalCents: 6000, lines: [{ payableId: rA.id, appliedCents: 6000 }] });
await direct('POST', `/treasury/payments/${edited.json.id}/approve`, undefined, USER_2, 'payment:approve');
const reedit = await gw('PUT', `/treasury/payments/${edited.json.id}`, { paymentDate: today, method: 'transfer', reference: 'GRANDE-2', totalCents: 7000, lines: [{ payableId: rA.id, appliedCents: 7000 }] });
check('editar un pago aprobado le QUITA la aprobación', reedit.status === 200 && reedit.json.status === 'draft' && reedit.json.approvedBy === null);
check('… y entonces vuelve a exigir aprobación', (await gw('POST', `/treasury/payments/${edited.json.id}/post`)).status === 409);
await gw('PUT', '/treasury/payments/settings', { approvalThresholdCents: null });
check('quitar el umbral deja contabilizar sin aprobación', (await gw('POST', `/treasury/payments/${edited.json.id}/post`)).status === 200);

// ── 5. anticipos a proveedores ──
const advDebt = (await gw('GET', `/treasury/payables?supplierId=${S2.id}&pageSize=100`)).json.items.find((x) => x.sourceId === bDup);
const over = (await gw('POST', '/treasury/payments', { supplierId: S2.id, paymentDate: today, method: 'cash', totalCents: 9000, lines: [{ payableId: advDebt.id, appliedCents: 5000 }] })).json;
const overPosted = (await gw('POST', `/treasury/payments/${over.id}/post`)).json;
check('pagar de más deja un anticipo de 40,00', overPosted.advanceCents === 4000 && overPosted.appliedCents === 5000, JSON.stringify({ a: overPosted.advanceCents }));
const stmt2 = await statementOf(S2.id);
const advance = stmt2.advances.find((a) => a.balanceCents === 4000);
check('el estado de cuenta lo muestra aparte (no entra en el neto)', !!advance && stmt2.advanceCents === 4000);
const bE = postBill(S2, 5750, doc(base % 900000 + 6));
await sleep(4000);
const rE = (await gw('GET', `/treasury/payables?supplierId=${S2.id}&pageSize=100`)).json.items.find((x) => x.sourceId === bE);
const use = (await gw('POST', '/treasury/payments', { supplierId: S2.id, paymentDate: today, method: 'cash', totalCents: 0, lines: [{ payableId: rE.id, appliedCents: 3000 }], advanceUses: [{ advanceId: advance.id, usedCents: 3000 }] })).json;
const usePosted = await gw('POST', `/treasury/payments/${use.id}/post`);
check('otro pago consume el anticipo sin que salga dinero', usePosted.status === 200 && usePosted.json.totalCents === 0 && usePosted.json.advanceUsedCents === 3000, usePosted.status);
const blockVoid = await gw('POST', `/treasury/payments/${over.id}/void`, { reason: 'Se anula el pago de más' });
check('NO se anula el pago cuyo anticipo ya consumió otro (409 PAYMENT_ADVANCE_IN_USE)', blockVoid.status === 409 && blockVoid.json?.code === 'PAYMENT_ADVANCE_IN_USE', `${blockVoid.status} ${blockVoid.json?.code}`);
const tooBig = await gw('POST', '/treasury/payments', { supplierId: S2.id, paymentDate: today, method: 'cash', totalCents: 0, lines: [{ payableId: rE.id, appliedCents: 2000 }], advanceUses: [{ advanceId: advance.id, usedCents: 2000 }] });
check('del anticipo de 40,00 quedan 10,00: pedir 20,00 se rechaza en el borrador', tooBig.status === 422 && tooBig.json?.details?.[0]?.field === 'advanceUses[0].usedCents', `${tooBig.status} ${JSON.stringify(tooBig.json?.details?.[0])}`);

// ── 6. anular y reversa ──
const toVoid = ok[0].json;
const noReason = await gw('POST', `/treasury/payments/${toVoid.id}/void`, { reason: 'abc' });
check('anular exige motivo de 5 caracteres (422)', noReason.status === 422);
const v = await gw('POST', `/treasury/payments/${toVoid.id}/void`, { reason: 'Pago registrado dos veces por error' });
check('anular con motivo (200) y la deuda recupera 10,00', v.status === 200 && v.json.status === 'voided' && (await debtOf(S2.id, bC)).balanceCents === 1000, `${v.status}`);
check('anular otra vez es idempotente', (await gw('POST', `/treasury/payments/${toVoid.id}/void`, { reason: 'Pago registrado dos veces por error' })).status === 200);

// ── 7. LA PRUEBA DE ORO: tesorería = contabilidad, por proveedor ──
console.log('   esperando a que contabilidad asiente los pagos (RabbitMQ)…');
await sleep(10000);
const ledger = (supplierId, role) => Number(sql('accounting_db', `select ifnull(sum(l.debit_cents - l.credit_cents),0) from journal_lines l join journal_entries e on e.id = l.entry_id join accounts a on a.id = l.account_id where a.system_role = '${role}' and l.party_id = '${supplierId}' and e.status = 'posted' and e.organization_id = '${ORG}'`));
const s2 = await statementOf(S2.id);
check(`ORO proveedor DOS (sin retención): lo que se le debe en tesorería (${s2.netCents}) = «proveedores» del libro mayor (${-ledger(S2.id, 'payables')})`, s2.netCents === -ledger(S2.id, 'payables'));
check(`ORO proveedor DOS: anticipos de tesorería (${s2.advanceCents}) = «anticipos a proveedores» del libro mayor (${ledger(S2.id, 'supplier_advances')})`, s2.advanceCents === ledger(S2.id, 'supplier_advances'));
// UNO tiene retenciones: contabilidad las asienta SIN tercero (solo trae el RUC), así que el libro por proveedor conserva lo retenido.
const s1 = await statementOf(S1.id);
const retained = s1.applications.filter((a) => a.sourceType === 'withholding').reduce((acc, a) => acc + a.appliedCents, 0);
check(`ORO proveedor UNO: lo que se le debe (${s1.netCents}) + lo retenido (${retained}) = «proveedores» del libro mayor con su tercero (${-ledger(S1.id, 'payables')})`, s1.netCents + retained === -ledger(S1.id, 'payables'));
const posted = sql('accounting_db', `select count(*) from journal_entries where organization_id='${ORG}' and source_type='payment' and kind='automatic' and source_id in (select id from (select 1) x where 0)`);
void posted;
const paymentIds = [...ok.map((r) => r.json.id), dup.id, big.id, edited.json.id, over.id, use.id];
const entries = Number(sql('accounting_db', `select count(*) from journal_entries where organization_id='${ORG}' and source_type='payment' and kind='automatic' and source_id in (${paymentIds.map((i) => `'${i}'`).join(',')})`));
check(`contabilidad asentó los ${paymentIds.length} pagos contabilizados`, entries === paymentIds.length, entries);
const reversals = Number(sql('accounting_db', `select count(*) from journal_entries where organization_id='${ORG}' and source_type='payment' and kind='reversal' and source_id='${toVoid.id}'`));
check('contabilidad reversó el pago anulado', reversals === 1, reversals);
const pending = Number(sql('accounting_db', `select count(*) from pending_postings where organization_id='${ORG}' and status='pending' and source_type in ('payment','payment_void')`));
check('ningún pago quedó pendiente en contabilidad', pending === 0, pending);
const unbalanced = Number(sql('accounting_db', `select count(*) from journal_entries e where e.organization_id='${ORG}' and e.source_type='payment' and e.total_debit_cents <> e.total_credit_cents`));
check('todos los asientos de pagos cuadran (debe = haber)', unbalanced === 0, unbalanced);

// ── 8. exportar y bitácora ──
const exp = await gw('GET', `/treasury/payables/export?supplierId=${S1.id}&lang=en`, undefined, true);
const bytes = new Uint8Array(await exp.arrayBuffer());
const csv = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes).replace(/^﻿/, '').trimEnd().split('\r\n');
check('exportar las deudas de un proveedor: CSV con BOM y encabezado en inglés', exp.status === 200 && bytes[0] === 0xef && csv[0].startsWith('Supplier invoice,Internal no.'), csv[0]?.slice(0, 60));
check('… con una fila por deuda (3: A, B y la de la retención adelantada)', csv.length === 4, csv.length);
const ev = JSON.parse(sql('treasury_db', `select payload from outbox_messages where type='treasury.report.exported' order by occurred_at desc limit 1`));
check('dejó el evento `treasury.report.exported` (payables) con quién y cuántas filas', ev.report === 'payables' && ev.rowCount === 3 && ev.exportedBy === ADMIN, JSON.stringify(ev).slice(0, 160));
const events = sql('treasury_db', `select type, count(*) from outbox_messages where JSON_UNQUOTE(JSON_EXTRACT(payload,'$.organizationId'))='${ORG}' and (type like 'treasury.payment.%' or type like 'treasury.payable.%' or type like 'treasury.supplier_advance.%') group by type`);
for (const t of ['treasury.payable.opened', 'treasury.payable.credited', 'treasury.payment.created', 'treasury.payment.approved', 'treasury.payment.posted', 'treasury.payment.voided', 'treasury.payment_settings.updated', 'treasury.supplier_advance.opened']) {
  const present = events.includes(t) || sql('treasury_db', `select count(*) from outbox_messages where type='${t}'`) !== '0';
  check(`el outbox publicó ${t}`, present);
}
await sleep(3000);
const audit = await gw('GET', '/audit-logs?event=treasury.&pageSize=100');
const names = (audit.json?.items ?? audit.json?.data ?? []).map((e) => e.event);
check('la bitácora registra los pagos y las deudas', names.includes('treasury.payment.posted') && names.includes('treasury.payable.opened'), [...new Set(names)].slice(0, 8).join(', '));

await ch.close(); await conn.close();
console.log(failures ? `\n${failures} verificaciones FALLARON` : '\nTODO OK');
process.exit(failures ? 1 : 0);
