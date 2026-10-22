import { Hono, type Context } from 'hono';
import type { z } from 'zod';
import type {
  GetAgingUseCase,
  GetCustomerStatementUseCase,
  GetReceivableDetailUseCase,
  GetReceivableUseCase,
  ListReceivablesUseCase,
} from '../../application/use-cases/list-use-cases.js';
import type { GetCustomerTermsUseCase, SetCustomerTermsUseCase } from '../../application/use-cases/customer-use-cases.js';
import type { ExportReportsUseCase, CsvFile } from '../../application/use-cases/export-use-cases.js';
import type {
  GetReminderSettingsUseCase,
  PreviewRemindersUseCase,
  RunRemindersUseCase,
  SetReminderSettingsUseCase,
} from '../../application/use-cases/reminder-use-cases.js';
import type {
  GetPayableDetailUseCase,
  GetPayablesAgingUseCase,
  GetSupplierStatementUseCase,
  ListPayablesUseCase,
  LoadPayableOpeningBalancesUseCase,
} from '../../application/use-cases/payable-list-use-cases.js';
import type {
  ApprovePaymentUseCase,
  CreatePaymentUseCase,
  GetPaymentSettingsUseCase,
  GetPaymentUseCase,
  ListPaymentsUseCase,
  PostPaymentUseCase,
  SetPaymentSettingsUseCase,
  UpdatePaymentUseCase,
  VoidPaymentUseCase,
} from '../../application/use-cases/payment-use-cases.js';
import { requiresApproval, type Payment, type PaymentInput, type PaymentStatus as PaymentStatusT } from '../../domain/payment.js';
import type { PayableStatus } from '../../domain/payable.js';
import type { LoadOpeningBalancesUseCase } from '../../application/use-cases/opening-balance-use-case.js';
import type {
  CreateReceiptUseCase,
  GetReceiptUseCase,
  ListReceiptsUseCase,
  PostReceiptUseCase,
  UpdateReceiptUseCase,
  VoidReceiptUseCase,
} from '../../application/use-cases/receipt-use-cases.js';
import type { ReceiptInput, ReceiptStatus as ReceiptStatusT } from '../../domain/receipt.js';
import type { ReceivableStatus } from '../../domain/receivable.js';
import { requireOrganization, requirePermission, requireUser, type ContextVariables } from './middlewares.js';
import {
  agingQuerySchema,
  createPaymentSchema,
  createReceiptSchema,
  customerTermsSchema,
  exportAgingQuerySchema,
  exportPayablesQuerySchema,
  exportReceivablesQuerySchema,
  exportStatementQuerySchema,
  openingBalanceSchema,
  payableOpeningBalanceSchema,
  payableQuerySchema,
  paymentQuerySchema,
  paymentSettingsSchema,
  receiptQuerySchema,
  receivableQuerySchema,
  reminderSettingsSchema,
  statementQuerySchema,
  updatePaymentSchema,
  updateReceiptSchema,
  voidPaymentSchema,
  voidReceiptSchema,
  validateJson,
  validateQuery,
} from './validators.js';
import {
  toAgingJSON,
  toCustomerTermsJSON,
  toOpeningBalanceLoadJSON,
  toPayableDetailJSON,
  toPayableJSON,
  toPayableOpeningLoadJSON,
  toPayablesAgingJSON,
  toPaymentJSON,
  toPaymentSettingsJSON,
  toSupplierStatementJSON,
  toReceiptJSON,
  toReceivableDetailJSON,
  toReceivableJSON,
  toReminderPreviewJSON,
  toReminderRunJSON,
  toReminderSettingsJSON,
  toStatementJSON,
} from './serializers.js';

type Vars = { Variables: ContextVariables };
type Ctx = Context<Vars>;

