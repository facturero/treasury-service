import { describe, expect, it } from 'vitest';
import { csvCell, toCsv, Amount } from '../domain/report-csv.js';
import { ALL_PERMISSIONS, buildWorld, CUSTOMER_1, CUSTOMER_2, headers, ORG_A, ORG_B, USER_1, type World } from './helpers.js';

async function debt(w: World, opts: { total?: number; issued?: string; customerId?: string; name?: string } = {}): Promise<string> {
  const customerId = opts.customerId ?? CUSTOMER_1;
  const inv = w.invoice({
    total: opts.total ?? 11500,
    customerId,
    issueDate: `${opts.issued ?? '2026-10-01'}T15:00:00.000Z`,
    customerSnapshot: { id: customerId, businessName: opts.name ?? 'CLIENTE UNO S.A.', identification: '1790012345001' },
  });
  await w.useCases.invoiceIssued.execute(inv);
  return w.receivables().find((r) => r.sourceId === inv.invoiceId)!.id;
}

async function get(w: World, path: string, perms: string[] = ALL_PERMISSIONS, org: string | null = ORG_A) {
  const res = await w.app.request(path, { headers: headers(perms, org) });
  // `text()` descarta el BOM al decodificar: se lee en bytes para poder comprobarlo.
  const bytes = new Uint8Array(await res.arrayBuffer());
  return { status: res.status, text: new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes), bytes, headers: res.headers };
}

const lines = (text: string) => text.replace(/^﻿/, '').trimEnd().split('\r\n');

describe('celdas de CSV', () => {
  it('comillas, comas y saltos de línea se escapan', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('di "hola"')).toBe('"di ""hola"""');
    expect(csvCell('uno\ndos')).toBe('"uno\ndos"');
    expect(csvCell(null)).toBe('');
  });

  it('un texto que empieza como fórmula se neutraliza (el nombre de un cliente lo escribe cualquiera)', () => {
    for (const evil of ['=HYPERLINK("http://x","clic")', '+1+1', '-2+3', '@SUM(A1)', '\tcmd']) {
      expect(csvCell(evil).replace(/^"/, '')).toMatch(/^'/);
    }
  });

  it('los importes siempre llevan dos decimales y un saldo negativo es un número, no una fórmula', () => {
    expect(csvCell(new Amount(1200))).toBe('12.00');
    expect(csvCell(new Amount(-575))).toBe('-5.75');
    expect(csvCell(new Amount(5))).toBe('0.05');
    expect(toCsv([['a', new Amount(100)]])).toBe('a,1.00\r\n');
  });
});

describe('exportar la cartera', () => {
  it('permiso aparte: `receivable:read` NO basta, hace falta `receivable:export`', async () => {
    const w = buildWorld();
    for (const path of ['/treasury/receivables/export', '/treasury/receivables/aging/export', `/treasury/customers/${CUSTOMER_1}/statement/export`]) {
      expect((await get(w, path, ['receivable:read'])).status, path).toBe(403);
      expect((await get(w, path, [])).status, path).toBe(403);
      expect((await get(w, path, ['receivable:export'])).status, path).toBe(200);
    }
    expect(w.events('treasury.report.exported')).toHaveLength(3); // solo las exportaciones que sí salieron
  });

  it('devuelve un CSV con BOM, encabezados en el idioma pedido y una fila por partida', async () => {
    const w = buildWorld();
    await debt(w, { issued: '2026-10-01', total: 11500 });
    await debt(w, { issued: '2026-10-15', total: 5750, customerId: CUSTOMER_2, name: 'CLIENTE DOS' });

    const es = await get(w, '/treasury/receivables/export?asOf=2026-10-21');
    expect(es.status).toBe(200);
    expect(es.headers.get('content-type')).toContain('text/csv');
    expect(es.headers.get('content-disposition')).toBe('attachment; filename="cartera-2026-10-21.csv"');
    expect(es.headers.get('cache-control')).toBe('no-store');
    expect([...es.bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // BOM: sin él Excel rompe los acentos
    const rows = lines(es.text);
    expect(rows[0]).toBe('Documento,Cliente,Identificación,Emisión,Vencimiento,Días de atraso,Importe original,Aplicado,Saldo,Estado,Moneda');
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.includes('CLIENTE UNO'))).toMatch(/,2026-10-01,2026-10-01,20,115\.00,0\.00,115\.00,Abierta,USD$/);

    expect(lines((await get(w, '/treasury/receivables/export?lang=en')).text)[0]).toBe('Document,Customer,Tax ID,Issued,Due,Days overdue,Original amount,Applied,Balance,Status,Currency');
    expect(lines((await get(w, '/treasury/receivables/export?lang=fr')).text)[0]).toContain('Montant initial');
  });

  it('respeta los MISMOS filtros que la pantalla y no pagina', async () => {
    const w = buildWorld();
    for (let i = 0; i < 30; i += 1) await debt(w, { issued: '2026-10-01', total: 1150 });
    await debt(w, { issued: '2026-10-20', customerId: CUSTOMER_2, name: 'CLIENTE DOS' });
    const all = lines((await get(w, '/treasury/receivables/export?asOf=2026-10-21')).text);
    expect(all).toHaveLength(1 + 31); // más que la página de la pantalla (25)
    const only = lines((await get(w, `/treasury/receivables/export?customerId=${CUSTOMER_2}`)).text);
    expect(only).toHaveLength(2);
    const overdue = lines((await get(w, '/treasury/receivables/export?overdueOnly=true&asOf=2026-10-21')).text);
    expect(overdue).toHaveLength(1 + 31); // la de CLIENTE DOS venció ayer: también es vencida
  });

  it('deja UN evento `treasury.report.exported` con el reporte, los filtros, las filas y quién', async () => {
    const w = buildWorld();
    await debt(w);
    await debt(w);
    await get(w, `/treasury/receivables/export?asOf=2026-10-21&overdueOnly=true&q=UNO`);
    const events = w.events('treasury.report.exported');
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({
      organizationId: ORG_A,
      report: 'receivables',
      format: 'csv',
      rowCount: 2,
      exportedBy: USER_1,
      filters: { asOf: '2026-10-21', overdueOnly: true, q: 'UNO' },
    });
    // sin claves vacías
    expect(Object.keys(events[0]!.payload.filters as object).sort()).toEqual(['asOf', 'overdueOnly', 'q']);
  });

  it('el nombre de un cliente con una fórmula sale neutralizado', async () => {
    const w = buildWorld();
    await debt(w, { name: '=HYPERLINK("http://malo.test","clic")' });
    const { text } = await get(w, '/treasury/receivables/export');
    expect(text).not.toMatch(/(^|,)=HYPERLINK/m);
    expect(text).toContain(`"'=HYPERLINK(""http://malo.test"",""clic"")"`);
  });

  it('aislamiento: no exporta la cartera de otra organización', async () => {
    const w = buildWorld();
    await debt(w);
    expect(lines((await get(w, '/treasury/receivables/export', ALL_PERMISSIONS, ORG_B)).text)).toHaveLength(1); // solo encabezado
  });

  it('un rango imposible se rechaza con 422 y no deja evento', async () => {
    const w = buildWorld();
    expect((await get(w, '/treasury/receivables/export?asOf=mañana')).status).toBe(422);
    expect(w.events('treasury.report.exported')).toHaveLength(0);
  });
});

