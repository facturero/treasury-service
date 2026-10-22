import { randomUUID } from 'node:crypto';
import {
  BankAccountNotFoundError,
  BankMovementNotFoundError,
  BankStatementAlreadyImportedError,
  BankMatchError,
  ValidationError,
  type ErrorDetail,
} from '../../domain/errors.js';
import {
  validateBankAccountInput,
  validateImportProfile,
  type BankAccount,
  type BankAccountInput,
  type BankMatch,
  type BankMovement,
  type BankStatement,
  type BankStatementLine,
  type ImportProfile,
} from '../../domain/bank.js';
import { registerBalanceOf } from '../../domain/bank-reconciliation.js';
import { parseStatement, type ParsedStatement } from '../../domain/statement-import.js';
import type { BankLineFilters, BankMovementFilters, Page, UnitOfWork } from '../../domain/repositories.js';
import { bankAccountCreatedEvent, bankAccountUpdatedEvent, bankMovementAssignedEvent, bankStatementImportedEvent } from '../events.js';
import type { AccountingCatalogPort, Clock, UnitOfWorkGateway } from '../ports.js';
import { inTransaction, isUniqueViolation } from './transaction.js';

export interface BankDependencies {
  gateway: UnitOfWorkGateway;
  accounting: AccountingCatalogPort;
  clock: Clock;
}

const nameTaken = (): ValidationError => new ValidationError([{ field: 'name', message: 'Ya existe una cuenta bancaria con ese nombre.' }]);

/** El modelo completo de una cuenta con lo que la pantalla de Bancos necesita de un vistazo. */
export interface BankAccountSummary {
  account: BankAccount;
  /** Saldo según el registro de tesorería: apertura + movimientos activos + renglones externos posteriores a la apertura. */
  registerBalanceCents: number;
  unmatchedLines: number;
  unmatchedMovements: number;
  /** Fecha de corte de la última conciliación cerrada. */
  lastReconciledOn: string | null;
  lastStatementDate: string | null;
}

export async function loadAccountOrThrow(uow: UnitOfWork, organizationId: string, id: string, options?: { lock?: boolean }): Promise<BankAccount> {
  const account = await uow.bankAccounts.findById(organizationId, id, options);
  if (!account) throw new BankAccountNotFoundError();
  return account;
}

export async function summarizeAccount(uow: UnitOfWork, account: BankAccount): Promise<BankAccountSummary> {
  const organizationId = account.organizationId;
  const [movements, lines, matches, closed, statements] = await Promise.all([
    uow.bankMovements.listActiveByAccount(organizationId, account.id),
    uow.bankLines.listAll(organizationId, account.id),
    uow.bankMatches.listByAccount(organizationId, account.id),
    uow.bankReconciliations.findLatestClosed(organizationId, account.id),
    uow.bankStatements.list(organizationId, account.id),
  ]);
  const matched = new Set(matches.map((m) => m.movementId));
  const register = registerBalanceOf(
    account,
    movements.map((m) => ({ date: m.movementDate, amountCents: m.amountCents })),
    lines.filter((l) => l.status === 'external').map((l) => ({ date: l.lineDate, amountCents: l.amountCents })),
  );
  return {
    account,
    registerBalanceCents: register,
    unmatchedLines: lines.filter((l) => l.status === 'unmatched').length,
    unmatchedMovements: movements.filter((m) => m.movementDate > account.openingDate && !matched.has(m.id)).length,
    lastReconciledOn: closed?.cutoffDate ?? null,
    lastStatementDate: statements.reduce<string | null>((acc, s) => (acc === null || s.periodEnd > acc ? s.periodEnd : acc), null),
  };
}

/** Crea una cuenta bancaria. La moneda es la base de la contabilidad: tesorería no maneja otra. */
export class CreateBankAccountUseCase {
  constructor(private readonly deps: BankDependencies) {}

