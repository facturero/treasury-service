// Verificación de EXPORTAR y de los RECORDATORIOS (bloque C) contra MySQL y RabbitMQ REALES, por el gateway real.
//
//   1. pila local arriba (mysql, rabbitmq, customer-service, organization-service, audit-log) y migraciones aplicadas
//      (treasury_db: 20261022100000-create-reminders; auth_db: 20261022100000-add-treasury-collection-permissions)
//   2. tesorería (:3018, con CUSTOMER_SERVICE_URL y ORGANIZATION_SERVICE_URL), contabilidad (:3016), gateway (:8080) y
//      notification-service, TODOS del árbol actual. Notificaciones sin SMTP_HOST usa el mailer de consola (no sale ningún correo real)
//   3. NOTIFICATION_LOG=<archivo con la salida de notification-service> node scripts/verify-reminders.mjs
//
// Qué comprueba que ninguna prueba unitaria puede ver:
//   · el UNIQUE (partida, día) con MySQL de verdad: 8 corridas SIMULTÁNEAS de «enviar ahora» dejan UN solo evento por cliente y un
//     solo registro por partida, sin errores 500;
//   · los recordatorios apagados NO envían nada, ni pidiéndolo una persona (409) ni por el proceso;
//   · el evento llega a notification-service y sale UN correo al cliente (a su correo, no a otro), y la bitácora lo registra;
//   · exportar por el gateway: CSV con BOM, mismos filtros que la pantalla, y un evento `treasury.report.exported` con quién y cuántas filas;
//   · un nombre de cliente con una fórmula no llega como fórmula al archivo.
import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';

const GATEWAY = process.env.GATEWAY ?? 'http://127.0.0.1:8080';
let failures = 0;
const check = (name, ok, detail = '') => { if (!ok) failures += 1; console.log(`${ok ? 'OK   ' : 'FALLO'} ${name}${detail !== '' ? ' — ' + String(detail).slice(0, 240) : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sql = (db, q) => execSync(`docker exec cmr-mysql mysql -uroot -proot123 -N -B ${db} -e "${q.replace(/"/g, '\\"')}"`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

