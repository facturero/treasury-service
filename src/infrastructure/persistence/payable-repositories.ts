import { randomUUID } from 'node:crypto';
import { Op, QueryTypes, type Transaction, type WhereOptions } from 'sequelize';
import { sequelize } from './sequelize.js';
import {
  PayableApplicationModel,
  PayableModel,
  PayableOpeningLoadModel,
  PaymentAdvanceUseModel,
  PaymentModel,
  PaymentSettingsModel,
  SupplierAdvanceModel,
  UnmatchedWithholdingModel,
} from './models.js';
import { ConcurrentUpdateError } from '../../domain/errors.js';
import type { Payable, PayableApplication, PayableSourceType, PayableStatus, SupplierAdvance } from '../../domain/payable.js';
import type { Payment, PaymentAccountRole, PaymentAdvanceUse, PaymentLine, PaymentMethod, PaymentStatus } from '../../domain/payment.js';
import type { Page, PayableFilters, PaymentFilters, UnitOfWork } from '../../domain/repositories.js';

/** Escapa los comodines de LIKE: buscar «100%» no debe traer todo. */
const likeTerm = (q: string): string => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

// ── Deudas ───────────────────────────────────────────────────────────────────

const toPayable = (m: PayableModel, appliedCents: number): Payable => ({
  id: m.id,
  organizationId: m.organization_id,
  supplierId: m.supplier_id,
  supplierName: m.supplier_name,
  supplierIdentification: m.supplier_identification,
  sourceType: m.source_type as PayableSourceType,
  sourceId: m.source_id,
  documentNumber: m.document_number,
  internalNumber: m.internal_number,
  issueDate: String(m.issue_date),
  dueDate: String(m.due_date),
  currencyCode: m.currency_code,
  originalCents: Number(m.original_cents),
  status: m.status as PayableStatus,
  version: m.version,
  createdAt: m.created_at,
  updatedAt: m.updated_at,
  appliedCents,
});

const payableFields = (p: Payable) => ({
  organization_id: p.organizationId,
  supplier_id: p.supplierId,
  supplier_name: p.supplierName,
  supplier_identification: p.supplierIdentification,
  source_type: p.sourceType,
  source_id: p.sourceId,
  document_number: p.documentNumber,
  internal_number: p.internalNumber,
  issue_date: p.issueDate,
  due_date: p.dueDate,
  currency_code: p.currencyCode,
  original_cents: p.originalCents,
  status: p.status,
  version: p.version,
  updated_at: p.updatedAt,
});

/** Lo aplicado vigente por deuda (pagos + retenciones). El saldo se deriva de esta suma, nunca se guarda. */
async function payableAppliedCents(tx: Transaction | undefined, organizationId: string, ids: readonly string[]): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (!ids.length) return map;
  const rows = await sequelize.query<{ payable_id: string; applied: string }>(
    `SELECT payable_id, SUM(applied_cents) AS applied
       FROM payable_applications
      WHERE organization_id = :organizationId AND payable_id IN (:ids) AND reversed_at IS NULL
      GROUP BY payable_id`,
    { replacements: { organizationId, ids }, transaction: tx, type: QueryTypes.SELECT },
  );
  for (const row of rows) map.set(row.payable_id, Number(row.applied));
  return map;
}

