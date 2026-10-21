import { describe, expect, it } from 'vitest';
import { CatalogUnavailableError, RemindersDisabledError, ValidationError } from '../domain/errors.js';
import { planReminders } from '../domain/reminder.js';
import type { Receivable } from '../domain/receivable.js';
import { ALL_PERMISSIONS, buildWorld, CUSTOMER_1, CUSTOMER_2, headers, ORG_A, ORG_B, USER_1, type World } from './helpers.js';

/** «Hoy» de las pruebas es 2026-10-21 10:00 en Guayaquil (15:00 UTC): ya pasó la hora de envío (09:00). */
const TODAY = '2026-10-21';

async function overdueInvoice(w: World, opts: { total?: number; issued: string; customerId?: string; name?: string }): Promise<string> {
  const customerId = opts.customerId ?? CUSTOMER_1;
  const inv = w.invoice({
    total: opts.total ?? 11500,
    customerId,
    issueDate: `${opts.issued}T15:00:00.000Z`,
    customerSnapshot: { id: customerId, businessName: opts.name ?? 'CLIENTE UNO S.A.', identification: '1790012345001' },
  });
  await w.useCases.invoiceIssued.execute(inv);
  return w.receivables().find((r) => r.sourceId === inv.invoiceId)!.id;
}

const enable = (w: World, overrides: Partial<{ firstAfterDays: number; repeatEveryDays: number }> = {}) =>
  w.useCases.setReminderSettings.execute({ organizationId: ORG_A, enabled: true, firstAfterDays: 3, repeatEveryDays: 7, userId: USER_1, ...overrides });

const run = (w: World, trigger: 'scheduled' | 'manual' = 'manual') => w.useCases.runReminders.execute({ organizationId: ORG_A, trigger, userId: trigger === 'manual' ? USER_1 : null });

describe('planReminders (dominio)', () => {
  const rec = (over: Partial<Receivable> & { id: string }): Receivable => ({
    organizationId: ORG_A, customerId: CUSTOMER_1, customerName: 'UNO', customerIdentification: null, sourceType: 'invoice', sourceId: over.id,
    documentNumber: `F-${over.id}`, issueDate: '2026-09-01', dueDate: '2026-10-10', currencyCode: 'USD', originalCents: 1000, appliedCents: 0,
    status: 'open', version: 1, createdAt: new Date(), updatedAt: new Date(), ...over,
  } as Receivable);
  const cfg = { firstAfterDays: 3, repeatEveryDays: 7 };

  it('solo avisa lo que ya pasó los días de gracia, y lo agrupa por cliente', () => {
    const plans = planReminders([rec({ id: 'a', dueDate: '2026-10-10' }), rec({ id: 'b', dueDate: '2026-10-19' }), rec({ id: 'c', dueDate: '2026-10-20' }), rec({ id: 'd', customerId: CUSTOMER_2, dueDate: '2026-10-01' })], cfg, TODAY, new Map());
    // `b` lleva 2 días y `c` 1: todavía no. `a` y `d` sí, cada uno con su cliente.
    expect(Object.fromEntries(plans.map((p) => [p.customerId, p.receivableIds]))).toEqual({ [CUSTOMER_1]: ['a'], [CUSTOMER_2]: ['d'] });
  });

  it('no avisa lo pagado, lo anulado ni las partidas fantasma', () => {
    const plans = planReminders([rec({ id: 'p', status: 'paid', appliedCents: 1000 }), rec({ id: 'x', status: 'cancelled' }), rec({ id: 'g', customerId: '' }), rec({ id: 'ok' })], cfg, TODAY, new Map());
    expect(plans.flatMap((p) => p.receivableIds)).toEqual(['ok']);
  });

  it('una partida avisada hace menos de `repeatEveryDays` no se vuelve a avisar; al cumplirse, sí', () => {
    const r = [rec({ id: 'a' })];
    expect(planReminders(r, cfg, TODAY, new Map([['a', '2026-10-15']]))).toEqual([]); // hace 6 días
    expect(planReminders(r, cfg, TODAY, new Map([['a', '2026-10-14']]))).toHaveLength(1); // hace 7 días
  });

  it('un cliente con muchas partidas es UN aviso: detalla las 20 más atrasadas y suma todas', () => {
    const many = Array.from({ length: 25 }, (_, i) => rec({ id: `r${String(i).padStart(2, '0')}`, dueDate: `2026-10-${String(1 + (i % 15)).padStart(2, '0')}`, originalCents: 100 }));
    const [plan] = planReminders(many, cfg, TODAY, new Map());
    expect(plan!.items).toHaveLength(20);
    expect(plan!.extraItems).toBe(5);
    expect(plan!.receivableIds).toHaveLength(25);
    expect(plan!.totalCents).toBe(2500);
    expect(plan!.items[0]!.daysOverdue).toBeGreaterThanOrEqual(plan!.items[19]!.daysOverdue);
  });

  it('no suma monedas distintas: cada una va en su propio aviso', () => {
    const plans = planReminders([rec({ id: 'u' }), rec({ id: 'e', currencyCode: 'EUR' })], cfg, TODAY, new Map());
    expect(plans.map((p) => p.currencyCode).sort()).toEqual(['EUR', 'USD']);
  });
});

