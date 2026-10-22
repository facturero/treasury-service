import { Op, QueryTypes, type Transaction, type WhereOptions } from 'sequelize';
import { sequelize } from './sequelize.js';
import {
  BankAccountModel,
  BankMatchModel,
  BankMovementModel,
  BankReconciliationModel,
  BankStatementLineModel,
  BankStatementModel,
} from './models.js';
import { ConcurrentUpdateError } from '../../domain/errors.js';
import type {
  AdjustmentKind,
  BankAccount,
  BankAccountType,
  BankMatch,
  BankMovement,
  BankMovementSource,
  BankMovementStatus,
  BankReconciliation,
  BankStatement,
  BankStatementLine,
  ImportProfile,
  LineStatus,
} from '../../domain/bank.js';
import type { BankLineFilters, BankMovementFilters, Page, UnitOfWork } from '../../domain/repositories.js';

/** Escapa los comodines de LIKE: buscar «100%» no debe traer todo. */
const likeTerm = (q: string): string => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

const asProfile = (value: unknown): ImportProfile | null => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as ImportProfile;
    } catch {
      return null;
    }
  }
  return value as ImportProfile;
};

// ── Cuentas ──────────────────────────────────────────────────────────────────

const toAccount = (m: BankAccountModel): BankAccount => ({
  id: m.id,
  organizationId: m.organization_id,
  name: m.name,
  bankName: m.bank_name,
  accountType: m.account_type as BankAccountType,
  accountLast4: m.account_last4,
  currencyCode: m.currency_code,
  openingBalanceCents: Number(m.opening_balance_cents),
  openingDate: String(m.opening_date),
  isActive: Boolean(m.is_active),
  importProfile: asProfile(m.import_profile),
  version: m.version,
  createdAt: m.created_at,
  updatedAt: m.updated_at,
});

const accountFields = (a: BankAccount) => ({
  organization_id: a.organizationId,
  name: a.name,
  bank_name: a.bankName,
  account_type: a.accountType,
  account_last4: a.accountLast4,
  currency_code: a.currencyCode,
  opening_balance_cents: a.openingBalanceCents,
  opening_date: a.openingDate,
  is_active: a.isActive,
  import_profile: a.importProfile,
  version: a.version,
  updated_at: a.updatedAt,
});

function accountRepository(tx?: Transaction): UnitOfWork['bankAccounts'] {
  return {
    async findById(organizationId, id, options) {
      const lock = Boolean(options?.lock && tx);
      const row = await BankAccountModel.findOne({ where: { id, organization_id: organizationId }, transaction: tx, ...(lock ? { lock: tx!.LOCK.UPDATE } : {}) });
      return row ? toAccount(row) : null;
    },
    async findByName(organizationId, name) {
      const row = await BankAccountModel.findOne({ where: { organization_id: organizationId, name }, transaction: tx });
      return row ? toAccount(row) : null;
    },
    async list(organizationId, options) {
      const rows = await BankAccountModel.findAll({
        where: { organization_id: organizationId, ...(options?.activeOnly ? { is_active: true } : {}) },
        order: [['is_active', 'DESC'], ['name', 'ASC']],
        transaction: tx,
      });
      return rows.map(toAccount);
    },
    async save(account, expectedVersion) {
      if (expectedVersion === undefined) {
        await BankAccountModel.create({ id: account.id, created_at: account.createdAt, ...accountFields(account) }, { transaction: tx });
        return;
      }
      const [updated] = await BankAccountModel.update(accountFields(account), { where: { id: account.id, organization_id: account.organizationId, version: expectedVersion }, transaction: tx });
      if (updated === 0) throw new ConcurrentUpdateError();
    },
  };
}

// ── Movimientos ──────────────────────────────────────────────────────────────

const toMovement = (m: BankMovementModel): BankMovement => ({
  id: m.id,
  organizationId: m.organization_id,
  bankAccountId: m.bank_account_id,
  sourceType: m.source_type as BankMovementSource,
  sourceId: m.source_id,
  movementDate: String(m.movement_date),
  amountCents: Number(m.amount_cents),
  reference: m.reference,
  description: m.description,
  kind: m.kind as AdjustmentKind | null,
  status: m.status as BankMovementStatus,
  createdBy: m.created_by,
  version: m.version,
  createdAt: m.created_at,
  updatedAt: m.updated_at,
});