function payableRepository(tx?: Transaction): UnitOfWork['payables'] {
  const withApplied = async (rows: PayableModel[], organizationId: string): Promise<Payable[]> => {
    const applied = await payableAppliedCents(tx, organizationId, rows.map((r) => r.id));
    return rows.map((r) => toPayable(r, applied.get(r.id) ?? 0));
  };
  return {
    async findById(organizationId, id, options) {
      const lock = Boolean(options?.lock && tx);
      const row = await PayableModel.findOne({ where: { id, organization_id: organizationId }, transaction: tx, ...(lock ? { lock: tx!.LOCK.UPDATE } : {}) });
      return row ? (await withApplied([row], organizationId))[0]! : null;
    },
    async findBySource(organizationId, sourceType, sourceId) {
      const row = await PayableModel.findOne({ where: { organization_id: organizationId, source_type: sourceType, source_id: sourceId }, transaction: tx });
      return row ? (await withApplied([row], organizationId))[0]! : null;
    },
    async listBySupplierIdentification(organizationId, identification) {
      const rows = await PayableModel.findAll({
        where: { organization_id: organizationId, supplier_identification: identification },
        order: [['issue_date', 'ASC'], ['created_at', 'ASC']],
        transaction: tx,
      });
      return withApplied(rows, organizationId);
    },
    async list(organizationId, filters: PayableFilters): Promise<Page<Payable>> {
      // La deuda «fantasma» (anulación que llegó antes que la factura, sin proveedor) solo existe para que la factura posterior no abra nada.
      const and: WhereOptions[] = [{ organization_id: organizationId }, { supplier_id: { [Op.ne]: '' } }];
      if (filters.supplierId) and.push({ supplier_id: filters.supplierId });
      // «Vencida» y «por vencer» son deudas que siguen vivas: una pagada o anulada no vence.
      const LIVE: PayableStatus[] = ['open', 'partial'];
      const live = filters.overdueOnly || filters.dueBefore;
      const statuses = live ? (filters.status?.length ? filters.status.filter((s) => LIVE.includes(s)) : LIVE) : filters.status;
      if (statuses?.length) and.push({ status: statuses });
      else if (live) and.push({ id: null });
      if (filters.overdueOnly && filters.asOf) and.push({ due_date: { [Op.lt]: filters.asOf } });
      if (filters.dueBefore && filters.asOf) and.push({ due_date: { [Op.gte]: filters.asOf } }, { due_date: { [Op.lte]: filters.dueBefore } });
      if (filters.from) and.push({ issue_date: { [Op.gte]: filters.from } });
      if (filters.to) and.push({ issue_date: { [Op.lte]: filters.to } });
      if (filters.q?.trim()) {
        const term = likeTerm(filters.q.trim());
        and.push({ [Op.or]: [{ document_number: { [Op.like]: term } }, { internal_number: { [Op.like]: term } }, { supplier_name: { [Op.like]: term } }] });
      }
      const { rows, count } = await PayableModel.findAndCountAll({
        where: { [Op.and]: and },
        order: [['due_date', 'ASC'], ['created_at', 'DESC']],
        limit: filters.pageSize,
        offset: (filters.page - 1) * filters.pageSize,
        transaction: tx,
      });
      return { items: await withApplied(rows, organizationId), total: count, page: filters.page, pageSize: filters.pageSize };
    },
    async listBalances(organizationId, options) {
      const where: WhereOptions = { organization_id: organizationId, supplier_id: { [Op.ne]: '' } };
      if (options?.supplierId) (where as Record<string, unknown>).supplier_id = options.supplierId;
      const rows = await PayableModel.findAll({ where, order: [['issue_date', 'ASC'], ['created_at', 'ASC']], transaction: tx });
      return withApplied(rows, organizationId);
    },
    async save(payable, expectedVersion) {
      if (expectedVersion === undefined) {
        await PayableModel.create({ id: payable.id, created_at: payable.createdAt, ...payableFields(payable) }, { transaction: tx });
        return;
      }
      const [updated] = await PayableModel.update(payableFields(payable), {
        where: { id: payable.id, organization_id: payable.organizationId, version: expectedVersion },
        transaction: tx,
      });
      if (updated === 0) throw new ConcurrentUpdateError();
    },
  };
}

