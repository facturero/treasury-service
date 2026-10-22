// Verificación de BANCOS, EXTRACTOS y CONCILIACIÓN (bloque E) contra MySQL y RabbitMQ REALES, con tesorería y contabilidad corriendo.
//
//   1. pila local arriba (mysql, rabbitmq, auth, customer, purchasing, plugin-catalog, audit-log) y migraciones aplicadas
//      (treasury_db: 20261024100000-create-banking; auth_db: 20261024100000-add-treasury-bank-permissions)
//   2. tesorería (:3018), contabilidad (:3016) y gateway (:8080), del árbol actual  →  bash scripts/local-stack/arrancar-arbol.sh servicios
//   3. node scripts/verify-banking.mjs
//
// Qué comprueba que ninguna prueba unitaria (repos en memoria) puede ver:
//   · el relleno de la migración y el SQL real: el filtro «emparejado / pendiente» de movimientos y el congelado de renglones al cerrar;
//   · 10 renglones iguales peleándose por UN movimiento a la vez: exactamente un emparejamiento, sin 500 ni interbloqueos;
//   · emparejar y ANULAR el mismo cobro a la vez, 12 rondas: nunca queda un emparejamiento sobre un movimiento revertido, ni un renglón
//     «emparejado» sin emparejamiento (el orden de bloqueos cuenta → renglón → movimiento);
//   · importar: el mismo archivo es 409; un extracto que se solapa omite lo ya importado; una fila mala no importa nada;
//   · los ajustes bancarios llegan a contabilidad por RabbitMQ (Dr otros gastos / Cr bancos y al revés) y su anulación los reversa;
//   · cerrar una conciliación congela; con ella cerrada no se desempareja ni se anula el cobro (409 BANK_RECONCILED); reabrir lo libera;
//   · LA PRUEBA DE ORO: lo que se movió en el registro de bancos de tesorería es EXACTAMENTE lo que se movió en «Bancos» del libro mayor
//     (cobros +, pagos −, ajustes ±; lo anulado queda en cero en los dos lados).
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';

const require = createRequire(new URL('../node_modules/@facturero/outbox-relay/package.json', import.meta.url));
const amqp = require('amqplib');

const GATEWAY = process.env.GATEWAY ?? 'http://127.0.0.1:8080';
const BASE = process.env.TREASURY ?? 'http://127.0.0.1:3018';
const USER = '22222222-2222-4222-8222-222222222222';
const ALL = 'receivable:read,receipt:read,receipt:create,receipt:void,payable:read,payment:read,payment:create,payment:approve,payment:void,customer_terms:manage,opening_balance:load,bank_account:read,bank_account:manage,reconciliation:manage';
let failures = 0;
const check = (name, ok, detail = '') => { if (!ok) failures += 1; console.log(`${ok ? 'OK   ' : 'FALLO'} ${name}${detail !== '' ? ' — ' + String(detail).slice(0, 260) : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sql = (db, q) => execSync(`docker exec cmr-mysql mysql -uroot -proot123 -N -B ${db} -e "${q.replace(/"/g, '\\"')}"`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const num = (v) => Number(v === '' || v === 'NULL' ? 0 : v);

