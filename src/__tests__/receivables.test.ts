import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CatalogUnavailableError } from '../domain/errors.js';
import { balanceOf } from '../domain/receivable.js';
import { buildWorld, CUSTOMER_1, CUSTOMER_2, ORG_A, ORG_B } from './helpers.js';

describe('factura emitida → partida de cartera', () => {
  it('abre una partida con el cliente, el importe y el vencimiento por días de crédito', async () => {
    const w = buildWorld();
    await w.useCases.setCustomerTerms.execute({ organizationId: ORG_A, customerId: CUSTOMER_1, creditDays: 30, creditLimitCents: null, userId: 'u' });
    const inv = w.invoice({ total: 11500 });

    const result = await w.useCases.invoiceIssued.execute(inv);

    expect(result.outcome).toBe('applied');
    const [r] = w.receivables();
    expect(r).toMatchObject({ customerId: CUSTOMER_1, customerName: 'CLIENTE UNO S.A.', sourceType: 'invoice', sourceId: inv.invoiceId, originalCents: 11500, status: 'open', currencyCode: 'USD' });
    expect(r!.issueDate).toBe('2026-10-21');
    expect(r!.dueDate).toBe('2026-11-20');
    expect(w.events('treasury.receivable.opened')).toHaveLength(1);
  });

  it('sin condiciones de crédito vence el mismo día (contado)', async () => {
    const w = buildWorld();
    await w.useCases.invoiceIssued.execute(w.invoice());
    expect(w.receivables()[0]!.dueDate).toBe('2026-10-21');
  });

  it('cambiar los días de crédito NO reescribe las partidas ya abiertas', async () => {
    const w = buildWorld();
    await w.useCases.setCustomerTerms.execute({ organizationId: ORG_A, customerId: CUSTOMER_1, creditDays: 15, creditLimitCents: null, userId: 'u' });
    const first = w.invoice();
    await w.useCases.invoiceIssued.execute(first);
    await w.useCases.setCustomerTerms.execute({ organizationId: ORG_A, customerId: CUSTOMER_1, creditDays: 60, creditLimitCents: null, userId: 'u' });
    const second = w.invoice();
    await w.useCases.invoiceIssued.execute(second);

    const due = (id: string) => w.receivables().find((r) => r.sourceId === id)!.dueDate;
    expect(due(first.invoiceId)).toBe('2026-11-05'); // 15 días: no cambió
    expect(due(second.invoiceId)).toBe('2026-12-20'); // 60 días
  });

  it('la fecha de emisión a las 23:30 hora de Ecuador es ese día (no el siguiente de UTC)', async () => {
    const w = buildWorld();
    // 2026-10-20 23:30 en Guayaquil = 2026-10-21 04:30 UTC
    await w.useCases.invoiceIssued.execute(w.invoice({ issueDate: '2026-10-21T04:30:00.000Z' }));
    expect(w.receivables()[0]!.issueDate).toBe('2026-10-20');
  });

  it('una fecha de emisión sin hora no se corre un día', async () => {
    const w = buildWorld();
    await w.useCases.invoiceIssued.execute(w.invoice({ issueDate: '2026-11-01' }));
    expect(w.receivables()[0]!.issueDate).toBe('2026-11-01');
  });

  it('la nota de débito también es deuda del cliente', async () => {
    const w = buildWorld();
    await w.useCases.invoiceIssued.execute(w.invoice({ documentTypeCode: '05', total: 2300 }));
    expect(w.receivables()[0]).toMatchObject({ originalCents: 2300, status: 'open' });
  });

  it('reenviar el mismo comprobante (otro eventId) no duplica la partida ni el evento', async () => {
    const w = buildWorld();
    const inv = w.invoice();
    await w.useCases.invoiceIssued.execute(inv);
    const again = await w.useCases.invoiceIssued.execute(inv);
    expect(again.outcome).toBe('duplicate');
    expect(w.receivables()).toHaveLength(1);
    expect(w.events('treasury.receivable.opened')).toHaveLength(1);
  });

  describe('lo que NO abre partida (y por qué)', () => {
    it('una venta del POS: ya se cobró', async () => {
      const w = buildWorld();
      const r = await w.useCases.invoiceIssued.execute(w.invoice({ posSaleId: randomUUID() }));
      expect(r).toMatchObject({ outcome: 'skipped' });
      expect(w.receivables()).toHaveLength(0);
    });

    it('cobro inmediato (efectivo y tarjetas): no queda nada por cobrar', async () => {
      const w = buildWorld();
      for (const code of ['01', '16', '19']) {
        expect(await w.useCases.invoiceIssued.execute(w.invoice({ paymentMethodCode: code }))).toMatchObject({ outcome: 'skipped' });
      }
      expect(w.receivables()).toHaveLength(0);
    });

    it('una forma de pago «por cobrar» (compensación de deudas) SÍ abre partida', async () => {
      const w = buildWorld();
      await w.useCases.invoiceIssued.execute(w.invoice({ paymentMethodCode: '15' }));
      expect(w.receivables()).toHaveLength(1);
    });

    it('moneda distinta de la base: contabilidad la bloquea, tesorería no la abre', async () => {
      const w = buildWorld();
      expect(await w.useCases.invoiceIssued.execute(w.invoice({ currencyCode: 'EUR' }))).toMatchObject({ outcome: 'skipped' });
      expect(w.receivables()).toHaveLength(0);
    });

    it('documento anterior a la fecha de arranque de la contabilización', async () => {
      const w = buildWorld({ settings: { autoPostingFrom: '2026-10-22' } });
      expect(await w.useCases.invoiceIssued.execute(w.invoice())).toMatchObject({ outcome: 'skipped' });
      expect(w.receivables()).toHaveLength(0);
    });

    it('contabilización automática apagada', async () => {
      const w = buildWorld({ settings: { autoPosting: false } });
      expect(await w.useCases.invoiceIssued.execute(w.invoice())).toMatchObject({ outcome: 'skipped' });
    });

    it('la organización sin contabilidad configurada', async () => {
      const w = buildWorld({ settings: null });
      expect(await w.useCases.invoiceIssued.execute(w.invoice())).toMatchObject({ outcome: 'skipped' });
    });

    it('un comprobante que no cuadra (ventas + IVA ≠ total) o con un impuesto que no es IVA', async () => {
      const w = buildWorld();
      expect(await w.useCases.invoiceIssued.execute(w.invoice({ lines: [{ subtotalCents: 100, taxes: [{ kind: 'vat', amountCents: 15 }] }], totalCents: 999 }))).toMatchObject({ outcome: 'skipped' });
      expect(await w.useCases.invoiceIssued.execute(w.invoice({ lines: [{ subtotalCents: 10000, taxes: [{ kind: 'ice', amountCents: 1500 }] }] }))).toMatchObject({ outcome: 'skipped' });
      expect(w.receivables()).toHaveLength(0);
    });

    it('un evento sin organización, sin importe, sin cliente o de un tipo sin regla', async () => {
      const w = buildWorld();
      expect(await w.useCases.invoiceIssued.execute({ ...w.invoice(), organizationId: '' })).toMatchObject({ outcome: 'skipped' });
      expect(await w.useCases.invoiceIssued.execute(w.invoice({ totalCents: 0 }))).toMatchObject({ outcome: 'skipped' });
      expect(await w.useCases.invoiceIssued.execute(w.invoice({ customerId: null, customerSnapshot: null }))).toMatchObject({ outcome: 'skipped' });
      expect(await w.useCases.invoiceIssued.execute(w.invoice({ documentTypeCode: '07' }))).toMatchObject({ outcome: 'skipped' });
      expect(w.receivables()).toHaveLength(0);
    });
  });
});

