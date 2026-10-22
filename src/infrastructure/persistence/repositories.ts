import { randomUUID } from 'node:crypto';
import { Op, QueryTypes, Transaction, type WhereOptions } from 'sequelize';
import { withActor } from '@facturero/outbox-relay';
import { sequelize } from './sequelize.js';
import { buildPayableRepositories } from './payable-repositories.js';
import {
  CreditApplicationModel,
  CustomerAdvanceApplicationModel,
  CustomerAdvanceModel,
  CustomerTermsModel,
  OpeningBalanceLoadModel,
  OutboxModel,
  ReceiptAdvanceUseModel,
  ReceiptLineModel,
  ReceiptModel,
  ReceivableModel,
  ReceivableReminderModel,
  ReminderSettingsModel,
} from './models.js';
import type { WriteUnitOfWork } from '../../application/ports.js';
import { ConcurrentUpdateError } from '../../domain/errors.js';
import type {
  CreditApplication,
  CustomerAdvance,
  CustomerAdvanceApplication,
  CustomerTerms,
  OpeningBalanceLoad,
  Receivable,
  ReceivableSourceType,
  ReceivableStatus,
} from '../../domain/receivable.js';
import type { DomainEvent, Page, ReceiptFilters, ReceivableFilters, UnitOfWork } from '../../domain/repositories.js';
import type { ReminderSettings } from '../../domain/reminder.js';
import type { Receipt, ReceiptAccountRole, ReceiptAdvanceUse, ReceiptMethod, ReceiptStatus } from '../../domain/receipt.js';

// ── Partidas ─────────────────────────────────────────────────────────────────

const toReceivable = (m: ReceivableModel, appliedCents: number): Receivable => ({
  id: m.id,
  organizationId: m.organization_id,
  customerId: m.customer_id,
  customerName: m.customer_name,
  customerIdentification: m.customer_identification,
  sourceType: m.source_type as ReceivableSourceType,
  sourceId: m.source_id,
  documentNumber: m.document_number,
  issueDate: String(m.issue_date),
  dueDate: String(m.due_date),
  currencyCode: m.currency_code,
  originalCents: Number(m.original_cents),
  status: m.status as ReceivableStatus,
  version: m.version,
  createdAt: m.created_at,
  updatedAt: m.updated_at,
  appliedCents,
});

const receivableFields = (r: Receivable) => ({
  organization_id: r.organizationId,
  customer_id: r.customerId,
  customer_name: r.customerName,
  customer_identification: r.customerIdentification,
  source_type: r.sourceType,
  source_id: r.sourceId,
  document_number: r.documentNumber,
  issue_date: r.issueDate,
  due_date: r.dueDate,
  currency_code: r.currencyCode,
  original_cents: r.originalCents,
  status: r.status,
  version: r.version,
  updated_at: r.updatedAt,
});

/** Escapa los comodines de LIKE: buscar «100%» no debe traer todo. */
const likeTerm = (q: string): string => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

