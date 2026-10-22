import { describe, expect, it } from 'vitest';
import { ALL_PERMISSIONS, buildWorld, headers, ORG_A, ORG_B, SUPPLIER_1, SUPPLIER_2, USER_1, USER_2, type World } from './helpers.js';

async function call(w: World, method: string, path: string, opts: { perms?: string[] | string; org?: string | null; user?: string | null; body?: unknown; raw?: string } = {}) {
  const res = await w.app.request(path, {
    method,
    headers: headers(opts.perms ?? ALL_PERMISSIONS, opts.org === undefined ? ORG_A : opts.org, opts.user === undefined ? USER_1 : opts.user),
    body: opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)),
  });
  const bytes = new Uint8Array(await res.arrayBuffer());
  const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, json, text, bytes, headers: res.headers };
}

async function debt(w: World, total = 11500, overrides: Parameters<World['bill']>[0] = {}): Promise<string> {
  const bill = w.bill({ total, ...overrides });
  await w.useCases.billPosted.execute(bill);
  return w.payableOf(bill.billId)!.id;
}

const body = (payableId: string, overrides: Record<string, unknown> = {}) => ({
  supplierId: SUPPLIER_1,
  paymentDate: '2026-10-21',
  method: 'transfer',
  reference: 'TRX-1',
  totalCents: 5000,
  lines: [{ payableId, appliedCents: 5000 }],
  ...overrides,
});

/** Cada ruta con el permiso que la protege. */
const ROUTES: { method: string; path: (id: string) => string; permission: string; body?: (pid: string) => unknown; user?: string }[] = [
  { method: 'GET', path: () => '/treasury/payables', permission: 'payable:read' },
  { method: 'GET', path: (id) => `/treasury/payables/${id}`, permission: 'payable:read' },
  { method: 'GET', path: () => '/treasury/payables/aging', permission: 'payable:read' },
  { method: 'GET', path: () => `/treasury/suppliers/${SUPPLIER_1}/statement`, permission: 'payable:read' },
  { method: 'GET', path: () => '/treasury/payables/export', permission: 'payable:export' },
  { method: 'GET', path: () => '/treasury/payables/aging/export', permission: 'payable:export' },
  { method: 'GET', path: () => `/treasury/suppliers/${SUPPLIER_1}/statement/export`, permission: 'payable:export' },
  { method: 'POST', path: () => '/treasury/payable-opening-balances', permission: 'opening_balance:load', body: () => ({ cutoffDate: '2026-09-30', reason: 'Migración', lines: [{ supplierId: SUPPLIER_1, issueDate: '2026-08-01', amountCents: 100 }] }) },
  { method: 'GET', path: () => '/treasury/payments', permission: 'payment:read' },
  { method: 'GET', path: (id) => `/treasury/payments/${id}`, permission: 'payment:read' },
  { method: 'POST', path: () => '/treasury/payments', permission: 'payment:create', body: (pid) => body(pid) },
  { method: 'PUT', path: (id) => `/treasury/payments/${id}`, permission: 'payment:create', body: (pid) => { const { supplierId: _s, ...rest } = body(pid); return rest; } },
  { method: 'POST', path: (id) => `/treasury/payments/${id}/post`, permission: 'payment:create' },
  // Quien creó el pago no lo aprueba (403 por separación de funciones): la prueba del permiso lo hace otra persona.
  { method: 'POST', path: (id) => `/treasury/payments/${id}/approve`, permission: 'payment:approve', user: USER_2 },
  { method: 'POST', path: (id) => `/treasury/payments/${id}/void`, permission: 'payment:void', body: () => ({ reason: 'Pago duplicado por error' }) },
  { method: 'GET', path: () => '/treasury/payments/settings', permission: 'payment:approve' },
  { method: 'PUT', path: () => '/treasury/payments/settings', permission: 'payment:approve', body: () => ({ approvalThresholdCents: 100000 }) },
];