function payableApplicationRepository(tx?: Transaction): UnitOfWork['payableApplications'] {
  const toApplication = (m: PayableApplicationModel): PayableApplication => ({
    id: m.id,
    organizationId: m.organization_id,
    payableId: m.payable_id,
    sourceType: m.source_type as PayableApplication['sourceType'],
    sourceId: m.source_id,
    documentNumber: m.document_number,
    appliedCents: Number(m.applied_cents),
    appliedAt: String(m.applied_at),
    createdAt: m.created_at,
    reversedAt: m.reversed_at,
  });
  return {
    async listByPayable(organizationId, payableIds) {
      if (!payableIds.length) return [];
      const rows = await PayableApplicationModel.findAll({
        where: { organization_id: organizationId, payable_id: [...payableIds] },
        order: [['applied_at', 'ASC'], ['created_at', 'ASC']],
        transaction: tx,
      });
      return rows.map(toApplication);
    },
    async add(a) {
      await PayableApplicationModel.create(
        {
          id: a.id,
          organization_id: a.organizationId,
          payable_id: a.payableId,
          source_type: a.sourceType,
          source_id: a.sourceId,
          document_number: a.documentNumber,
          applied_cents: a.appliedCents,
          applied_at: a.appliedAt,
          reversed_at: null,
          created_at: a.createdAt,
        },
        { transaction: tx },
      );
    },
    async reverseBySource(organizationId, sourceType, sourceId, at) {
      const where = { organization_id: organizationId, source_type: sourceType, source_id: sourceId, reversed_at: null };
      const rows = await PayableApplicationModel.findAll({ where, transaction: tx });
      if (rows.length) await PayableApplicationModel.update({ reversed_at: at }, { where, transaction: tx });
      return rows.map((m) => ({ ...toApplication(m), reversedAt: at }));
    },
  };
}

// ── Anticipos a proveedores ──────────────────────────────────────────────────

/** Lo consumido vigente por anticipo (pagos posteriores que lo usan). */
async function advanceUsedCents(tx: Transaction | undefined, organizationId: string, ids: readonly string[]): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (!ids.length) return map;
  const rows = await sequelize.query<{ advance_id: string; used: string }>(
    `SELECT advance_id, SUM(used_cents) AS used
       FROM payment_advance_uses
      WHERE organization_id = :organizationId AND advance_id IN (:ids) AND reversed_at IS NULL
      GROUP BY advance_id`,
    { replacements: { organizationId, ids }, transaction: tx, type: QueryTypes.SELECT },
  );
  for (const row of rows) map.set(row.advance_id, Number(row.used));
  return map;
}

function supplierAdvanceRepository(tx?: Transaction): UnitOfWork['supplierAdvances'] {
  const toAdvance = (m: SupplierAdvanceModel, appliedCents: number): SupplierAdvance => ({
    id: m.id,
    organizationId: m.organization_id,
    supplierId: m.supplier_id,
    supplierName: m.supplier_name,
    supplierIdentification: m.supplier_identification,
    originId: m.origin_id,
    documentNumber: m.document_number,
    currencyCode: m.currency_code,
    originalCents: Number(m.original_cents),
    version: m.version,
    createdAt: m.created_at,
    updatedAt: m.updated_at,
    appliedCents,
    voidedAt: m.voided_at,
  });
  const fields = (a: SupplierAdvance) => ({
    organization_id: a.organizationId,
    supplier_id: a.supplierId,
    supplier_name: a.supplierName,
    supplier_identification: a.supplierIdentification,
    origin_id: a.originId,
    document_number: a.documentNumber,
    currency_code: a.currencyCode,
    original_cents: a.originalCents,
    version: a.version,
    updated_at: a.updatedAt,
    voided_at: a.voidedAt ?? null,
  });
  return {
    async findById(organizationId, id, options) {
      const lock = Boolean(options?.lock && tx);
      const row = await SupplierAdvanceModel.findOne({ where: { id, organization_id: organizationId }, transaction: tx, ...(lock ? { lock: tx!.LOCK.UPDATE } : {}) });
      if (!row) return null;
      return toAdvance(row, (await advanceUsedCents(tx, organizationId, [row.id])).get(row.id) ?? 0);
    },
    async findByOrigin(organizationId, originId) {
      const row = await SupplierAdvanceModel.findOne({ where: { organization_id: organizationId, origin_id: originId }, transaction: tx });
      if (!row) return null;
      return toAdvance(row, (await advanceUsedCents(tx, organizationId, [row.id])).get(row.id) ?? 0);
    },
    async listBySupplier(organizationId, supplierId) {
      const rows = await SupplierAdvanceModel.findAll({ where: { organization_id: organizationId, supplier_id: supplierId, voided_at: null }, order: [['created_at', 'ASC']], transaction: tx });
      const used = await advanceUsedCents(tx, organizationId, rows.map((r) => r.id));
      return rows.map((r) => toAdvance(r, used.get(r.id) ?? 0));
    },
    async save(advance, expectedVersion) {
      if (expectedVersion === undefined) {
        await SupplierAdvanceModel.create({ id: advance.id, created_at: advance.createdAt, ...fields(advance) }, { transaction: tx });
        return;
      }
      const [updated] = await SupplierAdvanceModel.update(fields(advance), { where: { id: advance.id, organization_id: advance.organizationId, version: expectedVersion }, transaction: tx });
      if (updated === 0) throw new ConcurrentUpdateError();
    },
  };
}