describe('nota de crédito', () => {
  it('con su factura conocida: abona a esa partida (parcial) y no abre saldo a favor', async () => {
    const w = buildWorld();
    const inv = w.invoice({ total: 11500 });
    await w.useCases.invoiceIssued.execute(inv);
    await w.useCases.invoiceIssued.execute(w.invoice({ documentTypeCode: '04', total: 2300, relatedInvoiceId: inv.invoiceId }));

    const r = w.receivables()[0]!;
    const derived = (await w.useCases.getReceivable.execute({ organizationId: ORG_A, receivableId: r.id }));
    expect(derived.status).toBe('partial');
    expect(balanceOf(derived)).toBe(9200);
    expect(w.data.advances.size).toBe(0);
    expect(w.events('treasury.receivable.credited')).toHaveLength(1);
  });

  it('por el total de la factura: la partida queda pagada', async () => {
    const w = buildWorld();
    const inv = w.invoice({ total: 11500 });
    await w.useCases.invoiceIssued.execute(inv);
    await w.useCases.invoiceIssued.execute(w.invoice({ documentTypeCode: '04', total: 11500, relatedInvoiceId: inv.invoiceId }));
    const derived = await w.useCases.getReceivable.execute({ organizationId: ORG_A, receivableId: w.receivables()[0]!.id });
    expect(derived.status).toBe('paid');
    expect(balanceOf(derived)).toBe(0);
  });

  it('reenviada NO abona dos veces', async () => {
    const w = buildWorld();
    const inv = w.invoice({ total: 11500 });
    await w.useCases.invoiceIssued.execute(inv);
    const nc = w.invoice({ documentTypeCode: '04', total: 2300, relatedInvoiceId: inv.invoiceId });
    await w.useCases.invoiceIssued.execute(nc);
    // El segundo intento choca con el UNIQUE de la aplicación: es un duplicado limpio, no un error que llene la cola de fallos.
    expect(await w.useCases.invoiceIssued.execute(nc)).toMatchObject({ outcome: 'duplicate' });
    const derived = await w.useCases.getReceivable.execute({ organizationId: ORG_A, receivableId: w.receivables()[0]!.id });
    expect(balanceOf(derived)).toBe(9200);
    expect(w.data.creditApplications).toHaveLength(1);
  });

  it('sin factura previa: queda como SALDO A FAVOR del cliente', async () => {
    const w = buildWorld();
    await w.useCases.invoiceIssued.execute(w.invoice({ documentTypeCode: '04', total: 2300, relatedInvoiceId: null }));
    expect(w.receivables()).toHaveLength(0);
    const [advance] = [...w.data.advances.values()];
    expect(advance).toMatchObject({ customerId: CUSTOMER_1, originalCents: 2300, origin: 'credit_note' });
    expect(w.events('treasury.customer_advance.opened')).toHaveLength(1);
  });

  it('el excedente sobre lo que debía la factura queda como saldo a favor', async () => {
    const w = buildWorld();
    const inv = w.invoice({ total: 1000 });
    await w.useCases.invoiceIssued.execute(inv);
    await w.useCases.invoiceIssued.execute(w.invoice({ documentTypeCode: '04', total: 1500, relatedInvoiceId: inv.invoiceId }));
    expect(balanceOf(await w.useCases.getReceivable.execute({ organizationId: ORG_A, receivableId: w.receivables()[0]!.id }))).toBe(0);
    expect([...w.data.advances.values()][0]!.originalCents).toBe(500);
  });

  it('llega ANTES que su factura: queda como saldo a favor y se aplica al llegar la factura', async () => {
    const w = buildWorld();
    const invoiceId = randomUUID();
    await w.useCases.invoiceIssued.execute(w.invoice({ documentTypeCode: '04', total: 1000, relatedInvoiceId: invoiceId }));
    await w.useCases.invoiceIssued.execute(w.invoice({ invoiceId, total: 5750 }));

    const derived = await w.useCases.getReceivable.execute({ organizationId: ORG_A, receivableId: w.receivables()[0]!.id });
    expect(balanceOf(derived)).toBe(4750);
    expect(derived.status).toBe('partial');
    const advance = [...w.data.advances.values()][0]!;
    expect(advance.originalCents - (w.data.advanceApplications.reduce((a, x) => a + x.appliedCents, 0))).toBe(0);
  });

  it('un saldo a favor no se aplica a la factura de OTRO cliente', async () => {
    const w = buildWorld();
    await w.useCases.invoiceIssued.execute(w.invoice({ documentTypeCode: '04', total: 1000, customerId: CUSTOMER_1 }));
    await w.useCases.invoiceIssued.execute(w.invoice({ total: 5750, customerId: CUSTOMER_2, customerSnapshot: { id: CUSTOMER_2, businessName: 'CLIENTE DOS', identification: '0912345678' } }));
    const derived = await w.useCases.getReceivable.execute({ organizationId: ORG_A, receivableId: w.receivables()[0]!.id });
    expect(balanceOf(derived)).toBe(5750);
  });
});