function receivableRepository(tx?: Transaction): UnitOfWork['receivables'] {
  return {
    async findById(organizationId, id, options) {
      const lock = Boolean(options?.lock && tx);
      const row = await ReceivableModel.findOne({
        where: { id, organization_id: organizationId },
        transaction: tx,
        ...(lock ? { lock: tx!.LOCK.UPDATE } : {}),
      });
      if (!row) return null;
      const applied = await appliedCentsOf(tx, organizationId, [row.id]);
      return toReceivable(row, applied.get(row.id) ?? 0);
    },

    async findBySource(organizationId, sourceType, sourceId) {
      const row = await ReceivableModel.findOne({
        where: { organization_id: organizationId, source_type: sourceType, source_id: sourceId },
        transaction: tx,
      });
      if (!row) return null;
      const applied = await appliedCentsOf(tx, organizationId, [row.id]);
      return toReceivable(row, applied.get(row.id) ?? 0);
    },

    async list(organizationId, filters: ReceivableFilters): Promise<Page<Receivable>> {
      // La partida «fantasma» (una anulación que llegó antes que su emisión, sin cliente ni importe) solo existe para que la
      // emisión posterior no abra una deuda: no es cartera y no se lista.
      const and: WhereOptions[] = [{ organization_id: organizationId }, { customer_id: { [Op.ne]: '' } }];
      if (filters.customerId) and.push({ customer_id: filters.customerId });
      // «Vencida» es una deuda que sigue viva: una partida pagada, anulada o castigada con vencimiento pasado no está vencida.
      const LIVE: ReceivableStatus[] = ['open', 'partial'];
      const statuses = filters.overdueOnly ? (filters.status?.length ? filters.status.filter((s) => LIVE.includes(s)) : LIVE) : filters.status;
      if (statuses?.length) and.push({ status: statuses });
      else if (filters.overdueOnly) and.push({ id: null }); // pidió solo estados que no pueden estar vencidos: ninguna coincide
      if (filters.overdueOnly && filters.asOf) and.push({ due_date: { [Op.lt]: filters.asOf } });
      if (filters.from) and.push({ issue_date: { [Op.gte]: filters.from } });
      if (filters.to) and.push({ issue_date: { [Op.lte]: filters.to } });
      if (filters.q?.trim()) {
        const term = likeTerm(filters.q.trim());
        and.push({ [Op.or]: [{ document_number: { [Op.like]: term } }, { customer_name: { [Op.like]: term } }] });
      }
      const { rows, count } = await ReceivableModel.findAndCountAll({
        where: { [Op.and]: and },
        order: [['issue_date', 'DESC'], ['created_at', 'DESC']],
        limit: filters.pageSize,
        offset: (filters.page - 1) * filters.pageSize,
        transaction: tx,
      });
      const applied = await appliedCentsOf(tx, organizationId, rows.map((r) => r.id));
      return {
        items: rows.map((r) => toReceivable(r, applied.get(r.id) ?? 0)),
        total: count,
        page: filters.page,
        pageSize: filters.pageSize,
      };
    },

    async listBalances(organizationId, options) {
      const where: WhereOptions = { organization_id: organizationId, customer_id: { [Op.ne]: '' } };
      if (options?.customerId) where.customer_id = options.customerId;
      const rows = await ReceivableModel.findAll({
        where,
        order: [['issue_date', 'ASC'], ['created_at', 'ASC']],
        transaction: tx,
      });
      const applied = await appliedCentsOf(tx, organizationId, rows.map((r) => r.id));
      return rows.map((r) => toReceivable(r, applied.get(r.id) ?? 0));
    },

    async save(receivable, expectedVersion) {
      if (expectedVersion === undefined) {
        await ReceivableModel.create({ id: receivable.id, created_at: receivable.createdAt, ...receivableFields(receivable) }, { transaction: tx });
        return;
      }
      // Solo si nadie la cambió desde que se leyó: si no, dos personas (o dos eventos) se pisarían sin saberlo.
      const [updated] = await ReceivableModel.update(receivableFields(receivable), {
        where: { id: receivable.id, organization_id: receivable.organizationId, version: expectedVersion },
        transaction: tx,
      });
      if (updated === 0) throw new ConcurrentUpdateError();
    },

    async appliedCentsOf(organizationId, receivableIds) {
      return appliedCentsOf(tx, organizationId, receivableIds);
    },
  };
}

/**
 * Suma aplicada por partida.
 *
 * El saldo de una partida NUNCA es una columna que se reste a mano: se deriva de esta suma. En el bloque B esta
 * consulta sumará también `receipt_applications` (los cobros): hasta entonces, solo hay notas de crédito.
 */
async function appliedCentsOf(
  tx: Transaction | undefined,
  organizationId: string,
  receivableIds: readonly string[],
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (!receivableIds.length) return map;
  const rows = await sequelize.query<{ receivable_id: string; applied: string }>(
    `SELECT receivable_id, SUM(applied_cents) AS applied
       FROM credit_applications
      WHERE organization_id = :organizationId
        AND receivable_id IN (:receivableIds)
        AND reversed_at IS NULL
      GROUP BY receivable_id`,
    { replacements: { organizationId, receivableIds }, transaction: tx, type: QueryTypes.SELECT },
  );
  for (const row of rows) map.set(row.receivable_id, Number(row.applied));
  return map;
}

// ── Aplicaciones de nota de crédito ─────────────────────────────────────────