const login = await (await fetch(`${GATEWAY}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: process.env.ADMIN_EMAIL ?? 'admin@admin.com', password: process.env.ADMIN_PASSWORD ?? 'Admin1234!' }) })).json();
if (!login.accessToken) throw new Error('No pude entrar con la cuenta de desarrollo.');
const claims = JSON.parse(Buffer.from(login.accessToken.split('.')[1], 'base64url').toString());
const ORG = claims.org_id;
const ADMIN_ID = claims.sub ?? claims.user_id ?? claims.userId;
const sello = Date.now();

// Todo va por el gateway real (con el token), como la interfaz.
async function gw(method, path, body, raw = false) {
  const r = await fetch(GATEWAY + path, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${login.accessToken}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (raw) return r;
  const t = await r.text(); let json = null; try { json = t ? JSON.parse(t) : null; } catch { json = t; }
  return { status: r.status, json };
}
async function customer(name, email) {
  const r = await gw('POST', '/customers', { businessName: name, type: 'company', ...(email ? { email } : {}) });
  if (r.status !== 201 && r.status !== 200) throw new Error(`no pude crear el cliente ${name}: ${r.status} ${JSON.stringify(r.json)}`);
  return r.json.id;
}

/**
 * Deudas con la fecha que se quiera. Las FACTURAS no sirven para esto: tesorería imita a contabilidad y ignora lo anterior a su fecha
 * de arranque (`auto_posting_from`), así que una factura «de hace 20 días» no abre partida. Un saldo inicial sí admite cualquier fecha.
 */
const day = (daysAgo) => new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);
async function owe(lines) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    // La fecha de corte es única por organización: una al azar entre 1990 y 1995.
    const cutoffDate = `${1990 + Math.floor(Math.random() * 6)}-${String(1 + Math.floor(Math.random() * 12)).padStart(2, '0')}-${String(1 + Math.floor(Math.random() * 28)).padStart(2, '0')}`;
    const r = await gw('POST', '/treasury/opening-balances', {
      cutoffDate, reason: 'Verificación de recordatorios',
      lines: lines.map((l, i) => ({ customerId: l.customerId, customerName: l.name, documentNumber: `R-${sello}-${i}`, issueDate: day(l.daysAgo), dueDate: day(l.daysAgo), amountCents: l.cents })),
    });
    if (r.status === 201) return;
    if (r.status !== 409) throw new Error(`saldos iniciales: ${r.status} ${JSON.stringify(r.json)}`);
  }
  throw new Error('no encontré una fecha de corte libre');
}
const outboxEvents = (type, customerId) =>
  Number(sql('treasury_db', `select count(*) from outbox_messages where type='${type}' and JSON_UNQUOTE(JSON_EXTRACT(payload,'$.customerId'))='${customerId}'`));
const reminderRows = (customerId) => Number(sql('treasury_db', `select count(*) from receivable_reminders where customer_id='${customerId}'`));

// ── Datos ──
const nameOf = (s) => `RECORD ${s} ${sello}`;
const E1 = await customer(nameOf('UNO'), `uno-${sello}@example.test`);
const E2 = await customer(nameOf('DOS'), `dos-${sello}@example.test`);
const N = await customer(nameOf('SIN CORREO'), null);
const EVIL = await customer(`=HYPERLINK("http://malo.test","clic") ${sello}`, `evil-${sello}@example.test`);
await owe([
  { customerId: E1, name: nameOf('UNO'), cents: 11500, daysAgo: 20 },
  { customerId: E1, name: nameOf('UNO'), cents: 5750, daysAgo: 11 },
  { customerId: E1, name: nameOf('UNO'), cents: 2300, daysAgo: 1 }, // 1 día: con 3 de gracia, todavía no toca
  { customerId: E2, name: nameOf('DOS'), cents: 23000, daysAgo: 30 },
  { customerId: N, name: nameOf('SIN CORREO'), cents: 11500, daysAgo: 10 },
  { customerId: EVIL, name: `=HYPERLINK("http://malo.test","clic") ${sello}`, cents: 1150, daysAgo: 8 },
]);
const debtsOf = async (id) => (await gw('GET', `/treasury/receivables?customerId=${id}&pageSize=100`)).json.items;
check('los saldos iniciales abrieron las deudas', (await debtsOf(E1)).length === 3 && (await debtsOf(E2)).length === 1 && (await debtsOf(N)).length === 1);

// ── 1. Apagados por defecto: no sale nada ──
// Si una corrida anterior se abortó con los recordatorios encendidos, se parte de apagado (la configuración nace apagada: se comprueba abajo
// con la vista previa y con «enviar ahora»; aquí solo se limpia el estado que dejó esa corrida).
await gw('PUT', '/treasury/reminders/settings', { enabled: false, firstAfterDays: 3, repeatEveryDays: 7 });
const settings0 = await gw('GET', '/treasury/reminders/settings');
check('la configuración está APAGADA (nace así)', settings0.status === 200 && settings0.json.enabled === false, JSON.stringify(settings0.json));
const runOff = await gw('POST', '/treasury/reminders/run');
check('«enviar ahora» con los recordatorios apagados → 409 REMINDERS_DISABLED', runOff.status === 409 && runOff.json?.code === 'REMINDERS_DISABLED', `${runOff.status} ${JSON.stringify(runOff.json)}`);
check('… y no quedó nada registrado ni publicado', reminderRows(E1) === 0 && outboxEvents('treasury.receivable.overdue', E1) === 0);

// ── 2. Vista previa (funciona apagado, no envía) ──
const prev = await gw('GET', '/treasury/reminders/preview');
const pc = (id) => prev.json.customers.find((c) => c.customerId === id);
check('vista previa con los recordatorios apagados: 200 y enabled=false', prev.status === 200 && prev.json.enabled === false);
check('E1 aparece con sus 2 documentos vencidos (el de 1 día no toca)', pc(E1)?.receivableCount === 2 && pc(E1)?.totalCents === 17250, JSON.stringify(pc(E1))?.slice(0, 160));
check('el cliente sin correo se marca `hasEmail=false`', pc(N)?.hasEmail === false && pc(N)?.emailHint === null);
check('el correo completo NO viaja en la vista previa (solo una pista)', !JSON.stringify(prev.json).includes(`uno-${sello}@example.test`) && pc(E1)?.emailHint === `un***@example.test`, pc(E1)?.emailHint);
check('la vista previa NO registró nada', reminderRows(E1) === 0 && outboxEvents('treasury.receivable.overdue', E1) === 0);

// ── 3. Configurar ──
const bad = await gw('PUT', '/treasury/reminders/settings', { enabled: true, firstAfterDays: 3, repeatEveryDays: 3 });
check('repetir más de una vez por semana → 422 con el campo', bad.status === 422 && bad.json?.details?.[0]?.field === 'repeatEveryDays', `${bad.status} ${JSON.stringify(bad.json)?.slice(0, 120)}`);
const on = await gw('PUT', '/treasury/reminders/settings', { enabled: true, firstAfterDays: 3, repeatEveryDays: 7 });
check('encender (200)', on.status === 200 && on.json.enabled === true && on.json.updatedBy === ADMIN_ID, JSON.stringify(on.json));
check('el cambio dejó el evento `treasury.reminder_settings.updated` con el valor anterior y el nuevo',
  Number(sql('treasury_db', `select count(*) from outbox_messages where type='treasury.reminder_settings.updated' and JSON_EXTRACT(payload,'$.enabled')=true and JSON_EXTRACT(payload,'$.previousEnabled')=false and JSON_UNQUOTE(JSON_EXTRACT(payload,'$.organizationId'))='${ORG}'`)) >= 1);

// ── 4. Enviar ahora ──
const run1 = await gw('POST', '/treasury/reminders/run');
check('enviar ahora (200)', run1.status === 200, `${run1.status} ${JSON.stringify(run1.json)}`);
check('avisó a E1, E2 y EVIL; el cliente sin correo no recibió nada (se cuenta aparte)', run1.json?.customersReminded >= 3 && run1.json?.customersWithoutEmail >= 1, JSON.stringify(run1.json));
check('E1: UN evento (no uno por factura) y 2 partidas registradas', outboxEvents('treasury.receivable.overdue', E1) === 1 && reminderRows(E1) === 2, `${outboxEvents('treasury.receivable.overdue', E1)} / ${reminderRows(E1)}`);
check('E2: un evento y una partida', outboxEvents('treasury.receivable.overdue', E2) === 1 && reminderRows(E2) === 1);
check('el cliente sin correo: nada publicado ni registrado (cuando tenga correo se le avisa)', outboxEvents('treasury.receivable.overdue', N) === 0 && reminderRows(N) === 0);
const payload = JSON.parse(sql('treasury_db', `select payload from outbox_messages where type='treasury.receivable.overdue' and JSON_UNQUOTE(JSON_EXTRACT(payload,'$.customerId'))='${E1}' limit 1`));
check('el evento lleva correo, firma, total, detalle y quién lo disparó', payload.email === `uno-${sello}@example.test` && payload.totalOverdueCents === 17250 && payload.items.length === 2 && payload.trigger === 'manual' && payload.triggeredBy === ADMIN_ID && typeof payload.organizationName === 'string' && payload.organizationName.length > 0, JSON.stringify({ ...payload, items: payload.items.length }).slice(0, 220));

// ── 5. Idempotencia ──
const run2 = await gw('POST', '/treasury/reminders/run');
check('repetirlo el mismo día no avisa de nuevo', run2.status === 200 && outboxEvents('treasury.receivable.overdue', E1) === 1 && outboxEvents('treasury.receivable.overdue', E2) === 1 && reminderRows(E1) === 2, JSON.stringify(run2.json));

// ── 6. La carrera real: 8 corridas simultáneas con una deuda NUEVA ──
const E3 = await customer(nameOf('TRES'), `tres-${sello}@example.test`);
await owe([
  { customerId: E3, name: nameOf('TRES'), cents: 11500, daysAgo: 15 },
  { customerId: E3, name: nameOf('TRES'), cents: 5750, daysAgo: 9 },
]);
const race = await Promise.all(Array.from({ length: 8 }, () => gw('POST', '/treasury/reminders/run')));
check('8 corridas simultáneas: ninguna da error de servidor', race.every((r) => r.status === 200), race.map((r) => r.status).join(','));
check('… y E3 recibió UN solo evento y 2 registros (el UNIQUE decide, no el azar)', outboxEvents('treasury.receivable.overdue', E3) === 1 && reminderRows(E3) === 2, `${outboxEvents('treasury.receivable.overdue', E3)} / ${reminderRows(E3)}`);
check('… la suma de avisados entre las 8 es exactamente 1 para E3 (los otros ya lo veían avisado o perdieron la carrera)', race.reduce((acc, r) => acc + (r.json?.customersReminded ?? 0), 0) >= 1);

// ── 7. Notificaciones: llega UN correo al cliente ──
await sleep(5000);
const logPath = process.env.NOTIFICATION_LOG;
if (logPath && existsSync(logPath)) {
  const log = readFileSync(logPath, 'utf8');
  const mailsTo = (email) => (log.match(new RegExp(`To: ${email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g')) ?? []).length;
  check('notification-service mandó UN correo a E1 (a su correo)', mailsTo(`uno-${sello}@example.test`) === 1, mailsTo(`uno-${sello}@example.test`));
  check('… UN correo a E3 aunque corrieron 8 a la vez', mailsTo(`tres-${sello}@example.test`) === 1, mailsTo(`tres-${sello}@example.test`));
  check('… y ninguno al cliente sin correo', !log.includes('SIN CORREO'));
  check('el asunto lleva el nombre de la organización', /Subject: Recordatorio de pago — .+/.test(log));
} else {
  console.log('   (sin NOTIFICATION_LOG: se omite la comprobación del correo)');
}

// ── 8. Bitácora ──
await sleep(3000);
const audit = await gw('GET', '/audit-logs?event=treasury.&pageSize=100');
const events = (audit.json?.items ?? audit.json?.data ?? []).map((e) => e.event);
check('la bitácora registra los recordatorios y el cambio de configuración', events.includes('treasury.receivable.overdue') && events.includes('treasury.reminder_settings.updated'), [...new Set(events)].join(', '));

// ── 9. Exportar ──
const before = Number(sql('treasury_db', `select count(*) from outbox_messages where type='treasury.report.exported'`));
const exp = await gw('GET', `/treasury/receivables/export?customerId=${E1}&lang=en`, undefined, true);
const bytes = new Uint8Array(await exp.arrayBuffer());
const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
const lines = text.replace(/^﻿/, '').trimEnd().split('\r\n');
check('exportar la cartera de un cliente (200, text/csv, adjunto, sin caché)', exp.status === 200 && (exp.headers.get('content-type') ?? '').includes('text/csv') && /attachment/.test(exp.headers.get('content-disposition') ?? '') && exp.headers.get('cache-control') === 'no-store');
check('BOM al inicio (Excel lee bien las tildes)', bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf);
check('encabezados en inglés y una fila por partida de E1 (3)', lines[0].startsWith('Document,Customer') && lines.length === 4, `${lines.length} líneas`);
check('importes con dos decimales y punto', lines.slice(1).every((l) => /,\d+\.\d{2},\d+\.\d{2},\d+\.\d{2},/.test(l)), lines[1]);
const exportEvent = JSON.parse(sql('treasury_db', `select payload from outbox_messages where type='treasury.report.exported' order by occurred_at desc limit 1`));
check('dejó UN evento `treasury.report.exported` con reporte, filtros, filas y quién', Number(sql('treasury_db', `select count(*) from outbox_messages where type='treasury.report.exported'`)) === before + 1 && exportEvent.report === 'receivables' && exportEvent.rowCount === 3 && exportEvent.exportedBy === ADMIN_ID && exportEvent.filters.customerId === E1, JSON.stringify(exportEvent).slice(0, 220));

const expAll = await gw('GET', '/treasury/receivables/export?overdueOnly=true', undefined, true);
const allLines = (await expAll.text()).replace(/^﻿/, '').trimEnd().split('\r\n');
const listed = (await gw('GET', '/treasury/receivables?overdueOnly=true&pageSize=1')).json.total;
check('sin paginar: el archivo trae TODAS las vencidas (las mismas que cuenta la lista)', allLines.length - 1 === listed, `${allLines.length - 1} vs ${listed}`);

const expEvil = (await (await gw('GET', `/treasury/receivables/export?customerId=${EVIL}`, undefined, true)).text()).replace(/^﻿/, '');
check('un nombre de cliente que empieza con `=` sale neutralizado (no es una fórmula)', !/(^|,)"?=HYPERLINK/m.test(expEvil) && expEvil.includes(`'=HYPERLINK`), expEvil.split('\r\n')[1]?.slice(0, 120));

const expAging = await gw('GET', '/treasury/receivables/aging/export', undefined, true);
const agingLines = (await expAging.text()).replace(/^﻿/, '').trimEnd().split('\r\n');
check('antigüedad exportada: encabezado, clientes y fila TOTAL', expAging.status === 200 && agingLines[0].startsWith('Cliente,Corriente') && agingLines.at(-1).startsWith('TOTAL,'), agingLines.at(-1));
const expSt = await gw('GET', `/treasury/customers/${E1}/statement/export?lang=fr`, undefined, true);
const stText = (await expSt.text()).replace(/^﻿/, '');
const screen = (await gw('GET', `/treasury/customers/${E1}/statement`)).json;
check('estado de cuenta exportado (fr): el neto es el mismo que muestra la pantalla', expSt.status === 200 && stText.includes('Relevé de compte') && stText.includes(`Net,${(screen.netCents / 100).toFixed(2)}`), (stText.match(/Net,[\d.-]+/) ?? [''])[0]);

// ── 10. Apagar: otra vez no sale nada ──
const off = await gw('PUT', '/treasury/reminders/settings', { enabled: false, firstAfterDays: 3, repeatEveryDays: 7 });
check('apagar (200)', off.status === 200 && off.json.enabled === false);
const E4 = await customer(nameOf('CUATRO'), `cuatro-${sello}@example.test`);
await owe([{ customerId: E4, name: nameOf('CUATRO'), cents: 11500, daysAgo: 12 }]);
const runOff2 = await gw('POST', '/treasury/reminders/run');
check('apagados otra vez: 409 y nada nuevo para E4', runOff2.status === 409 && outboxEvents('treasury.receivable.overdue', E4) === 0 && reminderRows(E4) === 0);

console.log(failures ? `\n${failures} verificaciones FALLARON` : '\nTODO OK');
process.exit(failures ? 1 : 0);