describe('factura anulada', () => {
  it('cierra la partida (cancelled) y publica el motivo', async () => {
    const w = buildWorld();
    const inv = w.invoice();
    await w.useCases.invoiceIssued.execute(inv);
    const result = await w.useCases.invoiceVoided.execute({ organizationId: ORG_A, invoiceId: inv.invoiceId, number: inv.number, issueDate: inv.issueDate, reason: 'Error de digitación' });

    expect(result.outcome).toBe('cancelled');
    expect(w.receivables()[0]!.status).toBe('cancelled');
    const [event] = w.events('treasury.receivable.cancelled');
    expect(event!.payload).toMatchObject({ reason: 'Error de digitación' });
  });

  it('anular dos veces es idempotente', async () => {
    const w = buildWorld();
    const inv = w.invoice();
    await w.useCases.invoiceIssued.execute(inv);
    const payload = { organizationId: ORG_A, invoiceId: inv.invoiceId, number: inv.number, issueDate: inv.issueDate };
    await w.useCases.invoiceVoided.execute(payload);
    const again = await w.useCases.invoiceVoided.execute(payload);
    expect(again.outcome).toBe('duplicate');
    expect(w.events('treasury.receivable.cancelled')).toHaveLength(1);
  });

  it('la anulación llega ANTES que la emisión: la emisión posterior no abre deuda', async () => {
    const w = buildWorld();
    const inv = w.invoice();
    await w.useCases.invoiceVoided.execute({ organizationId: ORG_A, invoiceId: inv.invoiceId, number: inv.number, issueDate: inv.issueDate });
    const issued = await w.useCases.invoiceIssued.execute(inv);
    expect(issued.outcome).toBe('duplicate');
    // La partida «fantasma» no es cartera: no aparece en el listado ni en el estado de cuenta.
    const list = await w.useCases.listReceivables.execute({ organizationId: ORG_A, filters: { page: 1, pageSize: 25 } });
    expect(list.page.items).toHaveLength(0);
  });

  it('con una nota de crédito encima, la partida anulada deja el saldo EN CONTRA (así lo dice el libro mayor)', async () => {
    const w = buildWorld();
    const inv = w.invoice({ total: 11500 });
    await w.useCases.invoiceIssued.execute(inv);
    await w.useCases.invoiceIssued.execute(w.invoice({ documentTypeCode: '04', total: 2300, relatedInvoiceId: inv.invoiceId }));
    await w.useCases.invoiceVoided.execute({ organizationId: ORG_A, invoiceId: inv.invoiceId, number: inv.number, issueDate: inv.issueDate });
    const derived = await w.useCases.getReceivable.execute({ organizationId: ORG_A, receivableId: w.receivables()[0]!.id });
    expect(derived.status).toBe('cancelled');
    expect(balanceOf(derived)).toBe(-2300);
  });
});