const login = await (await fetch(`${GATEWAY}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: process.env.ADMIN_EMAIL ?? 'admin@admin.com', password: process.env.ADMIN_PASSWORD ?? 'Admin1234!' }) })).json();
if (!login.accessToken) throw new Error('No pude entrar con la cuenta de desarrollo.');
const claims = JSON.parse(Buffer.from(login.accessToken.split('.')[1], 'base64url').toString());
const ORG = claims.org_id;
const sello = Date.now();
const today = new Date().toLocaleDateString('en-CA');
const plus = (days) => new Date(Date.now() + days * 86_400_000).toLocaleDateString('en-CA');

async function api(method, path, body, user = USER, perms = ALL) {
  const r = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', 'X-Organization-Id': ORG, 'X-User-Id': user, 'X-Permissions': perms }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text(); let json = null; try { json = t ? JSON.parse(t) : null; } catch { json = t; }
  return { status: r.status, json };
}
async function gw(method, path, body) {
  const r = await fetch(GATEWAY + path, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${login.accessToken}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text(); let json = null; try { json = t ? JSON.parse(t) : null; } catch { json = t; }
  return { status: r.status, json };
}

const conn = await amqp.connect(process.env.AMQP ?? 'amqp://127.0.0.1:5672');
const ch = await conn.createChannel();
await ch.assertExchange('crm.events', 'topic', { durable: true });
const publish = (key, payload) => ch.publish('crm.events', key, Buffer.from(JSON.stringify(payload)), { persistent: true, headers: { eventId: randomUUID() } });

// ── Un cliente y un proveedor reales, con una deuda GRANDE cada uno (de ahí salen todos los cobros y pagos) ──
const customerId = (await (await fetch(`${GATEWAY}/customers`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${login.accessToken}` }, body: JSON.stringify({ businessName: `BANCOS CLIENTE ${sello}`, type: 'company' }) })).json()).id;
const ruc = `1${String(sello).slice(-9)}001`;
const supplier = (await gw('POST', '/purchasing/suppliers', { identificationType: 'RUC', identification: ruc, legalName: `BANCOS PROVEEDOR ${sello}` })).json;
const BIG = 100_000_000;
const invoiceId = randomUUID();
const sub = Math.round(BIG / 1.15);
publish('billing.invoice.issued', { organizationId: ORG, invoiceId, customerId, number: `001-001-${String(sello).slice(-9)}`, issueDate: new Date().toISOString(), documentTypeCode: '01', currencyCode: 'USD', totalCents: BIG, posSaleId: null, paymentMethodCode: null, relatedInvoiceId: null, customerSnapshot: { id: customerId, businessName: `BANCOS CLIENTE ${sello}`, identification: null }, lines: [{ subtotalCents: sub, taxes: [{ kind: 'vat', amountCents: BIG - sub }] }] });
const billId = randomUUID();
publish('purchasing.bill.posted', { organizationId: ORG, billId, internalNumber: `FC-${sello}`, supplierId: supplier.id, supplier: { identification: ruc, legalName: `BANCOS PROVEEDOR ${sello}` }, docType: '01', supplierDocument: `001-001-${String(sello).slice(-9)}`, issueDate: today, dueDate: plus(30), currencyCode: 'USD', subtotalCents: sub, taxCents: BIG - sub, totalCents: BIG, matchStatus: 'not_applicable', lines: [{ kind: 'expense', subtotalCents: sub, vatCents: BIG - sub, iceCents: 0, irbpnrCents: 0, priceVarianceCents: 0 }] });
await sleep(6000);
const receivable = (await api('GET', `/treasury/receivables?customerId=${customerId}&pageSize=10`)).json.items.find((x) => x.sourceId === invoiceId);
const payable = (await api('GET', `/treasury/payables?supplierId=${supplier.id}&pageSize=10`)).json.items.find((x) => x.sourceId === billId);
check('la factura y la factura de compra grandes abrieron sus deudas', !!receivable && !!payable, `${receivable?.balanceCents} / ${payable?.balanceCents}`);

const bankLedger = () => {
  const id = sql('accounting_db', `select id from accounts where organization_id='${ORG}' and system_role='bank' limit 1`);
  return num(sql('accounting_db', `select coalesce(sum(debit_cents - credit_cents),0) from journal_lines where organization_id='${ORG}' and account_id='${id}' and is_posted=1`));
};
const bankRegister = () => num(sql('treasury_db', `select coalesce(sum(amount_cents),0) from bank_movements where organization_id='${ORG}' and status='active'`));
const ledger0 = bankLedger();
const register0 = bankRegister();