describe('configuración de recordatorios', () => {
  it('sin configuración guardada están APAGADOS', async () => {
    const w = buildWorld();
    const s = await w.useCases.getReminderSettings.execute({ organizationId: ORG_A });
    expect(s).toMatchObject({ enabled: false, firstAfterDays: 3, repeatEveryDays: 7 });
  });

  it('rechaza repetir más de una vez por semana y días fuera de rango (con el campo)', async () => {
    const w = buildWorld();
    const bad = await enable(w, { repeatEveryDays: 3 }).catch((e) => e);
    expect(bad).toBeInstanceOf(ValidationError);
    expect(bad.details.map((d: { field: string }) => d.field)).toEqual(['repeatEveryDays']);
    const bad2 = await enable(w, { firstAfterDays: 0, repeatEveryDays: 100 }).catch((e) => e);
    expect(bad2.details.map((d: { field: string }) => d.field)).toEqual(['firstAfterDays', 'repeatEveryDays']);
    expect(w.events()).toHaveLength(0);
  });

  it('cambiarla deja UN evento con el valor anterior y el nuevo, y quién lo hizo', async () => {
    const w = buildWorld();
    await enable(w);
    const [e] = w.events('treasury.reminder_settings.updated');
    expect(e!.payload).toMatchObject({ organizationId: ORG_A, enabled: true, previousEnabled: false, firstAfterDays: 3, previousFirstAfterDays: 3, updatedBy: USER_1 });
    expect(w.events()).toHaveLength(1);
  });
});

