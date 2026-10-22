import { ConcurrentUpdateError } from '../domain/errors.js';
import type { BankAccount, BankMatch, BankMovement, BankReconciliation, BankStatement, BankStatementLine } from '../domain/bank.js';
import type { BankLineFilters, BankMovementFilters, Page, UnitOfWork } from '../domain/repositories.js';

/**
 * Los repositorios de bancos en memoria, con la MISMA semántica que los de MySQL: los UNIQUE del esquema lanzan el mismo error, `save` con
 * versión rechaza si alguien cambió la fila, `freeze` congela lo que dice el esquema. Lo que NO puede probar es la concurrencia real
 * (el rollback restaura una copia): eso va contra MySQL en `scripts/verify-banking.mjs`.
 */
export interface BankData {
  bankAccounts: Map<string, BankAccount>;
  bankMovements: Map<string, BankMovement>;
  bankStatements: BankStatement[];
  bankLines: Map<string, BankStatementLine>;
  bankMatches: BankMatch[];
  bankReconciliations: Map<string, BankReconciliation>;
}

export const emptyBankData = (): BankData => ({
  bankAccounts: new Map(),
  bankMovements: new Map(),
  bankStatements: [],
  bankLines: new Map(),
  bankMatches: [],
  bankReconciliations: new Map(),
});

const clone = <T>(value: T): T => structuredClone(value);

function uniqueViolation(): Error {
  const err = new Error('Duplicate entry');
  err.name = 'SequelizeUniqueConstraintError';
  return err;
}

const page = <T>(rows: T[], p: number, size: number): Page<T> => ({ items: rows.slice((p - 1) * size, p * size).map(clone), total: rows.length, page: p, pageSize: size });