async function collect(cents, reference, bankAccountId, date = today) {
  const d = await api('POST', '/treasury/receipts', { customerId, receiptDate: date, method: 'transfer', reference, bankAccountId, totalCents: cents, lines: [{ receivableId: receivable.id, appliedCents: cents }] });
  if (d.status !== 201) throw new Error(`cobro: ${d.status} ${JSON.stringify(d.json)}`);
  const p = await api('POST', `/treasury/receipts/${d.json.id}/post`);
  if (p.status !== 200) throw new Error(`contabilizar cobro: ${p.status} ${JSON.stringify(p.json)}`);
  return p.json;
}
async function pay(cents, reference, bankAccountId, date = today) {
  const d = await api('POST', '/treasury/payments', { supplierId: supplier.id, paymentDate: date, method: 'transfer', reference, bankAccountId, totalCents: cents, lines: [{ payableId: payable.id, appliedCents: cents }] });
  if (d.status !== 201) throw new Error(`pago: ${d.status} ${JSON.stringify(d.json)}`);
  const p = await api('POST', `/treasury/payments/${d.json.id}/post`);
  if (p.status !== 200) throw new Error(`contabilizar pago: ${p.status} ${JSON.stringify(p.json)}`);
  return p.json;
}
const movementOf = (sourceId) => sql('treasury_db', `select id, bank_account_id, amount_cents, status from bank_movements where source_id='${sourceId}'`).split('\t');
const csvText = (rows) => ['Fecha,Descripcion,Referencia,Monto', ...rows.map((r) => r.join(','))].join('\n');
const profile = { delimiter: ',', skipRows: 1, dateColumn: 1, dateFormat: 'YYYY-MM-DD', descriptionColumn: 2, referenceColumn: 3, amountMode: 'signed', amountColumn: 4, debitColumn: null, creditColumn: null, invertSign: false, decimalSeparator: '.', balanceColumn: null };

// ── 1. Cuentas ──
const A = (await gw('POST', '/treasury/bank-accounts', { name: `Pichincha ${sello}`, bankName: 'Banco Pichincha', accountType: 'checking', accountLast4: '1234', openingBalanceCents: 100000, openingDate: '2020-01-01', importProfile: profile })).json;
check('la cuenta se crea por el gateway y solo guarda los últimos 4 dígitos', A.accountLast4 === '1234' && A.currencyCode === 'USD' && !JSON.stringify(A).includes('accountNumber'), JSON.stringify(A).slice(0, 120));
const dup = await gw('POST', '/treasury/bank-accounts', { name: `Pichincha ${sello}`, bankName: 'X', accountType: 'checking', openingBalanceCents: 0, openingDate: '2020-01-01' });
check('el nombre repetido es 422', dup.status === 422, dup.status);

// ── 2. Cobros y pagos dejan su movimiento en el registro ──
const r1 = await collect(10000, `R1-${sello}`, A.id);
const r2 = await collect(20000, `R2-${sello}`, A.id);
const r3 = await collect(30000, `R3-${sello}`, A.id);
const r5 = await collect(5000, `R5-${sello}`, A.id); // todavía sin cobrar en el banco: queda pendiente
const p1 = await pay(15000, `CHQ1-${sello}`, A.id);
const p2 = await pay(7000, `CHQ2-${sello}`, A.id); // cheque en circulación
const rLoose = await collect(4000, `SINCTA-${sello}`, null); // sin cuenta elegida
const m = Object.fromEntries([['r1', r1], ['r2', r2], ['r3', r3], ['r5', r5], ['p1', p1], ['p2', p2], ['loose', rLoose]].map(([k, v]) => [k, movementOf(v.id)]));
check('el cobro deja un movimiento que ENTRA y el pago uno que SALE, en su cuenta', m.r1[1] === A.id && num(m.r1[2]) === 10000 && m.p1[1] === A.id && num(m.p1[2]) === -15000, JSON.stringify(m.p1));
check('un cobro sin cuenta elegida queda «sin asignar»', m.loose[1] === 'NULL', m.loose[1]);
const listed = (await gw('GET', '/treasury/bank-accounts')).json;
check('la lista trae el saldo del registro y lo sin asignar', listed.items.find((x) => x.id === A.id).registerBalanceCents === 100000 + 10000 + 20000 + 30000 + 5000 - 15000 - 7000 && listed.unassignedMovements >= 1);
const assigned = await api('POST', `/treasury/bank-movements/${m.loose[0]}/account`, { bankAccountId: A.id });
check('se asigna cuenta a un movimiento sin asignar', assigned.status === 200 && assigned.json.bankAccountId === A.id, assigned.status);