describe('enviar recordatorios', () => {
  it('con los recordatorios APAGADOS no sale nada, ni pidiéndolo una persona', async () => {
    const w = buildWorld();
    await overdueInvoice(w, { issued: '2026-10-01' });
    await expect(run(w)).rejects.toBeInstanceOf(RemindersDisabledError);
    expect(w.events('treasury.receivable.overdue')).toHaveLength(0);
    expect(w.data.reminders).toHaveLength(0);
  });

  it('un evento por cliente con TODAS sus partidas vencidas, el correo y quién lo disparó', async () => {
    const w = buildWorld();
    const a = await overdueInvoice(w, { issued: '2026-10-01', total: 11500 });
    const b = await overdueInvoice(w, { issued: '2026-10-10', total: 5750 });
    await overdueInvoice(w, { issued: '2026-10-20' }); // 1 día: no toca
    await enable(w);

    const result = await run(w);
    expect(result).toMatchObject({ runDate: TODAY, customersReminded: 1, receivablesReminded: 2, customersWithoutEmail: 0, customersAlreadyReminded: 0 });

    const events = w.events('treasury.receivable.overdue');
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({
      organizationId: ORG_A,
      organizationName: 'MI EMPRESA S.A.',
      customerId: CUSTOMER_1,
      email: 'uno@cliente.test',
      currencyCode: 'USD',
      totalOverdueCents: 17250,
      receivableCount: 2,
      trigger: 'manual',
      triggeredBy: USER_1,
    });
    expect((events[0]!.payload.items as { receivableId: string; daysOverdue: number }[]).map((i) => [i.receivableId, i.daysOverdue])).toEqual([[a, 20], [b, 11]]);
    expect(w.data.reminders.map((r) => r.receivableId).sort()).toEqual([a, b].sort());
  });

  it('un cliente SIN correo no recibe nada y no queda marcado como avisado (cuando tenga correo se le avisa)', async () => {
    const w = buildWorld();
    await overdueInvoice(w, { issued: '2026-10-01', customerId: CUSTOMER_2, name: 'CLIENTE DOS' });
    await enable(w);
    expect(await run(w)).toMatchObject({ customersReminded: 0, customersWithoutEmail: 1 });
    expect(w.events('treasury.receivable.overdue')).toHaveLength(0);
    expect(w.data.reminders).toHaveLength(0);

    w.knownCustomers.set(CUSTOMER_2, { id: CUSTOMER_2, businessName: 'CLIENTE DOS', identification: null, email: 'dos@cliente.test' });
    expect(await run(w)).toMatchObject({ customersReminded: 1 });
  });

  it('idempotente: correrlo otra vez el mismo día no avisa de nuevo', async () => {
    const w = buildWorld();
    await overdueInvoice(w, { issued: '2026-10-01' });
    await enable(w);
    await run(w);
    expect(await run(w)).toMatchObject({ customersReminded: 0 });
    expect(w.events('treasury.receivable.overdue')).toHaveLength(1);
  });

  it('si OTRA réplica avisa mientras esta consulta al cliente, el UNIQUE (partida, día) evita el doble aviso', async () => {
    const w = buildWorld();
    const id = await overdueInvoice(w, { issued: '2026-10-01' });
    await enable(w);
    // La otra réplica confirma justo durante la llamada HTTP a customer-service (fuera de la transacción).
    const original = w.customers.findById.bind(w.customers);
    w.customers.findById = async (org, customerId) => {
      w.data.reminders.push({ organizationId: ORG_A, receivableId: id, customerId, reminderDate: TODAY, trigger: 'scheduled', sentBy: null });
      return original(org, customerId);
    };
    const r = await run(w);
    expect(r).toMatchObject({ customersReminded: 0, customersAlreadyReminded: 1 });
    expect(w.events('treasury.receivable.overdue')).toHaveLength(0);
    expect(w.data.reminders).toHaveLength(1);
  });

  it('un recordatorio por partida y semana como máximo', async () => {
    const w = buildWorld();
    await overdueInvoice(w, { issued: '2026-10-01' });
    await enable(w);
    await run(w);
    w.setNow('2026-10-24T15:00:00.000Z'); // +3 días
    expect(await run(w)).toMatchObject({ customersReminded: 0 });
    w.setNow('2026-10-27T15:00:00.000Z'); // +6
    expect(await run(w)).toMatchObject({ customersReminded: 0 });
    w.setNow('2026-10-28T15:00:00.000Z'); // +7
    expect(await run(w)).toMatchObject({ customersReminded: 1, runDate: '2026-10-28' });
    expect(w.events('treasury.receivable.overdue')).toHaveLength(2);
  });

  it('lo que se cobra deja de recordarse', async () => {
    const w = buildWorld();
    const id = await overdueInvoice(w, { issued: '2026-10-01', total: 11500 });
    await enable(w);
    const receipt = await w.useCases.createReceipt.execute({
      organizationId: ORG_A, customerId: CUSTOMER_1, userId: USER_1,
      receipt: { receiptDate: TODAY, method: 'transfer', reference: 'T-1', totalCents: 11500, lines: [{ receivableId: id, appliedCents: 11500 }] } as never,
    });
    await w.useCases.postReceipt.execute({ organizationId: ORG_A, receiptId: receipt.id, userId: USER_1 });
    expect(await run(w)).toMatchObject({ customersReminded: 0 });
  });

  it('un catálogo caído detiene la corrida SIN dejar nada a medias, y se reintenta', async () => {
    const down = buildWorld({ customersDown: true });
    await overdueInvoice(down, { issued: '2026-10-01' });
    await enable(down);
    await expect(run(down)).rejects.toBeInstanceOf(CatalogUnavailableError);
    expect(down.data.reminders).toHaveLength(0);
    expect(down.events('treasury.receivable.overdue')).toHaveLength(0);
    expect((await down.useCases.getReminderSettings.execute({ organizationId: ORG_A })).lastRunOn).toBeNull();

    const w = buildWorld();
    await overdueInvoice(w, { issued: '2026-10-01' });
    await enable(w);
    w.organizations.down = true;
    await expect(run(w)).rejects.toBeInstanceOf(CatalogUnavailableError);
    expect(w.events('treasury.receivable.overdue')).toHaveLength(0);
    w.organizations.down = false;
    expect(await run(w)).toMatchObject({ customersReminded: 1 });
  });

  it('si la organización no completó su perfil, el correo se firma con un texto genérico', async () => {
    const w = buildWorld();
    w.organizations.name = null;
    await overdueInvoice(w, { issued: '2026-10-01' });
    await enable(w);
    await run(w);
    expect(w.events('treasury.receivable.overdue')[0]!.payload.organizationName).toBe('Su proveedor');
  });

  it('aislamiento: los recordatorios de una organización no tocan las deudas de otra', async () => {
    const w = buildWorld();
    await overdueInvoice(w, { issued: '2026-10-01' });
    await w.useCases.setReminderSettings.execute({ organizationId: ORG_B, enabled: true, firstAfterDays: 3, repeatEveryDays: 7, userId: USER_1 });
    const r = await w.useCases.runReminders.execute({ organizationId: ORG_B, trigger: 'manual', userId: USER_1 });
    expect(r).toMatchObject({ customersReminded: 0 });
    expect(w.events('treasury.receivable.overdue')).toHaveLength(0);
    expect(await w.useCases.getReminderSettings.execute({ organizationId: ORG_A })).toMatchObject({ enabled: false });
  });
});