const movementFields = (m: BankMovement) => ({
  organization_id: m.organizationId,
  bank_account_id: m.bankAccountId,
  source_type: m.sourceType,
  source_id: m.sourceId,
  movement_date: m.movementDate,
  amount_cents: m.amountCents,
  reference: m.reference,
  description: m.description,
  kind: m.kind,
  status: m.status,
  created_by: m.createdBy,
  version: m.version,
  updated_at: m.updatedAt,
});

/** Subconsulta «este movimiento ya tiene emparejamiento». El alias de la tabla en Sequelize es el nombre del modelo. */
const MATCHED_SQL = 'EXISTS (SELECT 1 FROM bank_matches bm WHERE bm.organization_id = BankMovementModel.organization_id AND bm.movement_id = BankMovementModel.id)';

function movementRepository(tx?: Transaction): UnitOfWork['bankMovements'] {
  return {
    async findById(organizationId, id, options) {
      const lock = Boolean(options?.lock && tx);
      const row = await BankMovementModel.findOne({ where: { id, organization_id: organizationId }, transaction: tx, ...(lock ? { lock: tx!.LOCK.UPDATE } : {}) });
      return row ? toMovement(row) : null;
    },
    async findBySource(organizationId, sourceType, sourceId, options) {
      const lock = Boolean(options?.lock && tx);
      const row = await BankMovementModel.findOne({ where: { organization_id: organizationId, source_type: sourceType, source_id: sourceId }, transaction: tx, ...(lock ? { lock: tx!.LOCK.UPDATE } : {}) });
      return row ? toMovement(row) : null;
    },
    async list(organizationId, filters: BankMovementFilters): Promise<Page<BankMovement>> {
      const and: WhereOptions[] = [{ organization_id: organizationId }];
      if (filters.bankAccountId === 'none') and.push({ bank_account_id: null });
      else if (filters.bankAccountId) and.push({ bank_account_id: filters.bankAccountId });
      if (filters.status?.length) and.push({ status: filters.status });
      if (filters.from) and.push({ movement_date: { [Op.gte]: filters.from } });
      if (filters.to) and.push({ movement_date: { [Op.lte]: filters.to } });
      if (filters.matched === true) and.push(sequelize.literal(MATCHED_SQL));
      if (filters.matched === false) and.push(sequelize.literal(`NOT ${MATCHED_SQL}`));
      if (filters.q?.trim()) {
        const term = likeTerm(filters.q.trim());
        and.push({ [Op.or]: [{ reference: { [Op.like]: term } }, { description: { [Op.like]: term } }] });
      }
      const { rows, count } = await BankMovementModel.findAndCountAll({
        where: { [Op.and]: and },
        order: [['movement_date', 'DESC'], ['created_at', 'DESC']],
        limit: filters.pageSize,
        offset: (filters.page - 1) * filters.pageSize,
        transaction: tx,
      });
      return { items: rows.map(toMovement), total: count, page: filters.page, pageSize: filters.pageSize };
    },
    async listActiveByAccount(organizationId, bankAccountId) {
      const rows = await BankMovementModel.findAll({
        where: { organization_id: organizationId, bank_account_id: bankAccountId, status: 'active' },
        order: [['movement_date', 'ASC'], ['created_at', 'ASC']],
        transaction: tx,
      });
      return rows.map(toMovement);
    },
    async listActive(organizationId) {
      const rows = await BankMovementModel.findAll({ where: { organization_id: organizationId, status: 'active' }, transaction: tx });
      return rows.map(toMovement);
    },
    async countUnassigned(organizationId) {
      return BankMovementModel.count({ where: { organization_id: organizationId, bank_account_id: null, status: 'active' }, transaction: tx });
    },
    async save(movement, expectedVersion) {
      if (expectedVersion === undefined) {
        await BankMovementModel.create({ id: movement.id, created_at: movement.createdAt, ...movementFields(movement) }, { transaction: tx });
        return;
      }
      const [updated] = await BankMovementModel.update(movementFields(movement), { where: { id: movement.id, organization_id: movement.organizationId, version: expectedVersion }, transaction: tx });
      if (updated === 0) throw new ConcurrentUpdateError();
    },
  };
}

// ── Extractos y renglones ────────────────────────────────────────────────────