// ── 3. Importar el extracto ──
const lines = [
  [today, `Transferencia recibida R1`, `R1-${sello}`, '100.00'],
  [today, `Deposito R2 y R3`, 'DEP-9', '500.00'],
  [today, `Cheque pagado`, `CHQ1-${sello}`, '-150.00'],
  [today, `Comision mantenimiento`, '', '-2.50'],
  [today, `Interes ganado`, '', '1.20'],
  [today, `Venta cobrada con tarjeta`, 'POS-1', '333.33'],
  [today, `Cobro sin cuenta`, `SINCTA-${sello}`, '40.00'],
];
const imp = await api('POST', `/treasury/bank-accounts/${A.id}/statements`, { csv: csvText(lines), fileName: 'octubre.csv' });
check('el extracto se importa (201) con todos sus renglones', imp.status === 201 && imp.json.importedLines === 7, JSON.stringify(imp.json).slice(0, 200));
const same = await api('POST', `/treasury/bank-accounts/${A.id}/statements`, { csv: csvText(lines) });
check('el MISMO archivo es 409 BANK_STATEMENT_ALREADY_IMPORTED', same.status === 409 && same.json.code === 'BANK_STATEMENT_ALREADY_IMPORTED', same.status);
const overlap = await api('POST', `/treasury/bank-accounts/${A.id}/statements`, { csv: csvText([...lines.slice(3), [today, 'Cargo chequera', '', '-1.00']]) });
check('un extracto que se solapa omite lo ya importado y cuenta cuánto', overlap.status === 201 && overlap.json.importedLines === 1 && overlap.json.skippedDuplicates === 4, JSON.stringify(overlap.json).slice(0, 200));
const bad = await api('POST', `/treasury/bank-accounts/${A.id}/statements`, { csv: csvText([[today, 'Bien', '', '5.00'], ['2026-13-40', 'Mal', '', '5.00']]) });
check('una fila mala no importa NADA y dice la fila', bad.status === 422 && JSON.stringify(bad.json).includes('rows[3].date') && num(sql('treasury_db', `select count(*) from bank_statement_lines where bank_account_id='${A.id}' and description='Bien'`)) === 0, bad.status);
const lineOf = (needle) => sql('treasury_db', `select id from bank_statement_lines where bank_account_id='${A.id}' and description like '${needle}%' limit 1`);

// ── 4. Sugerencias (por referencia) y confirmación ──
const sug = (await api('GET', `/treasury/bank-accounts/${A.id}/suggestions`)).json.suggestions;
const sugBy = (ref) => sug.find((s) => s.movement.reference === ref);
check('sugiere por referencia el cobro R1, el cheque y el cobro que estaba sin cuenta', !!sugBy(`R1-${sello}`) && !!sugBy(`CHQ1-${sello}`) && !!sugBy(`SINCTA-${sello}`) && sug.length === 3, sug.map((s) => s.movement.reference).join(','));
const batch = await api('POST', '/treasury/bank-lines/match', { pairs: sug.map((s) => ({ lineId: s.line.id, movementIds: [s.movement.id] })), method: 'suggested' });
check('confirmadas en lote: las 3 emparejadas', batch.json.matched.length === 3 && batch.json.failed.length === 0, JSON.stringify(batch.json).slice(0, 160));
const dep = await api('POST', `/treasury/bank-lines/${lineOf('Deposito R2')}/match`, { movementIds: [m.r2[0], m.r3[0]] });
check('un depósito se empareja con DOS cobros que suman exacto', dep.status === 200 && dep.json.status === 'matched', dep.status + JSON.stringify(dep.json).slice(0, 120));
const wrong = await api('POST', `/treasury/bank-lines/${lineOf('Comision')}/match`, { movementIds: [m.r5[0]] });
check('un movimiento de otro importe no se empareja (409)', wrong.status === 409 && wrong.json.code === 'BANK_MATCH_INVALID', wrong.status);
const mm = (await gw('GET', `/treasury/bank-movements?bankAccountId=${A.id}&matched=true&pageSize=100`)).json.items.length;
const mp = (await gw('GET', `/treasury/bank-movements?bankAccountId=${A.id}&matched=false&status=active&pageSize=100`)).json.items;
check('el filtro «emparejado / pendiente» de movimientos (SQL real) cuadra: 5 emparejados, 2 pendientes (R5 y el cheque en circulación)', mm === 5 && mp.length === 2 && mp.every((x) => [`R5-${sello}`, `CHQ2-${sello}`].includes(x.reference)), `${mm} / ${mp.map((x) => x.reference)}`);