describe('aislamiento entre organizaciones', () => {
  it('la cartera de A no existe para B: ni listado, ni detalle, ni estado de cuenta, ni antigüedad', async () => {
    const w = buildWorld();
    const inv = w.invoice();
    await w.useCases.invoiceIssued.execute(inv);
    const id = w.receivables()[0]!.id;

    const list = await w.useCases.listReceivables.execute({ organizationId: ORG_B, filters: { page: 1, pageSize: 25 } });
    expect(list.page.total).toBe(0);
    await expect(w.useCases.getReceivable.execute({ organizationId: ORG_B, receivableId: id })).rejects.toMatchObject({ code: 'RECEIVABLE_NOT_FOUND' });
    await expect(w.useCases.getReceivableDetail.execute({ organizationId: ORG_B, receivableId: id })).rejects.toMatchObject({ httpStatus: 404 });
    const statement = await w.useCases.getStatement.execute({ organizationId: ORG_B, customerId: CUSTOMER_1 });
    expect(statement.receivables).toHaveLength(0);
    expect((await w.useCases.getAging.execute({ organizationId: ORG_B })).totals.totalCents).toBe(0);
  });

  it('el mismo comprobante en dos organizaciones abre dos partidas independientes', async () => {
    const w = buildWorld();
    const inv = w.invoice();
    await w.useCases.invoiceIssued.execute(inv);
    await w.useCases.invoiceIssued.execute({ ...inv, organizationId: ORG_B });
    expect(w.receivables(ORG_A)).toHaveLength(1);
    expect(w.receivables(ORG_B)).toHaveLength(1);
  });

  it('las condiciones de crédito de A no se aplican a las facturas de B', async () => {
    const w = buildWorld();
    await w.useCases.setCustomerTerms.execute({ organizationId: ORG_A, customerId: CUSTOMER_1, creditDays: 45, creditLimitCents: null, userId: 'u' });
    await w.useCases.invoiceIssued.execute({ ...w.invoice(), organizationId: ORG_B });
    expect(w.receivables(ORG_B)[0]!.dueDate).toBe('2026-10-21');
  });
});

