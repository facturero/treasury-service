import { describe, expect, it } from 'vitest';
import { ALL_PERMISSIONS, buildWorld, CUSTOMER_1, headers, ORG_A, ORG_B, USER_1, USER_2, type World } from './helpers.js';

async function call(w: World, method: string, path: string, opts: { perms?: string[] | string; org?: string | null; user?: string | null; body?: unknown } = {}) {
  const res = await w.app.request(path, {
    method,
    headers: headers(opts.perms ?? ALL_PERMISSIONS, opts.org === undefined ? ORG_A : opts.org, opts.user === undefined ? USER_1 : opts.user),
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
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

const profile = { delimiter: ',', skipRows: 1, dateColumn: 1, dateFormat: 'DD/MM/YYYY', descriptionColumn: 2, referenceColumn: 3, amountMode: 'signed', amountColumn: 4, debitColumn: null, creditColumn: null, invertSign: false, decimalSeparator: '.', balanceColumn: 5 };
const accountBody = { name: 'Pichincha', bankName: 'Banco Pichincha', accountType: 'checking', accountLast4: '1234', openingBalanceCents: 100000, openingDate: '2026-09-30', importProfile: profile };
const CSV = 'Fecha,Descripcion,Referencia,Monto,Saldo\n06/10/2026,Transferencia TRX-1,TRX-1,50.00,1050.00\n10/10/2026,Comision,,-2.50,1047.50\n';

async function seed(w: World) {
  const account = (await call(w, 'POST', '/treasury/bank-accounts', { body: accountBody })).json;
  const inv = w.invoice({ total: 5000 });
  await w.useCases.invoiceIssued.execute(inv);
  const r = w.receivables().find((x) => x.sourceId === inv.invoiceId)!;
  const receipt = (await call(w, 'POST', '/treasury/receipts', { body: { customerId: CUSTOMER_1, receiptDate: '2026-10-05', method: 'transfer', reference: 'TRX-1', bankAccountId: account.id, totalCents: 5000, lines: [{ receivableId: r.id, appliedCents: 5000 }] } })).json;
  await call(w, 'POST', `/treasury/receipts/${receipt.id}/post`);
  const imported = (await call(w, 'POST', `/treasury/bank-accounts/${account.id}/statements`, { body: { csv: CSV, fileName: 'octubre.csv' } })).json;
  return { account, receipt, imported };
}

/** Cada ruta con el permiso que la protege. */
const ROUTES: { method: string; path: (ids: { account: string; line: string; movement: string; rec: string }) => string; permission: string; body?: (ids: { account: string; line: string; movement: string }) => unknown }[] = [
  { method: 'GET', path: () => '/treasury/bank-accounts', permission: 'bank_account:read' },
  { method: 'GET', path: (i) => `/treasury/bank-accounts/${i.account}`, permission: 'bank_account:read' },
  { method: 'POST', path: () => '/treasury/bank-accounts', permission: 'bank_account:manage', body: () => ({ ...accountBody, name: 'Otra cuenta' }) },
  { method: 'PUT', path: (i) => `/treasury/bank-accounts/${i.account}`, permission: 'bank_account:manage', body: () => ({ bankName: 'Banco del Pacífico' }) },
  { method: 'POST', path: (i) => `/treasury/bank-accounts/${i.account}/statements/preview`, permission: 'bank_account:manage', body: () => ({ csv: CSV }) },
  { method: 'GET', path: (i) => `/treasury/bank-accounts/${i.account}/lines`, permission: 'bank_account:read' },
  { method: 'GET', path: (i) => `/treasury/bank-accounts/${i.account}/suggestions`, permission: 'bank_account:read' },
  { method: 'GET', path: () => '/treasury/bank-movements', permission: 'bank_account:read' },
  { method: 'POST', path: (i) => `/treasury/bank-movements/${i.movement}/account`, permission: 'bank_account:manage', body: (i) => ({ bankAccountId: i.account }) },
  { method: 'POST', path: (i) => `/treasury/bank-lines/${i.line}/match`, permission: 'reconciliation:manage', body: (i) => ({ movementIds: [i.movement] }) },
  { method: 'POST', path: () => '/treasury/bank-lines/match', permission: 'reconciliation:manage', body: (i) => ({ pairs: [{ lineId: i.line, movementIds: [i.movement] }] }) },
  { method: 'POST', path: (i) => `/treasury/bank-lines/${i.line}/unmatch`, permission: 'reconciliation:manage' },
  { method: 'POST', path: (i) => `/treasury/bank-lines/${i.line}/external`, permission: 'reconciliation:manage', body: () => ({ reason: 'Venta con tarjeta' }) },
  { method: 'POST', path: (i) => `/treasury/bank-lines/${i.line}/unexternal`, permission: 'reconciliation:manage' },
  { method: 'POST', path: () => '/treasury/bank-adjustments', permission: 'reconciliation:manage', body: (i) => ({ bankAccountId: i.account, kind: 'bank_fee', date: '2026-10-12', amountCents: 100, description: 'Cargo de chequera' }) },
  { method: 'POST', path: (i) => `/treasury/bank-adjustments/${i.movement}/void`, permission: 'reconciliation:manage', body: () => ({ reason: 'Se cargó por error' }) },
  { method: 'GET', path: (i) => `/treasury/bank-accounts/${i.account}/reconciliation?cutoffDate=2026-10-31&statementBalanceCents=104750`, permission: 'bank_account:read' },
  { method: 'GET', path: (i) => `/treasury/bank-accounts/${i.account}/reconciliations`, permission: 'bank_account:read' },
  { method: 'POST', path: (i) => `/treasury/bank-accounts/${i.account}/reconciliations`, permission: 'reconciliation:manage', body: () => ({ cutoffDate: '2026-10-31', statementBalanceCents: 104750 }) },
  { method: 'POST', path: (i) => `/treasury/bank-reconciliations/${i.rec}/reopen`, permission: 'reconciliation:manage', body: () => ({ reason: 'Faltaba un depósito' }) },
  { method: 'GET', path: () => '/treasury/cash-flow', permission: 'bank_account:read' },
  { method: 'GET', path: () => '/treasury/cash-flow/export', permission: 'bank_account:read' },
];

describe('permisos por ruta de bancos y conciliación', () => {
  it.each(ROUTES)('$method $permission', async (route) => {
    const w = buildWorld();
    const { account } = await seed(w);
    const line = [...w.data.bankLines.keys()][0]!;
    const movement = [...w.data.bankMovements.keys()][0]!;
    const ids = { account: account.id, line, movement, rec: '99999999-9999-4999-8999-999999999999' };
    const send = (perms: string[]) => call(w, route.method, route.path(ids), { perms, body: route.body?.(ids) });
    // sin el permiso → 403; los demás permisos del módulo no lo suplen
    const others = ALL_PERMISSIONS.filter((p) => p !== route.permission);
    expect((await send(others)).status, `${route.method} sin ${route.permission}`).toBe(403);
    // con el permiso, la autorización pasa (la respuesta puede ser de negocio — 404, 409, 422 —, pero nunca 401/403)
    const allowed = (await send([route.permission])).status;
    expect([401, 403], `${route.method} con ${route.permission}`).not.toContain(allowed);
  });

  it('sin organización → 401', async () => {
    const w = buildWorld();
    expect((await call(w, 'GET', '/treasury/bank-accounts', { org: null })).status).toBe(401);
    expect((await call(w, 'GET', '/treasury/cash-flow', { org: null })).status).toBe(401);
  });
});

describe('cuentas por HTTP', () => {
  it('crea (201), lista con el saldo del registro y lo sin asignar, y no deja ver el perfil a otra organización', async () => {
    const w = buildWorld();
    const { account } = await seed(w);
    expect(account).toMatchObject({ name: 'Pichincha', accountLast4: '1234', currencyCode: 'USD', isActive: true });
    const list = (await call(w, 'GET', '/treasury/bank-accounts')).json;
    expect(list.items[0]).toMatchObject({ id: account.id, registerBalanceCents: 105000, unmatchedLines: 2, unmatchedMovements: 1, lastStatementDate: '2026-10-10', lastReconciledOn: null });
    expect(list.unassignedMovements).toBe(0);
    expect((await call(w, 'GET', `/treasury/bank-accounts/${account.id}`, { org: ORG_B })).status).toBe(404);
    expect((await call(w, 'GET', '/treasury/bank-accounts', { org: ORG_B })).json.items).toEqual([]);
  });

  it('un perfil o una cuenta mal formados son 422 con el campo; un campo desconocido también', async () => {
    const w = buildWorld();
    const r = await call(w, 'POST', '/treasury/bank-accounts', { body: { ...accountBody, importProfile: { ...profile, dateFormat: 'YY/MM/DD' } } });
    expect(r.status).toBe(422);
    expect((await call(w, 'POST', '/treasury/bank-accounts', { body: { ...accountBody, accountNumber: '2200123456789' } })).status).toBe(422); // el número completo ni se acepta
    expect((await call(w, 'POST', '/treasury/bank-accounts', { body: { ...accountBody, accountLast4: '22001' } })).status).toBe(422);
  });
});

describe('importar por HTTP', () => {
  it('vista previa, importar (201), repetir el mismo archivo (409)', async () => {
    const w = buildWorld();
    const { account } = await seed(w);
    const other = (await call(w, 'POST', '/treasury/bank-accounts', { body: { ...accountBody, name: 'Guayaquil' } })).json;
    const preview = await call(w, 'POST', `/treasury/bank-accounts/${other.id}/statements/preview`, { body: { csv: CSV } });
    expect(preview.status).toBe(200);
    expect(preview.json).toMatchObject({ newLines: 2, canImport: true, closingBalanceCents: 104750 });
    expect((await call(w, 'POST', `/treasury/bank-accounts/${other.id}/statements`, { body: { csv: CSV } })).status).toBe(201);
    const again = await call(w, 'POST', `/treasury/bank-accounts/${other.id}/statements`, { body: { csv: CSV } });
    expect(again.status).toBe(409);
    expect(again.json.code).toBe('BANK_STATEMENT_ALREADY_IMPORTED');
    expect(account.id).not.toBe(other.id);
  });

  it('un archivo con filas malas es 422 y dice la fila', async () => {
    const w = buildWorld();
    const { account } = await seed(w);
    const r = await call(w, 'POST', `/treasury/bank-accounts/${account.id}/statements`, { body: { csv: 'Fecha,D,R,M,S\n40/10/2026,x,,5.00,\n' } });
    expect(r.status).toBe(422);
    expect(JSON.stringify(r.json)).toContain('rows[2].date');
  });
});

describe('conciliar por HTTP', () => {
  it('el recorrido completo: sugerir, confirmar, ajuste desde el renglón, cerrar con diferencia 0 y reabrir', async () => {
    const w = buildWorld();
    const { account } = await seed(w);
    const suggestions = (await call(w, 'GET', `/treasury/bank-accounts/${account.id}/suggestions`)).json.suggestions;
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({ reason: 'reference', line: { amountCents: 5000 }, movement: { amountCents: 5000 } });
    const batch = await call(w, 'POST', '/treasury/bank-lines/match', { body: { pairs: [{ lineId: suggestions[0].line.id, movementIds: [suggestions[0].movement.id] }] } });
    expect(batch.json).toEqual({ matched: [suggestions[0].line.id], failed: [] });

    const fee = (await call(w, 'GET', `/treasury/bank-accounts/${account.id}/lines?status=unmatched`)).json.items[0];
    expect(fee).toMatchObject({ amountCents: -250, status: 'unmatched' });
    expect((await call(w, 'POST', '/treasury/bank-adjustments', { body: { bankAccountId: account.id, kind: 'bank_fee', date: '2026-10-10', amountCents: 250, description: 'Comisión mensual', lineId: fee.id } })).status).toBe(201);

    const preview = (await call(w, 'GET', `/treasury/bank-accounts/${account.id}/reconciliation?cutoffDate=2026-10-31`)).json;
    expect(preview).toMatchObject({ statementBalanceCents: 104750, suggestedStatementBalance: { cents: 104750, date: '2026-10-10' }, result: { differenceCents: 0, canClose: true, unresolvedLines: 0 } });
    const closed = await call(w, 'POST', `/treasury/bank-accounts/${account.id}/reconciliations`, { user: USER_2, body: { cutoffDate: '2026-10-31', statementBalanceCents: 104750, notes: 'Octubre' } });
    expect(closed.status).toBe(201);
    expect(closed.json).toMatchObject({ status: 'closed', differenceCents: 0, closedBy: USER_2, notes: 'Octubre' });

    const again = await call(w, 'POST', `/treasury/bank-accounts/${account.id}/reconciliations`, { body: { cutoffDate: '2026-10-31', statementBalanceCents: 104750 } });
    expect(again.status).toBe(422);
    const reopened = await call(w, 'POST', `/treasury/bank-reconciliations/${closed.json.id}/reopen`, { body: { reason: 'Faltaba un depósito' } });
    expect(reopened.json.status).toBe('reopened');
    expect((await call(w, 'GET', `/treasury/bank-accounts/${account.id}/reconciliations`)).json.items).toHaveLength(1);
  });

  it('cerrar con diferencia es 409 con el motivo; anular lo conciliado es 409 BANK_RECONCILED', async () => {
    const w = buildWorld();
    const { account, receipt } = await seed(w);
    const unresolved = await call(w, 'POST', `/treasury/bank-accounts/${account.id}/reconciliations`, { body: { cutoffDate: '2026-10-31', statementBalanceCents: 104750 } });
    expect(unresolved.status).toBe(409);
    expect(unresolved.json.code).toBe('INVALID_RECONCILIATION_STATE');
    const line = [...w.data.bankLines.values()].find((l) => l.amountCents === 5000)!;
    const feeLine = [...w.data.bankLines.values()].find((l) => l.amountCents === -250)!;
    await call(w, 'POST', `/treasury/bank-lines/${line.id}/match`, { body: { movementIds: [[...w.data.bankMovements.keys()][0]] } });
    await call(w, 'POST', `/treasury/bank-lines/${feeLine.id}/external`, { body: { reason: 'Ya asentada a mano' } });
    expect((await call(w, 'POST', `/treasury/bank-accounts/${account.id}/reconciliations`, { body: { cutoffDate: '2026-10-31', statementBalanceCents: 104750 } })).status).toBe(201);
    const voided = await call(w, 'POST', `/treasury/receipts/${receipt.id}/void`, { body: { reason: 'Quiero anularlo' } });
    expect(voided.status).toBe(409);
    expect(voided.json.code).toBe('BANK_RECONCILED');
  });
});

describe('flujo de caja por HTTP', () => {
  it('se lee en JSON y se exporta a CSV (con BOM, sin caché y con un evento en la bitácora)', async () => {
    const w = buildWorld();
    await seed(w);
    const flow = (await call(w, 'GET', '/treasury/cash-flow?weeks=4&asOf=2026-10-22')).json;
    expect(flow).toMatchObject({ asOf: '2026-10-22', weeks: 4, openingCents: 105000 });
    expect(flow.buckets.map((b: { key: string }) => b.key)).toEqual(['overdue', 'w1', 'w2', 'w3', 'w4', 'later']);
    const csv = await call(w, 'GET', '/treasury/cash-flow/export?weeks=4&asOf=2026-10-22&lang=en');
    expect(csv.status).toBe(200);
    expect(csv.headers.get('content-type')).toContain('text/csv');
    expect(csv.headers.get('cache-control')).toBe('no-store');
    expect([...csv.bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(csv.text).toContain('Projected cash flow');
    expect(csv.text).toContain('1050.00');
    expect(w.events('treasury.report.exported').at(-1)!.payload).toMatchObject({ report: 'cash_flow', filters: { asOf: '2026-10-22', weeks: 4 }, exportedBy: USER_1 });
    expect((await call(w, 'GET', '/treasury/cash-flow?weeks=99')).status).toBe(422);
  });
});