function creditApplicationRepository(tx?: Transaction): UnitOfWork['creditApplications'] {
  const toApplication = (m: CreditApplicationModel): CreditApplication => ({
    id: m.id,
    organizationId: m.organization_id,
    receivableId: m.receivable_id,
    sourceId: m.source_id,
    sourceType: m.source_type as CreditApplication['sourceType'],
    documentNumber: m.document_number,
    appliedCents: Number(m.applied_cents),
    appliedAt: String(m.applied_at),
    createdAt: m.created_at,
    reversedAt: m.reversed_at,
  });

  return {
    async listByReceivable(organizationId, receivableIds) {
      if (!receivableIds.length) return [];
      const rows = await CreditApplicationModel.findAll({
        where: { organization_id: organizationId, receivable_id: receivableIds },
        order: [['applied_at', 'ASC'], ['created_at', 'ASC']],
        transaction: tx,
      });
      return rows.map(toApplication);
    },

    async add(application) {
      await CreditApplicationModel.create(
        {
          id: application.id,
          organization_id: application.organizationId,
          receivable_id: application.receivableId,
          source_type: application.sourceType,
          source_id: application.sourceId,
          document_number: application.documentNumber,
          applied_cents: application.appliedCents,
          applied_at: application.appliedAt,
          created_at: application.createdAt,
        },
        { transaction: tx },
      );
    },

    async reverseBySource(organizationId, sourceType, sourceId, at) {
      const rows = await CreditApplicationModel.findAll({
        where: { organization_id: organizationId, source_type: sourceType, source_id: sourceId, reversed_at: null },
        transaction: tx,
      });
      if (rows.length) {
        await CreditApplicationModel.update(
          { reversed_at: at },
          { where: { organization_id: organizationId, source_type: sourceType, source_id: sourceId, reversed_at: null }, transaction: tx },
        );
      }
      return rows.map((m) => ({ ...toApplication(m), reversedAt: at }));
    },
  };
}

// ── Saldos a favor ───────────────────────────────────────────────────────────

function customerAdvanceRepository(tx?: Transaction): UnitOfWork['advances'] {
  const toAdvance = (m: CustomerAdvanceModel, appliedCents: number): CustomerAdvance => ({
    id: m.id,
    organizationId: m.organization_id,
    customerId: m.customer_id,
    customerName: m.customer_name,
    customerIdentification: m.customer_identification,
    origin: m.origin as CustomerAdvance['origin'],
    originId: m.origin_id,
    relatedInvoiceId: m.related_invoice_id,
    documentNumber: m.document_number,
    currencyCode: m.currency_code,
    originalCents: Number(m.original_cents),
    version: m.version,
    createdAt: m.created_at,
    updatedAt: m.updated_at,
    appliedCents,
    voidedAt: m.voided_at,
  });

  const advanceFields = (a: CustomerAdvance) => ({
    organization_id: a.organizationId,
    customer_id: a.customerId,
    customer_name: a.customerName,
    customer_identification: a.customerIdentification,
    origin: a.origin,
    origin_id: a.originId,
    related_invoice_id: a.relatedInvoiceId,
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
      const row = await CustomerAdvanceModel.findOne({
        where: { id, organization_id: organizationId },
        transaction: tx,
        ...(lock ? { lock: tx!.LOCK.UPDATE } : {}),
      });
      if (!row) return null;
      const applied = await advanceAppliedCentsOf(tx, organizationId, [row.id]);
      return toAdvance(row, applied.get(row.id) ?? 0);
    },

    async findByOrigin(organizationId, origin, originId) {
      const row = await CustomerAdvanceModel.findOne({
        where: { organization_id: organizationId, origin, origin_id: originId },
        transaction: tx,
      });
      if (!row) return null;
      const applied = await advanceAppliedCentsOf(tx, organizationId, [row.id]);
      return toAdvance(row, applied.get(row.id) ?? 0);
    },

    async listByCustomer(organizationId, customerId) {
      const rows = await CustomerAdvanceModel.findAll({
        where: { organization_id: organizationId, customer_id: customerId, voided_at: null },
        order: [['created_at', 'ASC']],
        transaction: tx,
      });
      const applied = await advanceAppliedCentsOf(tx, organizationId, rows.map((r) => r.id));
      return rows.map((r) => toAdvance(r, applied.get(r.id) ?? 0));
    },

    async listApplicable(organizationId, customerId, invoiceId) {
      // Un saldo a favor con factura relacionada solo se aplica a ESA factura; sin ella, a la próxima del cliente.
      const rows = await CustomerAdvanceModel.findAll({
        where: {
          organization_id: organizationId,
          customer_id: customerId,
          voided_at: null,
          [Op.or]: [{ related_invoice_id: null }, { related_invoice_id: invoiceId }],
        },
        order: [['created_at', 'ASC']],
        transaction: tx,
      });
      const applied = await advanceAppliedCentsOf(tx, organizationId, rows.map((r) => r.id));
      // Los que ya se consumieron enteros no se pueden volver a aplicar.
      return rows
        .map((r) => toAdvance(r, applied.get(r.id) ?? 0))
        .filter((a) => a.originalCents - a.appliedCents > 0);
    },

    async save(advance, expectedVersion) {
      if (expectedVersion === undefined) {
        await CustomerAdvanceModel.create({ id: advance.id, created_at: advance.createdAt, ...advanceFields(advance) }, { transaction: tx });
        return;
      }
      const [updated] = await CustomerAdvanceModel.update(advanceFields(advance), {
        where: { id: advance.id, organization_id: advance.organizationId, version: expectedVersion },
        transaction: tx,
      });
      if (updated === 0) throw new ConcurrentUpdateError();
    },

    async appliedCentsOf(organizationId, advanceIds) {
      return advanceAppliedCentsOf(tx, organizationId, advanceIds);
    },
  };
}