describe('permisos por ruta de cuentas por pagar y pagos', () => {
  it.each(ROUTES)('$method $permission', async (route) => {
    const w = buildWorld();
    const pid = await debt(w);
    const draft = (await call(w, 'POST', '/treasury/payments', { body: body(pid) })).json;
    for (const perms of [[], ALL_PERMISSIONS.filter((p) => p !== route.permission), ['receivable:read', 'receipt:read', 'receipt:create']]) {
      expect((await call(w, route.method, route.path(draft.id), { perms, body: route.body?.(pid) })).status, `${route.method} ${route.path('x')} con ${perms}`).toBe(403);
    }
    expect((await call(w, route.method, route.path(draft.id), { perms: [route.permission], body: route.body?.(pid), user: route.user })).status).not.toBe(403);
  });

  it('`X-Permissions: *` enviado por un cliente no concede nada', async () => {
    const w = buildWorld();
    const pid = await debt(w);
    for (const [method, path] of [['GET', '/treasury/payables'], ['POST', '/treasury/payments'], ['GET', '/treasury/payments/settings']] as const) {
      expect((await call(w, method, path, { perms: '*', body: method === 'POST' ? body(pid) : undefined })).status).toBe(403);
    }
  });

  it('sin organización → 401; sin usuario en una escritura → 401', async () => {
    const w = buildWorld();
    const pid = await debt(w);
    expect((await call(w, 'GET', '/treasury/payables', { org: null })).status).toBe(401);
    expect((await call(w, 'POST', '/treasury/payments', { user: null, body: body(pid) })).status).toBe(401);
  });

  it('los permisos de cobrar NO sirven para pagar (y al revés): son otra cosa', async () => {
    const w = buildWorld();
    const pid = await debt(w);
    const receiptsOnly = ['receivable:read', 'receipt:read', 'receipt:create', 'receipt:void'];
    expect((await call(w, 'POST', '/treasury/payments', { perms: receiptsOnly, body: body(pid) })).status).toBe(403);
    expect((await call(w, 'GET', '/treasury/receipts', { perms: ['payable:read', 'payment:read', 'payment:create'] })).status).toBe(403);
  });
});

