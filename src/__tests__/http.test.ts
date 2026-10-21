import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ALL_PERMISSIONS, buildWorld, CUSTOMER_1, CUSTOMER_2, headers, ORG_A, ORG_B, USER_1, type World } from './helpers.js';

async function call(w: World, method: string, path: string, opts: { perms?: string[] | string; org?: string | null; user?: string | null; body?: unknown; raw?: string } = {}) {
  const res = await w.app.request(path, {
    method,
    headers: headers(opts.perms ?? ALL_PERMISSIONS, opts.org === undefined ? ORG_A : opts.org, opts.user === undefined ? USER_1 : opts.user),
    body: opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, json };
}

const openingBody = (overrides: Record<string, unknown> = {}) => ({
  cutoffDate: '2026-09-30',
  reason: 'Saldos al arranque',
  lines: [{ customerId: CUSTOMER_1, documentNumber: 'ANT-1', issueDate: '2026-08-15', amountCents: 50000 }],
  ...overrides,
});

/** Cada ruta con el permiso que la protege: sin él, 403; con él, no. */
const ROUTES: { method: string; path: string; permission: string; body?: () => unknown }[] = [
  { method: 'GET', path: '/treasury/receivables', permission: 'receivable:read' },
  { method: 'GET', path: '/treasury/receivables/aging', permission: 'receivable:read' },
  { method: 'GET', path: `/treasury/receivables/${randomUUID()}`, permission: 'receivable:read' },
  { method: 'GET', path: `/treasury/customers/${CUSTOMER_1}/statement`, permission: 'receivable:read' },
  { method: 'GET', path: `/treasury/customers/${CUSTOMER_1}/terms`, permission: 'receivable:read' },
  { method: 'PUT', path: `/treasury/customers/${CUSTOMER_1}/terms`, permission: 'customer_terms:manage', body: () => ({ creditDays: 10, creditLimitCents: null }) },
  { method: 'POST', path: '/treasury/opening-balances', permission: 'opening_balance:load', body: () => openingBody() },
];

describe('permisos por ruta', () => {
  it.each(ROUTES)('$method $path exige $permission', async (route) => {
    const w = buildWorld();
    const others = ALL_PERMISSIONS.filter((p) => p !== route.permission);
    expect((await call(w, route.method, route.path, { perms: others, body: route.body?.() })).status).toBe(403);
    expect((await call(w, route.method, route.path, { perms: [], body: route.body?.() })).status).toBe(403);
    expect((await call(w, route.method, route.path, { perms: [route.permission], body: route.body?.() })).status).not.toBe(403);
  });

  it('un cliente que manda `X-Permissions: *` NO obtiene permisos (el servicio solo respeta lo que el gateway inyecta, y esto no es un permiso)', async () => {
    const w = buildWorld();
    for (const route of ROUTES) {
      expect((await call(w, route.method, route.path, { perms: '*', body: route.body?.() })).status, `${route.method} ${route.path}`).toBe(403);
    }
  });

  it('una lectura no da permiso para escribir (ver cartera ≠ cambiar condiciones ≠ cargar saldos)', async () => {
    const w = buildWorld();
    expect((await call(w, 'PUT', `/treasury/customers/${CUSTOMER_1}/terms`, { perms: ['receivable:read'], body: { creditDays: 5, creditLimitCents: null } })).status).toBe(403);
    expect((await call(w, 'POST', '/treasury/opening-balances', { perms: ['receivable:read', 'customer_terms:manage'], body: openingBody() })).status).toBe(403);
    expect(w.data.events).toHaveLength(0);
  });

  it('sin organización → 401, y sin usuario en lo que escribe → 401', async () => {
    const w = buildWorld();
    expect((await call(w, 'GET', '/treasury/receivables', { org: null })).status).toBe(401);
    expect((await call(w, 'PUT', `/treasury/customers/${CUSTOMER_1}/terms`, { user: null, body: { creditDays: 5, creditLimitCents: null } })).status).toBe(401);
    expect((await call(w, 'POST', '/treasury/opening-balances', { user: null, body: openingBody() })).status).toBe(401);
  });

  it('una ruta que no existe es 404 y /health no pide nada', async () => {
    const w = buildWorld();
    expect((await call(w, 'GET', '/treasury/otra-cosa')).status).toBe(404);
    expect((await w.app.request('/health')).status).toBe(200);
  });
});

describe('condiciones de crédito por HTTP (cada campo viaja y vuelve)', () => {
  it('PUT guarda días, cupo y nombre; GET los devuelve; el actor queda como updatedBy', async () => {
    const w = buildWorld();
    const put = await call(w, 'PUT', `/treasury/customers/${CUSTOMER_1}/terms`, { body: { creditDays: 30, creditLimitCents: 500000, customerName: 'CLIENTE UNO' } });
    expect(put.status).toBe(200);
    expect(put.json).toMatchObject({ customerId: CUSTOMER_1, customerName: 'CLIENTE UNO', creditDays: 30, creditLimitCents: 500000, updatedBy: USER_1 });

    const get = await call(w, 'GET', `/treasury/customers/${CUSTOMER_1}/terms`);
    expect(get.json).toMatchObject({ creditDays: 30, creditLimitCents: 500000, customerName: 'CLIENTE UNO' });
  });

  it('un cliente sin condiciones devuelve null (la pantalla lo muestra como 0 días y sin cupo)', async () => {
    const w = buildWorld();
    const get = await call(w, 'GET', `/treasury/customers/${CUSTOMER_2}/terms`);
    expect(get.status).toBe(200);
    expect(get.json).toBeNull();
  });

  it('los días de crédito guardados llegan a la partida que abre la siguiente factura', async () => {
    const w = buildWorld();
    await call(w, 'PUT', `/treasury/customers/${CUSTOMER_1}/terms`, { body: { creditDays: 30, creditLimitCents: null } });
    await w.useCases.invoiceIssued.execute(w.invoice());
    const list = await call(w, 'GET', '/treasury/receivables');
    expect(list.json.items[0]).toMatchObject({ issueDate: '2026-10-21', dueDate: '2026-11-20' });
  });

  it.each([
    ['días negativos', { creditDays: -1, creditLimitCents: null }, 'creditDays'],
    ['días > 365', { creditDays: 400, creditLimitCents: null }, 'creditDays'],
    ['días con decimales', { creditDays: 1.5, creditLimitCents: null }, 'creditDays'],
    ['días como texto', { creditDays: '30', creditLimitCents: null }, 'creditDays'],
    ['cupo negativo', { creditDays: 10, creditLimitCents: -5 }, 'creditLimitCents'],
    ['cupo con decimales', { creditDays: 10, creditLimitCents: 10.5 }, 'creditLimitCents'],
    ['sin días', { creditLimitCents: null }, 'creditDays'],
    ['un campo que no existe', { creditDays: 10, creditLimitCents: null, descuento: 5 }, ''],
  ])('%s → 422', async (_name, body, field) => {
    const w = buildWorld();
    const res = await call(w, 'PUT', `/treasury/customers/${CUSTOMER_1}/terms`, { body });
    expect(res.status).toBe(422);
    expect(res.json.code).toBe('VALIDATION_ERROR');
    if (field) expect(res.json.details.map((d: { field: string }) => d.field)).toContain(field);
    expect(w.data.events).toHaveLength(0);
  });

  it('un cuerpo que no es JSON es 400 (INVALID_JSON), no un 500', async () => {
    const w = buildWorld();
    const res = await call(w, 'PUT', `/treasury/customers/${CUSTOMER_1}/terms`, { raw: '{no es json' });
    expect(res.status).toBe(400);
    expect(res.json.code).toBe('INVALID_JSON');
  });
});

describe('saldos iniciales por HTTP', () => {
  it('201 con la carga, y las partidas aparecen en la cartera con cada campo que se envió', async () => {
    const w = buildWorld();
    const res = await call(w, 'POST', '/treasury/opening-balances', { body: openingBody({ lines: [{ customerId: CUSTOMER_1, documentNumber: 'ANT-1', issueDate: '2026-08-15', dueDate: '2026-09-14', amountCents: 50000 }] }) });
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({ cutoffDate: '2026-09-30', totalCents: 50000, loadedBy: USER_1, reason: 'Saldos al arranque' });

    const list = await call(w, 'GET', '/treasury/receivables');
    expect(list.json.items).toHaveLength(1);
    expect(list.json.items[0]).toMatchObject({ sourceType: 'initial_balance', documentNumber: 'ANT-1', issueDate: '2026-08-15', dueDate: '2026-09-14', originalCents: 50000, balanceCents: 50000, status: 'open', customerName: 'CLIENTE UNO S.A.' });
  });

  it('la misma fecha de corte otra vez → 409', async () => {
    const w = buildWorld();
    await call(w, 'POST', '/treasury/opening-balances', { body: openingBody() });
    const again = await call(w, 'POST', '/treasury/opening-balances', { body: openingBody() });
    expect(again.status).toBe(409);
    expect(again.json.code).toBe('OPENING_BALANCE_ALREADY_LOADED');
  });

  it('un cliente que no existe → 422 con el índice; el servicio de clientes caído → 502', async () => {
    const w = buildWorld();
    const unknown = await call(w, 'POST', '/treasury/opening-balances', { body: openingBody({ lines: [{ customerId: randomUUID(), issueDate: '2026-08-15', amountCents: 100 }] }) });
    expect(unknown.status).toBe(422);
    expect(unknown.json.details[0].field).toBe('lines[0].customerId');

    const down = await call(buildWorld({ customersDown: true }), 'POST', '/treasury/opening-balances', { body: openingBody() });
    expect(down.status).toBe(502);
    expect(down.json.code).toBe('CATALOG_UNAVAILABLE');
  });

  it.each([
    ['importe negativo', { lines: [{ customerId: CUSTOMER_1, issueDate: '2026-08-15', amountCents: -5 }] }, 'lines.0.amountCents'],
    ['importe cero', { lines: [{ customerId: CUSTOMER_1, issueDate: '2026-08-15', amountCents: 0 }] }, 'lines.0.amountCents'],
    ['importe con decimales', { lines: [{ customerId: CUSTOMER_1, issueDate: '2026-08-15', amountCents: 10.5 }] }, 'lines.0.amountCents'],
    ['cliente que no es un UUID', { lines: [{ customerId: 'abc', issueDate: '2026-08-15', amountCents: 100 }] }, 'lines.0.customerId'],
    ['fecha con otro formato', { lines: [{ customerId: CUSTOMER_1, issueDate: '15/08/2026', amountCents: 100 }] }, 'lines.0.issueDate'],
    ['fecha de corte con otro formato', { cutoffDate: '30-09-2026' }, 'cutoffDate'],
    ['motivo muy corto', { reason: 'x' }, 'reason'],
    ['sin líneas', { lines: [] }, 'lines'],
    ['más de 500 líneas', { lines: Array.from({ length: 501 }, () => ({ customerId: CUSTOMER_1, issueDate: '2026-08-15', amountCents: 1 })) }, 'lines'],
    ['un campo que no existe en la línea', { lines: [{ customerId: CUSTOMER_1, issueDate: '2026-08-15', amountCents: 100, moneda: 'EUR' }] }, ''],
  ])('%s → 422 con el campo', async (_name, overrides, field) => {
    const w = buildWorld();
    const res = await call(w, 'POST', '/treasury/opening-balances', { body: openingBody(overrides) });
    expect(res.status).toBe(422);
    if (field) expect(res.json.details.map((d: { field: string }) => d.field)).toContain(field);
    expect(w.receivables()).toHaveLength(0);
  });

  it('una línea con vencimiento anterior a la emisión → 422 con el índice de la línea', async () => {
    const w = buildWorld();
    const res = await call(w, 'POST', '/treasury/opening-balances', { body: openingBody({ lines: [{ customerId: CUSTOMER_1, issueDate: '2026-08-15', dueDate: '2026-08-01', amountCents: 100 }] }) });
    expect(res.status).toBe(422);
    expect(res.json.details[0].field).toBe('lines[0].dueDate');
  });
});

describe('lectura de cartera por HTTP', () => {
  async function sembrar(w: World) {
    const inv = w.invoice({ total: 11500 });
    await w.useCases.invoiceIssued.execute(inv);
    await w.useCases.invoiceIssued.execute(w.invoice({ documentTypeCode: '04', total: 2300, relatedInvoiceId: inv.invoiceId }));
    return inv;
  }

  it('el listado trae el saldo derivado (no una columna) y la fecha de corte del servidor', async () => {
    const w = buildWorld();
    await sembrar(w);
    const res = await call(w, 'GET', '/treasury/receivables');
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ total: 1, page: 1, pageSize: 25, asOf: '2026-10-21' });
    expect(res.json.items[0]).toMatchObject({ originalCents: 11500, appliedCents: 2300, balanceCents: 9200, status: 'partial' });
  });

  it('el detalle trae su historial de aplicaciones', async () => {
    const w = buildWorld();
    await sembrar(w);
    const id = w.receivables()[0]!.id;
    const res = await call(w, 'GET', `/treasury/receivables/${id}`);
    expect(res.status).toBe(200);
    expect(res.json.applications).toHaveLength(1);
    expect(res.json.applications[0]).toMatchObject({ sourceType: 'credit_note', appliedCents: 2300 });
  });

  it('el estado de cuenta y la antigüedad responden con los totales del servidor', async () => {
    const w = buildWorld();
    await sembrar(w);
    const statement = await call(w, 'GET', `/treasury/customers/${CUSTOMER_1}/statement`);
    expect(statement.json).toMatchObject({ receivableCents: 9200, advanceCents: 0, netCents: 9200, asOf: '2026-10-21' });
    const aging = await call(w, 'GET', '/treasury/receivables/aging');
    expect(aging.json.totals).toMatchObject({ currentCents: 9200, totalCents: 9200 });
    expect((await call(w, 'GET', '/treasury/receivables/aging?asOf=2027-01-31')).json.totals).toMatchObject({ daysOver90Cents: 9200, totalCents: 9200 }); // 102 días de atraso
  });

  it('el filtro `status` admite varios separados por coma y rechaza uno que no existe', async () => {
    const w = buildWorld();
    await sembrar(w);
    expect((await call(w, 'GET', '/treasury/receivables?status=open,partial')).json.total).toBe(1);
    expect((await call(w, 'GET', '/treasury/receivables?status=paid')).json.total).toBe(0);
    expect((await call(w, 'GET', '/treasury/receivables?status=inventado')).status).toBe(422);
  });

  it.each([
    ['pageSize pasado de 100', '?pageSize=200'],
    ['página 0', '?page=0'],
    ['fecha con otro formato', '?asOf=21/10/2026'],
    ['customerId que no es UUID', '?customerId=abc'],
    ['overdueOnly inválido', '?overdueOnly=quizas'],
  ])('%s → 422', async (_name, query) => {
    const w = buildWorld();
    expect((await call(w, 'GET', `/treasury/receivables${query}`)).status).toBe(422);
  });

  it('«vencidas» (`overdueOnly`) trae solo deuda viva con vencimiento anterior a la fecha de corte', async () => {
    const w = buildWorld();
    await sembrar(w); // vence el 2026-10-21 (contado)
    expect((await call(w, 'GET', '/treasury/receivables?overdueOnly=true')).json.total).toBe(0);
    expect((await call(w, 'GET', '/treasury/receivables?overdueOnly=true&asOf=2026-10-22')).json.total).toBe(1);
  });
});