const toStatement = (m: BankStatementModel): BankStatement => ({
  id: m.id,
  organizationId: m.organization_id,
  bankAccountId: m.bank_account_id,
  fileName: m.file_name,
  contentHash: m.content_hash,
  periodStart: String(m.period_start),
  periodEnd: String(m.period_end),
  lineCount: m.line_count,
  closingBalanceCents: m.closing_balance_cents === null ? null : Number(m.closing_balance_cents),
  closingDate: m.closing_date ? String(m.closing_date) : null,
  importedBy: m.imported_by,
  importedAt: m.imported_at,
});

function statementRepository(tx?: Transaction): UnitOfWork['bankStatements'] {
  return {
    async findByHash(organizationId, bankAccountId, contentHash) {
      const row = await BankStatementModel.findOne({ where: { organization_id: organizationId, bank_account_id: bankAccountId, content_hash: contentHash }, transaction: tx });
      return row ? toStatement(row) : null;
    },
    async list(organizationId, bankAccountId) {
      const rows = await BankStatementModel.findAll({ where: { organization_id: organizationId, bank_account_id: bankAccountId }, order: [['imported_at', 'DESC']], transaction: tx });
      return rows.map(toStatement);
    },
    async add(s) {
      await BankStatementModel.create(
        {
          id: s.id,
          organization_id: s.organizationId,
          bank_account_id: s.bankAccountId,
          file_name: s.fileName,
          content_hash: s.contentHash,
          period_start: s.periodStart,
          period_end: s.periodEnd,
          line_count: s.lineCount,
          closing_balance_cents: s.closingBalanceCents,
          closing_date: s.closingDate,
          imported_by: s.importedBy,
          imported_at: s.importedAt,
        },
        { transaction: tx },
      );
    },
  };
}

const toLine = (m: BankStatementLineModel): BankStatementLine => ({
  id: m.id,
  organizationId: m.organization_id,
  bankAccountId: m.bank_account_id,
  statementId: m.statement_id,
  lineDate: String(m.line_date),
  description: m.description,
  reference: m.reference,
  amountCents: Number(m.amount_cents),
  balanceCents: m.balance_cents === null ? null : Number(m.balance_cents),
  fingerprint: m.fingerprint,
  status: m.status as LineStatus,
  externalReason: m.external_reason,
  reconciliationId: m.reconciliation_id,
  createdAt: m.created_at,
  updatedAt: m.updated_at,
});

function lineRepository(tx?: Transaction): UnitOfWork['bankLines'] {
  return {
    async findById(organizationId, id, options) {
      const lock = Boolean(options?.lock && tx);
      const row = await BankStatementLineModel.findOne({ where: { id, organization_id: organizationId }, transaction: tx, ...(lock ? { lock: tx!.LOCK.UPDATE } : {}) });
      return row ? toLine(row) : null;
    },
    async addMany(lines) {
      if (!lines.length) return;
      await BankStatementLineModel.bulkCreate(
        lines.map((l) => ({
          id: l.id,
          organization_id: l.organizationId,
          bank_account_id: l.bankAccountId,
          statement_id: l.statementId,
          line_date: l.lineDate,
          description: l.description,
          reference: l.reference,
          amount_cents: l.amountCents,
          balance_cents: l.balanceCents,
          fingerprint: l.fingerprint,
          status: l.status,
          external_reason: l.externalReason,
          reconciliation_id: l.reconciliationId,
          created_at: l.createdAt,
          updated_at: l.updatedAt,
        })),
        { transaction: tx },
      );
    },
    async existingFingerprints(organizationId, bankAccountId, fingerprints) {
      const found = new Set<string>();
      // En trozos: una lista IN de miles de huellas rompe el límite del paquete de MySQL.
      for (let i = 0; i < fingerprints.length; i += 500) {
        const chunk = fingerprints.slice(i, i + 500);
        const rows = await BankStatementLineModel.findAll({ attributes: ['fingerprint'], where: { organization_id: organizationId, bank_account_id: bankAccountId, fingerprint: chunk }, transaction: tx });
        for (const r of rows) found.add(r.fingerprint);
      }
      return found;
    },
    async list(organizationId, bankAccountId, filters: BankLineFilters): Promise<Page<BankStatementLine>> {
      const and: WhereOptions[] = [{ organization_id: organizationId, bank_account_id: bankAccountId }];
      if (filters.status?.length) and.push({ status: filters.status });
      if (filters.from) and.push({ line_date: { [Op.gte]: filters.from } });
      if (filters.to) and.push({ line_date: { [Op.lte]: filters.to } });
      if (filters.q?.trim()) {
        const term = likeTerm(filters.q.trim());
        and.push({ [Op.or]: [{ reference: { [Op.like]: term } }, { description: { [Op.like]: term } }] });
      }
      const { rows, count } = await BankStatementLineModel.findAndCountAll({
        where: { [Op.and]: and },
        order: [['line_date', 'DESC'], ['created_at', 'DESC'], ['id', 'ASC']],
        limit: filters.pageSize,
        offset: (filters.page - 1) * filters.pageSize,
        transaction: tx,
      });
      return { items: rows.map(toLine), total: count, page: filters.page, pageSize: filters.pageSize };
    },
    async listAll(organizationId, bankAccountId) {
      const rows = await BankStatementLineModel.findAll({ where: { organization_id: organizationId, bank_account_id: bankAccountId }, order: [['line_date', 'ASC'], ['created_at', 'ASC']], transaction: tx });
      return rows.map(toLine);
    },
    async save(line) {
      await BankStatementLineModel.update(
        { status: line.status, external_reason: line.externalReason, reconciliation_id: line.reconciliationId, updated_at: line.updatedAt },
        { where: { id: line.id, organization_id: line.organizationId }, transaction: tx },
      );
    },
    async freeze(organizationId, bankAccountId, upTo, reconciliationId) {
      await BankStatementLineModel.update(
        { reconciliation_id: reconciliationId },
        { where: { organization_id: organizationId, bank_account_id: bankAccountId, line_date: { [Op.lte]: upTo }, status: ['matched', 'external'], reconciliation_id: null }, transaction: tx },
      );
    },
    async unfreeze(organizationId, reconciliationId) {
      await BankStatementLineModel.update({ reconciliation_id: null }, { where: { organization_id: organizationId, reconciliation_id: reconciliationId }, transaction: tx });
    },
  };
}