// ── 5. Concurrencia: 10 renglones iguales por UN movimiento ──
const rc = await collect(7777, `RACE-${sello}`, A.id);
const rcMovement = movementOf(rc.id)[0];
const raceLines = Array.from({ length: 10 }, (_, i) => [today, `Carrera ${i}`, '', '77.77']);
await api('POST', `/treasury/bank-accounts/${A.id}/statements`, { csv: csvText(raceLines), fileName: 'carrera.csv' });
const raceIds = sql('treasury_db', `select id from bank_statement_lines where bank_account_id='${A.id}' and description like 'Carrera %'`).split('\n');
const race = await Promise.all(raceIds.map((id) => api('POST', `/treasury/bank-lines/${id}/match`, { movementIds: [rcMovement] })));
const statuses = race.map((x) => x.status);
check('10 renglones iguales por UN movimiento: exactamente un emparejamiento, el resto 409, ningún 500', statuses.filter((s) => s === 200).length === 1 && statuses.filter((s) => s === 409).length === 9, statuses.join(','));
check('en la base queda UN solo emparejamiento de ese movimiento', num(sql('treasury_db', `select count(*) from bank_matches where movement_id='${rcMovement}'`)) === 1);

// ── 6. Concurrencia: emparejar y anular el mismo cobro a la vez, 12 rondas ──
const roundLines = Array.from({ length: 12 }, (_, i) => [today, `Ronda ${i}`, '', String(11 + i) + '.00']);
await api('POST', `/treasury/bank-accounts/${A.id}/statements`, { csv: csvText(roundLines), fileName: 'rondas.csv' });
const outcomes = [];
for (let i = 0; i < 12; i += 1) {
  const receipt = await collect((11 + i) * 100, `RONDA${i}-${sello}`, A.id);
  const lineId = lineOf(`Ronda ${i}`);
  const [a, b] = await Promise.all([
    api('POST', `/treasury/bank-lines/${lineId}/match`, { movementIds: [movementOf(receipt.id)[0]] }),
    api('POST', `/treasury/receipts/${receipt.id}/void`, { reason: 'Anulación concurrente de prueba' }),
  ]);
  outcomes.push(`${a.status}/${b.status}`);
}
check('emparejar y anular a la vez: solo respuestas de negocio (200/409/422), nunca 500', outcomes.every((o) => o.split('/').every((s) => ['200', '409', '422'].includes(s))), outcomes.join(' '));
const bad1 = num(sql('treasury_db', `select count(*) from bank_matches bm join bank_movements mv on mv.id = bm.movement_id where mv.status = 'reversed'`));
const bad2 = num(sql('treasury_db', `select count(*) from bank_statement_lines l where l.status = 'matched' and not exists (select 1 from bank_matches bm where bm.line_id = l.id)`));
const bad3 = num(sql('treasury_db', `select count(*) from bank_matches bm join bank_statement_lines l on l.id = bm.line_id where l.status <> 'matched'`));
check('ningún emparejamiento sobre un movimiento revertido, ni renglón «emparejado» sin emparejamiento, ni al revés', bad1 === 0 && bad2 === 0 && bad3 === 0, `${bad1}/${bad2}/${bad3}`);
// los renglones de las rondas que quedaron sin emparejar se marcan externos (para no ensuciar la conciliación que sigue)
for (const id of sql('treasury_db', `select id from bank_statement_lines where bank_account_id='${A.id}' and description like 'Ronda %' and status='unmatched'`).split('\n').filter(Boolean)) {
  await api('POST', `/treasury/bank-lines/${id}/external`, { reason: 'Renglón de la prueba de concurrencia' });
}
// el cobro de la carrera y sus renglones sobrantes se dejan también resueltos
for (const id of sql('treasury_db', `select id from bank_statement_lines where bank_account_id='${A.id}' and description like 'Carrera %' and status='unmatched'`).split('\n').filter(Boolean)) {
  await api('POST', `/treasury/bank-lines/${id}/external`, { reason: 'Renglón de la prueba de la carrera' });
}

