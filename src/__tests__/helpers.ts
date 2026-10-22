import { randomUUID } from 'node:crypto';
import type {
  AccountingCatalogPort,
  AccountingSettingsInfo,
  CustomerCatalogPort,
  CustomerInfo,
  OrganizationCatalogPort,
  SupplierCatalogPort,
  SupplierInfo,
  UnitOfWorkGateway,
  WriteUnitOfWork,
} from '../application/ports.js';
import { CatalogUnavailableError, ConcurrentUpdateError } from '../domain/errors.js';
import {
  deriveStatus,
  type CreditApplication,
  type CustomerAdvance,
  type CustomerAdvanceApplication,
  type CustomerTerms,
  type OpeningBalanceLoad,
  type Receivable,
} from '../domain/receivable.js';
import type { DomainEvent, Page, ReceiptFilters, ReceivableFilters, UnitOfWork } from '../domain/repositories.js';
import type { Receipt, ReceiptAdvanceUse } from '../domain/receipt.js';
import type { ReminderSettings } from '../domain/reminder.js';
import { derivePayableStatus, type Payable, type PayableApplication, type PayableOpeningLoad, type SupplierAdvance, type UnmatchedWithholding } from '../domain/payable.js';
import type { Payment, PaymentSettings } from '../domain/payment.js';
import type { PayableFilters, PaymentFilters } from '../domain/repositories.js';
import { GetCustomerTermsUseCase, SetCustomerTermsUseCase } from '../application/use-cases/customer-use-cases.js';
import {
  GetAgingUseCase,
  GetCustomerStatementUseCase,
  GetReceivableDetailUseCase,
  GetReceivableUseCase,
  ListReceivablesUseCase,
} from '../application/use-cases/list-use-cases.js';
import {
  HandleBillPostedUseCase,
  HandleBillVoidedUseCase,
  HandleWithholdingIssuedUseCase,
  type BillPostedPayload,
  type WithholdingIssuedPayload,
} from '../application/use-cases/payable-event-use-cases.js';
import {
  GetPayableDetailUseCase,
  GetPayablesAgingUseCase,
  GetSupplierStatementUseCase,
  ListPayablesUseCase,
  LoadPayableOpeningBalancesUseCase,
} from '../application/use-cases/payable-list-use-cases.js';
import {
  ApprovePaymentUseCase,
  CreatePaymentUseCase,
  GetPaymentSettingsUseCase,
  GetPaymentUseCase,
  ListPaymentsUseCase,
  PostPaymentUseCase,
  SetPaymentSettingsUseCase,
  UpdatePaymentUseCase,
  VoidPaymentUseCase,
} from '../application/use-cases/payment-use-cases.js';
import { ExportReportsUseCase } from '../application/use-cases/export-use-cases.js';
import {
  GetReminderSettingsUseCase,
  PreviewRemindersUseCase,
  RunDueRemindersUseCase,
  RunRemindersUseCase,
  SetReminderSettingsUseCase,
} from '../application/use-cases/reminder-use-cases.js';
import { LoadOpeningBalancesUseCase } from '../application/use-cases/opening-balance-use-case.js';
import {
  HandleInvoiceIssuedUseCase,
  HandleInvoiceVoidedUseCase,
  type InvoiceIssuedPayload,
} from '../application/use-cases/receivable-use-cases.js';
import {
  CreateReceiptUseCase,
  GetReceiptUseCase,
  ListReceiptsUseCase,
  PostReceiptUseCase,
  UpdateReceiptUseCase,
  VoidReceiptUseCase,
} from '../application/use-cases/receipt-use-cases.js';
import { createApp } from '../interface/http/app.js';

export const ORG_A = '11111111-1111-4111-8111-111111111111';
export const ORG_B = '22222222-2222-4222-8222-222222222222';
export const USER_1 = '33333333-3333-4333-8333-333333333333';
export const CUSTOMER_1 = '44444444-4444-4444-8444-444444444444';
export const CUSTOMER_2 = '55555555-5555-4555-8555-555555555555';
export const SUPPLIER_1 = '66666666-6666-4666-8666-666666666666';
export const SUPPLIER_2 = '77777777-7777-4777-8777-777777777777';
export const USER_2 = '88888888-8888-4888-8888-888888888888';

const clone = <T>(value: T): T => structuredClone(value);

/** La «base de datos»: todo lo que las pruebas pueden mirar después. */
interface Data {
  receivables: Map<string, Receivable>;
  creditApplications: CreditApplication[];
  advances: Map<string, CustomerAdvance>;
  advanceApplications: CustomerAdvanceApplication[];
  terms: Map<string, CustomerTerms>;
  loads: OpeningBalanceLoad[];
  receipts: Map<string, Receipt>;
  receiptAdvanceUses: { receiptId: string; organizationId: string; advanceId: string; usedCents: number; reversedAt: Date | null }[];
  sequences: Map<string, number>;
  reminderSettings: Map<string, ReminderSettings>;
  payables: Map<string, Payable>;
  payableApplications: PayableApplication[];
  supplierAdvances: Map<string, SupplierAdvance>;
  payments: Map<string, Payment>;
  paymentAdvanceUses: { paymentId: string; organizationId: string; advanceId: string; usedCents: number; reversedAt: Date | null }[];
  paymentSequences: Map<string, number>;
  paymentSettings: Map<string, PaymentSettings>;
  unmatchedWithholdings: UnmatchedWithholding[];
  payableOpeningLoads: PayableOpeningLoad[];
  reminders: { organizationId: string; receivableId: string; customerId: string; reminderDate: string; trigger: string; sentBy: string | null }[];
  events: DomainEvent[];
}