// ── Emparejamientos ──────────────────────────────────────────────────────────

const toMatch = (m: BankMatchModel): BankMatch => ({
  id: m.id,
  organizationId: m.organization_id,
  bankAccountId: m.bank_account_id,
  lineId: m.line_id,
  movementId: m.movement_id,
  amountCents: Number(m.amount_cents),
  method: m.method as BankMatch['method'],
  matchedBy: m.matched_by,
  matchedAt: m.matched_at,
  reconciliationId: m.reconciliation_id,
});

function matchRepository(tx?: Transaction): UnitOfWork['bankMatches'] {
  return {
    async add(m) {
      await BankMatchModel.create(
        {
          id: m.id,
          organization_id: m.organizationId,
          bank_account_id: m.bankAccountId,
          line_id: m.lineId,
          movement_id: m.movementId,
          amount_cents: m.amountCents,
          method: m.method,
          matched_by: m.matchedBy,
          matched_at: m.matchedAt,
          reconciliation_id: m.reconciliationId,
        },
        { transaction: tx },
      );
    },
    async findByMovement(organizationId, movementId, options) {
      const lock = Boolean(options?.lock && tx);
      const row = await BankMatchModel.findOne({ where: { organization_id: organizationId, movement_id: movementId }, transaction: tx, ...(lock ? { lock: tx!.LOCK.UPDATE } : {}) });
      return row ? toMatch(row) : null;
    },
    async listByLines(organizationId, lineIds) {
      if (!lineIds.length) return [];
      const rows = await BankMatchModel.findAll({ where: { organization_id: organizationId, line_id: [...lineIds] }, transaction: tx });
      return rows.map(toMatch);
    },
    async listByMovements(organizationId, movementIds) {
      if (!movementIds.length) return [];
      const rows = await BankMatchModel.findAll({ where: { organization_id: organizationId, movement_id: [...movementIds] }, transaction: tx });
      return rows.map(toMatch);
    },
    async listByAccount(organizationId, bankAccountId) {
      const rows = await BankMatchModel.findAll({ where: { organization_id: organizationId, bank_account_id: bankAccountId }, transaction: tx });
      return rows.map(toMatch);
    },
    async removeByLine(organizationId, lineId) {
      const rows = await BankMatchModel.findAll({ where: { organization_id: organizationId, line_id: lineId }, transaction: tx });
      await BankMatchModel.destroy({ where: { organization_id: organizationId, line_id: lineId }, transaction: tx });
      return rows.map(toMatch);
    },
    async freeze(organizationId, reconciliationId) {
      await sequelize.query(
        'UPDATE bank_matches m JOIN bank_statement_lines l ON l.id = m.line_id SET m.reconciliation_id = :reconciliationId WHERE m.organization_id = :organizationId AND l.reconciliation_id = :reconciliationId',
        { replacements: { organizationId, reconciliationId }, transaction: tx, type: QueryTypes.UPDATE },
      );
    },
    async unfreeze(organizationId, reconciliationId) {
      await BankMatchModel.update({ reconciliation_id: null }, { where: { organization_id: organizationId, reconciliation_id: reconciliationId }, transaction: tx });
    },
  };
}