// ── Pagos ────────────────────────────────────────────────────────────────────

const asJsonArray = <T>(value: unknown): T[] => {
  if (Array.isArray(value)) return value as T[];
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? (parsed as T[]) : [];
    } catch {
      return [];
    }
  }
  return [];
};

const toPayment = (m: PaymentModel): Payment => ({
  id: m.id,
  organizationId: m.organization_id,
  number: m.number,
  supplierId: m.supplier_id,
  supplierName: m.supplier_name,
  supplierIdentification: m.supplier_identification,
  paymentDate: String(m.payment_date),
  method: m.method as PaymentMethod,
  accountRole: m.account_role as PaymentAccountRole,
  bankAccountId: m.bank_account_id,
  reference: m.reference,
  currencyCode: m.currency_code,
  totalCents: Number(m.total_cents),
  advanceUsedCents: Number(m.advance_used_cents),
  appliedCents: Number(m.applied_cents),
  advanceCents: Number(m.advance_cents),
  lines: asJsonArray<PaymentLine>(m.lines),
  advanceUses: asJsonArray<PaymentAdvanceUse>(m.advance_uses),
  notes: m.notes,
  status: m.status as PaymentStatus,
  voidReason: m.void_reason,
  createdBy: m.created_by,
  approvedBy: m.approved_by,
  postedBy: m.posted_by,
  voidedBy: m.voided_by,
  approvedAt: m.approved_at,
  postedAt: m.posted_at,
  voidedAt: m.voided_at,
  version: m.version,
  createdAt: m.created_at,
  updatedAt: m.updated_at,
});

const paymentFields = (p: Payment) => ({
  organization_id: p.organizationId,
  number: p.number,
  supplier_id: p.supplierId,
  supplier_name: p.supplierName,
  supplier_identification: p.supplierIdentification,
  payment_date: p.paymentDate,
  method: p.method,
  account_role: p.accountRole,
  bank_account_id: p.bankAccountId,
  reference: p.reference,
  currency_code: p.currencyCode,
  total_cents: p.totalCents,
  advance_used_cents: p.advanceUsedCents,
  applied_cents: p.appliedCents,
  advance_cents: p.advanceCents,
  lines: p.lines,
  advance_uses: p.advanceUses,
  notes: p.notes,
  status: p.status,
  void_reason: p.voidReason,
  approved_by: p.approvedBy,
  posted_by: p.postedBy,
  voided_by: p.voidedBy,
  approved_at: p.approvedAt,
  posted_at: p.postedAt,
  voided_at: p.voidedAt,
  version: p.version,
  updated_at: p.updatedAt,
});