async function advanceAppliedCentsOf(
  tx: Transaction | undefined,
  organizationId: string,
  advanceIds: readonly string[],
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (!advanceIds.length) return map;
  // Lo consumido de un anticipo = lo aplicado a partidas (notas de crédito que llegaron antes que su factura) + lo que consumieron
  // los recibos VIGENTES. Un recibo anulado devuelve su consumo: la fila se marca `reversed_at` y esta suma la ignora.
  const rows = await sequelize.query<{ advance_id: string; applied: string }>(
    `SELECT advance_id, SUM(cents) AS applied FROM (
        SELECT advance_id, applied_cents AS cents FROM customer_advance_applications
         WHERE organization_id = :organizationId AND advance_id IN (:advanceIds)
        UNION ALL
        SELECT advance_id, used_cents AS cents FROM receipt_advance_uses
         WHERE organization_id = :organizationId AND advance_id IN (:advanceIds) AND reversed_at IS NULL
      ) u GROUP BY advance_id`,
    { replacements: { organizationId, advanceIds }, transaction: tx, type: QueryTypes.SELECT },
  );
  for (const row of rows) map.set(row.advance_id, Number(row.applied));
  return map;
}

function customerAdvanceApplicationRepository(tx?: Transaction): UnitOfWork['advanceApplications'] {
  const toApplication = (m: CustomerAdvanceApplicationModel): CustomerAdvanceApplication => ({
    id: m.id,
    organizationId: m.organization_id,
    advanceId: m.advance_id,
    receivableId: m.receivable_id,
    appliedCents: Number(m.applied_cents),
    createdAt: m.created_at,
  });

  return {
    async listByAdvance(organizationId, advanceIds) {
      if (!advanceIds.length) return [];
      const rows = await CustomerAdvanceApplicationModel.findAll({
        where: { organization_id: organizationId, advance_id: advanceIds },
        order: [['created_at', 'ASC']],
        transaction: tx,
      });
      return rows.map(toApplication);
    },

    async add(application) {
      await CustomerAdvanceApplicationModel.create(
        {
          id: application.id,
          organization_id: application.organizationId,
          advance_id: application.advanceId,
          receivable_id: application.receivableId,
          applied_cents: application.appliedCents,
          created_at: application.createdAt,
        },
        { transaction: tx },
      );
    },
  };
}

// ── Condiciones de crédito y saldos iniciales ────────────────────────────────