// ── Conciliaciones ───────────────────────────────────────────────────────────

const toReconciliation = (m: BankReconciliationModel): BankReconciliation => ({
  id: m.id,
  organizationId: m.organization_id,
  bankAccountId: m.bank_account_id,
  cutoffDate: String(m.cutoff_date),
  statementBalanceCents: Number(m.statement_balance_cents),
  registerBalanceCents: Number(m.register_balance_cents),
  pendingCents: Number(m.pending_cents),
  differenceCents: Number(m.difference_cents),
  status: m.status as BankReconciliation['status'],
  closedBy: m.closed_by,
  closedAt: m.closed_at,
  reopenedBy: m.reopened_by,
  reopenedAt: m.reopened_at,
  notes: m.notes,
  version: m.version,
  createdAt: m.created_at,
});

const reconciliationFields = (r: BankReconciliation) => ({
  organization_id: r.organizationId,
  bank_account_id: r.bankAccountId,
  cutoff_date: r.cutoffDate,
  statement_balance_cents: r.statementBalanceCents,
  register_balance_cents: r.registerBalanceCents,
  pending_cents: r.pendingCents,
  difference_cents: r.differenceCents,
  status: r.status,
  closed_by: r.closedBy,
  closed_at: r.closedAt,
  reopened_by: r.reopenedBy,
  reopened_at: r.reopenedAt,
  notes: r.notes,
  version: r.version,
});

function reconciliationRepository(tx?: Transaction): UnitOfWork['bankReconciliations'] {
  return {
    async findById(organizationId, id, options) {
      const lock = Boolean(options?.lock && tx);
      const row = await BankReconciliationModel.findOne({ where: { id, organization_id: organizationId }, transaction: tx, ...(lock ? { lock: tx!.LOCK.UPDATE } : {}) });
      return row ? toReconciliation(row) : null;
    },
    async findLatestClosed(organizationId, bankAccountId) {
      const row = await BankReconciliationModel.findOne({
        where: { organization_id: organizationId, bank_account_id: bankAccountId, status: 'closed' },
        order: [['cutoff_date', 'DESC'], ['closed_at', 'DESC']],
        transaction: tx,
      });
      return row ? toReconciliation(row) : null;
    },
    async list(organizationId, bankAccountId) {
      const rows = await BankReconciliationModel.findAll({ where: { organization_id: organizationId, bank_account_id: bankAccountId }, order: [['cutoff_date', 'DESC'], ['created_at', 'DESC']], transaction: tx });
      return rows.map(toReconciliation);
    },
    async save(reconciliation, expectedVersion) {
      if (expectedVersion === undefined) {
        await BankReconciliationModel.create({ id: reconciliation.id, created_at: reconciliation.createdAt, ...reconciliationFields(reconciliation) }, { transaction: tx });
        return;
      }
      const [updated] = await BankReconciliationModel.update(reconciliationFields(reconciliation), {
        where: { id: reconciliation.id, organization_id: reconciliation.organizationId, version: expectedVersion },
        transaction: tx,
      });
      if (updated === 0) throw new ConcurrentUpdateError();
    },
  };
}

/** Repositorios del bloque E. `buildRepositories` los une a los de cartera, cobros, deudas y pagos. */
export function buildBankRepositories(tx?: Transaction) {
  return {
    bankAccounts: accountRepository(tx),
    bankMovements: movementRepository(tx),
    bankStatements: statementRepository(tx),
    bankLines: lineRepository(tx),
    bankMatches: matchRepository(tx),
    bankReconciliations: reconciliationRepository(tx),
  };
}
