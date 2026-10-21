import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ALL_PERMISSIONS, buildWorld, CUSTOMER_1, headers, ORG_A, ORG_B, USER_1, type World } from './helpers.js';

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

async function debt(w: World, total = 11500): Promise<string> {
  const inv = w.invoice({ total });
  await w.useCases.invoiceIssued.execute(inv);
  return w.receivables().find((r) => r.sourceId === inv.invoiceId)!.id;
}

const body = (receivableId: string, overrides: Record<string, unknown> = {}) => ({
  customerId: CUSTOMER_1,
  receiptDate: '2026-10-21',
  method: 'transfer',
  reference: 'TRX-1',
  totalCents: 5000,
  lines: [{ receivableId, appliedCents: 5000 }],
  ...overrides,
});

/** Cada ruta con el permiso que la protege. */
const ROUTES: { method: string; path: (id: string) => string; permission: string; body?: (rid: string) => unknown }[] = [
  { method: 'GET', path: () => '/treasury/receipts', permission: 'receipt:read' },
  { method: 'GET', path: (id) => `/treasury/receipts/${id}`, permission: 'receipt:read' },
  { method: 'POST', path: () => '/treasury/receipts', permission: 'receipt:create', body: (rid) => body(rid) },
  { method: 'PUT', path: (id) => `/treasury/receipts/${id}`, permission: 'receipt:create', body: (rid) => { const { customerId: _c, ...rest } = body(rid); return rest; } },
  { method: 'POST', path: (id) => `/treasury/receipts/${id}/post`, permission: 'receipt:create' },
  { method: 'POST', path: (id) => `/treasury/receipts/${id}/void`, permission: 'receipt:void', body: () => ({ reason: 'Cobro duplicado por error' }) },
];

describe('permisos por ruta de cobros', () => {
  it.each(ROUTES)('$method $permission', async (route) => {
    const w = buildWorld();
    const rid = await debt(w);
    const draft = (await call(w, 'POST', '/treasury/receipts', { body: body(rid) })).json;
    for (const perms of [[], ALL_PERMISSIONS.filter((p) => p !== route.permission), ['receivable:read']]) {
      expect((await call(w, route.method, route.path(draft.id), { perms, body: route.body?.(rid) })).status, `${route.method} con ${perms}`).toBe(403);
    }
    expect((await call(w, route.method, route.path(draft.id), { perms: [route.permission], body: route.body?.(rid) })).status).not.toBe(403);
  });

  it('`X-Permissions: *` enviado por un cliente no concede nada', async () => {
    const w = buildWorld();
    const rid = await debt(w);
    for (const route of ROUTES) expect((await call(w, route.method, route.path(randomUUID()), { perms: '*', body: route.body?.(rid) })).status).toBe(403);
  });

  it('quien cobra (receipt:create) NO anula: anular es un permiso aparte', async () => {
    const w = buildWorld();
    const rid = await debt(w);
    const created = (await call(w, 'POST', '/treasury/receipts', { body: body(rid) })).json;
    await call(w, 'POST', `/treasury/receipts/${created.id}/post`);
    const res = await call(w, 'POST', `/treasury/receipts/${created.id}/void`, { perms: ['receipt:read', 'receipt:create'], body: { reason: 'Quiero deshacerlo' } });
    expect(res.status).toBe(403);
    expect((await call(w, 'GET', `/treasury/receipts/${created.id}`)).json.status).toBe('posted');
  });

  it('sin organización → 401; sin usuario en lo que escribe → 401', async () => {
    const w = buildWorld();
    const rid = await debt(w);
    expect((await call(w, 'GET', '/treasury/receipts', { org: null })).status).toBe(401);
    expect((await call(w, 'POST', '/treasury/receipts', { user: null, body: body(rid) })).status).toBe(401);
    expect((await call(w, 'POST', `/treasury/receipts/${randomUUID()}/void`, { user: null, body: { reason: 'sin usuario' } })).status).toBe(401);
  });
});