function customerTermsRepository(tx?: Transaction): UnitOfWork['customerTerms'] {
  return {
    async find(organizationId, customerId) {
      const row = await CustomerTermsModel.findOne({ where: { organization_id: organizationId, customer_id: customerId }, transaction: tx });
      if (!row) return null;
      return {
        organizationId: row.organization_id,
        customerId: row.customer_id,
        customerName: row.customer_name,
        creditDays: row.credit_days,
        creditLimitCents: row.credit_limit_cents === null ? null : Number(row.credit_limit_cents),
        updatedBy: row.updated_by,
        updatedAt: row.updated_at,
      } satisfies CustomerTerms;
    },
    async save(terms) {
      const fields = {
        customer_name: terms.customerName,
        credit_days: terms.creditDays,
        credit_limit_cents: terms.creditLimitCents,
        updated_by: terms.updatedBy,
        updated_at: terms.updatedAt,
      };
      const [updated] = await CustomerTermsModel.update(fields, {
        where: { organization_id: terms.organizationId, customer_id: terms.customerId },
        transaction: tx,
      });
      if (updated === 0) {
        const exists = await CustomerTermsModel.count({ where: { organization_id: terms.organizationId, customer_id: terms.customerId }, transaction: tx });
        if (!exists) {
          await CustomerTermsModel.create(
            { organization_id: terms.organizationId, customer_id: terms.customerId, ...fields },
            { transaction: tx },
          );
        }
      }
    },
  };
}

function openingBalanceLoadRepository(tx?: Transaction): UnitOfWork['openingBalanceLoads'] {
  return {
    async findByCutoff(organizationId, cutoffDate) {
      const row = await OpeningBalanceLoadModel.findOne({ where: { organization_id: organizationId, cutoff_date: cutoffDate }, transaction: tx });
      if (!row) return null;
      return {
        id: row.id,
        organizationId: row.organization_id,
        cutoffDate: String(row.cutoff_date),
        loadedBy: row.loaded_by,
        reason: row.reason,
        totalCents: Number(row.total_cents),
        createdAt: row.created_at,
      } satisfies OpeningBalanceLoad;
    },
    async save(load) {
      await OpeningBalanceLoadModel.create(
        {
          id: load.id,
          organization_id: load.organizationId,
          cutoff_date: load.cutoffDate,
          loaded_by: load.loadedBy,
          reason: load.reason,
          total_cents: load.totalCents,
          created_at: load.createdAt,
        },
        { transaction: tx },
      );
    },
  };
}

// ── Cobros (recibos) ─────────────────────────────────────────────────────────