describe('vista previa', () => {
  it('dice a quién se avisaría SIN enviar ni registrar nada, aunque estén apagados', async () => {
    const w = buildWorld();
    await overdueInvoice(w, { issued: '2026-10-01' });
    await overdueInvoice(w, { issued: '2026-10-02', customerId: CUSTOMER_2, name: 'CLIENTE DOS' });
    const preview = await w.useCases.previewReminders.execute({ organizationId: ORG_A });
    expect(preview).toMatchObject({ enabled: false, receivableCount: 2, withoutEmailCount: 1 });
    expect(Object.fromEntries(preview.customers.map((c) => [c.plan.customerId, c.email]))).toEqual({ [CUSTOMER_1]: 'uno@cliente.test', [CUSTOMER_2]: null });
    expect(w.events('treasury.receivable.overdue')).toHaveLength(0);
    expect(w.data.reminders).toHaveLength(0);
  });
});

describe('proceso diario', () => {
  it('antes de las 09:00 locales no envía; después, una sola vez al día', async () => {
    const w = buildWorld();
    await overdueInvoice(w, { issued: '2026-10-01' });
    await enable(w);

    w.setNow('2026-10-21T12:00:00.000Z'); // 07:00 en Guayaquil
    expect(await w.useCases.runDueReminders.execute()).toBe(0);
    expect(w.events('treasury.receivable.overdue')).toHaveLength(0);

    w.setNow('2026-10-21T15:00:00.000Z'); // 10:00
    expect(await w.useCases.runDueReminders.execute()).toBe(1);
    expect(w.events('treasury.receivable.overdue')).toHaveLength(1);
    expect(w.events('treasury.receivable.overdue')[0]!.payload).toMatchObject({ trigger: 'scheduled', triggeredBy: null });

    expect(await w.useCases.runDueReminders.execute()).toBe(0); // hoy ya corrió
    expect((await w.useCases.getReminderSettings.execute({ organizationId: ORG_A })).lastRunOn).toBe(TODAY);
  });

  it('no corre para organizaciones con los recordatorios apagados', async () => {
    const w = buildWorld();
    await overdueInvoice(w, { issued: '2026-10-01' });
    expect(await w.useCases.runDueReminders.execute()).toBe(0);
    expect(w.events('treasury.receivable.overdue')).toHaveLength(0);
  });

  it('un fallo en una organización no detiene a las demás y se reintenta en la próxima vuelta', async () => {
    const w = buildWorld({ customersDown: true });
    await overdueInvoice(w, { issued: '2026-10-01' });
    await enable(w);
    expect(await w.useCases.runDueReminders.execute()).toBe(0);
    expect(w.logs.some((l) => l.includes('no corrieron'))).toBe(true);
    // no quedó marcado como «hoy ya corrí»: cuando el catálogo vuelve, la siguiente vuelta sí corre
    expect((await w.useCases.getReminderSettings.execute({ organizationId: ORG_A })).lastRunOn).toBeNull();
    w.customers.down = false;
    expect(await w.useCases.runDueReminders.execute()).toBe(1);
    expect(w.events('treasury.receivable.overdue')).toHaveLength(1);
  });

  it('volver a encender los recordatorios no hereda «hoy ya corrí»', async () => {
    const w = buildWorld();
    await overdueInvoice(w, { issued: '2026-10-01' });
    await enable(w);
    await w.useCases.runDueReminders.execute();
    await w.useCases.setReminderSettings.execute({ organizationId: ORG_A, enabled: false, firstAfterDays: 3, repeatEveryDays: 7, userId: USER_1 });
    await w.useCases.setReminderSettings.execute({ organizationId: ORG_A, enabled: true, firstAfterDays: 3, repeatEveryDays: 7, userId: USER_1 });
    expect((await w.useCases.getReminderSettings.execute({ organizationId: ORG_A })).lastRunOn).toBeNull();
  });
});