const emptyData = (): Data => ({
  receivables: new Map(),
  creditApplications: [],
  advances: new Map(),
  advanceApplications: [],
  terms: new Map(),
  loads: [],
  receipts: new Map(),
  receiptAdvanceUses: [],
  sequences: new Map(),
  reminderSettings: new Map(),
  payables: new Map(),
  payableApplications: [],
  supplierAdvances: new Map(),
  payments: new Map(),
  paymentAdvanceUses: [],
  paymentSequences: new Map(),
  paymentSettings: new Map(),
  unmatchedWithholdings: [],
  payableOpeningLoads: [],
  reminders: [],
  events: [],
});

/** Igual que el UNIQUE de MySQL: el repositorio real lanza `SequelizeUniqueConstraintError` y los casos de uso lo tratan como duplicado. */
function uniqueViolation(): Error {
  const err = new Error('Duplicate entry');
  err.name = 'SequelizeUniqueConstraintError';
  return err;
}

const sum = (values: number[]) => values.reduce((acc, v) => acc + v, 0);

/**
 * Unidad de trabajo en memoria con la MISMA semántica que la real: lo derivado (lo aplicado) se calcula al leer, `save` con
 * versión rechaza si alguien cambió la fila, y un UNIQUE violado lanza el mismo error. `commit`/`rollback` de verdad.
 */