// ── 7. Ajustes: comisión e interés desde sus renglones; contabilidad los asienta ──
const fee = await api('POST', '/treasury/bank-adjustments', { bankAccountId: A.id, kind: 'bank_fee', date: today, amountCents: 250, description: 'Comisión mantenimiento', lineId: lineOf('Comision') });
const interest = await api('POST', '/treasury/bank-adjustments', { bankAccountId: A.id, kind: 'interest', date: today, amountCents: 120, description: 'Interés ganado', lineId: lineOf('Interes') });
check('la comisión y el interés se registran desde su renglón y nacen emparejados', fee.status === 201 && interest.status === 201 && fee.json.amountCents === -250 && interest.json.amountCents === 120, `${fee.status}/${interest.status}`);
const mismatch = await api('POST', '/treasury/bank-adjustments', { bankAccountId: A.id, kind: 'bank_fee', date: today, amountCents: 999, description: 'Importe equivocado', lineId: lineOf('Venta cobrada') });
check('un ajuste que no coincide con el renglón es 422', mismatch.status === 422, mismatch.status);
const loose = await api('POST', '/treasury/bank-adjustments', { bankAccountId: A.id, kind: 'other_out', date: today, amountCents: 500, description: 'Cargo por chequera' });
const entryOf = (id) => sql('accounting_db', `select concat(je.status,'|',je.total_debit_cents,'|',je.kind) from journal_entries je where je.organization_id='${ORG}' and je.source_type='bank_adjustment' and je.source_id='${id}' order by je.created_at`).split('\n').filter(Boolean);
let entries = [];
for (let i = 0; i < 20; i += 1) { await sleep(1000); entries = [entryOf(fee.json.id), entryOf(interest.json.id), entryOf(loose.json.id)]; if (entries.every((e) => e.length)) break; }
check('contabilidad asentó los tres ajustes (por RabbitMQ) con el importe del evento', entries.every((e) => e.length === 1) && entries[0][0].startsWith('posted|250') && entries[1][0].startsWith('posted|120') && entries[2][0].startsWith('posted|500'), JSON.stringify(entries));
const lines3 = (id) => sql('accounting_db', `select concat(a.system_role, ':', jl.debit_cents, ':', jl.credit_cents) from journal_lines jl join journal_entries je on je.id = jl.entry_id join accounts a on a.id = jl.account_id where je.source_type='bank_adjustment' and je.source_id='${id}' order by jl.line_no`).split('\n');
check('la comisión es Dr otros gastos / Cr bancos; el interés, Dr bancos / Cr otros ingresos', lines3(fee.json.id).join() === 'other_expense:250:0,bank:0:250' && lines3(interest.json.id).join() === 'bank:120:0,other_income:0:120', lines3(fee.json.id).join() + ' | ' + lines3(interest.json.id).join());
const voidLoose = await api('POST', `/treasury/bank-adjustments/${loose.json.id}/void`, { reason: 'Se cargó por error' });
let reversed = [];
for (let i = 0; i < 20; i += 1) { await sleep(1000); reversed = entryOf(loose.json.id); if (reversed.length === 2) break; }
check('anular un ajuste lo reversa en contabilidad (dos asientos: el original y su reversa)', voidLoose.status === 200 && reversed.length === 2 && reversed.some((e) => e.endsWith('reversal')), JSON.stringify(reversed));
const ext = await api('POST', `/treasury/bank-lines/${lineOf('Venta cobrada')}/external`, { reason: 'Venta cobrada con tarjeta al emitir la factura' });
check('«contabilizado fuera de tesorería» pide motivo y queda marcado', ext.status === 200 && ext.json.status === 'external', ext.status);