describe('HTTP de recordatorios', () => {
  async function call(w: World, method: string, path: string, opts: { perms?: string[]; body?: unknown } = {}) {
    const res = await w.app.request(path, { method, headers: headers(opts.perms ?? ALL_PERMISSIONS), body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  }
  const ROUTES = [
    { method: 'GET', path: '/treasury/reminders/settings' },
    { method: 'PUT', path: '/treasury/reminders/settings', body: { enabled: true, firstAfterDays: 3, repeatEveryDays: 7 } },
    { method: 'GET', path: '/treasury/reminders/preview' },
    { method: 'POST', path: '/treasury/reminders/run' },
  ];

  it.each(ROUTES)('$method $path exige `reminder:manage` (ni `receivable:read` ni `receivable:export` bastan)', async (route) => {
    const w = buildWorld();
    for (const perms of [[], ['receivable:read', 'receivable:export', 'receipt:read', 'receipt:create', 'receipt:void', 'customer_terms:manage']]) {
      expect((await call(w, route.method, route.path, { perms, body: route.body })).status).toBe(403);
    }
    expect((await call(w, route.method, route.path, { perms: ['reminder:manage'], body: route.body })).status).not.toBe(403);
  });

  it('«enviar ahora» con los recordatorios apagados responde 409 REMINDERS_DISABLED', async () => {
    const w = buildWorld();
    const r = await call(w, 'POST', '/treasury/reminders/run');
    expect(r.status).toBe(409);
    expect(r.json.code).toBe('REMINDERS_DISABLED');
  });

  it('un campo mal escrito falla (strict) y el rango se explica por campo (422)', async () => {
    const w = buildWorld();
    expect((await call(w, 'PUT', '/treasury/reminders/settings', { body: { enabled: true, firstAfterDays: 3, repeatEveryDays: 7, sendToAll: true } })).status).toBe(422);
    const r = await call(w, 'PUT', '/treasury/reminders/settings', { body: { enabled: true, firstAfterDays: 3, repeatEveryDays: 2 } });
    expect(r.status).toBe(422);
    expect(r.json.details[0].field).toBe('repeatEveryDays');
  });

  it('la vista previa no entrega correos completos (solo una pista para reconocerlos)', async () => {
    const w = buildWorld();
    await overdueInvoice(w, { issued: '2026-10-01' });
    const r = await call(w, 'GET', '/treasury/reminders/preview');
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.json)).not.toContain('uno@cliente.test');
    expect(r.json.customers[0]).toMatchObject({ hasEmail: true, emailHint: 'un***@cliente.test', receivableCount: 1 });
  });

  it('PUT y luego «enviar ahora» (flujo completo por HTTP)', async () => {
    const w = buildWorld();
    await overdueInvoice(w, { issued: '2026-10-01' });
    expect((await call(w, 'PUT', '/treasury/reminders/settings', { body: { enabled: true, firstAfterDays: 3, repeatEveryDays: 7 } })).status).toBe(200);
    const r = await call(w, 'POST', '/treasury/reminders/run');
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ customersReminded: 1, receivablesReminded: 1 });
  });
});