function receiptRepository(tx?: Transaction): UnitOfWork['receipts'] {
  const toReceipt = (m: ReceiptModel, lines: ReceiptLineModel[]): Receipt => ({
    id: m.id,
    organizationId: m.organization_id,
    number: m.number,
    customerId: m.customer_id,
    customerName: m.customer_name,
    customerIdentification: m.customer_identification,
    receiptDate: String(m.receipt_date),
    method: m.method as ReceiptMethod,
    accountRole: m.account_role as ReceiptAccountRole,
    reference: m.reference,
    currencyCode: m.currency_code,
    totalCents: Number(m.total_cents),
    advanceUsedCents: Number(m.advance_used_cents),
    appliedCents: Number(m.applied_cents),
    advanceCents: Number(m.advance_cents),
    lines: lines.map((l) => ({ receivableId: l.receivable_id, appliedCents: Number(l.applied_cents) })),
    advanceUses: ((m.advance_uses as ReceiptAdvanceUse[] | null) ?? []).map((u) => ({ advanceId: u.advanceId, usedCents: Number(u.usedCents) })),
    notes: m.notes,
    status: m.status as ReceiptStatus,
    voidReason: m.void_reason,
    createdBy: m.created_by,
    postedBy: m.posted_by,
    voidedBy: m.voided_by,
    postedAt: m.posted_at,
    voidedAt: m.voided_at,
    version: m.version,
    createdAt: m.created_at,
    updatedAt: m.updated_at,
  });

  const receiptFields = (r: Receipt) => ({
    organization_id: r.organizationId,
    number: r.number,
    customer_id: r.customerId,
    customer_name: r.customerName,
    customer_identification: r.customerIdentification,
    receipt_date: r.receiptDate,
    method: r.method,
    account_role: r.accountRole,
    reference: r.reference,
    currency_code: r.currencyCode,
    total_cents: r.totalCents,
    advance_used_cents: r.advanceUsedCents,
    applied_cents: r.appliedCents,
    advance_cents: r.advanceCents,
    advance_uses: r.advanceUses,
    notes: r.notes,
    status: r.status,
    void_reason: r.voidReason,
    posted_by: r.postedBy,
    voided_by: r.voidedBy,
    posted_at: r.postedAt,
    voided_at: r.voidedAt,
    version: r.version,
    updated_at: r.updatedAt,
  });

  const linesOf = (organizationId: string, ids: string[]) =>
    ids.length
      ? ReceiptLineModel.findAll({ where: { organization_id: organizationId, receipt_id: ids }, order: [['id', 'ASC']], transaction: tx })
      : Promise.resolve([] as ReceiptLineModel[]);

  return {
    async findById(organizationId, id, options) {
      const lock = Boolean(options?.lock && tx);
      const row = await ReceiptModel.findOne({
        where: { id, organization_id: organizationId },
        transaction: tx,
        ...(lock ? { lock: tx!.LOCK.UPDATE } : {}),
      });
      if (!row) return null;
      return toReceipt(row, await linesOf(organizationId, [row.id]));
    },

    async list(organizationId, filters: ReceiptFilters): Promise<Page<Receipt>> {
      const and: WhereOptions[] = [{ organization_id: organizationId }];
      if (filters.customerId) and.push({ customer_id: filters.customerId });
      if (filters.status?.length) and.push({ status: filters.status });
      if (filters.from) and.push({ receipt_date: { [Op.gte]: filters.from } });
      if (filters.to) and.push({ receipt_date: { [Op.lte]: filters.to } });
      if (filters.q?.trim()) {
        const term = likeTerm(filters.q.trim());
        and.push({ [Op.or]: [{ number: { [Op.like]: term } }, { reference: { [Op.like]: term } }, { customer_name: { [Op.like]: term } }] });
      }
      const { rows, count } = await ReceiptModel.findAndCountAll({
        where: { [Op.and]: and },
        order: [['receipt_date', 'DESC'], ['created_at', 'DESC']],
        limit: filters.pageSize,
        offset: (filters.page - 1) * filters.pageSize,
        transaction: tx,
      });
      // El listado muestra `lineCount`: sin cargar las líneas de la página saldría siempre 0 (ya pasó con recepciones de compra).
      const lines = await linesOf(organizationId, rows.map((r) => r.id));
      const byReceipt = new Map<string, ReceiptLineModel[]>();
      for (const l of lines) byReceipt.set(l.receipt_id, [...(byReceipt.get(l.receipt_id) ?? []), l]);
      return { items: rows.map((r) => toReceipt(r, byReceipt.get(r.id) ?? [])), total: count, page: filters.page, pageSize: filters.pageSize };
    },

    async save(receipt, expectedVersion) {
      if (expectedVersion === undefined) {
        await ReceiptModel.create({ id: receipt.id, created_by: receipt.createdBy, created_at: receipt.createdAt, ...receiptFields(receipt) }, { transaction: tx });
      } else {
        // Solo si nadie lo cambió desde que se leyó: si no, dos personas (o dos clics) se pisarían sin saberlo.
        const [updated] = await ReceiptModel.update(receiptFields(receipt), {
          where: { id: receipt.id, organization_id: receipt.organizationId, version: expectedVersion },
          transaction: tx,
        });
        if (updated === 0) throw new ConcurrentUpdateError();
      }
      // Las líneas se reemplazan enteras: solo un borrador se edita, y uno contabilizado ya no cambia sus líneas (se anula y se rehace).
      await ReceiptLineModel.destroy({ where: { receipt_id: receipt.id, organization_id: receipt.organizationId }, transaction: tx });
      if (receipt.lines.length) {
        await ReceiptLineModel.bulkCreate(
          receipt.lines.map((l, i) => ({
            id: `${receipt.id.slice(0, 31)}-${String(i).padStart(4, '0')}`,
            organization_id: receipt.organizationId,
            receipt_id: receipt.id,
            receivable_id: l.receivableId,
            applied_cents: l.appliedCents,
          })),
          { transaction: tx },
        );
      }
    },

    async nextSequence(organizationId, year) {
      // El UPDATE (vía ON DUPLICATE KEY) va antes que el SELECT … FOR UPDATE: la primera del año crea la fila y las demás esperan su turno.
      await sequelize.query(
        'INSERT INTO receipt_sequences (organization_id, year, current_value) VALUES (:organizationId, :year, 1) ON DUPLICATE KEY UPDATE current_value = current_value + 1',
        { replacements: { organizationId, year }, transaction: tx },
      );
      const [row] = await sequelize.query<{ current_value: number }>(
        'SELECT current_value FROM receipt_sequences WHERE organization_id = :organizationId AND year = :year FOR UPDATE',
        { replacements: { organizationId, year }, transaction: tx, type: QueryTypes.SELECT },
      );
      return Number(row!.current_value);
    },
  };
}