// el renglón «Cargo chequera» del extracto solapado también se resuelve antes de conciliar
const chequera = await api('POST', `/treasury/bank-lines/${lineOf('Cargo chequera')}/external`, { reason: 'Cargo ya asentado a mano en contabilidad' });
check('el renglón del extracto solapado se marca externo', chequera.status === 200, chequera.status);

// ── 8. Conciliación ──
// Saldo del extracto = apertura + todos los renglones hasta el corte (los de rondas y carrera quedaron externos, así que también cuentan).
const stmtBalance = num(sql('treasury_db', `select 100000 + coalesce(sum(amount_cents),0) from bank_statement_lines where bank_account_id='${A.id}'`));
const cutoff = plus(1);
const pre = (await api('GET', `/treasury/bank-accounts/${A.id}/reconciliation?cutoffDate=${cutoff}&statementBalanceCents=${stmtBalance}`)).json;
check('la conciliación a una fecha: diferencia 0 y los pendientes son R5 y el cheque en circulación', pre.result?.differenceCents === 0 && pre.result?.unresolvedLines === 0 && pre.pendingMovements.length === 2 && pre.result.pendingCents === 5000 - 7000, JSON.stringify(pre.result));
const wrongClose = await api('POST', `/treasury/bank-accounts/${A.id}/reconciliations`, { cutoffDate: cutoff, statementBalanceCents: stmtBalance + 1 });
check('con un saldo de extracto equivocado no se puede cerrar (409)', wrongClose.status === 409, wrongClose.status);
const closed = await api('POST', `/treasury/bank-accounts/${A.id}/reconciliations`, { cutoffDate: cutoff, statementBalanceCents: stmtBalance, notes: 'Cierre de prueba' });
check('cierra con diferencia 0', closed.status === 201 && closed.json.differenceCents === 0 && closed.json.status === 'closed', closed.status + JSON.stringify(closed.json).slice(0, 120));
const frozenLines = num(sql('treasury_db', `select count(*) from bank_statement_lines where bank_account_id='${A.id}' and reconciliation_id='${closed.json.id}'`));
const frozenMatches = num(sql('treasury_db', `select count(*) from bank_matches where bank_account_id='${A.id}' and reconciliation_id='${closed.json.id}'`));
const totalMatches = num(sql('treasury_db', `select count(*) from bank_matches bm join bank_statement_lines l on l.id=bm.line_id where bm.bank_account_id='${A.id}' and l.reconciliation_id='${closed.json.id}'`));
check('cerrar congela los renglones y todos sus emparejamientos (SQL real)', frozenLines > 0 && frozenMatches === totalMatches && frozenMatches > 0, `${frozenLines} renglones, ${frozenMatches}/${totalMatches} emparejamientos`);
const unm = await api('POST', `/treasury/bank-lines/${lineOf('Transferencia recibida')}/unmatch`);
check('con la conciliación cerrada no se desempareja (409 BANK_RECONCILED)', unm.status === 409 && unm.json.code === 'BANK_RECONCILED', unm.status + (unm.json?.code ?? ''));
const voidR1 = await api('POST', `/treasury/receipts/${r1.id}/void`, { reason: 'Quiero anularlo' });
check('ni se anula el cobro conciliado (409 BANK_RECONCILED) y el cobro sigue contabilizado', voidR1.status === 409 && voidR1.json.code === 'BANK_RECONCILED' && sql('treasury_db', `select status from receipts where id='${r1.id}'`) === 'posted', voidR1.status);
const late = await api('POST', `/treasury/bank-accounts/${A.id}/statements`, { csv: csvText([[today, 'Olvidado', '', '1.00']]) });
check('un renglón nuevo de un periodo ya conciliado no entra (422)', late.status === 422, late.status);
const again = await api('POST', `/treasury/bank-accounts/${A.id}/reconciliations`, { cutoffDate: cutoff, statementBalanceCents: stmtBalance });
check('no se cierra dos veces el mismo corte (422)', again.status === 422, again.status);
const reopen = await api('POST', `/treasury/bank-reconciliations/${closed.json.id}/reopen`, { reason: 'Faltaba un depósito' });
const stillFrozen = num(sql('treasury_db', `select count(*) from bank_statement_lines where bank_account_id='${A.id}' and reconciliation_id is not null`)) + num(sql('treasury_db', `select count(*) from bank_matches where bank_account_id='${A.id}' and reconciliation_id is not null`));
check('reabrir descongela todo', reopen.status === 200 && reopen.json.status === 'reopened' && stillFrozen === 0, `${reopen.status} congelado=${stillFrozen}`);
const unm2 = await api('POST', `/treasury/bank-lines/${lineOf('Transferencia recibida')}/unmatch`);
check('reabierta, ahora sí se desempareja', unm2.status === 200 && unm2.json.status === 'unmatched', unm2.status);
await api('POST', `/treasury/bank-lines/${lineOf('Transferencia recibida')}/match`, { movementIds: [m.r1[0]] });
const closed2 = await api('POST', `/treasury/bank-accounts/${A.id}/reconciliations`, { cutoffDate: cutoff, statementBalanceCents: stmtBalance });
check('se vuelve a cerrar el mismo corte (la reabierta queda como historia)', closed2.status === 201, closed2.status);
check('el historial trae las dos (la cerrada y la reabierta)', (await api('GET', `/treasury/bank-accounts/${A.id}/reconciliations`)).json.items.map((x) => x.status).sort().join() === 'closed,reopened');