export function buildBankMemory(data: BankData): Pick<UnitOfWork, 'bankAccounts' | 'bankMovements' | 'bankStatements' | 'bankLines' | 'bankMatches' | 'bankReconciliations'> {
  return {
    bankAccounts: {
      async findById(organizationId, id) {
        const a = data.bankAccounts.get(id);
        return a && a.organizationId === organizationId ? clone(a) : null;
      },
      async findByName(organizationId, name) {
        const a = [...data.bankAccounts.values()].find((x) => x.organizationId === organizationId && x.name === name);
        return a ? clone(a) : null;
      },
      async list(organizationId, options) {
        return [...data.bankAccounts.values()]
          .filter((a) => a.organizationId === organizationId && (!options?.activeOnly || a.isActive))
          .sort((a, b) => Number(b.isActive) - Number(a.isActive) || a.name.localeCompare(b.name))
          .map(clone);
      },
      async save(account, expectedVersion) {
        const existing = data.bankAccounts.get(account.id);
        if (expectedVersion === undefined) {
          if (existing) throw uniqueViolation();
        } else if (!existing || existing.version !== expectedVersion) {
          throw new ConcurrentUpdateError();
        }
        if ([...data.bankAccounts.values()].some((a) => a.id !== account.id && a.organizationId === account.organizationId && a.name === account.name)) throw uniqueViolation();
        data.bankAccounts.set(account.id, clone(account));
      },
    },
    bankMovements: {
      async findById(organizationId, id) {
        const m = data.bankMovements.get(id);
        return m && m.organizationId === organizationId ? clone(m) : null;
      },
      async findBySource(organizationId, sourceType, sourceId) {
        const m = [...data.bankMovements.values()].find((x) => x.organizationId === organizationId && x.sourceType === sourceType && x.sourceId === sourceId);
        return m ? clone(m) : null;
      },
      async list(organizationId, filters: BankMovementFilters) {
        const matched = new Set(data.bankMatches.map((m) => m.movementId));
        let rows = [...data.bankMovements.values()].filter((m) => m.organizationId === organizationId);
        if (filters.bankAccountId === 'none') rows = rows.filter((m) => m.bankAccountId === null);
        else if (filters.bankAccountId) rows = rows.filter((m) => m.bankAccountId === filters.bankAccountId);
        if (filters.status?.length) rows = rows.filter((m) => filters.status!.includes(m.status));
        if (filters.from) rows = rows.filter((m) => m.movementDate >= filters.from!);
        if (filters.to) rows = rows.filter((m) => m.movementDate <= filters.to!);
        if (filters.matched === true) rows = rows.filter((m) => matched.has(m.id));
        if (filters.matched === false) rows = rows.filter((m) => !matched.has(m.id));
        if (filters.q?.trim()) {
          const q = filters.q.trim().toLowerCase();
          rows = rows.filter((m) => (m.reference ?? '').toLowerCase().includes(q) || m.description.toLowerCase().includes(q));
        }
        rows.sort((a, b) => (a.movementDate === b.movementDate ? b.createdAt.getTime() - a.createdAt.getTime() : a.movementDate < b.movementDate ? 1 : -1));
        return page(rows, filters.page, filters.pageSize);
      },
      async listActiveByAccount(organizationId, bankAccountId) {
        return [...data.bankMovements.values()]
          .filter((m) => m.organizationId === organizationId && m.bankAccountId === bankAccountId && m.status === 'active')
          .sort((a, b) => (a.movementDate < b.movementDate ? -1 : a.movementDate > b.movementDate ? 1 : a.createdAt.getTime() - b.createdAt.getTime()))
          .map(clone);
      },
      async listActive(organizationId) {
        return [...data.bankMovements.values()].filter((m) => m.organizationId === organizationId && m.status === 'active').map(clone);
      },
      async countUnassigned(organizationId) {
        return [...data.bankMovements.values()].filter((m) => m.organizationId === organizationId && m.bankAccountId === null && m.status === 'active').length;
      },
      async save(movement, expectedVersion) {
        const existing = data.bankMovements.get(movement.id);
        if (expectedVersion === undefined) {
          if (existing) throw uniqueViolation();
          if ([...data.bankMovements.values()].some((m) => m.organizationId === movement.organizationId && m.sourceType === movement.sourceType && m.sourceId === movement.sourceId)) throw uniqueViolation();
        } else if (!existing || existing.version !== expectedVersion) {
          throw new ConcurrentUpdateError();
        }
        if (movement.amountCents === 0) throw new Error('CHECK bank_movements_amount_ck');
        data.bankMovements.set(movement.id, clone(movement));
      },
    },
    bankStatements: {
      async findByHash(organizationId, bankAccountId, contentHash) {
        const s = data.bankStatements.find((x) => x.organizationId === organizationId && x.bankAccountId === bankAccountId && x.contentHash === contentHash);
        return s ? clone(s) : null;
      },
      async list(organizationId, bankAccountId) {
        return data.bankStatements.filter((s) => s.organizationId === organizationId && s.bankAccountId === bankAccountId).map(clone).reverse();
      },
      async add(statement) {
        if (data.bankStatements.some((s) => s.organizationId === statement.organizationId && s.bankAccountId === statement.bankAccountId && s.contentHash === statement.contentHash)) throw uniqueViolation();
        data.bankStatements.push(clone(statement));
      },
    },
    bankLines: {
      async findById(organizationId, id) {
        const l = data.bankLines.get(id);
        return l && l.organizationId === organizationId ? clone(l) : null;
      },
      async addMany(lines) {
        const known = new Set([...data.bankLines.values()].map((l) => `${l.organizationId}|${l.bankAccountId}|${l.fingerprint}`));
        for (const l of lines) {
          const key = `${l.organizationId}|${l.bankAccountId}|${l.fingerprint}`;
          if (known.has(key)) throw uniqueViolation();
          known.add(key);
        }
        for (const l of lines) data.bankLines.set(l.id, clone(l));
      },
      async existingFingerprints(organizationId, bankAccountId, fingerprints) {
        const wanted = new Set(fingerprints);
        return new Set([...data.bankLines.values()].filter((l) => l.organizationId === organizationId && l.bankAccountId === bankAccountId && wanted.has(l.fingerprint)).map((l) => l.fingerprint));
      },
      async list(organizationId, bankAccountId, filters: BankLineFilters) {
        let rows = [...data.bankLines.values()].filter((l) => l.organizationId === organizationId && l.bankAccountId === bankAccountId);
        if (filters.status?.length) rows = rows.filter((l) => filters.status!.includes(l.status));
        if (filters.from) rows = rows.filter((l) => l.lineDate >= filters.from!);
        if (filters.to) rows = rows.filter((l) => l.lineDate <= filters.to!);
        if (filters.q?.trim()) {
          const q = filters.q.trim().toLowerCase();
          rows = rows.filter((l) => (l.reference ?? '').toLowerCase().includes(q) || l.description.toLowerCase().includes(q));
        }
        rows.sort((a, b) => (a.lineDate === b.lineDate ? a.id.localeCompare(b.id) : a.lineDate < b.lineDate ? 1 : -1));
        return page(rows, filters.page, filters.pageSize);
      },
      async listAll(organizationId, bankAccountId) {
        return [...data.bankLines.values()]
          .filter((l) => l.organizationId === organizationId && l.bankAccountId === bankAccountId)
          .sort((a, b) => (a.lineDate < b.lineDate ? -1 : a.lineDate > b.lineDate ? 1 : a.createdAt.getTime() - b.createdAt.getTime()))
          .map(clone);
      },
      async save(line) {
        const existing = data.bankLines.get(line.id);
        if (!existing) throw new ConcurrentUpdateError();
        data.bankLines.set(line.id, { ...existing, status: line.status, externalReason: line.externalReason, reconciliationId: line.reconciliationId, updatedAt: line.updatedAt });
      },
      async freeze(organizationId, bankAccountId, upTo, reconciliationId) {
        for (const l of data.bankLines.values()) {
          if (l.organizationId === organizationId && l.bankAccountId === bankAccountId && l.lineDate <= upTo && (l.status === 'matched' || l.status === 'external') && l.reconciliationId === null) l.reconciliationId = reconciliationId;
        }
      },
      async unfreeze(organizationId, reconciliationId) {
        for (const l of data.bankLines.values()) if (l.organizationId === organizationId && l.reconciliationId === reconciliationId) l.reconciliationId = null;
      },
    },
    bankMatches: {
      async add(match) {
        if (data.bankMatches.some((m) => m.organizationId === match.organizationId && m.movementId === match.movementId)) throw uniqueViolation();
        data.bankMatches.push(clone(match));
      },
      async findByMovement(organizationId, movementId) {
        const m = data.bankMatches.find((x) => x.organizationId === organizationId && x.movementId === movementId);
        return m ? clone(m) : null;
      },
      async listByLines(organizationId, lineIds) {
        return data.bankMatches.filter((m) => m.organizationId === organizationId && lineIds.includes(m.lineId)).map(clone);
      },
      async listByMovements(organizationId, movementIds) {
        return data.bankMatches.filter((m) => m.organizationId === organizationId && movementIds.includes(m.movementId)).map(clone);
      },
      async listByAccount(organizationId, bankAccountId) {
        return data.bankMatches.filter((m) => m.organizationId === organizationId && m.bankAccountId === bankAccountId).map(clone);
      },
      async removeByLine(organizationId, lineId) {
        const removed = data.bankMatches.filter((m) => m.organizationId === organizationId && m.lineId === lineId);
        data.bankMatches = data.bankMatches.filter((m) => !(m.organizationId === organizationId && m.lineId === lineId));
        return removed.map(clone);
      },
      async freeze(organizationId, reconciliationId) {
        const frozenLines = new Set([...data.bankLines.values()].filter((l) => l.organizationId === organizationId && l.reconciliationId === reconciliationId).map((l) => l.id));
        for (const m of data.bankMatches) if (m.organizationId === organizationId && frozenLines.has(m.lineId)) m.reconciliationId = reconciliationId;
      },
      async unfreeze(organizationId, reconciliationId) {
        for (const m of data.bankMatches) if (m.organizationId === organizationId && m.reconciliationId === reconciliationId) m.reconciliationId = null;
      },
    },
    bankReconciliations: {
      async findById(organizationId, id) {
        const r = data.bankReconciliations.get(id);
        return r && r.organizationId === organizationId ? clone(r) : null;
      },
      async findLatestClosed(organizationId, bankAccountId) {
        const rows = [...data.bankReconciliations.values()]
          .filter((r) => r.organizationId === organizationId && r.bankAccountId === bankAccountId && r.status === 'closed')
          .sort((a, b) => (a.cutoffDate < b.cutoffDate ? 1 : a.cutoffDate > b.cutoffDate ? -1 : 0));
        return rows[0] ? clone(rows[0]) : null;
      },
      async list(organizationId, bankAccountId) {
        return [...data.bankReconciliations.values()]
          .filter((r) => r.organizationId === organizationId && r.bankAccountId === bankAccountId)
          .sort((a, b) => (a.cutoffDate < b.cutoffDate ? 1 : a.cutoffDate > b.cutoffDate ? -1 : b.createdAt.getTime() - a.createdAt.getTime()))
          .map(clone);
      },
      async save(reconciliation, expectedVersion) {
        const existing = data.bankReconciliations.get(reconciliation.id);
        if (expectedVersion === undefined) {
          if (existing) throw uniqueViolation();
        } else if (!existing || existing.version !== expectedVersion) {
          throw new ConcurrentUpdateError();
        }
        data.bankReconciliations.set(reconciliation.id, clone(reconciliation));
      },
    },
  };
}
