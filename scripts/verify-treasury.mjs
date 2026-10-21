// Verificación de treasury-service (bloque A) contra MySQL y RabbitMQ REALES y los clientes REALES del stack local.
//
//   1. docker compose up -d mysql rabbitmq auth-service organization-service customer-service accounting-service billing-service gateway
//   2. crear treasury_db y migrar:  DB_HOST=127.0.0.1 DB_PORT=3307 DB_USER=root DB_PASSWORD=root123 DB_NAME=treasury_db npx sequelize-cli db:migrate
//   3. levantar el servicio en :3018 con esas variables + RABBITMQ_URL=amqp://127.0.0.1:5672, ACCOUNTING_SERVICE_URL=http://127.0.0.1:3016
//      y CUSTOMER_SERVICE_URL=http://127.0.0.1:3004  (npx tsx src/main.ts)
//   4. node scripts/verify-treasury.mjs
//
// Variables: GATEWAY (http://127.0.0.1:8080: solo para entrar y crear dos clientes de verificación), TREASURY (http://127.0.0.1:3018),
// AMQP (amqp://127.0.0.1:5672) y ADMIN_EMAIL / ADMIN_PASSWORD (la cuenta de desarrollo). Publica `billing.invoice.*` por RabbitMQ
// como lo haría billing y mira lo que el servicio deja en su cartera: lo que comprueba es el camino real (evento → consumidor → MySQL).
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
// amqplib viene con @facturero/outbox-relay (dependencia del servicio): no se añade otra.
const require = createRequire(new URL('../node_modules/@facturero/outbox-relay/package.json', import.meta.url));
const amqp = require('amqplib');

const GATEWAY = process.env.GATEWAY ?? 'http://127.0.0.1:8080';
const BASE = process.env.TREASURY ?? 'http://127.0.0.1:3018';
const OTHER_ORG = '11111111-1111-4111-8111-111111111111';