function receiptAdvanceUseRepository(tx?: Transaction): UnitOfWork['receiptAdvanceUses'] {
  return {
    async add(organizationId, receiptId, use, at) {
      await ReceiptAdvanceUseModel.create(
        {
          id: randomUUID(),
          organization_id: organizationId,
          receipt_id: receiptId,
          advance_id: use.advanceId,
          used_cents: use.usedCents,
          reversed_at: null,
          created_at: at,
        },
        { transaction: tx },
      );
    },
    async reverseByReceipt(organizationId, receiptId, at) {
      await ReceiptAdvanceUseModel.update(
        { reversed_at: at },
        { where: { organization_id: organizationId, receipt_id: receiptId, reversed_at: null }, transaction: tx },
      );
    },
  };
}

// ── Recordatorios de cobro ───────────────────────────────────────────────────

const toReminderSettings = (row: ReminderSettingsModel): ReminderSettings => ({
  organizationId: row.organization_id,
  enabled: Boolean(row.enabled),
  firstAfterDays: row.first_after_days,
  repeatEveryDays: row.repeat_every_days,
  lastRunOn: row.last_run_on ? String(row.last_run_on) : null,
  updatedBy: row.updated_by,
  updatedAt: row.updated_at,
});

function reminderSettingsRepository(tx?: Transaction): UnitOfWork['reminderSettings'] {
  return {
    async find(organizationId) {
      const row = await ReminderSettingsModel.findByPk(organizationId, { transaction: tx });
      return row ? toReminderSettings(row) : null;
    },
    async listEnabled() {
      const rows = await ReminderSettingsModel.findAll({ where: { enabled: true }, transaction: tx });
      return rows.map(toReminderSettings);
    },
    async save(settings) {
      const now = new Date();
      const fields = {
        enabled: settings.enabled,
        first_after_days: settings.firstAfterDays,
        repeat_every_days: settings.repeatEveryDays,
        last_run_on: settings.lastRunOn,
        updated_by: settings.updatedBy,
        updated_at: settings.updatedAt ?? now,
      };
      const [updated] = await ReminderSettingsModel.update(fields, { where: { organization_id: settings.organizationId }, transaction: tx });
      if (updated === 0) {
        const exists = await ReminderSettingsModel.count({ where: { organization_id: settings.organizationId }, transaction: tx });
        if (!exists) await ReminderSettingsModel.create({ organization_id: settings.organizationId, ...fields, created_at: now }, { transaction: tx });
      }
    },
  };
}

function reminderRepository(tx?: Transaction): UnitOfWork['reminders'] {
  return {
    async lastRemindedOn(organizationId, receivableIds) {
      const result = new Map<string, string>();
      if (receivableIds.length === 0) return result;
      // Por tandas: una cartera grande no cabe en un solo IN.
      for (let i = 0; i < receivableIds.length; i += 500) {
        const rows = (await sequelize.query(
          'SELECT receivable_id, MAX(reminder_date) AS last_date FROM receivable_reminders WHERE organization_id = :organizationId AND receivable_id IN (:ids) GROUP BY receivable_id',
          { replacements: { organizationId, ids: receivableIds.slice(i, i + 500) }, type: QueryTypes.SELECT, transaction: tx },
        )) as { receivable_id: string; last_date: string | Date }[];
        for (const row of rows) result.set(row.receivable_id, String(row.last_date).slice(0, 10));
      }
      return result;
    },
    async add(entry) {
      await ReceivableReminderModel.create(
        {
          id: randomUUID(),
          organization_id: entry.organizationId,
          receivable_id: entry.receivableId,
          customer_id: entry.customerId,
          reminder_date: entry.reminderDate,
          trigger_kind: entry.trigger,
          sent_by: entry.sentBy,
          created_at: entry.at,
        },
        { transaction: tx },
      );
    },
  };
}