// ── 9. Flujo de caja ──
const flow = (await gw('GET', '/treasury/cash-flow?weeks=8')).json;
check('el flujo de caja parte del saldo del registro y reparte por semanas', Array.isArray(flow.buckets) && flow.buckets.length === 10 && flow.accounts.some((x) => x.id === A.id), flow.openingCents);
const csv = await fetch(`${GATEWAY}/treasury/cash-flow/export?weeks=4&lang=es`, { headers: { Authorization: `Bearer ${login.accessToken}` } });
const csvBytes = new Uint8Array(await csv.arrayBuffer());
check('el CSV del flujo de caja sale con BOM y sin caché', csv.status === 200 && csv.headers.get('cache-control') === 'no-store' && csvBytes[0] === 0xef && csvBytes[1] === 0xbb && csvBytes[2] === 0xbf, csv.status);

// ── 10. LA PRUEBA DE ORO ──
let ledgerDelta = 0, registerDelta = 0;
for (let i = 0; i < 30; i += 1) {
  ledgerDelta = bankLedger() - ledger0;
  registerDelta = bankRegister() - register0;
  if (ledgerDelta === registerDelta) break;
  await sleep(1000);
}
check('PRUEBA DE ORO: lo que se movió en el registro de bancos de tesorería es EXACTAMENTE lo que se movió en «Bancos» del libro mayor', ledgerDelta === registerDelta && registerDelta !== 0, `registro ${registerDelta} / libro mayor ${ledgerDelta}`);

console.log(failures === 0 ? '\nTODO OK' : `\n${failures} FALLO(S)`);
await ch.close();
await conn.close();
process.exit(failures === 0 ? 0 : 1);