// ── Datos reales del stack: la organización de la cuenta de desarrollo y dos clientes que existen de verdad ──
const login = await (await fetch(`${GATEWAY}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: process.env.ADMIN_EMAIL ?? 'admin@admin.com', password: process.env.ADMIN_PASSWORD ?? 'Admin1234!' }) })).json();
if (!login.accessToken) throw new Error('No pude entrar con la cuenta de desarrollo (ADMIN_EMAIL / ADMIN_PASSWORD).');
const ORG = JSON.parse(Buffer.from(login.accessToken.split('.')[1], 'base64url').toString()).org_id;
async function crearCliente(nombre) {
  const r = await fetch(`${GATEWAY}/customers`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${login.accessToken}` }, body: JSON.stringify({ businessName: nombre, type: 'company' }) });
  const body = await r.json();
  if (!body.id) throw new Error(`No pude crear el cliente de verificación: ${r.status} ${JSON.stringify(body)}`);
  return body.id;
}
const sello = Date.now();
// Fecha de corte distinta en cada corrida (una sola carga por fecha de corte): el script se puede repetir sin limpiar la base.
const corte = (n) => new Date(Date.UTC(1950, 0, 1) + ((Math.floor(sello / 1000) % 36500) + n * 2) * 86_400_000).toISOString().slice(0, 10);
let failures = 0;
const check = (name, ok, detail = '') => { if (!ok) failures += 1; console.log(`${ok ? 'OK   ' : 'FALLO'} ${name}${detail !== '' ? ' — ' + String(detail).slice(0, 220) : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(method, path, { org = ORG, perms = 'receivable:read,customer_terms:manage,opening_balance:load', body, user = '22222222-2222-4222-8222-222222222222' } = {}) {
  const headers = { 'Content-Type': 'application/json', 'X-Organization-Id': org, 'X-User-Id': user, 'X-Permissions': perms };
  const r = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text(); let json = null; try { json = t ? JSON.parse(t) : null; } catch { json = t; }
  return { status: r.status, json };
}

const conn = await amqp.connect(process.env.AMQP ?? 'amqp://127.0.0.1:5672');
const ch = await conn.createChannel();
await ch.assertExchange('crm.events', 'topic', { durable: true });
const publish = (key, payload, eventId = randomUUID()) => ch.publish('crm.events', key, Buffer.from(JSON.stringify(payload)), { persistent: true, headers: { eventId } });

const C1 = await crearCliente(`VERIFICACIÓN TESORERÍA UNO ${sello}`); const C2 = await crearCliente(`VERIFICACIÓN TESORERÍA DOS ${sello}`);
const invoice = ({ id = randomUUID(), customerId = C1, total = 11500, doc = '01', related = null, number = null, issueDate = new Date().toISOString(), posSaleId = null, pay = null } = {}) => ({
  organizationId: ORG, invoiceId: id, customerId, number: number ?? `001-001-${Math.floor(Math.random() * 1e9)}`, issueDate, documentTypeCode: doc,
  relatedInvoiceId: related, posSaleId, paymentMethodCode: pay, currencyCode: 'USD', totalCents: total,
  customerSnapshot: { id: customerId, businessName: customerId === C1 ? 'CLIENTE UNO' : 'CLIENTE DOS', identification: null },
  lines: [{ subtotalCents: Math.round(total / 1.15), taxes: [{ kind: 'vat', amountCents: total - Math.round(total / 1.15) }] }],
});

// 0. salud y permisos
check('GET /health', (await fetch(BASE + '/health')).status === 200);
check('sin permiso → 403', (await call('GET', '/treasury/receivables', { perms: 'invoice:read' })).status === 403);
check('sin organización → 401/400', [400, 401].includes((await fetch(BASE + '/treasury/receivables')).status));

// 1. condiciones de crédito antes de la factura: 30 días
const put = await call('PUT', `/treasury/customers/${C1}/terms`, { body: { customerName: 'CLIENTE UNO', creditDays: 30, creditLimitCents: 500000 } });
check('PUT terms 200', put.status === 200, JSON.stringify(put.json));
check('PUT terms sin permiso → 403', (await call('PUT', `/treasury/customers/${C1}/terms`, { perms: 'receivable:read', body: { customerName: 'x', creditDays: 1 } })).status === 403);
const get = await call('GET', `/treasury/customers/${C1}/terms`);
check('GET terms devuelve lo guardado', get.json?.creditDays === 30 && get.json?.creditLimitCents === 500000, JSON.stringify(get.json));

// 2. factura emitida → partida con vencimiento a 30 días
const inv1 = invoice({ total: 11500 });
publish('billing.invoice.issued', inv1);
await sleep(2500);
let list = await call('GET', '/treasury/receivables?pageSize=100');
const r1 = list.json?.items?.find((x) => x.sourceId === inv1.invoiceId);
check('factura abre partida', !!r1, JSON.stringify(list.json).slice(0, 200));
if (r1) {
  const today = new Date(); const due = new Date(today.getTime() + 30 * 864e5);
  check('saldo = 11500, estado open', Number(r1.balanceCents) === 11500 && r1.status === 'open', JSON.stringify(r1));
  check('vence a los 30 días (fecha sin hora)', typeof r1.dueDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r1.dueDate), r1.dueDate + ' (hoy+30 ≈ ' + due.toISOString().slice(0, 10) + ')');
}

// 3. idempotencia: el mismo comprobante con OTRO eventId y 2 a la vez
publish('billing.invoice.issued', inv1, randomUUID());
publish('billing.invoice.issued', inv1, randomUUID());
await sleep(2500);
list = await call('GET', '/treasury/receivables?pageSize=100');
check('reenvío del mismo comprobante no duplica la partida', list.json.items.filter((x) => x.sourceId === inv1.invoiceId).length === 1);

// 4. venta de POS y forma de pago inmediata NO abren partida
const pos = invoice({ posSaleId: randomUUID() }); const cash = invoice({ pay: '01' });
publish('billing.invoice.issued', pos); publish('billing.invoice.issued', cash);
await sleep(2000);
list = await call('GET', '/treasury/receivables?pageSize=100');
check('venta de POS no abre partida', !list.json.items.some((x) => x.sourceId === pos.invoiceId));
check('cobro en efectivo no abre partida', !list.json.items.some((x) => x.sourceId === cash.invoiceId));

// 5. nota de crédito relacionada: abona parcialmente
const nc = invoice({ doc: '04', total: 2300, related: inv1.invoiceId });
publish('billing.invoice.issued', nc);
await sleep(2500);
const d1 = await call('GET', `/treasury/receivables/${r1?.id}`);
check('nota de crédito abona: saldo 9200 y estado partial', Number(d1.json?.balanceCents) === 9200 && d1.json?.status === 'partial', JSON.stringify(d1.json).slice(0, 250));
publish('billing.invoice.issued', nc, randomUUID());
await sleep(2000);
const d1b = await call('GET', `/treasury/receivables/${r1?.id}`);
check('la misma nota de crédito reenviada NO abona dos veces', Number(d1b.json?.balanceCents) === 9200, d1b.json?.balanceCents);

// 6. nota de crédito ANTES que su factura → saldo a favor que se aplica al llegar la factura
const invLate = randomUUID();
publish('billing.invoice.issued', invoice({ doc: '04', total: 1000, related: invLate, customerId: C2 }));
await sleep(2000);
publish('billing.invoice.issued', invoice({ id: invLate, total: 5750, customerId: C2 }));
await sleep(2500);
list = await call('GET', '/treasury/receivables?pageSize=100');
const late = list.json.items.find((x) => x.sourceId === invLate);
check('nota de crédito llegada antes: la factura nace con saldo 4750', Number(late?.balanceCents) === 4750, JSON.stringify(late));

// 7. anulación ANTES que la emisión → no se abre deuda
const voidFirst = invoice({ customerId: C2 });
publish('billing.invoice.voided', { organizationId: ORG, invoiceId: voidFirst.invoiceId, number: voidFirst.number, issueDate: voidFirst.issueDate });
await sleep(1500);
publish('billing.invoice.issued', voidFirst);
await sleep(2000);
list = await call('GET', '/treasury/receivables?pageSize=100&status=open,partial');
check('anulación llegada antes: no queda deuda abierta', !list.json.items.some((x) => x.sourceId === voidFirst.invoiceId));

// 8. anular una factura emitida cierra la partida
const inv3 = invoice({ customerId: C2, total: 3450 });
publish('billing.invoice.issued', inv3); await sleep(1800);
publish('billing.invoice.voided', { organizationId: ORG, invoiceId: inv3.invoiceId, number: inv3.number, issueDate: inv3.issueDate, reason: 'x' }); await sleep(2000);
list = await call('GET', '/treasury/receivables?pageSize=100');
check('anulación cierra la partida (cancelled)', list.json.items.find((x) => x.sourceId === inv3.invoiceId)?.status === 'cancelled');

// 9. concurrencia: 30 facturas distintas a la vez + 30 reenvíos
const many = Array.from({ length: 30 }, () => invoice({ customerId: C2, total: 1150 }));
many.forEach((m) => publish('billing.invoice.issued', m));
many.forEach((m) => publish('billing.invoice.issued', m, randomUUID()));
await sleep(8000);
list = await call('GET', `/treasury/receivables?customerId=${C2}&pageSize=100`);
const got = many.filter((m) => list.json.items.filter((x) => x.sourceId === m.invoiceId).length === 1).length;
check('30 facturas simultáneas (con 30 reenvíos) → 30 partidas, ninguna repetida', got === 30, `${got}/30`);

// 10. antigüedad y estado de cuenta
const aging = await call('GET', '/treasury/receivables/aging');
check('aging responde', aging.status === 200, JSON.stringify(aging.json).slice(0, 300));
const st = await call('GET', `/treasury/customers/${C1}/statement`);
check('estado de cuenta responde con saldo 9200', st.status === 200 && JSON.stringify(st.json).includes('9200'), JSON.stringify(st.json).slice(0, 300));

// 11. aislamiento entre organizaciones
const other = await call('GET', '/treasury/receivables?pageSize=100', { org: OTHER_ORG });
check('otra organización no ve la cartera', other.status === 200 && (other.json.total ?? other.json.items.length) === 0, other.json?.total);
check('otra organización no puede leer una partida ajena (404)', (await call('GET', `/treasury/receivables/${r1?.id}`, { org: OTHER_ORG })).status === 404);

// 12. saldos iniciales
const ob = { cutoffDate: corte(0), reason: 'Saldos al arranque', lines: [{ customerId: C1, customerName: 'CLIENTE UNO', documentNumber: 'ANT-1', issueDate: '2026-08-15', amountCents: 50000 }] };
const ob1 = await call('POST', '/treasury/opening-balances', { body: ob });
check('saldos iniciales 201', ob1.status === 201, JSON.stringify(ob1.json).slice(0, 200));
check('misma fecha de corte → 409', (await call('POST', '/treasury/opening-balances', { body: ob })).status === 409);
check('saldos iniciales sin permiso → 403', (await call('POST', '/treasury/opening-balances', { perms: 'receivable:read', body: { ...ob, cutoffDate: corte(1) } })).status === 403);
const ob2 = await call('POST', '/treasury/opening-balances', { body: { ...ob, cutoffDate: corte(2), lines: [{ customerId: C1, issueDate: '2026-08-15', amountCents: -5 }] } });
check('importe negativo → 422', ob2.status === 422, ob2.status);
const overdue = await call('GET', '/treasury/receivables?overdueOnly=true&pageSize=100');
check('el saldo inicial vencido aparece en «vencidas»', overdue.json?.items?.some((x) => x.documentNumber === 'ANT-1'));

// 13. un cliente que NO existe en customer-service → 422 con el índice de la línea (no se guarda nada)
const ghost = await call('POST', '/treasury/opening-balances', { body: { cutoffDate: corte(1), reason: 'Cliente inexistente', lines: [{ customerId: randomUUID(), issueDate: '2026-08-15', amountCents: 100 }] } });
check('saldo inicial a nombre de un cliente que no existe → 422 con el índice', ghost.status === 422 && ghost.json?.details?.[0]?.field === 'lines[0].customerId', JSON.stringify(ghost.json));

// 14. cuerpo que no es JSON → 400, no 500
const bad = await fetch(BASE + `/treasury/customers/${C1}/terms`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Organization-Id': ORG, 'X-User-Id': '22222222-2222-4222-8222-222222222222', 'X-Permissions': 'customer_terms:manage' }, body: '{no es json' });
check('cuerpo que no es JSON → 400', bad.status === 400, bad.status);

// 15. «vencidas» no trae deuda ya anulada o pagada
const vencidas = await call('GET', '/treasury/receivables?overdueOnly=true&asOf=2099-01-01&pageSize=100');
check('«vencidas» solo trae deuda viva (open/partial)', vencidas.json?.items?.every((x) => ['open', 'partial'].includes(x.status)), vencidas.json?.items?.map((x) => x.status).join(','));

console.log(failures ? `\n${failures} verificaciones FALLARON` : '\nTODO OK');
await ch.close(); await conn.close();
process.exit(failures ? 1 : 0);