  async execute(input: { organizationId: string; userId: string; account: BankAccountInput }): Promise<BankAccount> {
    validateBankAccountInput(input.account);
    const settings = await this.deps.accounting.getSettings(input.organizationId);
    if (!settings) throw new ValidationError([{ field: 'currencyCode', message: 'La organización no tiene contabilidad configurada: no se sabe la moneda de la cuenta.' }]);
    const now = this.deps.clock();
    try {
      return await inTransaction(this.deps.gateway, async (uow) => {
        const name = input.account.name.trim();
        if (await uow.bankAccounts.findByName(input.organizationId, name)) throw nameTaken();
        const account: BankAccount = {
          id: randomUUID(),
          organizationId: input.organizationId,
          name,
          bankName: input.account.bankName.trim(),
          accountType: input.account.accountType,
          accountLast4: input.account.accountLast4?.trim() || null,
          currencyCode: settings.baseCurrency,
          openingBalanceCents: input.account.openingBalanceCents,
          openingDate: input.account.openingDate,
          isActive: true,
          importProfile: input.account.importProfile ?? null,
          version: 1,
          createdAt: now,
          updatedAt: now,
        };
        await uow.bankAccounts.save(account);
        await uow.outbox.add(bankAccountCreatedEvent(account, input.userId));
        return account;
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw nameTaken();
      throw err;
    }
  }
}

export interface BankAccountPatch {
  name?: string;
  bankName?: string;
  accountLast4?: string | null;
  openingBalanceCents?: number;
  openingDate?: string;
  isActive?: boolean;
  importProfile?: ImportProfile | null;
}

/**
 * Edita una cuenta. El saldo y la fecha de APERTURA solo cambian mientras la cuenta no tenga extractos ni conciliaciones: después, mover
 * la apertura cambiaría en silencio lo ya conciliado. Desactivar una cuenta no borra nada: deja de ofrecerse en cobros y pagos.
 */
export class UpdateBankAccountUseCase {
  constructor(private readonly deps: BankDependencies) {}

  async execute(input: { organizationId: string; userId: string; bankAccountId: string; patch: BankAccountPatch; expectedVersion?: number }): Promise<BankAccount> {
    const now = this.deps.clock();
    try {
      return await inTransaction(this.deps.gateway, async (uow) => {
        const current = await loadAccountOrThrow(uow, input.organizationId, input.bankAccountId, { lock: true });
        if (input.expectedVersion !== undefined && input.expectedVersion !== current.version) {
          throw new ValidationError([{ field: 'version', message: 'Otra persona modificó esta cuenta. Vuelve a cargarla.' }]);
        }
        const p = input.patch;
        const next: BankAccount = {
          ...current,
          name: p.name !== undefined ? p.name.trim() : current.name,
          bankName: p.bankName !== undefined ? p.bankName.trim() : current.bankName,
          accountLast4: p.accountLast4 !== undefined ? p.accountLast4?.trim() || null : current.accountLast4,
          openingBalanceCents: p.openingBalanceCents ?? current.openingBalanceCents,
          openingDate: p.openingDate ?? current.openingDate,
          isActive: p.isActive ?? current.isActive,
          importProfile: p.importProfile !== undefined ? p.importProfile : current.importProfile,
          version: current.version + 1,
          updatedAt: now,
        };
        validateBankAccountInput({
          name: next.name,
          bankName: next.bankName,
          accountType: next.accountType,
          accountLast4: next.accountLast4,
          openingBalanceCents: next.openingBalanceCents,
          openingDate: next.openingDate,
          importProfile: next.importProfile,
        });
        const changes: Record<string, { from: unknown; to: unknown }> = {};
        for (const key of ['name', 'bankName', 'accountLast4', 'openingBalanceCents', 'openingDate', 'isActive'] as const) {
          if (next[key] !== current[key]) changes[key] = { from: current[key], to: next[key] };
        }
        if (JSON.stringify(next.importProfile) !== JSON.stringify(current.importProfile)) changes.importProfile = { from: current.importProfile !== null, to: next.importProfile !== null };
        if (!Object.keys(changes).length) return current;

        if (changes.openingBalanceCents || changes.openingDate) {
          const [statements, reconciliations] = await Promise.all([
            uow.bankStatements.list(input.organizationId, current.id),
            uow.bankReconciliations.list(input.organizationId, current.id),
          ]);
          if (statements.length || reconciliations.length) {
            throw new ValidationError([{ field: changes.openingDate ? 'openingDate' : 'openingBalanceCents', message: 'La apertura no se puede cambiar: la cuenta ya tiene extractos o conciliaciones.' }]);
          }
        }
        if (changes.name) {
          const other = await uow.bankAccounts.findByName(input.organizationId, next.name);
          if (other && other.id !== current.id) throw nameTaken();
        }
        await uow.bankAccounts.save(next, current.version);
        await uow.outbox.add(bankAccountUpdatedEvent(next, changes, input.userId));
        return next;
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw nameTaken();
      throw err;
    }
  }
}

export class ListBankAccountsUseCase {
  constructor(private readonly reads: UnitOfWork) {}

  async execute(input: { organizationId: string; activeOnly?: boolean }): Promise<{ items: BankAccountSummary[]; unassignedMovements: number }> {
    const accounts = await this.reads.bankAccounts.list(input.organizationId, { activeOnly: input.activeOnly });
    const items: BankAccountSummary[] = [];
    for (const account of accounts) items.push(await summarizeAccount(this.reads, account));
    return { items, unassignedMovements: await this.reads.bankMovements.countUnassigned(input.organizationId) };
  }
}

export class GetBankAccountUseCase {
  constructor(private readonly reads: UnitOfWork) {}

  async execute(input: { organizationId: string; bankAccountId: string }): Promise<BankAccountSummary & { statements: BankStatement[] }> {
    const account = await loadAccountOrThrow(this.reads, input.organizationId, input.bankAccountId);
    return { ...(await summarizeAccount(this.reads, account)), statements: await this.reads.bankStatements.list(input.organizationId, account.id) };
  }
}

// ── Importar un extracto ─────────────────────────────────────────────────────

const PREVIEW_LINES = 100;
const MAX_ERROR_DETAILS = 25;

export interface StatementAnalysis {
  parsed: ParsedStatement;
  alreadyImported: boolean;
  /** Los renglones que de verdad entrarían (sin los que ya estaban de un extracto anterior). */
  fresh: ParsedStatement['lines'];
  duplicates: number;
  /** Renglones nuevos de un periodo ya conciliado: no se admiten (cambiarían una conciliación cerrada). */
  lockedPeriod: number;
  lockedUntil: string | null;
}

async function analyze(uow: UnitOfWork, account: BankAccount, csv: string, profile: ImportProfile): Promise<StatementAnalysis> {
  const parsed = parseStatement(csv, profile, { openingDate: account.openingDate });
  const [existing, byHash, latestClosed] = await Promise.all([
    uow.bankLines.existingFingerprints(account.organizationId, account.id, parsed.lines.map((l) => l.fingerprint)),
    uow.bankStatements.findByHash(account.organizationId, account.id, parsed.contentHash),
    uow.bankReconciliations.findLatestClosed(account.organizationId, account.id),
  ]);
  const fresh = parsed.lines.filter((l) => !existing.has(l.fingerprint));
  const lockedUntil = latestClosed?.cutoffDate ?? null;
  const lockedPeriod = lockedUntil ? fresh.filter((l) => l.lineDate <= lockedUntil).length : 0;
  return { parsed, alreadyImported: byHash !== null, fresh, duplicates: parsed.lines.length - fresh.length, lockedPeriod, lockedUntil };
}

function profileOrThrow(account: BankAccount, override: ImportProfile | null | undefined): ImportProfile {
  const profile = override ?? account.importProfile;
  if (!profile) throw new ValidationError([{ field: 'importProfile', message: 'La cuenta no tiene perfil de importación: indica cómo leer el archivo (columnas, formato de fecha, separador decimal).' }]);
  return profile;
}

/** Vista previa: lee el archivo con el perfil y dice qué entraría y qué falla, SIN guardar nada. */
export class PreviewStatementUseCase {
  constructor(private readonly reads: UnitOfWork) {}

  async execute(input: { organizationId: string; bankAccountId: string; csv: string; profile?: ImportProfile | null }) {
    const account = await loadAccountOrThrow(this.reads, input.organizationId, input.bankAccountId);
    const profile = profileOrThrow(account, input.profile);
    const a = await analyze(this.reads, account, input.csv, profile);
    const fresh = new Set(a.fresh.map((l) => l.fingerprint));
    const sum = (pick: (cents: number) => boolean) => a.fresh.reduce((acc, l) => (pick(l.amountCents) ? acc + l.amountCents : acc), 0);
    return {
      profile,
      rowCount: a.parsed.rowCount,
      errors: a.parsed.errors.slice(0, MAX_ERROR_DETAILS),
      errorCount: a.parsed.errors.length,
      lines: a.parsed.lines.slice(0, PREVIEW_LINES).map((l) => ({ row: l.row, lineDate: l.lineDate, description: l.description, reference: l.reference, amountCents: l.amountCents, balanceCents: l.balanceCents, isDuplicate: !fresh.has(l.fingerprint) })),
      newLines: a.fresh.length,
      duplicates: a.duplicates,
      skippedBeforeOpening: a.parsed.skippedBeforeOpening,
      periodStart: a.parsed.periodStart,
      periodEnd: a.parsed.periodEnd,
      closingBalanceCents: a.parsed.closingBalanceCents,
      closingDate: a.parsed.closingDate,
      inCents: sum((c) => c > 0),
      outCents: sum((c) => c < 0),
      alreadyImported: a.alreadyImported,
      lockedPeriodLines: a.lockedPeriod,
      lockedUntil: a.lockedUntil,
      canImport: a.parsed.errors.length === 0 && !a.alreadyImported && a.fresh.length > 0 && a.lockedPeriod === 0,
    };
  }
}

/**
 * Importa el extracto: todo o nada. Con la cuenta bloqueada (dos importaciones simultáneas de la misma cuenta se turnan). El mismo archivo
 * no entra dos veces (409) y los renglones ya importados de un extracto que se solapa se omiten y se cuentan.
 */
export class ImportStatementUseCase {
  constructor(private readonly deps: BankDependencies) {}

  async execute(input: {
    organizationId: string;
    userId: string;
    bankAccountId: string;
    csv: string;
    fileName?: string | null;
    profile?: ImportProfile | null;
    saveProfile?: boolean;
  }): Promise<{ statement: BankStatement; importedLines: number; skippedDuplicates: number; skippedBeforeOpening: number }> {
    if (input.profile) {
      const problems = validateImportProfile(input.profile);
      if (problems.length) throw new ValidationError(problems);
    }
    const now = this.deps.clock();
    try {
      return await inTransaction(this.deps.gateway, async (uow) => {
        const account = await loadAccountOrThrow(uow, input.organizationId, input.bankAccountId, { lock: true });
        if (!account.isActive) throw new ValidationError([{ field: 'bankAccountId', message: 'La cuenta bancaria está desactivada.' }]);
        const profile = profileOrThrow(account, input.profile);
        const a = await analyze(uow, account, input.csv, profile);
        if (a.parsed.errors.length) {
          const details: ErrorDetail[] = a.parsed.errors.slice(0, MAX_ERROR_DETAILS).map((e) => ({ field: `rows[${e.row}].${e.field}`, message: `Fila ${e.row}: ${e.message}` }));
          throw new ValidationError(details, `El archivo tiene ${a.parsed.errors.length} fila(s) con error; no se importó nada.`);
        }
        if (a.alreadyImported) throw new BankStatementAlreadyImportedError();
        if (a.lockedPeriod > 0) {
          throw new ValidationError([{ field: 'csv', message: `El archivo trae ${a.lockedPeriod} renglón(es) nuevo(s) de un periodo ya conciliado (hasta ${a.lockedUntil}). Reabre la conciliación o quita esas filas.` }]);
        }
        if (a.fresh.length === 0) {
          throw new ValidationError([{ field: 'csv', message: 'No hay renglones nuevos: todo lo que trae el archivo ya estaba importado o es anterior a la apertura de la cuenta.' }]);
        }
        const statement: BankStatement = {
          id: randomUUID(),
          organizationId: input.organizationId,
          bankAccountId: account.id,
          fileName: input.fileName?.trim().slice(0, 200) || null,
          contentHash: a.parsed.contentHash,
          periodStart: a.parsed.periodStart!,
          periodEnd: a.parsed.periodEnd!,
          lineCount: a.fresh.length,
          closingBalanceCents: a.parsed.closingBalanceCents,
          closingDate: a.parsed.closingDate,
          importedBy: input.userId,
          importedAt: now,
        };
        await uow.bankStatements.add(statement);
        const lines: BankStatementLine[] = a.fresh.map((l) => ({
          id: randomUUID(),
          organizationId: input.organizationId,
          bankAccountId: account.id,
          statementId: statement.id,
          lineDate: l.lineDate,
          description: l.description,
          reference: l.reference,
          amountCents: l.amountCents,
          balanceCents: l.balanceCents,
          fingerprint: l.fingerprint,
          status: 'unmatched',
          externalReason: null,
          reconciliationId: null,
          createdAt: now,
          updatedAt: now,
        }));
        await uow.bankLines.addMany(lines);
        if (input.saveProfile && input.profile) {
          const next: BankAccount = { ...account, importProfile: input.profile, version: account.version + 1, updatedAt: now };
          await uow.bankAccounts.save(next, account.version);
          await uow.outbox.add(bankAccountUpdatedEvent(next, { importProfile: { from: account.importProfile !== null, to: true } }, input.userId));
        }
        await uow.outbox.add(bankStatementImportedEvent(statement, { bankAccountName: account.name, skippedDuplicates: a.duplicates, skippedBeforeOpening: a.parsed.skippedBeforeOpening, importedLines: lines.length }));
        return { statement, importedLines: lines.length, skippedDuplicates: a.duplicates, skippedBeforeOpening: a.parsed.skippedBeforeOpening };
      });
    } catch (err) {
      // Dos importaciones del mismo archivo a la vez: el UNIQUE del hash o de la huella lo detuvo.
      if (isUniqueViolation(err)) throw new BankStatementAlreadyImportedError();
      throw err;
    }
  }
}

// ── Listados ─────────────────────────────────────────────────────────────────

export interface LineView {
  line: BankStatementLine;
  /** Con qué movimientos está emparejado (vacío si no lo está). */
  movements: BankMovement[];
  reconciled: boolean;
}

export interface MovementView {
  movement: BankMovement;
  lineId: string | null;
  reconciled: boolean;
}

export class ListBankLinesUseCase {
  constructor(private readonly reads: UnitOfWork) {}

  async execute(input: { organizationId: string; bankAccountId: string; filters: BankLineFilters }): Promise<Page<LineView>> {
    await loadAccountOrThrow(this.reads, input.organizationId, input.bankAccountId);
    const page = await this.reads.bankLines.list(input.organizationId, input.bankAccountId, input.filters);
    const matches = await this.reads.bankMatches.listByLines(input.organizationId, page.items.map((l) => l.id));
    const movements = new Map<string, BankMovement>();
    for (const id of new Set(matches.map((m) => m.movementId))) {
      const movement = await this.reads.bankMovements.findById(input.organizationId, id);
      if (movement) movements.set(id, movement);
    }
    const items = page.items.map((line) => {
      const own = matches.filter((m) => m.lineId === line.id);
      return { line, movements: own.map((m) => movements.get(m.movementId)).filter((m): m is BankMovement => Boolean(m)), reconciled: line.reconciliationId !== null };
    });
    return { ...page, items };
  }
}

export class ListBankMovementsUseCase {
  constructor(private readonly reads: UnitOfWork) {}

  async execute(input: { organizationId: string; filters: BankMovementFilters }): Promise<Page<MovementView>> {
    if (input.filters.bankAccountId && input.filters.bankAccountId !== 'none') await loadAccountOrThrow(this.reads, input.organizationId, input.filters.bankAccountId);
    const page = await this.reads.bankMovements.list(input.organizationId, input.filters);
    const matches = await this.reads.bankMatches.listByMovements(input.organizationId, page.items.map((m) => m.id));
    const byMovement = new Map<string, BankMatch>(matches.map((m) => [m.movementId, m]));
    return { ...page, items: page.items.map((movement) => ({ movement, lineId: byMovement.get(movement.id)?.lineId ?? null, reconciled: Boolean(byMovement.get(movement.id)?.reconciliationId) })) };
  }
}

/**
 * Asigna una cuenta bancaria a un movimiento que no la tenía (cobros y pagos anteriores a este módulo, o elegidos sin cuenta). También
 * corrige una cuenta equivocada, siempre que el movimiento no esté emparejado ni conciliado.
 */
export class AssignMovementAccountUseCase {
  constructor(private readonly deps: BankDependencies) {}

  async execute(input: { organizationId: string; userId: string; movementId: string; bankAccountId: string }): Promise<BankMovement> {
    const now = this.deps.clock();
    return inTransaction(this.deps.gateway, async (uow) => {
      const account = await loadAccountOrThrow(uow, input.organizationId, input.bankAccountId, { lock: true });
      if (!account.isActive) throw new ValidationError([{ field: 'bankAccountId', message: 'La cuenta bancaria está desactivada.' }]);
      const movement = await uow.bankMovements.findById(input.organizationId, input.movementId, { lock: true });
      if (!movement) throw new BankMovementNotFoundError();
      if (movement.status !== 'active') throw new BankMatchError('El movimiento está revertido: no se le asigna cuenta.');
      if (movement.sourceType === 'adjustment') throw new BankMatchError('Un ajuste bancario nace con su cuenta: no se reasigna.');
      if (movement.bankAccountId === account.id) return movement;
      if (await uow.bankMatches.findByMovement(input.organizationId, movement.id)) throw new BankMatchError('El movimiento ya está emparejado con el extracto: deshaz el emparejamiento antes de cambiarle la cuenta.');
      const next: BankMovement = { ...movement, bankAccountId: account.id, version: movement.version + 1, updatedAt: now };
      await uow.bankMovements.save(next, movement.version);
      await uow.outbox.add(bankMovementAssignedEvent(next, movement.bankAccountId, input.userId));
      return next;
    });
  }
}