describe('cuentas por pagar y pagos por HTTP', () => {
  it('flujo completo: deuda → borrador (201) → contabilizar → saldo → anular', async () => {
    const w = buildWorld();
    const pid = await debt(w, 11500);
    const created = await call(w, 'POST', '/treasury/payments', { body: body(pid) });
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({ status: 'draft', number: null, supplierName: 'PROVEEDOR UNO S.A.', lineCount: 1 });
    const posted = await call(w, 'POST', `/treasury/payments/${created.json.id}/post`);
    expect(posted.status).toBe(200);
    expect(posted.json.number).toBe('PG-2026-000001');
    const detail = await call(w, 'GET', `/treasury/payables/${pid}`);
    expect(detail.json).toMatchObject({ balanceCents: 6500, status: 'partial' });
    expect(detail.json.applications).toHaveLength(1);
    const voided = await call(w, 'POST', `/treasury/payments/${created.json.id}/void`, { body: { reason: 'Pago duplicado por error' } });
    expect(voided.json.status).toBe('voided');
    expect((await call(w, 'GET', `/treasury/payables/${pid}`)).json.balanceCents).toBe(11500);
  });

  it('422 con el nombre del campo; cuerpo que no es JSON → 400; campo desconocido → 422', async () => {
    const w = buildWorld();
    const pid = await debt(w);
    const noRef = await call(w, 'POST', '/treasury/payments', { body: body(pid, { reference: null }) });
    expect(noRef.status).toBe(422);
    expect(noRef.json.details[0].field).toBe('reference');
    expect((await call(w, 'POST', '/treasury/payments', { raw: '{no es json' })).status).toBe(400);
    expect((await call(w, 'POST', '/treasury/payments', { body: body(pid, { sneaky: true }) })).status).toBe(422);
    const overpay = await call(w, 'POST', '/treasury/payments', { body: body(pid, { totalCents: 999999, lines: [{ payableId: pid, appliedCents: 999999 }] }) });
    expect(overpay.status).toBe(422);
    expect(overpay.json.details[0].field).toBe('lines[0].appliedCents');
  });

  it('el umbral: con él, pagar sin aprobar es 409 PAYMENT_APPROVAL_REQUIRED, aprobar uno propio es 403 y otra persona sí', async () => {
    const w = buildWorld();
    const pid = await debt(w, 115000);
    expect((await call(w, 'PUT', '/treasury/payments/settings', { body: { approvalThresholdCents: 50000 } })).json.approvalThresholdCents).toBe(50000);
    const draft = (await call(w, 'POST', '/treasury/payments', { body: body(pid, { totalCents: 60000, lines: [{ payableId: pid, appliedCents: 60000 }] }) })).json;
    const blocked = await call(w, 'POST', `/treasury/payments/${draft.id}/post`);
    expect(blocked.status).toBe(409);
    expect(blocked.json.code).toBe('PAYMENT_APPROVAL_REQUIRED');
    const self = await call(w, 'POST', `/treasury/payments/${draft.id}/approve`);
    expect(self.status).toBe(403);
    expect(self.json.code).toBe('PAYMENT_SELF_APPROVAL');
    expect((await call(w, 'POST', `/treasury/payments/${draft.id}/approve`, { user: USER_2 })).json.status).toBe('approved');
    expect((await call(w, 'POST', `/treasury/payments/${draft.id}/post`)).status).toBe(200);
  });

  it('cada pago dice si REQUIERE aprobación (quien no puede leer el umbral lo necesita para no ofrecer «Pagar» en vano)', async () => {
    const w = buildWorld();
    const pid = await debt(w, 115000);
    const small = (await call(w, 'POST', '/treasury/payments', { body: body(pid, { totalCents: 1000, lines: [{ payableId: pid, appliedCents: 1000 }] }) })).json;
    expect(small.requiresApproval).toBe(false); // sin umbral
    await call(w, 'PUT', '/treasury/payments/settings', { body: { approvalThresholdCents: 50000 } });
    const big = (await call(w, 'POST', '/treasury/payments', { body: body(pid, { totalCents: 60000, lines: [{ payableId: pid, appliedCents: 60000 }] }) })).json;
    expect(big.requiresApproval).toBe(true);
    // un Contador (sin `payment:approve`) lo lee igual: solo el sí/no, nunca el importe del umbral
    const asAccountant = await call(w, 'GET', `/treasury/payments/${big.id}`, { perms: ['payment:read'] });
    expect(asAccountant.json.requiresApproval).toBe(true);
    expect(JSON.stringify(asAccountant.json)).not.toContain('50000,');
    expect((await call(w, 'GET', `/treasury/payments/${small.id}`, { perms: ['payment:read'] })).json.requiresApproval).toBe(false); // por debajo del umbral nuevo: no lo necesita
    const approved = await call(w, 'POST', `/treasury/payments/${big.id}/approve`, { user: USER_2 });
    expect(approved.json.requiresApproval).toBe(false); // aprobado: ya no falta nada
  });

  it('el umbral rechaza importes inválidos y se puede quitar con null', async () => {
    const w = buildWorld();
    expect((await call(w, 'PUT', '/treasury/payments/settings', { body: { approvalThresholdCents: 0 } })).status).toBe(422);
    expect((await call(w, 'PUT', '/treasury/payments/settings', { body: { approvalThresholdCents: 100 } })).status).toBe(200);
    expect((await call(w, 'PUT', '/treasury/payments/settings', { body: { approvalThresholdCents: null } })).json.approvalThresholdCents).toBeNull();
    expect((await call(w, 'GET', '/treasury/payments/settings')).json.approvalThresholdCents).toBeNull();
  });

  it('«settings» no se confunde con un id de pago', async () => {
    const w = buildWorld();
    const res = await call(w, 'GET', '/treasury/payments/settings');
    expect(res.status).toBe(200);
    expect(res.json).toHaveProperty('approvalThresholdCents');
  });

  it('errores de proveedor: no existe → 422; compras caído → 502', async () => {
    const w = buildWorld();
    const pid = await debt(w);
    const missing = await call(w, 'POST', '/treasury/payments', { body: body(pid, { supplierId: '99999999-9999-4999-8999-999999999999' }) });
    expect(missing.status).toBe(422);
    w.suppliers.down = true;
    expect((await call(w, 'POST', '/treasury/payments', { body: body(pid) })).status).toBe(502);
  });

  it('listados: filtros, pagina y no mezcla organizaciones', async () => {
    const w = buildWorld();
    const a = await debt(w, 1150);
    await debt(w, 2300, { supplier: w.knownSuppliers.get(SUPPLIER_2)! });
    expect((await call(w, 'GET', '/treasury/payables')).json.total).toBe(2);
    expect((await call(w, 'GET', `/treasury/payables?supplierId=${SUPPLIER_2}`)).json.total).toBe(1);
    expect((await call(w, 'GET', '/treasury/payables?status=paid')).json.total).toBe(0);
    expect((await call(w, 'GET', '/treasury/payables?overdueOnly=true&asOf=2027-01-01')).json.total).toBe(2);
    expect((await call(w, 'GET', '/treasury/payables', { org: ORG_B })).json.total).toBe(0);
    expect((await call(w, 'GET', `/treasury/payables/${a}`, { org: ORG_B })).status).toBe(404);
    expect((await call(w, 'GET', '/treasury/payables?asOf=mañana')).status).toBe(422);
  });

  it('«aging» y «export» no se leen como un id de deuda', async () => {
    const w = buildWorld();
    await debt(w);
    expect((await call(w, 'GET', '/treasury/payables/aging')).json).toHaveProperty('totals');
    expect((await call(w, 'GET', '/treasury/payables/export')).headers.get('content-type')).toContain('text/csv');
  });
});