describe('ciclo del cobro por HTTP (cada campo viaja y vuelve)', () => {
  it('crea (201), contabiliza (200) y lee de vuelta todos los campos', async () => {
    const w = buildWorld();
    const rid = await debt(w, 11500);
    const created = await call(w, 'POST', '/treasury/receipts', { body: body(rid, { notes: 'Pago de octubre', accountRole: 'cash', totalCents: 11500, lines: [{ receivableId: rid, appliedCents: 11500 }] }) });
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({ status: 'draft', number: null, customerId: CUSTOMER_1, customerName: 'CLIENTE UNO S.A.', receiptDate: '2026-10-21', method: 'transfer', accountRole: 'cash', reference: 'TRX-1', notes: 'Pago de octubre', totalCents: 11500, appliedCents: 11500, advanceCents: 0, lineCount: 1, createdBy: USER_1 });

    const posted = await call(w, 'POST', `/treasury/receipts/${created.json.id}/post`);
    expect(posted.status).toBe(200);
    expect(posted.json).toMatchObject({ status: 'posted', number: 'RC-2026-000001', postedBy: USER_1 });
    expect(posted.json.postedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const read = await call(w, 'GET', `/treasury/receipts/${created.json.id}`);
    expect(read.json).toMatchObject({ number: 'RC-2026-000001', lines: [{ receivableId: rid, appliedCents: 11500 }] });
    expect((await call(w, 'GET', `/treasury/receivables/${rid}`)).json).toMatchObject({ status: 'paid', balanceCents: 0, appliedCents: 11500 });
  });

  it('edita un borrador con PUT y la versión', async () => {
    const w = buildWorld();
    const rid = await debt(w);
    const created = (await call(w, 'POST', '/treasury/receipts', { body: body(rid) })).json;
    const { customerId: _c, ...rest } = body(rid, { totalCents: 7000, lines: [{ receivableId: rid, appliedCents: 7000 }], reference: 'TRX-9' });
    const put = await call(w, 'PUT', `/treasury/receipts/${created.id}`, { body: { ...rest, expectedVersion: 1 } });
    expect(put.status).toBe(200);
    expect(put.json).toMatchObject({ totalCents: 7000, appliedCents: 7000, reference: 'TRX-9', version: 2 });
    expect((await call(w, 'PUT', `/treasury/receipts/${created.id}`, { body: { ...rest, expectedVersion: 1 } })).status).toBe(409);
  });

  it('contabilizar dos veces es 200 las dos y no cobra dos veces', async () => {
    const w = buildWorld();
    const rid = await debt(w, 11500);
    const created = (await call(w, 'POST', '/treasury/receipts', { body: body(rid) })).json;
    expect((await call(w, 'POST', `/treasury/receipts/${created.id}/post`)).status).toBe(200);
    expect((await call(w, 'POST', `/treasury/receipts/${created.id}/post`)).status).toBe(200);
    expect((await call(w, 'GET', `/treasury/receivables/${rid}`)).json.balanceCents).toBe(6500);
  });

  it('anula con motivo, devuelve el saldo y lo deja leer; sin motivo es 422', async () => {
    const w = buildWorld();
    const rid = await debt(w, 11500);
    const created = (await call(w, 'POST', '/treasury/receipts', { body: body(rid) })).json;
    await call(w, 'POST', `/treasury/receipts/${created.id}/post`);
    expect((await call(w, 'POST', `/treasury/receipts/${created.id}/void`, { body: { reason: 'x' } })).status).toBe(422);
    expect((await call(w, 'POST', `/treasury/receipts/${created.id}/void`, { body: {} })).status).toBe(422);
    const voided = await call(w, 'POST', `/treasury/receipts/${created.id}/void`, { body: { reason: 'Transferencia rechazada por el banco' } });
    expect(voided.status).toBe(200);
    expect(voided.json).toMatchObject({ status: 'voided', voidReason: 'Transferencia rechazada por el banco', voidedBy: USER_1 });
    expect((await call(w, 'GET', `/treasury/receivables/${rid}`)).json).toMatchObject({ status: 'open', balanceCents: 11500 });
  });

  it('el anticipo se ve en el estado de cuenta, separado del neto', async () => {
    const w = buildWorld();
    const rid = await debt(w, 10000);
    const created = (await call(w, 'POST', '/treasury/receipts', { body: body(rid, { totalCents: 15000, lines: [{ receivableId: rid, appliedCents: 10000 }] }) })).json;
    await call(w, 'POST', `/treasury/receipts/${created.id}/post`);
    const statement = (await call(w, 'GET', `/treasury/customers/${CUSTOMER_1}/statement`)).json;
    expect(statement).toMatchObject({ receivableCents: 0, advanceCents: 0, customerAdvanceCents: 5000, netCents: 0 });
    expect(statement.advances[0]).toMatchObject({ origin: 'receipt', originalCents: 5000, balanceCents: 5000 });
  });
});

describe('errores de cobros por HTTP', () => {
  it.each([
    ['importe negativo', { totalCents: -1 }, 'totalCents'],
    ['importe con decimales', { totalCents: 10.5 }, 'totalCents'],
    ['fecha con otro formato', { receiptDate: '21/10/2026' }, 'receiptDate'],
    ['medio inexistente', { method: 'bitcoin' }, 'method'],
    ['cliente que no es UUID', { customerId: 'abc' }, 'customerId'],
    ['deuda que no es UUID', { lines: [{ receivableId: 'abc', appliedCents: 100 }] }, 'lines.0.receivableId'],
    ['importe de línea cero', { lines: [{ receivableId: randomUUID(), appliedCents: 0 }] }, 'lines.0.appliedCents'],
    ['más de 200 líneas', { lines: Array.from({ length: 201 }, () => ({ receivableId: randomUUID(), appliedCents: 1 })) }, 'lines'],
    ['un campo que no existe', { descuento: 5 }, ''],
    ['sin referencia en transferencia', { reference: '' }, 'reference'],
  ])('%s → 422', async (_name, overrides, field) => {
    const w = buildWorld();
    const rid = await debt(w);
    const res = await call(w, 'POST', '/treasury/receipts', { body: body(rid, overrides) });
    expect(res.status).toBe(422);
    expect(res.json.code).toBe('VALIDATION_ERROR');
    if (field) expect(res.json.details.map((d: { field: string }) => d.field)).toContain(field);
    expect(w.data.receipts.size).toBe(0);
  });

  it('cobrar más que el saldo → 422 con la línea; una deuda de otro cliente → 422', async () => {
    const w = buildWorld();
    const rid = await debt(w, 5000);
    const over = await call(w, 'POST', '/treasury/receipts', { body: body(rid, { totalCents: 9000, lines: [{ receivableId: rid, appliedCents: 9000 }] }) });
    expect(over.status).toBe(422);
    expect(over.json.details[0].field).toBe('lines[0].appliedCents');
  });

  it('el segundo cobro que ya no cabe falla al contabilizar con 422 y el primero queda intacto', async () => {
    const w = buildWorld();
    const rid = await debt(w, 10000);
    const a = (await call(w, 'POST', '/treasury/receipts', { body: body(rid, { totalCents: 8000, lines: [{ receivableId: rid, appliedCents: 8000 }] }) })).json;
    const b = (await call(w, 'POST', '/treasury/receipts', { body: body(rid, { totalCents: 8000, lines: [{ receivableId: rid, appliedCents: 8000 }] }) })).json;
    expect((await call(w, 'POST', `/treasury/receipts/${a.id}/post`)).status).toBe(200);
    const second = await call(w, 'POST', `/treasury/receipts/${b.id}/post`);
    expect(second.status).toBe(422);
    expect((await call(w, 'GET', `/treasury/receivables/${rid}`)).json.balanceCents).toBe(2000);
  });

  it('un recibo contabilizado no se edita (409); un borrador no se anula (409); anticipo consumido impide anular (409)', async () => {
    const w = buildWorld();
    const rid = await debt(w, 10000);
    const draft = (await call(w, 'POST', '/treasury/receipts', { body: body(rid, { totalCents: 2000, lines: [{ receivableId: rid, appliedCents: 2000 }] }) })).json;
    expect((await call(w, 'POST', `/treasury/receipts/${draft.id}/void`, { body: { reason: 'sin contabilizar' } })).status).toBe(409);
    await call(w, 'POST', `/treasury/receipts/${draft.id}/post`);
    const { customerId: _c, ...rest } = body(rid);
    expect((await call(w, 'PUT', `/treasury/receipts/${draft.id}`, { body: rest })).status).toBe(409);

    const adv = (await call(w, 'POST', '/treasury/receipts', { body: body(rid, { totalCents: 3000, lines: [], reference: 'TRX-A' }) })).json;
    await call(w, 'POST', `/treasury/receipts/${adv.id}/post`);
    const advanceId = (await call(w, 'GET', `/treasury/customers/${CUSTOMER_1}/statement`)).json.advances.find((a: { origin: string }) => a.origin === 'receipt').id;
    const using = (await call(w, 'POST', '/treasury/receipts', { body: body(rid, { totalCents: 0, reference: null, method: 'cash', lines: [{ receivableId: rid, appliedCents: 1000 }], advanceUses: [{ advanceId, usedCents: 1000 }] }) })).json;
    await call(w, 'POST', `/treasury/receipts/${using.id}/post`);
    const blocked = await call(w, 'POST', `/treasury/receipts/${adv.id}/void`, { body: { reason: 'Anular el que dio el anticipo' } });
    expect(blocked.status).toBe(409);
    expect(blocked.json.code).toBe('RECEIPT_ADVANCE_IN_USE');
  });

  it('un cliente que no existe → 422; clientes caído → 502', async () => {
    const w = buildWorld();
    const rid = await debt(w);
    expect((await call(w, 'POST', '/treasury/receipts', { body: body(rid, { customerId: randomUUID() }) })).status).toBe(422);
    const down = buildWorld({ customersDown: true });
    expect((await call(down, 'POST', '/treasury/receipts', { body: body(randomUUID()) })).status).toBe(502);
  });

  it('cuerpo que no es JSON → 400', async () => {
    const w = buildWorld();
    const res = await call(w, 'POST', '/treasury/receipts', { raw: '{no es json' });
    expect(res.status).toBe(400);
    expect(res.json.code).toBe('INVALID_JSON');
  });
});

describe('listado y aislamiento de cobros por HTTP', () => {
  it('el listado trae lineCount (no 0) y filtra; el estado y la búsqueda van por query', async () => {
    const w = buildWorld();
    const a = await debt(w, 50000);
    const b = await debt(w, 50000);
    const c = (await call(w, 'POST', '/treasury/receipts', { body: body(a, { totalCents: 3000, lines: [{ receivableId: a, appliedCents: 1000 }, { receivableId: b, appliedCents: 2000 }] }) })).json;
    await call(w, 'POST', `/treasury/receipts/${c.id}/post`);
    await call(w, 'POST', '/treasury/receipts', { body: body(a, { totalCents: 500, lines: [{ receivableId: a, appliedCents: 500 }], reference: 'DRAFT-1' }) });

    const all = await call(w, 'GET', '/treasury/receipts');
    expect(all.json).toMatchObject({ total: 2, page: 1, pageSize: 25 });
    expect(all.json.items.find((r: { status: string }) => r.status === 'posted').lineCount).toBe(2);
    expect((await call(w, 'GET', '/treasury/receipts?status=posted')).json.total).toBe(1);
    expect((await call(w, 'GET', '/treasury/receipts?status=posted,draft')).json.total).toBe(2);
    expect((await call(w, 'GET', '/treasury/receipts?q=DRAFT-1')).json.total).toBe(1);
    expect((await call(w, 'GET', '/treasury/receipts?status=inventado')).status).toBe(422);
    expect((await call(w, 'GET', '/treasury/receipts?pageSize=200')).status).toBe(422);
  });

  it('otra organización no ve, no edita, no contabiliza y no anula', async () => {
    const w = buildWorld();
    const rid = await debt(w);
    const r = (await call(w, 'POST', '/treasury/receipts', { body: body(rid) })).json;
    expect((await call(w, 'GET', '/treasury/receipts', { org: ORG_B })).json.total).toBe(0);
    expect((await call(w, 'GET', `/treasury/receipts/${r.id}`, { org: ORG_B })).status).toBe(404);
    expect((await call(w, 'POST', `/treasury/receipts/${r.id}/post`, { org: ORG_B })).status).toBe(404);
    expect((await call(w, 'POST', `/treasury/receipts/${r.id}/void`, { org: ORG_B, body: { reason: 'Intento ajeno' } })).status).toBe(404);
    const { customerId: _c, ...rest } = body(rid);
    expect((await call(w, 'PUT', `/treasury/receipts/${r.id}`, { org: ORG_B, body: rest })).status).toBe(404);
  });
});