describe('contabilidad caída', () => {
  it('es un error (502) y NO «no hay contabilidad»: el evento se reintenta y no se pierde ni se abre a ciegas', async () => {
    const w = buildWorld({ accountingDown: true });
    await expect(w.useCases.invoiceIssued.execute(w.invoice())).rejects.toBeInstanceOf(CatalogUnavailableError);
    await expect(w.useCases.invoiceVoided.execute({ organizationId: ORG_A, invoiceId: randomUUID() })).rejects.toBeInstanceOf(CatalogUnavailableError);
    expect(w.receivables()).toHaveLength(0);
  });

  it('se consulta a contabilidad una vez por evento y FUERA de la transacción', async () => {
    const w = buildWorld();
    await w.useCases.invoiceIssued.execute(w.invoice());
    expect(w.accounting.calls).toBe(1);
  });
});

describe('transacción: si falla a mitad no queda basura', () => {
  it('una nota de crédito que falla al guardar deja intactos la partida y las aplicaciones', async () => {
    const w = buildWorld();
    const inv = w.invoice({ total: 11500 });
    await w.useCases.invoiceIssued.execute(inv);
    const eventsBefore = w.data.events.length;

    // Un importe inválido hace que la inserción de la aplicación falle (CHECK applied_cents > 0) DESPUÉS de leer y bloquear la partida.
    const broken = w.invoice({ documentTypeCode: '04', total: 11500, relatedInvoiceId: inv.invoiceId });
    const original = w.data.creditApplications.push.bind(w.data.creditApplications);
    w.data.creditApplications.push = () => {
      throw new Error('fallo simulado del disco');
    };
    await expect(w.useCases.invoiceIssued.execute(broken)).rejects.toThrow('fallo simulado del disco');
    w.data.creditApplications.push = original;

    expect(w.data.creditApplications).toHaveLength(0);
    expect(w.data.events).toHaveLength(eventsBefore);
    expect(w.receivables()[0]!.version).toBe(1);
  });
});