function buildUnitOfWork(data: Data): UnitOfWork {
  const appliedByReceivable = (organizationId: string, id: string) =>
    sum(data.creditApplications.filter((a) => a.organizationId === organizationId && a.receivableId === id && !a.reversedAt).map((a) => a.appliedCents));
  const appliedByAdvance = (organizationId: string, id: string) =>
    sum(data.advanceApplications.filter((a) => a.organizationId === organizationId && a.advanceId === id).map((a) => a.appliedCents)) +
    sum(data.receiptAdvanceUses.filter((u) => u.organizationId === organizationId && u.advanceId === id && !u.reversedAt).map((u) => u.usedCents));
  const withApplied = (r: Receivable): Receivable => ({ ...clone(r), appliedCents: appliedByReceivable(r.organizationId, r.id) });
  const advanceWithApplied = (a: CustomerAdvance): CustomerAdvance => ({ ...clone(a), appliedCents: appliedByAdvance(a.organizationId, a.id) });

  const payableApplied = (organizationId: string, id: string) => sum(data.payableApplications.filter((a) => a.organizationId === organizationId && a.payableId === id && !a.reversedAt).map((a) => a.appliedCents));
  const payableWithApplied = (p: Payable): Payable => ({ ...clone(p), appliedCents: payableApplied(p.organizationId, p.id) });
  const supplierAdvanceWithApplied = (a: SupplierAdvance): SupplierAdvance => ({
    ...clone(a),
    appliedCents: sum(data.paymentAdvanceUses.filter((u) => u.organizationId === a.organizationId && u.advanceId === a.id && !u.reversedAt).map((u) => u.usedCents)),
  });
  const payablesOfOrg = (organizationId: string) => [...data.payables.values()].filter((p) => p.organizationId === organizationId && p.supplierId !== '');

  const isGhost = (r: Receivable) => r.customerId === '';
  const byOrg = (organizationId: string) => [...data.receivables.values()].filter((r) => r.organizationId === organizationId && !isGhost(r));

  return {
    receivables: {
      async findById(organizationId, id) {
        const r = data.receivables.get(id);
        return r && r.organizationId === organizationId ? withApplied(r) : null;
      },
      async findBySource(organizationId, sourceType, sourceId) {
        const r = [...data.receivables.values()].find((x) => x.organizationId === organizationId && x.sourceType === sourceType && x.sourceId === sourceId);
        return r ? withApplied(r) : null;
      },
      async list(organizationId, filters: ReceivableFilters): Promise<Page<Receivable>> {
        let rows = byOrg(organizationId);
        if (filters.customerId) rows = rows.filter((r) => r.customerId === filters.customerId);
        const live = ['open', 'partial'];
        const statuses = filters.overdueOnly ? (filters.status?.length ? filters.status.filter((s) => live.includes(s)) : live) : filters.status;
        if (statuses?.length) rows = rows.filter((r) => statuses.includes(r.status));
        else if (filters.overdueOnly) rows = [];
        if (filters.overdueOnly && filters.asOf) rows = rows.filter((r) => r.dueDate < filters.asOf!);
        if (filters.from) rows = rows.filter((r) => r.issueDate >= filters.from!);
        if (filters.to) rows = rows.filter((r) => r.issueDate <= filters.to!);
        if (filters.q?.trim()) {
          const q = filters.q.trim().toLowerCase();
          rows = rows.filter((r) => (r.documentNumber ?? '').toLowerCase().includes(q) || r.customerName.toLowerCase().includes(q));
        }
        rows.sort((a, b) => (a.issueDate === b.issueDate ? b.createdAt.getTime() - a.createdAt.getTime() : a.issueDate < b.issueDate ? 1 : -1));
        const start = (filters.page - 1) * filters.pageSize;
        return { items: rows.slice(start, start + filters.pageSize).map(withApplied), total: rows.length, page: filters.page, pageSize: filters.pageSize };
      },
      async listBalances(organizationId, options) {
        let rows = byOrg(organizationId);
        if (options?.customerId) rows = rows.filter((r) => r.customerId === options.customerId);
        return rows.sort((a, b) => (a.issueDate < b.issueDate ? -1 : 1)).map(withApplied);
      },
      async save(receivable, expectedVersion) {
        const existing = data.receivables.get(receivable.id);
        if (expectedVersion === undefined) {
          const dup = [...data.receivables.values()].some(
            (x) => x.organizationId === receivable.organizationId && x.sourceType === receivable.sourceType && x.sourceId === receivable.sourceId,
          );
          if (existing || dup) throw uniqueViolation();
          data.receivables.set(receivable.id, { ...clone(receivable), appliedCents: 0 });
          return;
        }
        if (!existing || existing.version !== expectedVersion) throw new ConcurrentUpdateError();
        data.receivables.set(receivable.id, { ...clone(receivable), appliedCents: 0 });
      },
      async appliedCentsOf(organizationId, ids) {
        return new Map(ids.map((id) => [id, appliedByReceivable(organizationId, id)]));
      },
    },
    creditApplications: {
      async listByReceivable(organizationId, ids) {
        return data.creditApplications.filter((a) => a.organizationId === organizationId && ids.includes(a.receivableId)).map(clone);
      },
      async add(application) {
        const dup = data.creditApplications.some(
          (a) => a.organizationId === application.organizationId && a.receivableId === application.receivableId && a.sourceType === application.sourceType && a.sourceId === application.sourceId,
        );
        if (dup) throw uniqueViolation();
        if (application.appliedCents <= 0) throw new Error('CHECK applied_cents > 0');
        data.creditApplications.push(clone(application));
      },
      async reverseBySource(organizationId, sourceType, sourceId, at) {
        const hit = data.creditApplications.filter((a) => a.organizationId === organizationId && a.sourceType === sourceType && a.sourceId === sourceId && !a.reversedAt);
        for (const a of hit) a.reversedAt = at;
        return hit.map((a) => clone(a));
      },
    },
    advances: {
      async findById(organizationId, id) {
        const a = data.advances.get(id);
        return a && a.organizationId === organizationId ? advanceWithApplied(a) : null;
      },
      async findByOrigin(organizationId, origin, originId) {
        const a = [...data.advances.values()].find((x) => x.organizationId === organizationId && x.origin === origin && x.originId === originId);
        return a ? advanceWithApplied(a) : null;
      },
      async listByCustomer(organizationId, customerId) {
        return [...data.advances.values()].filter((a) => a.organizationId === organizationId && a.customerId === customerId && !a.voidedAt).map(advanceWithApplied);
      },
      async listApplicable(organizationId, customerId, invoiceId) {
        return [...data.advances.values()]
          .filter((a) => a.organizationId === organizationId && a.customerId === customerId && !a.voidedAt && (a.relatedInvoiceId === null || a.relatedInvoiceId === invoiceId))
          .map(advanceWithApplied)
          .filter((a) => a.originalCents - a.appliedCents > 0)
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      },
      async save(advance, expectedVersion) {
        const existing = data.advances.get(advance.id);
        if (expectedVersion === undefined) {
          const dup = [...data.advances.values()].some((x) => x.organizationId === advance.organizationId && x.origin === advance.origin && x.originId === advance.originId);
          if (existing || dup) throw uniqueViolation();
        } else if (!existing || existing.version !== expectedVersion) {
          throw new ConcurrentUpdateError();
        }
        data.advances.set(advance.id, { ...clone(advance), appliedCents: 0 });
      },
      async appliedCentsOf(organizationId, ids) {
        return new Map(ids.map((id) => [id, appliedByAdvance(organizationId, id)]));
      },
    },
    advanceApplications: {
      async listByAdvance(organizationId, ids) {
        return data.advanceApplications.filter((a) => a.organizationId === organizationId && ids.includes(a.advanceId)).map(clone);
      },
      async add(application) {
        const dup = data.advanceApplications.some((a) => a.organizationId === application.organizationId && a.advanceId === application.advanceId && a.receivableId === application.receivableId);
        if (dup) throw uniqueViolation();
        data.advanceApplications.push(clone(application));
      },
    },
    customerTerms: {
      async find(organizationId, customerId) {
        const t = data.terms.get(`${organizationId}:${customerId}`);
        return t ? clone(t) : null;
      },
      async save(terms) {
        data.terms.set(`${terms.organizationId}:${terms.customerId}`, clone(terms));
      },
    },
    openingBalanceLoads: {
      async findByCutoff(organizationId, cutoffDate) {
        const l = data.loads.find((x) => x.organizationId === organizationId && x.cutoffDate === cutoffDate);
        return l ? clone(l) : null;
      },
      async save(load) {
        if (data.loads.some((x) => x.organizationId === load.organizationId && x.cutoffDate === load.cutoffDate)) throw uniqueViolation();
        data.loads.push(clone(load));
      },
    },
    receipts: {
      async findById(organizationId, id) {
        const r = data.receipts.get(id);
        return r && r.organizationId === organizationId ? clone(r) : null;
      },
      async list(organizationId, filters: ReceiptFilters): Promise<Page<Receipt>> {
        let rows = [...data.receipts.values()].filter((r) => r.organizationId === organizationId);
        if (filters.customerId) rows = rows.filter((r) => r.customerId === filters.customerId);
        if (filters.status?.length) rows = rows.filter((r) => filters.status!.includes(r.status));
        if (filters.from) rows = rows.filter((r) => r.receiptDate >= filters.from!);
        if (filters.to) rows = rows.filter((r) => r.receiptDate <= filters.to!);
        if (filters.q?.trim()) {
          const q = filters.q.trim().toLowerCase();
          rows = rows.filter((r) => (r.number ?? '').toLowerCase().includes(q) || (r.reference ?? '').toLowerCase().includes(q) || r.customerName.toLowerCase().includes(q));
        }
        rows.sort((a, b) => (a.receiptDate === b.receiptDate ? b.createdAt.getTime() - a.createdAt.getTime() : a.receiptDate < b.receiptDate ? 1 : -1));
        const start = (filters.page - 1) * filters.pageSize;
        return { items: rows.slice(start, start + filters.pageSize).map(clone), total: rows.length, page: filters.page, pageSize: filters.pageSize };
      },
      async save(receipt, expectedVersion) {
        const existing = data.receipts.get(receipt.id);
        if (expectedVersion === undefined) {
          if (existing) throw uniqueViolation();
        } else if (!existing || existing.version !== expectedVersion) {
          throw new ConcurrentUpdateError();
        }
        if (receipt.number && [...data.receipts.values()].some((r) => r.id !== receipt.id && r.organizationId === receipt.organizationId && r.number === receipt.number)) throw uniqueViolation();
        // El CHECK del esquema: lo que entra + los anticipos consumidos = lo aplicado + el excedente.
        if (receipt.totalCents + receipt.advanceUsedCents !== receipt.appliedCents + receipt.advanceCents) throw new Error('CHECK receipts_amounts_chk');
        data.receipts.set(receipt.id, clone(receipt));
      },
      async nextSequence(organizationId, year) {
        const key = `${organizationId}:${year}`;
        const next = (data.sequences.get(key) ?? 0) + 1;
        data.sequences.set(key, next);
        return next;
      },
    },
    receiptAdvanceUses: {
      async add(organizationId, receiptId, use: ReceiptAdvanceUse) {
        if (data.receiptAdvanceUses.some((u) => u.receiptId === receiptId && u.advanceId === use.advanceId)) throw uniqueViolation();
        data.receiptAdvanceUses.push({ receiptId, organizationId, advanceId: use.advanceId, usedCents: use.usedCents, reversedAt: null });
      },
      async reverseByReceipt(organizationId, receiptId, at) {
        for (const u of data.receiptAdvanceUses) if (u.organizationId === organizationId && u.receiptId === receiptId && !u.reversedAt) u.reversedAt = at;
      },
    },
    payables: {
      async findById(organizationId, id) {
        const p = data.payables.get(id);
        return p && p.organizationId === organizationId ? payableWithApplied(p) : null;
      },
      async findBySource(organizationId, sourceType, sourceId) {
        const p = [...data.payables.values()].find((x) => x.organizationId === organizationId && x.sourceType === sourceType && x.sourceId === sourceId);
        return p ? payableWithApplied(p) : null;
      },
      async listBySupplierIdentification(organizationId, identification) {
        return [...data.payables.values()].filter((p) => p.organizationId === organizationId && p.supplierIdentification === identification).sort((a, b) => (a.issueDate < b.issueDate ? -1 : 1)).map(payableWithApplied);
      },
      async list(organizationId, filters: PayableFilters): Promise<Page<Payable>> {
        let rows = payablesOfOrg(organizationId);
        if (filters.supplierId) rows = rows.filter((p) => p.supplierId === filters.supplierId);
        const live = ['open', 'partial'];
        const wantsLive = Boolean(filters.overdueOnly || filters.dueBefore);
        const statuses = wantsLive ? (filters.status?.length ? filters.status.filter((s) => live.includes(s)) : live) : filters.status;
        if (statuses?.length) rows = rows.filter((p) => statuses.includes(p.status));
        else if (wantsLive) rows = [];
        if (filters.overdueOnly && filters.asOf) rows = rows.filter((p) => p.dueDate < filters.asOf!);
        if (filters.dueBefore && filters.asOf) rows = rows.filter((p) => p.dueDate >= filters.asOf! && p.dueDate <= filters.dueBefore!);
        if (filters.from) rows = rows.filter((p) => p.issueDate >= filters.from!);
        if (filters.to) rows = rows.filter((p) => p.issueDate <= filters.to!);
        if (filters.q?.trim()) {
          const q = filters.q.trim().toLowerCase();
          rows = rows.filter((p) => (p.documentNumber ?? '').toLowerCase().includes(q) || (p.internalNumber ?? '').toLowerCase().includes(q) || p.supplierName.toLowerCase().includes(q));
        }
        rows.sort((a, b) => (a.dueDate === b.dueDate ? b.createdAt.getTime() - a.createdAt.getTime() : a.dueDate < b.dueDate ? -1 : 1));
        const start = (filters.page - 1) * filters.pageSize;
        return { items: rows.slice(start, start + filters.pageSize).map(payableWithApplied), total: rows.length, page: filters.page, pageSize: filters.pageSize };
      },
      async listBalances(organizationId, options) {
        let rows = payablesOfOrg(organizationId);
        if (options?.supplierId) rows = rows.filter((p) => p.supplierId === options.supplierId);
        return rows.sort((a, b) => (a.issueDate < b.issueDate ? -1 : 1)).map(payableWithApplied);
      },
      async save(payable, expectedVersion) {
        const existing = data.payables.get(payable.id);
        if (expectedVersion === undefined) {
          const dup = [...data.payables.values()].some((x) => x.organizationId === payable.organizationId && x.sourceType === payable.sourceType && x.sourceId === payable.sourceId);
          if (existing || dup) throw uniqueViolation();
          data.payables.set(payable.id, { ...clone(payable), appliedCents: 0 });
          return;
        }
        if (!existing || existing.version !== expectedVersion) throw new ConcurrentUpdateError();
        data.payables.set(payable.id, { ...clone(payable), appliedCents: 0 });
      },
    },
    payableApplications: {
      async listByPayable(organizationId, ids) {
        return data.payableApplications.filter((a) => a.organizationId === organizationId && ids.includes(a.payableId)).map(clone);
      },
      async add(application) {
        const dup = data.payableApplications.some((a) => a.organizationId === application.organizationId && a.payableId === application.payableId && a.sourceType === application.sourceType && a.sourceId === application.sourceId);
        if (dup) throw uniqueViolation();
        if (application.appliedCents <= 0) throw new Error('CHECK applied_cents > 0');
        data.payableApplications.push(clone(application));
      },
      async reverseBySource(organizationId, sourceType, sourceId, at) {
        const hit = data.payableApplications.filter((a) => a.organizationId === organizationId && a.sourceType === sourceType && a.sourceId === sourceId && !a.reversedAt);
        for (const a of hit) a.reversedAt = at;
        return hit.map((a) => clone(a));
      },
    },
    supplierAdvances: {
      async findById(organizationId, id) {
        const a = data.supplierAdvances.get(id);
        return a && a.organizationId === organizationId ? supplierAdvanceWithApplied(a) : null;
      },
      async findByOrigin(organizationId, originId) {
        const a = [...data.supplierAdvances.values()].find((x) => x.organizationId === organizationId && x.originId === originId);
        return a ? supplierAdvanceWithApplied(a) : null;
      },
      async listBySupplier(organizationId, supplierId) {
        return [...data.supplierAdvances.values()].filter((a) => a.organizationId === organizationId && a.supplierId === supplierId && !a.voidedAt).map(supplierAdvanceWithApplied);
      },
      async save(advance, expectedVersion) {
        const existing = data.supplierAdvances.get(advance.id);
        if (expectedVersion === undefined) {
          const dup = [...data.supplierAdvances.values()].some((x) => x.organizationId === advance.organizationId && x.originId === advance.originId);
          if (existing || dup) throw uniqueViolation();
        } else if (!existing || existing.version !== expectedVersion) {
          throw new ConcurrentUpdateError();
        }
        data.supplierAdvances.set(advance.id, { ...clone(advance), appliedCents: 0 });
      },
    },
    payments: {
      async findById(organizationId, id) {
        const p = data.payments.get(id);
        return p && p.organizationId === organizationId ? clone(p) : null;
      },
      async list(organizationId, filters: PaymentFilters): Promise<Page<Payment>> {
        let rows = [...data.payments.values()].filter((p) => p.organizationId === organizationId);
        if (filters.supplierId) rows = rows.filter((p) => p.supplierId === filters.supplierId);
        if (filters.status?.length) rows = rows.filter((p) => filters.status!.includes(p.status));
        if (filters.from) rows = rows.filter((p) => p.paymentDate >= filters.from!);
        if (filters.to) rows = rows.filter((p) => p.paymentDate <= filters.to!);
        if (filters.q?.trim()) {
          const q = filters.q.trim().toLowerCase();
          rows = rows.filter((p) => (p.number ?? '').toLowerCase().includes(q) || (p.reference ?? '').toLowerCase().includes(q) || p.supplierName.toLowerCase().includes(q));
        }
        rows.sort((a, b) => (a.paymentDate === b.paymentDate ? b.createdAt.getTime() - a.createdAt.getTime() : a.paymentDate < b.paymentDate ? 1 : -1));
        const start = (filters.page - 1) * filters.pageSize;
        return { items: rows.slice(start, start + filters.pageSize).map(clone), total: rows.length, page: filters.page, pageSize: filters.pageSize };
      },
      async save(payment, expectedVersion) {
        const existing = data.payments.get(payment.id);
        if (expectedVersion === undefined) {
          if (existing) throw uniqueViolation();
        } else if (!existing || existing.version !== expectedVersion) {
          throw new ConcurrentUpdateError();
        }
        if (payment.number && [...data.payments.values()].some((p) => p.id !== payment.id && p.organizationId === payment.organizationId && p.number === payment.number)) throw uniqueViolation();
        // El CHECK del esquema.
        if (payment.totalCents + payment.advanceUsedCents !== payment.appliedCents + payment.advanceCents) throw new Error('CHECK payments_amounts_ck');
        data.payments.set(payment.id, clone(payment));
      },
      async nextSequence(organizationId, year) {
        const key = `${organizationId}:${year}`;
        const next = (data.paymentSequences.get(key) ?? 0) + 1;
        data.paymentSequences.set(key, next);
        return next;
      },
    },
    paymentAdvanceUses: {
      async add(organizationId, paymentId, use) {
        if (data.paymentAdvanceUses.some((u) => u.paymentId === paymentId && u.advanceId === use.advanceId)) throw uniqueViolation();
        data.paymentAdvanceUses.push({ paymentId, organizationId, advanceId: use.advanceId, usedCents: use.usedCents, reversedAt: null });
      },
      async reverseByPayment(organizationId, paymentId, at) {
        for (const u of data.paymentAdvanceUses) if (u.organizationId === organizationId && u.paymentId === paymentId && !u.reversedAt) u.reversedAt = at;
      },
    },
    paymentSettings: {
      async find(organizationId) {
        const s = data.paymentSettings.get(organizationId);
        return s ? clone(s) : null;
      },
      async save(settings) {
        data.paymentSettings.set(settings.organizationId, clone(settings));
      },
    },
    unmatchedWithholdings: {
      async add(w) {
        if (data.unmatchedWithholdings.some((x) => x.organizationId === w.organizationId && x.withholdingId === w.withholdingId)) throw uniqueViolation();
        data.unmatchedWithholdings.push(clone(w));
      },
      async listBySupplierIdentification(organizationId, identification) {
        return data.unmatchedWithholdings.filter((w) => w.organizationId === organizationId && w.supplierIdentification === identification).map(clone);
      },
      async remove(organizationId, id) {
        data.unmatchedWithholdings = data.unmatchedWithholdings.filter((w) => !(w.organizationId === organizationId && w.id === id));
      },
    },
    payableOpeningLoads: {
      async findByCutoff(organizationId, cutoffDate) {
        const l = data.payableOpeningLoads.find((x) => x.organizationId === organizationId && x.cutoffDate === cutoffDate);
        return l ? clone(l) : null;
      },
      async save(load) {
        if (data.payableOpeningLoads.some((x) => x.organizationId === load.organizationId && x.cutoffDate === load.cutoffDate)) throw uniqueViolation();
        data.payableOpeningLoads.push(clone(load));
      },
    },
    reminderSettings: {
      async find(organizationId) {
        const s = data.reminderSettings.get(organizationId);
        return s ? clone(s) : null;
      },
      async listEnabled() {
        return [...data.reminderSettings.values()].filter((s) => s.enabled).map(clone);
      },
      async save(settings) {
        data.reminderSettings.set(settings.organizationId, clone(settings));
      },
    },
    reminders: {
      async lastRemindedOn(organizationId, ids) {
        const out = new Map<string, string>();
        for (const r of data.reminders) {
          if (r.organizationId !== organizationId || !ids.includes(r.receivableId)) continue;
          const prev = out.get(r.receivableId);
          if (!prev || prev < r.reminderDate) out.set(r.receivableId, r.reminderDate);
        }
        return out;
      },
      async add(entry) {
        // El UNIQUE (partida, día) de la tabla.
        if (data.reminders.some((r) => r.receivableId === entry.receivableId && r.reminderDate === entry.reminderDate)) throw uniqueViolation();
        data.reminders.push({ organizationId: entry.organizationId, receivableId: entry.receivableId, customerId: entry.customerId, reminderDate: entry.reminderDate, trigger: entry.trigger, sentBy: entry.sentBy });
      },
    },
    outbox: {
      async add(event) {
        data.events.push(clone(event));
      },
    },
  };
}