// ── Outbox ───────────────────────────────────────────────────────────────────

function outboxRepository(tx?: Transaction): UnitOfWork['outbox'] {
  return {
    async add(event: DomainEvent) {
      await OutboxModel.create(
        {
          id: event.eventId,
          aggregate_type: event.aggregateType,
          aggregate_id: event.aggregateId,
          type: event.type,
          // El actor/IP/request-id viajan en el contexto de la petición para que la bitácora sepa QUIÉN hizo cada cosa.
          payload: withActor(event.payload),
          occurred_at: event.occurredAt,
          processed_at: null,
        },
        { transaction: tx },
      );
    },
  };
}

// ── Ensamblaje ───────────────────────────────────────────────────────────────

export function buildRepositories(tx?: Transaction): UnitOfWork {
  return {
    receivables: receivableRepository(tx),
    creditApplications: creditApplicationRepository(tx),
    advances: customerAdvanceRepository(tx),
    advanceApplications: customerAdvanceApplicationRepository(tx),
    customerTerms: customerTermsRepository(tx),
    openingBalanceLoads: openingBalanceLoadRepository(tx),
    receipts: receiptRepository(tx),
    receiptAdvanceUses: receiptAdvanceUseRepository(tx),
    reminderSettings: reminderSettingsRepository(tx),
    reminders: reminderRepository(tx),
    ...buildPayableRepositories(tx),
    outbox: outboxRepository(tx),
  };
}

export const readOnlyRepositories: UnitOfWork = buildRepositories(undefined);

export class SequelizeUnitOfWork implements WriteUnitOfWork {
  readonly receivables;
  readonly creditApplications;
  readonly advances;
  readonly advanceApplications;
  readonly customerTerms;
  readonly openingBalanceLoads;
  readonly receipts;
  readonly receiptAdvanceUses;
  readonly reminderSettings;
  readonly reminders;
  readonly payables;
  readonly payableApplications;
  readonly supplierAdvances;
  readonly payments;
  readonly paymentAdvanceUses;
  readonly paymentSettings;
  readonly unmatchedWithholdings;
  readonly payableOpeningLoads;
  readonly outbox;

  constructor(readonly tx: Transaction) {
    const repos = buildRepositories(tx);
    this.receivables = repos.receivables;
    this.creditApplications = repos.creditApplications;
    this.advances = repos.advances;
    this.advanceApplications = repos.advanceApplications;
    this.customerTerms = repos.customerTerms;
    this.openingBalanceLoads = repos.openingBalanceLoads;
    this.receipts = repos.receipts;
    this.receiptAdvanceUses = repos.receiptAdvanceUses;
    this.reminderSettings = repos.reminderSettings;
    this.reminders = repos.reminders;
    this.payables = repos.payables;
    this.payableApplications = repos.payableApplications;
    this.supplierAdvances = repos.supplierAdvances;
    this.payments = repos.payments;
    this.paymentAdvanceUses = repos.paymentAdvanceUses;
    this.paymentSettings = repos.paymentSettings;
    this.unmatchedWithholdings = repos.unmatchedWithholdings;
    this.payableOpeningLoads = repos.payableOpeningLoads;
    this.outbox = repos.outbox;
  }

  async commit(): Promise<void> {
    await this.tx.commit();
  }

  async rollback(): Promise<void> {
    // MySQL deshace por su cuenta la transacción que pierde un interbloqueo; volver a deshacerla lanzaría un error que taparía el verdadero.
    if ((this.tx as unknown as { finished?: string }).finished) return;
    await this.tx.rollback();
  }
}

export class SequelizeUnitOfWorkFactory {
  constructor(private readonly onCommit?: (tx: Transaction) => void) {}

  async begin(options?: { readCommitted?: boolean }): Promise<SequelizeUnitOfWork> {
    const tx = await sequelize.transaction(options?.readCommitted ? { isolationLevel: Transaction.ISOLATION_LEVELS.READ_COMMITTED } : undefined);
    // El relay publica el outbox justo tras el commit; sin este enganche los eventos esperan los 30 s del temporizador de respaldo.
    this.onCommit?.(tx);
    return new SequelizeUnitOfWork(tx);
  }
}