describe('exportar la antigüedad y el estado de cuenta', () => {
  it('antigüedad: una fila por cliente más los totales', async () => {
    const w = buildWorld();
    await debt(w, { issued: '2026-10-01', total: 11500 }); // 20 días → 1-30
    await debt(w, { issued: '2026-07-01', total: 5750, customerId: CUSTOMER_2, name: 'CLIENTE DOS' }); // 112 días → +90
    const res = await get(w, '/treasury/receivables/aging/export?asOf=2026-10-21');
    const rows = lines(res.text);
    expect(rows[0]).toBe('Cliente,Corriente,1 a 30 días,31 a 60 días,61 a 90 días,Más de 90 días,Total');
    expect(rows).toContain('CLIENTE UNO S.A.,0.00,115.00,0.00,0.00,0.00,115.00');
    expect(rows).toContain('CLIENTE DOS,0.00,0.00,0.00,0.00,57.50,57.50');
    expect(rows.at(-1)).toBe('TOTAL,0.00,115.00,0.00,0.00,57.50,172.50');
    expect(w.events('treasury.report.exported')[0]!.payload).toMatchObject({ report: 'aging', rowCount: 2, filters: { asOf: '2026-10-21' } });
  });

  it('estado de cuenta: encabezado, partidas y totales; el evento lleva el cliente', async () => {
    const w = buildWorld();
    await debt(w, { issued: '2026-10-01', total: 11500 });
    const res = await get(w, `/treasury/customers/${CUSTOMER_1}/statement/export?asOf=2026-10-21&lang=en`);
    expect(res.headers.get('content-disposition')).toContain('estado-de-cuenta-2026-10-21.csv');
    const rows = lines(res.text);
    expect(rows.slice(0, 3)).toEqual(['Statement of account', 'Customer,CLIENTE UNO S.A.', 'As of,2026-10-21']);
    expect(rows).toContain('Document,Issued,Due,Days overdue,Original amount,Applied,Balance,Status,Currency');
    expect(rows).toContain('Owed,115.00');
    expect(rows).toContain('Net,115.00');
    expect(w.events('treasury.report.exported')[0]!.payload).toMatchObject({ report: 'statement', customerId: CUSTOMER_1, rowCount: 1 });
  });

  it('el neto del estado de cuenta exportado es el mismo que el de la pantalla (deuda − saldo a favor)', async () => {
    const w = buildWorld();
    await debt(w, { total: 11500 });
    const screen = JSON.parse((await get(w, `/treasury/customers/${CUSTOMER_1}/statement`)).text);
    const csv = lines((await get(w, `/treasury/customers/${CUSTOMER_1}/statement/export`)).text);
    expect(csv).toContain(`Neto,${(screen.netCents / 100).toFixed(2)}`);
  });
});