/** Todo lo que una prueba necesita: la base, los casos de uso, la app HTTP y atajos para sembrar y mirar. */
export function buildWorld(options: { settings?: Partial<AccountingSettingsInfo> | null; accountingDown?: boolean; customersDown?: boolean; customers?: CustomerInfo[]; suppliersDown?: boolean } = {}) {
  const data = emptyData();
  let now = new Date('2026-10-21T15:00:00.000Z');
  const clock = () => new Date(now);

  const gateway: UnitOfWorkGateway = {
    async begin(): Promise<WriteUnitOfWork> {
      // Copia de seguridad para deshacer: `rollback` restaura TODO lo que cambió la transacción (partidas, aplicaciones, eventos).
      const backup = clone(data);
      return {
        ...buildUnitOfWork(data),
        async commit() {},
        async rollback() {
          Object.assign(data, backup);
        },
      };
    },
  };
  const reads = buildUnitOfWork(data);

  const settings: AccountingSettingsInfo | null = options.settings === null
    ? null
    : { baseCurrency: 'USD', timezone: 'America/Guayaquil', autoPosting: true, autoPostingFrom: null, paymentMethodRoles: null, ...(options.settings ?? {}) };
  const accounting: AccountingCatalogPort & { calls: number } = {
    calls: 0,
    async getSettings() {
      this.calls += 1;
      if (options.accountingDown) throw new CatalogUnavailableError();
      return settings;
    },
  };

  const knownCustomers = new Map<string, CustomerInfo>(
    (options.customers ?? [
      { id: CUSTOMER_1, businessName: 'CLIENTE UNO S.A.', identification: '1790012345001', email: 'uno@cliente.test' },
      { id: CUSTOMER_2, businessName: 'CLIENTE DOS', identification: '0912345678', email: null },
    ]).map((c) => [c.id, c]),
  );
  const customers: CustomerCatalogPort & { calls: string[]; down: boolean } = {
    calls: [],
    down: options.customersDown ?? false,
    async findById(_organizationId, customerId) {
      this.calls.push(customerId);
      if (this.down) throw new CatalogUnavailableError('No se pudo consultar a los clientes.');
      return knownCustomers.get(customerId) ?? null;
    },
  };

  const knownSuppliers = new Map<string, SupplierInfo>([
    [SUPPLIER_1, { id: SUPPLIER_1, legalName: 'PROVEEDOR UNO S.A.', identification: '1790011111001' }],
    [SUPPLIER_2, { id: SUPPLIER_2, legalName: 'PROVEEDOR DOS CIA. LTDA.', identification: '0992222222001' }],
  ]);
  const suppliers: SupplierCatalogPort & { calls: string[]; down: boolean } = {
    calls: [],
    down: options.suppliersDown ?? false,
    async findById(_organizationId, supplierId) {
      this.calls.push(supplierId);
      if (this.down) throw new CatalogUnavailableError('No se pudo consultar a los proveedores.');
      return knownSuppliers.get(supplierId) ?? null;
    },
  };

  const organizations: OrganizationCatalogPort & { name: string | null; down: boolean } = {
    name: 'MI EMPRESA S.A.',
    down: false,
    async getDisplayName() {
      if (this.down) throw new CatalogUnavailableError('No se pudo consultar los datos de la organización.');
      return this.name;
    },
  };

  const receiptDeps = { gateway, accounting, customers, clock };
  const reminderDeps = { gateway, reads, customers, organizations, clock, timezone: 'America/Guayaquil' };
  const runReminders = new RunRemindersUseCase(reminderDeps);
  const paymentDeps = { gateway, accounting, suppliers, clock };
  const logs: string[] = [];
  const useCases = {
    createReceipt: new CreateReceiptUseCase(receiptDeps),
    updateReceipt: new UpdateReceiptUseCase(receiptDeps),
    postReceipt: new PostReceiptUseCase(receiptDeps),
    voidReceipt: new VoidReceiptUseCase(receiptDeps),
    getReceipt: new GetReceiptUseCase(reads),
    listReceipts: new ListReceiptsUseCase(reads),
    invoiceIssued: new HandleInvoiceIssuedUseCase(gateway, accounting, clock),
    invoiceVoided: new HandleInvoiceVoidedUseCase(gateway, accounting, clock),
    loadOpeningBalances: new LoadOpeningBalancesUseCase(gateway, accounting, customers, clock),
    setCustomerTerms: new SetCustomerTermsUseCase(gateway, clock),
    getCustomerTerms: new GetCustomerTermsUseCase(reads),
    listReceivables: new ListReceivablesUseCase(reads, clock, 'America/Guayaquil'),
    getReceivable: new GetReceivableUseCase(reads),
    getReceivableDetail: new GetReceivableDetailUseCase(reads),
    getStatement: new GetCustomerStatementUseCase(reads, clock, 'America/Guayaquil'),
    getAging: new GetAgingUseCase(reads, clock, 'America/Guayaquil'),
    getReminderSettings: new GetReminderSettingsUseCase(reads),
    setReminderSettings: new SetReminderSettingsUseCase(gateway, clock),
    previewReminders: new PreviewRemindersUseCase(reminderDeps),
    runReminders,
    runDueReminders: new RunDueRemindersUseCase(reads, runReminders, clock, 'America/Guayaquil', (m) => logs.push(m)),
    exportReports: undefined as unknown as ExportReportsUseCase,
    billPosted: new HandleBillPostedUseCase(gateway, accounting, clock),
    billVoided: new HandleBillVoidedUseCase(gateway, clock),
    withholdingIssued: new HandleWithholdingIssuedUseCase(gateway, clock),
    listPayables: new ListPayablesUseCase(reads, clock, 'America/Guayaquil'),
    getPayableDetail: new GetPayableDetailUseCase(reads),
    getPayablesAging: new GetPayablesAgingUseCase(reads, clock, 'America/Guayaquil'),
    getSupplierStatement: new GetSupplierStatementUseCase(reads, clock, 'America/Guayaquil'),
    loadPayableOpeningBalances: new LoadPayableOpeningBalancesUseCase(gateway, accounting, suppliers, clock),
    listPayments: new ListPaymentsUseCase(reads),
    getPayment: new GetPaymentUseCase(reads),
    createPayment: new CreatePaymentUseCase(paymentDeps),
    updatePayment: new UpdatePaymentUseCase(paymentDeps),
    approvePayment: new ApprovePaymentUseCase(paymentDeps),
    postPayment: new PostPaymentUseCase(paymentDeps),
    voidPayment: new VoidPaymentUseCase(paymentDeps),
    getPaymentSettings: new GetPaymentSettingsUseCase(reads),
    setPaymentSettings: new SetPaymentSettingsUseCase(gateway, clock),
  };
  useCases.exportReports = new ExportReportsUseCase(gateway, reads, useCases.getAging, useCases.getStatement, clock, 'America/Guayaquil', useCases.getPayablesAging, useCases.getSupplierStatement);

  const app = createApp({
    useCases: {
      listReceivables: useCases.listReceivables,
      getReceivable: useCases.getReceivable,
      getReceivableDetail: useCases.getReceivableDetail,
      getStatement: useCases.getStatement,
      getAging: useCases.getAging,
      getCustomerTerms: useCases.getCustomerTerms,
      setCustomerTerms: useCases.setCustomerTerms,
      loadOpeningBalances: useCases.loadOpeningBalances,
      listReceipts: useCases.listReceipts,
      getReceipt: useCases.getReceipt,
      createReceipt: useCases.createReceipt,
      updateReceipt: useCases.updateReceipt,
      postReceipt: useCases.postReceipt,
      voidReceipt: useCases.voidReceipt,
      exportReports: useCases.exportReports,
      getReminderSettings: useCases.getReminderSettings,
      setReminderSettings: useCases.setReminderSettings,
      previewReminders: useCases.previewReminders,
      runReminders: useCases.runReminders,
      listPayables: useCases.listPayables,
      getPayableDetail: useCases.getPayableDetail,
      getPayablesAging: useCases.getPayablesAging,
      getSupplierStatement: useCases.getSupplierStatement,
      loadPayableOpeningBalances: useCases.loadPayableOpeningBalances,
      listPayments: useCases.listPayments,
      getPayment: useCases.getPayment,
      createPayment: useCases.createPayment,
      updatePayment: useCases.updatePayment,
      approvePayment: useCases.approvePayment,
      postPayment: useCases.postPayment,
      voidPayment: useCases.voidPayment,
      getPaymentSettings: useCases.getPaymentSettings,
      setPaymentSettings: useCases.setPaymentSettings,
    },
    corsOrigin: '*',
  });

  /** Una factura emitida tal como la publica billing. Los importes cuadran (ventas + IVA 15 % = total) salvo que se diga lo contrario. */
  const invoice = (overrides: Partial<InvoiceIssuedPayload> & { total?: number } = {}): InvoiceIssuedPayload => {
    const total = overrides.total ?? overrides.totalCents ?? 11500;
    const subtotal = Math.round(total / 1.15);
    const { total: _t, ...rest } = overrides;
    return {
      organizationId: ORG_A,
      invoiceId: randomUUID(),
      customerId: CUSTOMER_1,
      number: `001-001-${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`,
      issueDate: '2026-10-21T15:00:00.000Z',
      documentTypeCode: '01',
      relatedInvoiceId: null,
      posSaleId: null,
      paymentMethodCode: null,
      currencyCode: 'USD',
      totalCents: total,
      customerSnapshot: { id: overrides.customerId ?? CUSTOMER_1, businessName: 'CLIENTE UNO S.A.', identification: '1790012345001' },
      lines: [{ subtotalCents: subtotal, taxes: [{ kind: 'vat', amountCents: total - subtotal }] }],
      ...rest,
    };
  };

  /** Una factura de compra contabilizada tal como la publica compras (`purchasing.bill.posted`). Los importes cuadran (subtotal + IVA 15 % = total). */
  const bill = (overrides: Partial<BillPostedPayload> & { total?: number; supplier?: SupplierInfo } = {}): BillPostedPayload => {
    const total = overrides.total ?? overrides.totalCents ?? 11500;
    const subtotal = Math.round(total / 1.15);
    const { total: _t, supplier: sup, ...rest } = overrides;
    const supplier = sup ?? knownSuppliers.get(SUPPLIER_1)!;
    return {
      organizationId: ORG_A,
      billId: randomUUID(),
      internalNumber: `FC-2026-${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}`,
      supplierId: supplier.id,
      supplier: { identification: supplier.identification, legalName: supplier.legalName },
      docType: '01',
      supplierDocument: `001-001-${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`,
      issueDate: '2026-10-21',
      dueDate: '2026-11-20',
      currencyCode: 'USD',
      subtotalCents: subtotal,
      taxCents: total - subtotal,
      totalCents: total,
      lines: [{ subtotalCents: subtotal, vatCents: total - subtotal, iceCents: 0, irbpnrCents: 0 }],
      ...rest,
    };
  };
  /** Una retención autorizada tal como la publica fiscal (`fiscal.ec.withholding.issued`). */
  const withholding = (overrides: Partial<WithholdingIssuedPayload> = {}): WithholdingIssuedPayload => ({
    organizationId: ORG_A,
    withholdingId: randomUUID(),
    number: '001-001-000000007',
    issueDate: '2026-10-22',
    currencyCode: 'USD',
    supplier: { identification: knownSuppliers.get(SUPPLIER_1)!.identification },
    support: { documentCode: '01', number: '001-001-000000123' },
    totalWithheldCents: 1000,
    ...overrides,
  });

  return {
    data,
    useCases,
    app,
    suppliers,
    knownSuppliers,
    bill,
    withholding,
    payables: (organizationId = ORG_A) => [...data.payables.values()].filter((p) => p.organizationId === organizationId && p.supplierId !== ''),
    payableOf: (billId: string, organizationId = ORG_A) => [...data.payables.values()].find((p) => p.organizationId === organizationId && p.sourceId === billId),
    payments: (organizationId = ORG_A) => [...data.payments.values()].filter((p) => p.organizationId === organizationId),
    derivePayableStatus,
    accounting,
    customers,
    organizations,
    logs,
    knownCustomers,
    invoice,
    setNow(value: string) {
      now = new Date(value);
    },
    /** Partidas de una organización, con lo aplicado derivado. */
    receivables: (organizationId = ORG_A) => [...data.receivables.values()].filter((r) => r.organizationId === organizationId),
    events: (type?: string) => data.events.filter((e) => !type || e.type === type),
    status: deriveStatus,
  };
}

export type World = ReturnType<typeof buildWorld>;

/** Cabeceras que el gateway inyecta desde el token. */
export function headers(permissions: string[] | string, organizationId: string | null = ORG_A, userId: string | null = USER_1): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json', 'X-Permissions': Array.isArray(permissions) ? permissions.join(',') : permissions };
  if (organizationId) h['X-Organization-Id'] = organizationId;
  if (userId) h['X-User-Id'] = userId;
  return h;
}

export const ALL_PERMISSIONS = ['payable:read', 'payable:export', 'payment:read', 'payment:create', 'payment:approve', 'payment:void', 'receivable:read', 'customer_terms:manage', 'opening_balance:load', 'receipt:read', 'receipt:create', 'receipt:void', 'receivable:export', 'reminder:manage'];