function paymentRepository(tx?: Transaction): UnitOfWork['payments'] {
  return {
    async findById(organizationId, id, options) {
      const lock = Boolean(options?.lock && tx);
      const row = await PaymentModel.findOne({ where: { id, organization_id: organizationId }, transaction: tx, ...(lock ? { lock: tx!.LOCK.UPDATE } : {}) });
      return row ? toPayment(row) : null;
    },
    async list(organizationId, filters: PaymentFilters): Promise<Page<Payment>> {
      const and: WhereOptions[] = [{ organization_id: organizationId }];
      if (filters.supplierId) and.push({ supplier_id: filters.supplierId });
      if (filters.status?.length) and.push({ status: filters.status });
      if (filters.from) and.push({ payment_date: { [Op.gte]: filters.from } });
      if (filters.to) and.push({ payment_date: { [Op.lte]: filters.to } });
      if (filters.q?.trim()) {
        const term = likeTerm(filters.q.trim());
        and.push({ [Op.or]: [{ number: { [Op.like]: term } }, { reference: { [Op.like]: term } }, { supplier_name: { [Op.like]: term } }] });
      }
      const { rows, count } = await PaymentModel.findAndCountAll({
        where: { [Op.and]: and },
        order: [['payment_date', 'DESC'], ['created_at', 'DESC']],
        limit: filters.pageSize,
        offset: (filters.page - 1) * filters.pageSize,
        transaction: tx,
      });
      return { items: rows.map(toPayment), total: count, page: filters.page, pageSize: filters.pageSize };
    },
    async save(payment, expectedVersion) {
      if (expectedVersion === undefined) {
        await PaymentModel.create({ id: payment.id, created_by: payment.createdBy, created_at: payment.createdAt, ...paymentFields(payment) }, { transaction: tx });
        return;
      }
      const [updated] = await PaymentModel.update(paymentFields(payment), { where: { id: payment.id, organization_id: payment.organizationId, version: expectedVersion }, transaction: tx });
      if (updated === 0) throw new ConcurrentUpdateError();
    },
    async nextSequence(organizationId, year) {
      // El UPDATE (vía ON DUPLICATE KEY) va antes que el SELECT … FOR UPDATE: la primera del año crea la fila y las demás esperan su turno.
      await sequelize.query(
        'INSERT INTO payment_sequences (organization_id, year, current_value) VALUES (:organizationId, :year, 1) ON DUPLICATE KEY UPDATE current_value = current_value + 1',
        { replacements: { organizationId, year }, transaction: tx },
      );
      const [row] = await sequelize.query<{ current_value: number }>(
        'SELECT current_value FROM payment_sequences WHERE organization_id = :organizationId AND year = :year FOR UPDATE',
        { replacements: { organizationId, year }, transaction: tx, type: QueryTypes.SELECT },
      );
      return Number(row!.current_value);
    },
  };
}

function paymentAdvanceUseRepository(tx?: Transaction): UnitOfWork['paymentAdvanceUses'] {
  return {
    async add(organizationId, paymentId, use, at) {
      await PaymentAdvanceUseModel.create(
        { id: randomUUID(), organization_id: organizationId, payment_id: paymentId, advance_id: use.advanceId, used_cents: use.usedCents, reversed_at: null, created_at: at },
        { transaction: tx },
      );
    },
    async reverseByPayment(organizationId, paymentId, at) {
      await PaymentAdvanceUseModel.update({ reversed_at: at }, { where: { organization_id: organizationId, payment_id: paymentId, reversed_at: null }, transaction: tx });
    },
  };
}

// ── Configuración, retenciones sin emparejar y saldos iniciales ──────────────