describe('aislamiento entre organizaciones por HTTP', () => {
  it('B no ve la cartera de A: listado vacío, partida 404, estado de cuenta y antigüedad en cero', async () => {
    const w = buildWorld();
    await w.useCases.invoiceIssued.execute(w.invoice());
    const id = w.receivables()[0]!.id;

    expect((await call(w, 'GET', '/treasury/receivables', { org: ORG_B })).json.total).toBe(0);
    expect((await call(w, 'GET', `/treasury/receivables/${id}`, { org: ORG_B })).status).toBe(404);
    expect((await call(w, 'GET', `/treasury/customers/${CUSTOMER_1}/statement`, { org: ORG_B })).json.receivableCents).toBe(0);
    expect((await call(w, 'GET', '/treasury/receivables/aging', { org: ORG_B })).json.totals.totalCents).toBe(0);
  });

  it('las condiciones de crédito y los saldos iniciales de A no cruzan a B', async () => {
    const w = buildWorld();
    await call(w, 'PUT', `/treasury/customers/${CUSTOMER_1}/terms`, { body: { creditDays: 30, creditLimitCents: null } });
    await call(w, 'POST', '/treasury/opening-balances', { body: openingBody() });
    expect((await call(w, 'GET', `/treasury/customers/${CUSTOMER_1}/terms`, { org: ORG_B })).json).toBeNull();
    expect((await call(w, 'GET', '/treasury/receivables', { org: ORG_B })).json.total).toBe(0);
    // y B puede cargar la MISMA fecha de corte
    expect((await call(w, 'POST', '/treasury/opening-balances', { org: ORG_B, body: openingBody() })).status).toBe(201);
  });
});