describe('exportar cuentas por pagar', () => {
  it('CSV con BOM, encabezados en el idioma pedido y los MISMOS filtros; deja UN evento por archivo', async () => {
    const w = buildWorld();
    await debt(w, 11500, { supplierDocument: '001-001-000000111' });
    await debt(w, 2300, { supplier: w.knownSuppliers.get(SUPPLIER_2)! });
    const res = await call(w, 'GET', '/treasury/payables/export?asOf=2026-10-21&lang=en');
    expect(res.status).toBe(200);
    expect([...res.bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="por-pagar-2026-10-21.csv"');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const lines = res.text.replace(/^﻿/, '').trimEnd().split('\r\n');
    expect(lines[0]).toBe('Supplier invoice,Internal no.,Supplier,Tax ID,Issued,Due,Days overdue,Original amount,Paid and withheld,Balance,Status,Currency');
    expect(lines).toHaveLength(3);
    expect(lines.find((l) => l.startsWith('001-001-000000111'))).toMatch(/PROVEEDOR UNO S\.A\.,1790011111001,2026-10-21,2026-11-20,0,115\.00,0\.00,115\.00,Open,USD$/);

    const filtered = await call(w, 'GET', `/treasury/payables/export?supplierId=${SUPPLIER_2}`);
    expect(filtered.text.trimEnd().split('\r\n')).toHaveLength(2);
    const events = w.events('treasury.report.exported');
    expect(events).toHaveLength(2);
    expect(events[0]!.payload).toMatchObject({ report: 'payables', rowCount: 2, exportedBy: USER_1, filters: { asOf: '2026-10-21' } });
    expect(events[1]!.payload).toMatchObject({ report: 'payables', rowCount: 1, filters: { supplierId: SUPPLIER_2 } });
  });

  it('un nombre de proveedor que empieza con = sale neutralizado (no es una fórmula)', async () => {
    const w = buildWorld();
    await debt(w, 1150, { supplier: { id: SUPPLIER_1, legalName: '=HYPERLINK("http://malo.test","x")', identification: '1790011111001' } });
    const res = await call(w, 'GET', '/treasury/payables/export');
    expect(res.text).not.toMatch(/(^|,)=HYPERLINK/m);
    expect(res.text).toContain(`"'=HYPERLINK(""http://malo.test"",""x"")"`);
  });

  it('antigüedad y estado de cuenta del proveedor: filas, totales y evento con el proveedor', async () => {
    const w = buildWorld();
    await debt(w, 11500);
    await debt(w, 5750, { issueDate: '2026-07-01', dueDate: '2026-08-01', supplierDocument: '001-001-000000222' });
    const aging = await call(w, 'GET', '/treasury/payables/aging/export?asOf=2026-10-21');
    const rows = aging.text.replace(/^﻿/, '').trimEnd().split('\r\n');
    expect(rows[0]).toBe('Proveedor,Vence en 7 días,Corriente,1 a 30 días,31 a 60 días,61 a 90 días,Más de 90 días,Total');
    expect(rows.at(-1)).toBe('TOTAL,0.00,115.00,0.00,0.00,57.50,0.00,172.50');
    const statement = await call(w, 'GET', `/treasury/suppliers/${SUPPLIER_1}/statement/export?lang=fr&asOf=2026-10-21`);
    const st = statement.text.replace(/^﻿/, '');
    expect(st.split('\r\n')[0]).toBe('Relevé du fournisseur');
    expect(st).toContain('Net,172.50');
    expect(w.events('treasury.report.exported').at(-1)!.payload).toMatchObject({ report: 'supplier_statement', supplierId: SUPPLIER_1 });
  });
});