function paymentSettingsRepository(tx?: Transaction): UnitOfWork['paymentSettings'] {
  return {
    async find(organizationId) {
      const row = await PaymentSettingsModel.findByPk(organizationId, { transaction: tx });
      if (!row) return null;
      return {
        organizationId: row.organization_id,
        approvalThresholdCents: row.approval_threshold_cents === null ? null : Number(row.approval_threshold_cents),
        updatedBy: row.updated_by,
        updatedAt: row.updated_at,
      };
    },
    async save(settings) {
      const now = new Date();
      const fields = { approval_threshold_cents: settings.approvalThresholdCents, updated_by: settings.updatedBy, updated_at: settings.updatedAt ?? now };
      const [updated] = await PaymentSettingsModel.update(fields, { where: { organization_id: settings.organizationId }, transaction: tx });
      if (updated === 0) {
        const exists = await PaymentSettingsModel.count({ where: { organization_id: settings.organizationId }, transaction: tx });
        if (!exists) await PaymentSettingsModel.create({ organization_id: settings.organizationId, ...fields, created_at: now }, { transaction: tx });
      }
    },
  };
}

function unmatchedWithholdingRepository(tx?: Transaction): UnitOfWork['unmatchedWithholdings'] {
  return {
    async add(w) {
      await UnmatchedWithholdingModel.create(
        {
          id: w.id,
          organization_id: w.organizationId,
          withholding_id: w.withholdingId,
          number: w.number,
          supplier_identification: w.supplierIdentification,
          support_number: w.supportNumber,
          issue_date: w.issueDate,
          total_withheld_cents: w.totalWithheldCents,
          created_at: w.createdAt,
        },
        { transaction: tx },
      );
    },
    async listBySupplierIdentification(organizationId, identification) {
      const rows = await UnmatchedWithholdingModel.findAll({ where: { organization_id: organizationId, supplier_identification: identification }, order: [['created_at', 'ASC']], transaction: tx });
      return rows.map((m) => ({
        id: m.id,
        organizationId: m.organization_id,
        withholdingId: m.withholding_id,
        number: m.number,
        supplierIdentification: m.supplier_identification,
        supportNumber: m.support_number,
        issueDate: m.issue_date ? String(m.issue_date) : null,
        totalWithheldCents: Number(m.total_withheld_cents),
        createdAt: m.created_at,
      }));
    },
    async remove(organizationId, id) {
      await UnmatchedWithholdingModel.destroy({ where: { organization_id: organizationId, id }, transaction: tx });
    },
  };
}

function payableOpeningLoadRepository(tx?: Transaction): UnitOfWork['payableOpeningLoads'] {
  return {
    async findByCutoff(organizationId, cutoffDate) {
      const row = await PayableOpeningLoadModel.findOne({ where: { organization_id: organizationId, cutoff_date: cutoffDate }, transaction: tx });
      if (!row) return null;
      return { id: row.id, organizationId: row.organization_id, cutoffDate: String(row.cutoff_date), loadedBy: row.loaded_by, reason: row.reason, totalCents: Number(row.total_cents), createdAt: row.created_at };
    },
    async save(load) {
      await PayableOpeningLoadModel.create(
        { id: load.id, organization_id: load.organizationId, cutoff_date: load.cutoffDate, loaded_by: load.loadedBy, reason: load.reason, total_cents: load.totalCents, created_at: load.createdAt },
        { transaction: tx },
      );
    },
  };
}

/** Repositorios de cuentas por pagar y pagos (bloque D). `buildRepositories` los une a los de cartera y cobros. */
export function buildPayableRepositories(tx?: Transaction) {
  return {
    payables: payableRepository(tx),
    payableApplications: payableApplicationRepository(tx),
    supplierAdvances: supplierAdvanceRepository(tx),
    payments: paymentRepository(tx),
    paymentAdvanceUses: paymentAdvanceUseRepository(tx),
    paymentSettings: paymentSettingsRepository(tx),
    unmatchedWithholdings: unmatchedWithholdingRepository(tx),
    payableOpeningLoads: payableOpeningLoadRepository(tx),
  };
}
