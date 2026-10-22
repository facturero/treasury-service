import type { Hono } from 'hono';
import type { z } from 'zod';
import type {
  AssignMovementAccountUseCase,
  CreateBankAccountUseCase,
  GetBankAccountUseCase,
  ImportStatementUseCase,
  ListBankAccountsUseCase,
  ListBankLinesUseCase,
  ListBankMovementsUseCase,
  PreviewStatementUseCase,
  UpdateBankAccountUseCase,
} from '../../application/use-cases/bank-account-use-cases.js';
import type {
  CloseReconciliationUseCase,
  GetCashFlowUseCase,
  ListReconciliationsUseCase,
  MarkLineExternalUseCase,
  MatchLineUseCase,
  MatchManyUseCase,
  PostBankAdjustmentUseCase,
  PreviewReconciliationUseCase,
  ReopenReconciliationUseCase,
  SuggestMatchesUseCase,
  UnmarkLineExternalUseCase,
  UnmatchLineUseCase,
  VoidBankAdjustmentUseCase,
} from '../../application/use-cases/bank-reconcile-use-cases.js';
import type { ExportReportsUseCase } from '../../application/use-cases/export-use-cases.js';
import type { BankAccountInput, ImportProfile } from '../../domain/bank.js';
import { csvResponse, org, user, type Vars } from './http-helpers.js';
import { requireOrganization, requirePermission, requireUser } from './middlewares.js';
import {
  assignAccountSchema,
  bankAccountsQuerySchema,
  bankAdjustmentSchema,
  bankLinesQuerySchema,
  bankMovementsQuerySchema,
  cashFlowQuerySchema,
  closeReconciliationSchema,
  createBankAccountSchema,
  exportCashFlowQuerySchema,
  markExternalSchema,
  matchLineSchema,
  matchManySchema,
  reconciliationQuerySchema,
  reopenReconciliationSchema,
  statementBodySchema,
  updateBankAccountSchema,
  validateJson,
  validateQuery,
  voidAdjustmentSchema,
} from './validators.js';
import {
  toBankAccountJSON,
  toBankAccountSummaryJSON,
  toBankLineJSON,
  toBankLineViewJSON,
  toBankMovementJSON,
  toBankMovementViewJSON,
  toBankReconciliationJSON,
  toBankStatementJSON,
  toReconciliationPreviewJSON,
  toSuggestionJSON,
} from './serializers.js';

export interface BankUseCases {
  listBankAccounts: ListBankAccountsUseCase;
  getBankAccount: GetBankAccountUseCase;
  createBankAccount: CreateBankAccountUseCase;
  updateBankAccount: UpdateBankAccountUseCase;
  previewStatement: PreviewStatementUseCase;
  importStatement: ImportStatementUseCase;
  listBankLines: ListBankLinesUseCase;
  listBankMovements: ListBankMovementsUseCase;
  assignMovementAccount: AssignMovementAccountUseCase;
  suggestMatches: SuggestMatchesUseCase;
  matchLine: MatchLineUseCase;
  matchMany: MatchManyUseCase;
  unmatchLine: UnmatchLineUseCase;
  markLineExternal: MarkLineExternalUseCase;
  unmarkLineExternal: UnmarkLineExternalUseCase;
  postBankAdjustment: PostBankAdjustmentUseCase;
  voidBankAdjustment: VoidBankAdjustmentUseCase;
  previewReconciliation: PreviewReconciliationUseCase;
  closeReconciliation: CloseReconciliationUseCase;
  reopenReconciliation: ReopenReconciliationUseCase;
  listReconciliations: ListReconciliationsUseCase;
  getCashFlow: GetCashFlowUseCase;
  exportReports: ExportReportsUseCase;
}