export interface AppDependencies {
  useCases: {
    listReceivables: ListReceivablesUseCase;
    getReceivable: GetReceivableUseCase;
    getReceivableDetail: GetReceivableDetailUseCase;
    getStatement: GetCustomerStatementUseCase;
    getAging: GetAgingUseCase;
    getCustomerTerms: GetCustomerTermsUseCase;
    setCustomerTerms: SetCustomerTermsUseCase;
    loadOpeningBalances: LoadOpeningBalancesUseCase;
    listReceipts: ListReceiptsUseCase;
    getReceipt: GetReceiptUseCase;
    createReceipt: CreateReceiptUseCase;
    updateReceipt: UpdateReceiptUseCase;
    postReceipt: PostReceiptUseCase;
    voidReceipt: VoidReceiptUseCase;
    exportReports: ExportReportsUseCase;
    getReminderSettings: GetReminderSettingsUseCase;
    setReminderSettings: SetReminderSettingsUseCase;
    previewReminders: PreviewRemindersUseCase;
    runReminders: RunRemindersUseCase;
    listPayables: ListPayablesUseCase;
    getPayableDetail: GetPayableDetailUseCase;
    getPayablesAging: GetPayablesAgingUseCase;
    getSupplierStatement: GetSupplierStatementUseCase;
    loadPayableOpeningBalances: LoadPayableOpeningBalancesUseCase;
    listPayments: ListPaymentsUseCase;
    getPayment: GetPaymentUseCase;
    createPayment: CreatePaymentUseCase;
    updatePayment: UpdatePaymentUseCase;
    approvePayment: ApprovePaymentUseCase;
    postPayment: PostPaymentUseCase;
    voidPayment: VoidPaymentUseCase;
    getPaymentSettings: GetPaymentSettingsUseCase;
    setPaymentSettings: SetPaymentSettingsUseCase;
  };
  corsOrigin: string;
}

export function healthRoutes(): Hono {
  const r = new Hono();
  r.get('/health', (c) => c.json({ status: 'ok' }));
  return r;
}

/** Un CSV descargable. BOM al inicio: sin él Excel abre el archivo en la codificación equivocada y los acentos se ven mal. */
const csvResponse = (c: Ctx, file: CsvFile) =>
  c.body(`﻿${file.csv}`, 200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${file.filename}"`,
    // Es la cartera de clientes: que ningún intermediario la guarde.
    'Cache-Control': 'no-store',
  });

const org = (c: Ctx) => c.get('organizationId');

/**
 * Un pago con `requiresApproval`: ¿llega al umbral de aprobación de la organización? Quien crea o contabiliza pagos (el Contador) no puede
 * LEER el umbral (es del Administrador), pero sí necesita saber si ESTE pago necesita aprobación: sin ese dato la pantalla le ofrecería
 * «Pagar» sobre uno que el servidor va a rechazar. Solo viaja el sí/no, no el importe del umbral.
 */
const paymentJSON = async (uc: AppDependencies['useCases'], organizationId: string, payment: Payment) => ({
  ...toPaymentJSON(payment),
  requiresApproval: payment.status === 'draft' && requiresApproval(await uc.getPaymentSettings.execute({ organizationId }), payment),
});
const user = (c: Ctx) => c.get('userId');

/**
 * Rutas bajo `/treasury`. El gateway las deja pasar con el prefijo intacto y exige el plugin `finance.accounts_receivable_payable`;
 * aquí se exige el PERMISO de cada acción.
 *
 * Permisos del bloque A: `receivable:read` (ver la cartera), `customer_terms:manage` (cambiar el plazo de un cliente) y
 * `opening_balance:load` (cargar la cartera inicial). Los permisos de cobro (`receipt:*`) son del bloque B: se cargan
 * junto con sus rutas, no antes, porque un permiso sin ruta es una puerta que no lleva a ninguna parte.
 */