/**
 * Rutas de bancos, extractos y conciliación (bloque E), bajo `/treasury`.
 *
 * Permisos: `bank_account:read` (ver todo, incluido el flujo de caja), `bank_account:manage` (cuentas, perfil, importar extractos, asignar cuenta a un
 * movimiento) y `reconciliation:manage` (emparejar, marcar externo, ajustes bancarios, cerrar y reabrir). Las rutas fijas (`export`, `match`,
 * `preview`) van antes de las de `:id`.
 */
export function registerBankRoutes(r: Hono<Vars>, uc: BankUseCases): void {
  const base = [requireOrganization()] as const;

  // ── Cuentas ───────────────────────────────────────────────────────────────
  r.get('/treasury/bank-accounts', ...base, requirePermission('bank_account:read'), validateQuery(bankAccountsQuerySchema), async (c) => {
    const q = c.req.valid('query' as never) as z.infer<typeof bankAccountsQuerySchema>;
    const out = await uc.listBankAccounts.execute({ organizationId: org(c), activeOnly: q.activeOnly });
    return c.json({ items: out.items.map(toBankAccountSummaryJSON), unassignedMovements: out.unassignedMovements });
  });

  r.post('/treasury/bank-accounts', ...base, requireUser(), requirePermission('bank_account:manage'), validateJson(createBankAccountSchema), async (c) => {
    const account = c.req.valid('json' as never) as z.infer<typeof createBankAccountSchema>;
    const created = await uc.createBankAccount.execute({ organizationId: org(c), userId: user(c), account: account as BankAccountInput });
    return c.json(toBankAccountJSON(created), 201);
  });

  r.get('/treasury/bank-accounts/:id', ...base, requirePermission('bank_account:read'), async (c) => {
    const out = await uc.getBankAccount.execute({ organizationId: org(c), bankAccountId: c.req.param('id') });
    return c.json({ ...toBankAccountSummaryJSON(out), statements: out.statements.map(toBankStatementJSON) });
  });

  r.put('/treasury/bank-accounts/:id', ...base, requireUser(), requirePermission('bank_account:manage'), validateJson(updateBankAccountSchema), async (c) => {
    const { expectedVersion, ...patch } = c.req.valid('json' as never) as z.infer<typeof updateBankAccountSchema>;
    const updated = await uc.updateBankAccount.execute({ organizationId: org(c), userId: user(c), bankAccountId: c.req.param('id'), patch: patch as Parameters<UpdateBankAccountUseCase['execute']>[0]['patch'], expectedVersion });
    return c.json(toBankAccountJSON(updated));
  });

  // ── Extractos ─────────────────────────────────────────────────────────────
  r.post('/treasury/bank-accounts/:id/statements/preview', ...base, requirePermission('bank_account:manage'), validateJson(statementBodySchema), async (c) => {
    const body = c.req.valid('json' as never) as z.infer<typeof statementBodySchema>;
    return c.json(await uc.previewStatement.execute({ organizationId: org(c), bankAccountId: c.req.param('id'), csv: body.csv, profile: body.profile as ImportProfile | null }));
  });

  r.post('/treasury/bank-accounts/:id/statements', ...base, requireUser(), requirePermission('bank_account:manage'), validateJson(statementBodySchema), async (c) => {
    const body = c.req.valid('json' as never) as z.infer<typeof statementBodySchema>;
    const out = await uc.importStatement.execute({
      organizationId: org(c),
      userId: user(c),
      bankAccountId: c.req.param('id'),
      csv: body.csv,
      fileName: body.fileName,
      profile: body.profile as ImportProfile | null,
      saveProfile: body.saveProfile,
    });
    return c.json({ statement: toBankStatementJSON(out.statement), importedLines: out.importedLines, skippedDuplicates: out.skippedDuplicates, skippedBeforeOpening: out.skippedBeforeOpening }, 201);
  });

  r.get('/treasury/bank-accounts/:id/lines', ...base, requirePermission('bank_account:read'), validateQuery(bankLinesQuerySchema), async (c) => {
    const q = c.req.valid('query' as never) as z.infer<typeof bankLinesQuerySchema>;
    const page = await uc.listBankLines.execute({
      organizationId: org(c),
      bankAccountId: c.req.param('id'),
      filters: { status: q.status, from: q.from, to: q.to, q: q.q, page: q.page, pageSize: q.pageSize },
    });
    return c.json({ ...page, items: page.items.map(toBankLineViewJSON) });
  });

  r.get('/treasury/bank-accounts/:id/suggestions', ...base, requirePermission('bank_account:read'), async (c) => {
    const out = await uc.suggestMatches.execute({ organizationId: org(c), bankAccountId: c.req.param('id') });
    return c.json({ suggestions: out.suggestions.map(toSuggestionJSON) });
  });

  // ── Movimientos del registro ──────────────────────────────────────────────
  r.get('/treasury/bank-movements', ...base, requirePermission('bank_account:read'), validateQuery(bankMovementsQuerySchema), async (c) => {
    const q = c.req.valid('query' as never) as z.infer<typeof bankMovementsQuerySchema>;
    const page = await uc.listBankMovements.execute({
      organizationId: org(c),
      filters: { bankAccountId: q.bankAccountId, status: q.status, matched: q.matched, from: q.from, to: q.to, q: q.q, page: q.page, pageSize: q.pageSize },
    });
    return c.json({ ...page, items: page.items.map(toBankMovementViewJSON) });
  });

  r.post('/treasury/bank-movements/:id/account', ...base, requireUser(), requirePermission('bank_account:manage'), validateJson(assignAccountSchema), async (c) => {
    const { bankAccountId } = c.req.valid('json' as never) as z.infer<typeof assignAccountSchema>;
    const movement = await uc.assignMovementAccount.execute({ organizationId: org(c), userId: user(c), movementId: c.req.param('id'), bankAccountId });
    return c.json(toBankMovementJSON(movement));
  });

  // ── Emparejar (el lote va antes de `:id`: «match» no es un id) ────────────
  r.post('/treasury/bank-lines/match', ...base, requireUser(), requirePermission('reconciliation:manage'), validateJson(matchManySchema), async (c) => {
    const body = c.req.valid('json' as never) as z.infer<typeof matchManySchema>;
    return c.json(await uc.matchMany.execute({ organizationId: org(c), userId: user(c), pairs: body.pairs, method: body.method }));
  });

  r.post('/treasury/bank-lines/:id/match', ...base, requireUser(), requirePermission('reconciliation:manage'), validateJson(matchLineSchema), async (c) => {
    const body = c.req.valid('json' as never) as z.infer<typeof matchLineSchema>;
    const out = await uc.matchLine.execute({ organizationId: org(c), userId: user(c), lineId: c.req.param('id'), movementIds: body.movementIds, method: body.method });
    return c.json({ ...toBankLineJSON(out.line), movements: out.movements.map(toBankMovementJSON) });
  });

  r.post('/treasury/bank-lines/:id/unmatch', ...base, requireUser(), requirePermission('reconciliation:manage'), async (c) =>
    c.json(toBankLineJSON(await uc.unmatchLine.execute({ organizationId: org(c), userId: user(c), lineId: c.req.param('id') }))));

  r.post('/treasury/bank-lines/:id/external', ...base, requireUser(), requirePermission('reconciliation:manage'), validateJson(markExternalSchema), async (c) => {
    const { reason } = c.req.valid('json' as never) as z.infer<typeof markExternalSchema>;
    return c.json(toBankLineJSON(await uc.markLineExternal.execute({ organizationId: org(c), userId: user(c), lineId: c.req.param('id'), reason })));
  });

  r.post('/treasury/bank-lines/:id/unexternal', ...base, requireUser(), requirePermission('reconciliation:manage'), async (c) =>
    c.json(toBankLineJSON(await uc.unmarkLineExternal.execute({ organizationId: org(c), userId: user(c), lineId: c.req.param('id') }))));

  // ── Ajustes bancarios ─────────────────────────────────────────────────────
  r.post('/treasury/bank-adjustments', ...base, requireUser(), requirePermission('reconciliation:manage'), validateJson(bankAdjustmentSchema), async (c) => {
    const { lineId, ...adjustment } = c.req.valid('json' as never) as z.infer<typeof bankAdjustmentSchema>;
    const movement = await uc.postBankAdjustment.execute({ organizationId: org(c), userId: user(c), adjustment: adjustment as Parameters<PostBankAdjustmentUseCase['execute']>[0]['adjustment'], lineId });
    return c.json(toBankMovementJSON(movement), 201);
  });

  r.post('/treasury/bank-adjustments/:id/void', ...base, requireUser(), requirePermission('reconciliation:manage'), validateJson(voidAdjustmentSchema), async (c) => {
    const { reason } = c.req.valid('json' as never) as z.infer<typeof voidAdjustmentSchema>;
    return c.json(toBankMovementJSON(await uc.voidBankAdjustment.execute({ organizationId: org(c), userId: user(c), movementId: c.req.param('id'), reason })));
  });

  // ── Conciliación ──────────────────────────────────────────────────────────
  r.get('/treasury/bank-accounts/:id/reconciliation', ...base, requirePermission('bank_account:read'), validateQuery(reconciliationQuerySchema), async (c) => {
    const q = c.req.valid('query' as never) as z.infer<typeof reconciliationQuerySchema>;
    const preview = await uc.previewReconciliation.execute({ organizationId: org(c), bankAccountId: c.req.param('id'), cutoffDate: q.cutoffDate, statementBalanceCents: q.statementBalanceCents });
    return c.json(toReconciliationPreviewJSON(preview));
  });

  r.get('/treasury/bank-accounts/:id/reconciliations', ...base, requirePermission('bank_account:read'), async (c) => {
    const items = await uc.listReconciliations.execute({ organizationId: org(c), bankAccountId: c.req.param('id') });
    return c.json({ items: items.map(toBankReconciliationJSON) });
  });

  r.post('/treasury/bank-accounts/:id/reconciliations', ...base, requireUser(), requirePermission('reconciliation:manage'), validateJson(closeReconciliationSchema), async (c) => {
    const body = c.req.valid('json' as never) as z.infer<typeof closeReconciliationSchema>;
    const rec = await uc.closeReconciliation.execute({ organizationId: org(c), userId: user(c), bankAccountId: c.req.param('id'), cutoffDate: body.cutoffDate, statementBalanceCents: body.statementBalanceCents, notes: body.notes });
    return c.json(toBankReconciliationJSON(rec), 201);
  });

  r.post('/treasury/bank-reconciliations/:id/reopen', ...base, requireUser(), requirePermission('reconciliation:manage'), validateJson(reopenReconciliationSchema), async (c) => {
    const { reason } = c.req.valid('json' as never) as z.infer<typeof reopenReconciliationSchema>;
    return c.json(toBankReconciliationJSON(await uc.reopenReconciliation.execute({ organizationId: org(c), userId: user(c), reconciliationId: c.req.param('id'), reason })));
  });

  // ── Flujo de caja ─────────────────────────────────────────────────────────
  r.get('/treasury/cash-flow', ...base, requirePermission('bank_account:read'), validateQuery(cashFlowQuerySchema), async (c) => {
    const q = c.req.valid('query' as never) as z.infer<typeof cashFlowQuerySchema>;
    return c.json(await uc.getCashFlow.execute({ organizationId: org(c), weeks: q.weeks, asOf: q.asOf }));
  });

  r.get('/treasury/cash-flow/export', ...base, requireUser(), requirePermission('bank_account:read'), validateQuery(exportCashFlowQuerySchema), async (c) => {
    const q = c.req.valid('query' as never) as z.infer<typeof exportCashFlowQuerySchema>;
    return csvResponse(c, await uc.exportReports.cashFlow({ organizationId: org(c), userId: user(c), lang: q.lang, weeks: q.weeks, asOf: q.asOf }));
  });
}