export function treasuryRoutes(deps: AppDependencies): Hono<Vars> {
  const r = new Hono<Vars>();
  const { useCases: uc } = deps;
  const base = [requireOrganization()] as const;

  // ── Cartera ───────────────────────────────────────────────────────────────
  r.get('/treasury/receivables', ...base, requirePermission('receivable:read'), validateQuery(receivableQuerySchema), async (c) => {
    const q = c.req.valid('query' as never) as z.infer<typeof receivableQuerySchema>;
    const { page, asOf } = await uc.listReceivables.execute({
      organizationId: org(c),
      filters: {
        q: q.q,
        customerId: q.customerId,
        status: q.status as ReceivableStatus[] | undefined,
        overdueOnly: q.overdueOnly,
        asOf: q.asOf,
        from: q.from,
        to: q.to,
        page: q.page,
        pageSize: q.pageSize,
      },
    });
    return c.json({ ...page, asOf, items: page.items.map(toReceivableJSON) });
  });

  // Exportar a CSV: permiso aparte (`receivable:export`) porque es dato que SALE del sistema, y cada archivo deja un evento en la
  // bitácora. Van antes de `/:id` por la misma razón que la antigüedad.
  r.get('/treasury/receivables/export', ...base, requireUser(), requirePermission('receivable:export'), validateQuery(exportReceivablesQuerySchema), async (c) => {
    const { lang, ...q } = c.req.valid('query' as never) as z.infer<typeof exportReceivablesQuerySchema>;
    return csvResponse(c, await uc.exportReports.receivables({
      organizationId: org(c),
      userId: user(c),
      lang,
      filters: { q: q.q, customerId: q.customerId, status: q.status as ReceivableStatus[] | undefined, overdueOnly: q.overdueOnly, asOf: q.asOf, from: q.from, to: q.to },
    }));
  });

  r.get('/treasury/receivables/aging/export', ...base, requireUser(), requirePermission('receivable:export'), validateQuery(exportAgingQuerySchema), async (c) => {
    const q = c.req.valid('query' as never) as z.infer<typeof exportAgingQuerySchema>;
    return csvResponse(c, await uc.exportReports.aging({ organizationId: org(c), userId: user(c), lang: q.lang, asOf: q.asOf }));
  });

  // La antigüedad va ANTES que `/:id`: si no, «aging» se leería como un id y el reporte no existiría.
  r.get('/treasury/receivables/aging', ...base, requirePermission('receivable:read'), validateQuery(agingQuerySchema), async (c) => {
    const q = c.req.valid('query' as never) as z.infer<typeof agingQuerySchema>;
    return c.json(toAgingJSON(await uc.getAging.execute({ organizationId: org(c), asOf: q.asOf })));
  });

  r.get('/treasury/receivables/:id', ...base, requirePermission('receivable:read'), async (c) => {
    const detail = await uc.getReceivableDetail.execute({
      organizationId: org(c),
      receivableId: c.req.param('id'),
    });
    return c.json(toReceivableDetailJSON(detail.receivable, detail.applications));
  });

  // ── Estado de cuenta ──────────────────────────────────────────────────────
  r.get('/treasury/customers/:id/statement', ...base, requirePermission('receivable:read'), validateQuery(statementQuerySchema), async (c) => {
    const q = c.req.valid('query' as never) as z.infer<typeof statementQuerySchema>;
    return c.json(toStatementJSON(await uc.getStatement.execute({
      organizationId: org(c),
      customerId: c.req.param('id'),
      asOf: q.asOf,
    })));
  });

  r.get('/treasury/customers/:id/statement/export', ...base, requireUser(), requirePermission('receivable:export'), validateQuery(exportStatementQuerySchema), async (c) => {
    const q = c.req.valid('query' as never) as z.infer<typeof exportStatementQuerySchema>;
    return csvResponse(c, await uc.exportReports.statement({ organizationId: org(c), userId: user(c), lang: q.lang, customerId: c.req.param('id'), asOf: q.asOf }));
  });

  // ── Condiciones de crédito ────────────────────────────────────────────────
  r.get('/treasury/customers/:id/terms', ...base, requirePermission('receivable:read'), async (c) =>
    c.json(toCustomerTermsJSON(await uc.getCustomerTerms.execute({
      organizationId: org(c),
      customerId: c.req.param('id'),
    }))));

  r.put('/treasury/customers/:id/terms', ...base, requireUser(), requirePermission('customer_terms:manage'), validateJson(customerTermsSchema), async (c) => {
    const input = c.req.valid('json' as never) as z.infer<typeof customerTermsSchema>;
    const terms = await uc.setCustomerTerms.execute({
      organizationId: org(c),
      customerId: c.req.param('id'),
      customerName: input.customerName,
      creditDays: input.creditDays,
      creditLimitCents: input.creditLimitCents,
      userId: user(c),
    });
    return c.json(toCustomerTermsJSON(terms));
  });

  // ── Saldos iniciales ──────────────────────────────────────────────────────
  r.post('/treasury/opening-balances', ...base, requireUser(), requirePermission('opening_balance:load'), validateJson(openingBalanceSchema), async (c) => {
    const input = c.req.valid('json' as never) as z.infer<typeof openingBalanceSchema>;
    const load = await uc.loadOpeningBalances.execute({
      organizationId: org(c),
      cutoffDate: input.cutoffDate,
      reason: input.reason,
      lines: input.lines,
      userId: user(c),
    });
    return c.json(toOpeningBalanceLoadJSON(load), 201);
  });

  // ── Cobros ────────────────────────────────────────────────────────────────
  // Crear, editar un borrador y contabilizar van con `receipt:create` (no existen `receipt:update` ni `receipt:post`: serían permisos
  // de adorno, como pasó en compras). Anular es aparte y solo del Administrador: quien cobra no anula lo suyo sin que quede rastro.
  r.get('/treasury/receipts', ...base, requirePermission('receipt:read'), validateQuery(receiptQuerySchema), async (c) => {
    const q = c.req.valid('query' as never) as z.infer<typeof receiptQuerySchema>;
    const page = await uc.listReceipts.execute({
      organizationId: org(c),
      filters: { q: q.q, customerId: q.customerId, status: q.status as ReceiptStatusT[] | undefined, from: q.from, to: q.to, page: q.page, pageSize: q.pageSize },
    });
    return c.json({ ...page, items: page.items.map(toReceiptJSON) });
  });

  r.get('/treasury/receipts/:id', ...base, requirePermission('receipt:read'), async (c) =>
    c.json(toReceiptJSON(await uc.getReceipt.execute({ organizationId: org(c), receiptId: c.req.param('id') }))));

  r.post('/treasury/receipts', ...base, requireUser(), requirePermission('receipt:create'), validateJson(createReceiptSchema), async (c) => {
    const { customerId, ...receipt } = c.req.valid('json' as never) as z.infer<typeof createReceiptSchema>;
    const created = await uc.createReceipt.execute({ organizationId: org(c), customerId, userId: user(c), receipt: receipt as ReceiptInput });
    return c.json(toReceiptJSON(created), 201);
  });

  r.put('/treasury/receipts/:id', ...base, requireUser(), requirePermission('receipt:create'), validateJson(updateReceiptSchema), async (c) => {
    const { expectedVersion, ...receipt } = c.req.valid('json' as never) as z.infer<typeof updateReceiptSchema>;
    const updated = await uc.updateReceipt.execute({ organizationId: org(c), receiptId: c.req.param('id'), userId: user(c), receipt: receipt as ReceiptInput, expectedVersion });
    return c.json(toReceiptJSON(updated));
  });

  r.post('/treasury/receipts/:id/post', ...base, requireUser(), requirePermission('receipt:create'), async (c) =>
    c.json(toReceiptJSON(await uc.postReceipt.execute({ organizationId: org(c), receiptId: c.req.param('id'), userId: user(c) }))));

  r.post('/treasury/receipts/:id/void', ...base, requireUser(), requirePermission('receipt:void'), validateJson(voidReceiptSchema), async (c) => {
    const { reason } = c.req.valid('json' as never) as z.infer<typeof voidReceiptSchema>;
    return c.json(toReceiptJSON(await uc.voidReceipt.execute({ organizationId: org(c), receiptId: c.req.param('id'), userId: user(c), reason })));
  });

  // ══ Cuentas por pagar y pagos (bloque D) ══════════════════════════════════════
  // Mismas defensas que cobros: una ruta por método y permiso, `export`/`aging` ANTES de `/:id`. Pagar y aprobar son permisos distintos
  // (separación de funciones); anular y fijar el umbral de aprobación son solo del Administrador.
  r.get('/treasury/payables', ...base, requirePermission('payable:read'), validateQuery(payableQuerySchema), async (c) => {
    const q = c.req.valid('query' as never) as z.infer<typeof payableQuerySchema>;
    const { page, asOf } = await uc.listPayables.execute({
      organizationId: org(c),
      filters: { q: q.q, supplierId: q.supplierId, status: q.status as PayableStatus[] | undefined, overdueOnly: q.overdueOnly, asOf: q.asOf, from: q.from, to: q.to, page: q.page, pageSize: q.pageSize },
      dueSoon: q.dueSoon,
    });
    return c.json({ ...page, asOf, items: page.items.map(toPayableJSON) });
  });

  r.get('/treasury/payables/export', ...base, requireUser(), requirePermission('payable:export'), validateQuery(exportPayablesQuerySchema), async (c) => {
    const { lang, dueSoon, ...q } = c.req.valid('query' as never) as z.infer<typeof exportPayablesQuerySchema>;
    return csvResponse(c, await uc.exportReports.payables({
      organizationId: org(c),
      userId: user(c),
      lang,
      filters: { q: q.q, supplierId: q.supplierId, status: q.status as PayableStatus[] | undefined, overdueOnly: q.overdueOnly, asOf: q.asOf, from: q.from, to: q.to },
      dueSoon,
    }));
  });

  r.get('/treasury/payables/aging', ...base, requirePermission('payable:read'), validateQuery(agingQuerySchema), async (c) => {
    const q = c.req.valid('query' as never) as z.infer<typeof agingQuerySchema>;
    return c.json(toPayablesAgingJSON(await uc.getPayablesAging.execute({ organizationId: org(c), asOf: q.asOf })));
  });

  r.get('/treasury/payables/aging/export', ...base, requireUser(), requirePermission('payable:export'), validateQuery(exportAgingQuerySchema), async (c) => {
    const q = c.req.valid('query' as never) as z.infer<typeof exportAgingQuerySchema>;
    return csvResponse(c, await uc.exportReports.payablesAging({ organizationId: org(c), userId: user(c), lang: q.lang, asOf: q.asOf }));
  });

  r.get('/treasury/payables/:id', ...base, requirePermission('payable:read'), async (c) =>
    c.json(toPayableDetailJSON(await uc.getPayableDetail.execute({ organizationId: org(c), payableId: c.req.param('id') }))));

  r.get('/treasury/suppliers/:id/statement', ...base, requirePermission('payable:read'), validateQuery(statementQuerySchema), async (c) => {
    const q = c.req.valid('query' as never) as z.infer<typeof statementQuerySchema>;
    return c.json(toSupplierStatementJSON(await uc.getSupplierStatement.execute({ organizationId: org(c), supplierId: c.req.param('id'), asOf: q.asOf })));
  });

  r.get('/treasury/suppliers/:id/statement/export', ...base, requireUser(), requirePermission('payable:export'), validateQuery(exportStatementQuerySchema), async (c) => {
    const q = c.req.valid('query' as never) as z.infer<typeof exportStatementQuerySchema>;
    return csvResponse(c, await uc.exportReports.supplierStatement({ organizationId: org(c), userId: user(c), lang: q.lang, supplierId: c.req.param('id'), asOf: q.asOf }));
  });

  // Saldos iniciales de deudas: el mismo permiso que los de cartera (`opening_balance:load`), solo Administrador.
  r.post('/treasury/payable-opening-balances', ...base, requireUser(), requirePermission('opening_balance:load'), validateJson(payableOpeningBalanceSchema), async (c) => {
    const input = c.req.valid('json' as never) as z.infer<typeof payableOpeningBalanceSchema>;
    const load = await uc.loadPayableOpeningBalances.execute({ organizationId: org(c), cutoffDate: input.cutoffDate, reason: input.reason, lines: input.lines, userId: user(c) });
    return c.json(toPayableOpeningLoadJSON(load), 201);
  });

  r.get('/treasury/payments', ...base, requirePermission('payment:read'), validateQuery(paymentQuerySchema), async (c) => {
    const q = c.req.valid('query' as never) as z.infer<typeof paymentQuerySchema>;
    const page = await uc.listPayments.execute({
      organizationId: org(c),
      filters: { q: q.q, supplierId: q.supplierId, status: q.status as PaymentStatusT[] | undefined, from: q.from, to: q.to, page: q.page, pageSize: q.pageSize },
    });
    return c.json({ ...page, items: page.items.map(toPaymentJSON) });
  });

  // Configuración de pagos (umbral de aprobación). Antes de `/payments/:id`: «settings» no es un id.
  r.get('/treasury/payments/settings', ...base, requirePermission('payment:approve'), async (c) =>
    c.json(toPaymentSettingsJSON(await uc.getPaymentSettings.execute({ organizationId: org(c) }))));

  r.put('/treasury/payments/settings', ...base, requireUser(), requirePermission('payment:approve'), validateJson(paymentSettingsSchema), async (c) => {
    const input = c.req.valid('json' as never) as z.infer<typeof paymentSettingsSchema>;
    return c.json(toPaymentSettingsJSON(await uc.setPaymentSettings.execute({ organizationId: org(c), approvalThresholdCents: input.approvalThresholdCents, userId: user(c) })));
  });

  r.get('/treasury/payments/:id', ...base, requirePermission('payment:read'), async (c) =>
    c.json(await paymentJSON(uc, org(c), await uc.getPayment.execute({ organizationId: org(c), paymentId: c.req.param('id') }))));

  r.post('/treasury/payments', ...base, requireUser(), requirePermission('payment:create'), validateJson(createPaymentSchema), async (c) => {
    const { supplierId, ...payment } = c.req.valid('json' as never) as z.infer<typeof createPaymentSchema>;
    return c.json(await paymentJSON(uc, org(c), await uc.createPayment.execute({ organizationId: org(c), supplierId, userId: user(c), payment: payment as PaymentInput })), 201);
  });

  r.put('/treasury/payments/:id', ...base, requireUser(), requirePermission('payment:create'), validateJson(updatePaymentSchema), async (c) => {
    const { expectedVersion, ...payment } = c.req.valid('json' as never) as z.infer<typeof updatePaymentSchema>;
    return c.json(await paymentJSON(uc, org(c), await uc.updatePayment.execute({ organizationId: org(c), paymentId: c.req.param('id'), userId: user(c), payment: payment as PaymentInput, expectedVersion })));
  });

  r.post('/treasury/payments/:id/approve', ...base, requireUser(), requirePermission('payment:approve'), async (c) =>
    c.json(await paymentJSON(uc, org(c), await uc.approvePayment.execute({ organizationId: org(c), paymentId: c.req.param('id'), userId: user(c) }))));

  r.post('/treasury/payments/:id/post', ...base, requireUser(), requirePermission('payment:create'), async (c) =>
    c.json(await paymentJSON(uc, org(c), await uc.postPayment.execute({ organizationId: org(c), paymentId: c.req.param('id'), userId: user(c) }))));

  r.post('/treasury/payments/:id/void', ...base, requireUser(), requirePermission('payment:void'), validateJson(voidPaymentSchema), async (c) => {
    const { reason } = c.req.valid('json' as never) as z.infer<typeof voidPaymentSchema>;
    return c.json(await paymentJSON(uc, org(c), await uc.voidPayment.execute({ organizationId: org(c), paymentId: c.req.param('id'), userId: user(c), reason })));
  });

  // ── Recordatorios de cobro ────────────────────────────────────────────────
  // Le llegan al CLIENTE de la organización (comunicación externa): todo es `reminder:manage`, solo del Administrador, incluso ver la
  // configuración y la vista previa (esa lista trae los correos de los clientes).
  r.get('/treasury/reminders/settings', ...base, requirePermission('reminder:manage'), async (c) =>
    c.json(toReminderSettingsJSON(await uc.getReminderSettings.execute({ organizationId: org(c) }))));

  r.put('/treasury/reminders/settings', ...base, requireUser(), requirePermission('reminder:manage'), validateJson(reminderSettingsSchema), async (c) => {
    const input = c.req.valid('json' as never) as z.infer<typeof reminderSettingsSchema>;
    return c.json(toReminderSettingsJSON(await uc.setReminderSettings.execute({ organizationId: org(c), userId: user(c), ...input })));
  });

  r.get('/treasury/reminders/preview', ...base, requirePermission('reminder:manage'), async (c) =>
    c.json(toReminderPreviewJSON(await uc.previewReminders.execute({ organizationId: org(c) }))));

  r.post('/treasury/reminders/run', ...base, requireUser(), requirePermission('reminder:manage'), async (c) =>
    c.json(toReminderRunJSON(await uc.runReminders.execute({ organizationId: org(c), trigger: 'manual', userId: user(c) }))));


  return r;
}
