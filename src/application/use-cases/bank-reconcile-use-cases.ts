import { randomUUID } from 'node:crypto';
import {
  adjustmentSign,
  validateAdjustmentInput,
  type AdjustmentInput,
  type BankAccount,
  type BankMatch,
  type BankMovement,
  type BankReconciliation,
  type BankStatementLine,
} from '../../domain/bank.js';
import { computeReconciliation, suggestMatches, registerBalanceOf, type ReconciliationInput, type ReconciliationResult, type Suggestion } from '../../domain/bank-reconciliation.js';
import { buildCashFlow, DEFAULT_CASH_FLOW_WEEKS, MAX_CASH_FLOW_WEEKS, MIN_CASH_FLOW_WEEKS, type CashFlow } from '../../domain/cash-flow.js';
import { isLocalDate, localDateOf } from '../../domain/dates.js';
import {
  BankMatchError,
  BankMovementNotFoundError,
  BankReconciledError,
  BankReconciliationNotFoundError,
  BankReconciliationStateError,
  BankStatementLineNotFoundError,
  ValidationError,
} from '../../domain/errors.js';
import { payableBalanceOf } from '../../domain/payable.js';
import { balanceOf } from '../../domain/receivable.js';
import type { UnitOfWork } from '../../domain/repositories.js';
import {
  bankAdjustmentPostedEvent,
  bankAdjustmentVoidedEvent,
  bankLineMarkedExternalEvent,
  bankLineMatchedEvent,
  bankLineUnmarkedExternalEvent,
  bankLineUnmatchedEvent,
  bankReconciliationClosedEvent,
  bankReconciliationReopenedEvent,
} from '../events.js';
import type { Clock } from '../ports.js';
import { loadAccountOrThrow, type BankDependencies } from './bank-account-use-cases.js';
import { reverseBankMovement } from './bank-register.js';
import { inTransaction, isUniqueViolation } from './transaction.js';

export const MIN_REASON = 5;
const LIVE = ['open', 'partial'];

// ── Estado de una cuenta, tal como lo ve la conciliación ────────────────────

interface AccountState {
  movements: BankMovement[];
  lines: BankStatementLine[];
  matches: BankMatch[];
}

async function loadState(uow: UnitOfWork, account: BankAccount): Promise<AccountState> {
  const [movements, lines, matches] = await Promise.all([
    uow.bankMovements.listActiveByAccount(account.organizationId, account.id),
    uow.bankLines.listAll(account.organizationId, account.id),
    uow.bankMatches.listByAccount(account.organizationId, account.id),
  ]);
  return { movements, lines, matches };
}

function reconciliationInput(account: BankAccount, cutoffDate: string, statementBalanceCents: number, state: AccountState): ReconciliationInput {
  const lineDate = new Map(state.lines.map((l) => [l.id, l.lineDate]));
  const clearedOn = new Map<string, string>();
  for (const m of state.matches) {
    const date = lineDate.get(m.lineId);
    if (date) clearedOn.set(m.movementId, date);
  }
  return {
    openingBalanceCents: account.openingBalanceCents,
    openingDate: account.openingDate,
    cutoffDate,
    statementBalanceCents,
    movements: state.movements.map((m) => ({ id: m.id, date: m.movementDate, amountCents: m.amountCents, clearedOn: clearedOn.get(m.id) ?? null })),
    lines: state.lines.map((l) => ({ id: l.id, date: l.lineDate, amountCents: l.amountCents, status: l.status })),
  };
}

const sign = (n: number): 1 | -1 => (n < 0 ? -1 : 1);

// ── Sugerencias ──────────────────────────────────────────────────────────────

export interface SuggestionView extends Suggestion {
  line: BankStatementLine;
  movement: BankMovement;
}

/** Calcula las sugerencias de la cuenta. NO escribe nada: las confirma una persona. */
export class SuggestMatchesUseCase {
  constructor(private readonly reads: UnitOfWork) {}

  async execute(input: { organizationId: string; bankAccountId: string }): Promise<{ suggestions: SuggestionView[] }> {
    const account = await loadAccountOrThrow(this.reads, input.organizationId, input.bankAccountId);
    const state = await loadState(this.reads, account);
    const matched = new Set(state.matches.map((m) => m.movementId));
    const lines = state.lines.filter((l) => l.status === 'unmatched');
    const movements = state.movements.filter((m) => m.movementDate > account.openingDate && !matched.has(m.id));
    const suggestions = suggestMatches(
      lines.map((l) => ({ id: l.id, date: l.lineDate, amountCents: l.amountCents, description: l.description, reference: l.reference })),
      movements.map((m) => ({ id: m.id, date: m.movementDate, amountCents: m.amountCents, reference: m.reference, description: m.description })),
    );
    const lineById = new Map(lines.map((l) => [l.id, l]));
    const movementById = new Map(movements.map((m) => [m.id, m]));
    return { suggestions: suggestions.map((s) => ({ ...s, line: lineById.get(s.lineId)!, movement: movementById.get(s.movementId)! })) };
  }
}

// ── Emparejar ────────────────────────────────────────────────────────────────

const matchTaken = (): BankMatchError => new BankMatchError('Alguno de esos movimientos ya fue emparejado por otra persona. Recarga la conciliación.');

/**
 * Empareja un renglón del extracto con uno o varios movimientos del registro (un depósito de varios cobros). La SUMA de los movimientos
 * debe ser exactamente el importe del renglón y todos del mismo signo y de la misma cuenta. Orden de bloqueos: cuenta → renglón →
 * movimientos por id: así dos personas emparejando lo mismo se turnan en vez de interbloquearse.
 */
export class MatchLineUseCase {
  constructor(private readonly deps: BankDependencies) {}

  async execute(input: { organizationId: string; userId: string; lineId: string; movementIds: string[]; method: 'manual' | 'suggested' }): Promise<{ line: BankStatementLine; movements: BankMovement[] }> {
    const ids = [...new Set(input.movementIds)];
    if (!ids.length) throw new ValidationError([{ field: 'movementIds', message: 'Elige al menos un movimiento.' }]);
    const now = this.deps.clock();
    try {
      return await inTransaction(
        this.deps.gateway,
        async (uow) => {
          const peek = await uow.bankLines.findById(input.organizationId, input.lineId);
          if (!peek) throw new BankStatementLineNotFoundError();
          await uow.bankAccounts.findById(input.organizationId, peek.bankAccountId, { lock: true });
          const line = await uow.bankLines.findById(input.organizationId, input.lineId, { lock: true });
          if (!line) throw new BankStatementLineNotFoundError();
          if (line.status === 'matched') throw new BankMatchError('Este renglón ya está emparejado.');
          if (line.status === 'external') throw new BankMatchError('Este renglón está marcado como contabilizado fuera de tesorería: desmárcalo antes de emparejarlo.');

          const movements: BankMovement[] = [];
          for (const id of [...ids].sort()) {
            const m = await uow.bankMovements.findById(input.organizationId, id, { lock: true });
            if (!m) throw new BankMovementNotFoundError();
            if (m.status !== 'active') throw new BankMatchError('Uno de los movimientos está revertido.');
            if (m.bankAccountId !== line.bankAccountId) throw new BankMatchError('Uno de los movimientos es de otra cuenta bancaria (o no tiene cuenta asignada).');
            if (sign(m.amountCents) !== sign(line.amountCents)) throw new BankMatchError('Entrada y salida no se emparejan entre sí: el signo del movimiento no coincide con el del renglón.');
            if (await uow.bankMatches.findByMovement(input.organizationId, m.id)) throw matchTaken();
            movements.push(m);
          }
          const total = movements.reduce((acc, m) => acc + m.amountCents, 0);
          if (total !== line.amountCents) {
            throw new BankMatchError(`La suma de los movimientos (${total} centavos) no es igual al importe del renglón (${line.amountCents} centavos).`, [
              { field: 'movementIds', message: `Suman ${total} y el renglón es ${line.amountCents}.` },
            ]);
          }
          for (const m of movements) {
            await uow.bankMatches.add({
              id: randomUUID(),
              organizationId: input.organizationId,
              bankAccountId: line.bankAccountId,
              lineId: line.id,
              movementId: m.id,
              amountCents: m.amountCents,
              method: input.method,
              matchedBy: input.userId,
              matchedAt: now,
              reconciliationId: null,
            });
          }
          const matched: BankStatementLine = { ...line, status: 'matched', updatedAt: now };
          await uow.bankLines.save(matched);
          await uow.outbox.add(bankLineMatchedEvent(matched, movements.map((m) => ({ id: m.id, sourceType: m.sourceType, sourceId: m.sourceId, amountCents: m.amountCents })), input.method, input.userId));
          return { line: matched, movements };
        },
        { readCommitted: true },
      );
    } catch (err) {
      if (isUniqueViolation(err)) throw matchTaken();
      throw err;
    }
  }
}

export interface BatchMatchResult {
  matched: string[];
  failed: { lineId: string; code: string; message: string }[];
}

/** Confirma varios pares (las sugerencias aceptadas): cada uno en su transacción, así uno que falló no tumba a los demás. */
export class MatchManyUseCase {
  constructor(private readonly matchOne: MatchLineUseCase) {}

  async execute(input: { organizationId: string; userId: string; pairs: { lineId: string; movementIds: string[] }[]; method: 'manual' | 'suggested' }): Promise<BatchMatchResult> {
    const result: BatchMatchResult = { matched: [], failed: [] };
    for (const pair of input.pairs) {
      try {
        await this.matchOne.execute({ organizationId: input.organizationId, userId: input.userId, lineId: pair.lineId, movementIds: pair.movementIds, method: input.method });
        result.matched.push(pair.lineId);
      } catch (err) {
        const e = err as { code?: string; message?: string };
        if (!e.code) throw err;
        result.failed.push({ lineId: pair.lineId, code: e.code, message: e.message ?? '' });
      }
    }
    return result;
  }
}

/** Deshace el emparejamiento de un renglón (todos sus movimientos quedan libres). No se puede si ya está en una conciliación cerrada. */
export class UnmatchLineUseCase {
  constructor(private readonly deps: BankDependencies) {}

  async execute(input: { organizationId: string; userId: string; lineId: string }): Promise<BankStatementLine> {
    const now = this.deps.clock();
    return inTransaction(this.deps.gateway, async (uow) => {
      const peek = await uow.bankLines.findById(input.organizationId, input.lineId);
      if (!peek) throw new BankStatementLineNotFoundError();
      await uow.bankAccounts.findById(input.organizationId, peek.bankAccountId, { lock: true });
      const line = await uow.bankLines.findById(input.organizationId, input.lineId, { lock: true });
      if (!line) throw new BankStatementLineNotFoundError();
      if (line.status !== 'matched') throw new BankMatchError('Este renglón no está emparejado.');
      const matches = await uow.bankMatches.listByLines(input.organizationId, [line.id]);
      if (line.reconciliationId || matches.some((m) => m.reconciliationId)) throw new BankReconciledError('Este renglón ya está en una conciliación cerrada: reábrela primero.');
      await uow.bankMatches.removeByLine(input.organizationId, line.id);
      const next: BankStatementLine = { ...line, status: 'unmatched', updatedAt: now };
      await uow.bankLines.save(next);
      await uow.outbox.add(bankLineUnmatchedEvent(next, matches.map((m) => m.movementId), input.userId));
      return next;
    });
  }
}

/**
 * «Ya contabilizado fuera de tesorería»: el renglón del banco corresponde a algo que contabilidad ya tiene por otro camino (una venta cobrada
 * en el momento con tarjeta o transferencia). Es una afirmación de la persona: lleva motivo obligatorio y queda en la bitácora.
 */
export class MarkLineExternalUseCase {
  constructor(private readonly deps: BankDependencies) {}

  async execute(input: { organizationId: string; userId: string; lineId: string; reason: string }): Promise<BankStatementLine> {
    const reason = input.reason?.trim() ?? '';
    if (reason.length < MIN_REASON) throw new ValidationError([{ field: 'reason', message: `Indica por qué ya está contabilizado (mínimo ${MIN_REASON} caracteres).` }]);
    const now = this.deps.clock();
    return inTransaction(this.deps.gateway, async (uow) => {
      const peek = await uow.bankLines.findById(input.organizationId, input.lineId);
      if (!peek) throw new BankStatementLineNotFoundError();
      await uow.bankAccounts.findById(input.organizationId, peek.bankAccountId, { lock: true });
      const line = await uow.bankLines.findById(input.organizationId, input.lineId, { lock: true });
      if (!line) throw new BankStatementLineNotFoundError();
      if (line.status !== 'unmatched') throw new BankMatchError(line.status === 'matched' ? 'Este renglón ya está emparejado con un movimiento.' : 'Este renglón ya está marcado como externo.');
      const next: BankStatementLine = { ...line, status: 'external', externalReason: reason.slice(0, 300), updatedAt: now };
      await uow.bankLines.save(next);
      await uow.outbox.add(bankLineMarkedExternalEvent(next, input.userId));
      return next;
    });
  }
}

export class UnmarkLineExternalUseCase {
  constructor(private readonly deps: BankDependencies) {}

  async execute(input: { organizationId: string; userId: string; lineId: string }): Promise<BankStatementLine> {
    const now = this.deps.clock();
    return inTransaction(this.deps.gateway, async (uow) => {
      const peek = await uow.bankLines.findById(input.organizationId, input.lineId);
      if (!peek) throw new BankStatementLineNotFoundError();
      await uow.bankAccounts.findById(input.organizationId, peek.bankAccountId, { lock: true });
      const line = await uow.bankLines.findById(input.organizationId, input.lineId, { lock: true });
      if (!line) throw new BankStatementLineNotFoundError();
      if (line.status !== 'external') throw new BankMatchError('Este renglón no está marcado como externo.');
      if (line.reconciliationId) throw new BankReconciledError('Este renglón ya está en una conciliación cerrada: reábrela primero.');
      const next: BankStatementLine = { ...line, status: 'unmatched', externalReason: null, updatedAt: now };
      await uow.bankLines.save(next);
      await uow.outbox.add(bankLineUnmarkedExternalEvent(next, input.userId));
      return next;
    });
  }
}

// ── Ajustes bancarios ────────────────────────────────────────────────────────

/**
 * Registra lo que el banco hizo y la empresa no tenía (comisión, interés, otro ingreso o egreso). Es un movimiento de tesorería que
 * publica `treasury.bank_adjustment.posted`: contabilidad lo asienta contra `other_expense` / `other_income`.
 *
 * Con `lineId` nace YA emparejado con ese renglón (el flujo normal: «este renglón es una comisión»): el importe y el signo salen del
 * renglón y deben coincidir con el tipo elegido.
 */
export class PostBankAdjustmentUseCase {
  constructor(private readonly deps: BankDependencies) {}

  async execute(input: { organizationId: string; userId: string; adjustment: AdjustmentInput; lineId?: string | null }): Promise<BankMovement> {
    validateAdjustmentInput(input.adjustment);
    const now = this.deps.clock();
    return inTransaction(this.deps.gateway, async (uow) => {
      const account = await loadAccountOrThrow(uow, input.organizationId, input.adjustment.bankAccountId, { lock: true });
      if (!account.isActive) throw new ValidationError([{ field: 'bankAccountId', message: 'La cuenta bancaria está desactivada.' }]);
      const a = input.adjustment;
      const signed = adjustmentSign(a.kind) * a.amountCents;
      let date = a.date;
      let line: BankStatementLine | null = null;
      if (input.lineId) {
        line = await uow.bankLines.findById(input.organizationId, input.lineId, { lock: true });
        if (!line || line.bankAccountId !== account.id) throw new BankStatementLineNotFoundError();
        if (line.status !== 'unmatched') throw new BankMatchError('Este renglón ya está resuelto (emparejado o marcado como externo).');
        if (line.amountCents !== signed) {
          throw new ValidationError([{ field: 'amountCents', message: `El ajuste (${signed} centavos) no coincide con el renglón del extracto (${line.amountCents} centavos): revisa el tipo y el importe.` }]);
        }
        date = line.lineDate;
      }
      if (date <= account.openingDate) throw new ValidationError([{ field: 'date', message: `La fecha debe ser posterior a la apertura de la cuenta (${account.openingDate}).` }]);
      const closed = await uow.bankReconciliations.findLatestClosed(input.organizationId, account.id);
      if (closed && date <= closed.cutoffDate) {
        throw new ValidationError([{ field: 'date', message: `La fecha cae en un periodo ya conciliado (hasta ${closed.cutoffDate}): reabre la conciliación o usa una fecha posterior.` }]);
      }
      const id = randomUUID();
      const movement: BankMovement = {
        id,
        organizationId: input.organizationId,
        bankAccountId: account.id,
        sourceType: 'adjustment',
        sourceId: id,
        movementDate: date,
        amountCents: signed,
        reference: a.reference?.trim().slice(0, 100) || null,
        description: a.description.trim().slice(0, 300),
        kind: a.kind,
        status: 'active',
        createdBy: input.userId,
        version: 1,
        createdAt: now,
        updatedAt: now,
      };
      await uow.bankMovements.save(movement);
      await uow.outbox.add(bankAdjustmentPostedEvent(movement, { name: account.name, currencyCode: account.currencyCode }));
      if (line) {
        await uow.bankMatches.add({
          id: randomUUID(),
          organizationId: input.organizationId,
          bankAccountId: account.id,
          lineId: line.id,
          movementId: movement.id,
          amountCents: movement.amountCents,
          method: 'manual',
          matchedBy: input.userId,
          matchedAt: now,
          reconciliationId: null,
        });
        const matched: BankStatementLine = { ...line, status: 'matched', updatedAt: now };
        await uow.bankLines.save(matched);
        await uow.outbox.add(bankLineMatchedEvent(matched, [{ id: movement.id, sourceType: 'adjustment', sourceId: movement.id, amountCents: movement.amountCents }], 'manual', input.userId));
      }
      return movement;
    });
  }
}

/** Anula un ajuste bancario (con motivo): contabilidad reversa el asiento. Si estaba emparejado dentro de una conciliación cerrada, no. */
export class VoidBankAdjustmentUseCase {
  constructor(private readonly deps: BankDependencies) {}

  async execute(input: { organizationId: string; userId: string; movementId: string; reason: string }): Promise<BankMovement> {
    const reason = input.reason?.trim() ?? '';
    if (reason.length < MIN_REASON) throw new ValidationError([{ field: 'reason', message: `Indica el motivo de la anulación (mínimo ${MIN_REASON} caracteres).` }]);
    const now = this.deps.clock();
    return inTransaction(this.deps.gateway, async (uow) => {
      const peek = await uow.bankMovements.findById(input.organizationId, input.movementId);
      if (!peek || peek.sourceType !== 'adjustment') throw new BankMovementNotFoundError('Ajuste bancario no encontrado.');
      if (peek.status === 'reversed') return peek;
      const unmatched = await reverseBankMovement(uow, { organizationId: input.organizationId, sourceType: 'adjustment', sourceId: peek.sourceId, now });
      if (unmatched) await uow.outbox.add(unmatched);
      const done = (await uow.bankMovements.findById(input.organizationId, input.movementId))!;
      const account = await loadAccountOrThrow(uow, input.organizationId, done.bankAccountId!);
      await uow.outbox.add(bankAdjustmentVoidedEvent(done, { name: account.name, currencyCode: account.currencyCode }, reason, input.userId));
      return done;
    });
  }
}

// ── Conciliación ─────────────────────────────────────────────────────────────

export interface ReconciliationPreview {
  account: BankAccount;
  cutoffDate: string;
  /** El saldo que se usó (el escrito, o el del extracto importado más reciente hasta el corte). */
  statementBalanceCents: number | null;
  suggestedStatementBalance: { cents: number; date: string } | null;
  result: ReconciliationResult | null;
  pendingMovements: BankMovement[];
  unresolvedLines: BankStatementLine[];
  latestClosed: BankReconciliation | null;
}

const PENDING_LIST_LIMIT = 200;

async function previewFor(uow: UnitOfWork, account: BankAccount, cutoffDate: string, statementBalanceCents: number | undefined): Promise<ReconciliationPreview> {
  if (!isLocalDate(cutoffDate)) throw new ValidationError([{ field: 'cutoffDate', message: 'La fecha de corte no es válida (AAAA-MM-DD).' }]);
  const [state, statements, latestClosed] = await Promise.all([
    loadState(uow, account),
    uow.bankStatements.list(account.organizationId, account.id),
    uow.bankReconciliations.findLatestClosed(account.organizationId, account.id),
  ]);
  const withBalance = statements
    .filter((s) => s.closingBalanceCents !== null && s.closingDate !== null && s.closingDate <= cutoffDate)
    .sort((a, b) => (a.closingDate! < b.closingDate! ? 1 : -1));
  const suggested = withBalance[0] ? { cents: withBalance[0].closingBalanceCents!, date: withBalance[0].closingDate! } : null;
  const balance = statementBalanceCents ?? suggested?.cents ?? null;
  if (balance === null) {
    return { account, cutoffDate, statementBalanceCents: null, suggestedStatementBalance: null, result: null, pendingMovements: [], unresolvedLines: [], latestClosed };
  }
  const input = reconciliationInput(account, cutoffDate, balance, state);
  const result = computeReconciliation(input);
  const clearedOn = new Map(input.movements.map((m) => [m.id, m.clearedOn]));
  const pendingMovements = state.movements.filter((m) => {
    if (m.movementDate <= account.openingDate) return false;
    const cleared = clearedOn.get(m.id);
    const isCleared = cleared !== null && cleared !== undefined && cleared <= cutoffDate;
    return (m.movementDate <= cutoffDate || isCleared) && !isCleared;
  });
  const unresolvedLines = state.lines.filter((l) => l.status === 'unmatched' && l.lineDate > account.openingDate && l.lineDate <= cutoffDate);
  return {
    account,
    cutoffDate,
    statementBalanceCents: balance,
    suggestedStatementBalance: suggested,
    result,
    pendingMovements: pendingMovements.slice(0, PENDING_LIST_LIMIT),
    unresolvedLines: unresolvedLines.slice(0, PENDING_LIST_LIMIT),
    latestClosed,
  };
}

/** Calcula la conciliación a una fecha de corte, en vivo. No guarda nada. */
export class PreviewReconciliationUseCase {
  constructor(private readonly reads: UnitOfWork) {}

  async execute(input: { organizationId: string; bankAccountId: string; cutoffDate: string; statementBalanceCents?: number }): Promise<ReconciliationPreview> {
    const account = await loadAccountOrThrow(this.reads, input.organizationId, input.bankAccountId);
    return previewFor(this.reads, account, input.cutoffDate, input.statementBalanceCents);
  }
}

/**
 * Cierra la conciliación: solo con diferencia CERO y sin renglones sin resolver hasta el corte. Congela los renglones y los
 * emparejamientos (ya no se pueden deshacer ni anular lo que cubren sin reabrir). El corte debe ser posterior al de la última
 * conciliación cerrada: las conciliaciones se encadenan, no se pisan.
 */
export class CloseReconciliationUseCase {
  constructor(private readonly deps: BankDependencies) {}

  async execute(input: { organizationId: string; userId: string; bankAccountId: string; cutoffDate: string; statementBalanceCents: number; notes?: string | null }): Promise<BankReconciliation> {
    if (!Number.isSafeInteger(input.statementBalanceCents)) throw new ValidationError([{ field: 'statementBalanceCents', message: 'El saldo del extracto debe ser un número entero de centavos.' }]);
    const now = this.deps.clock();
    return inTransaction(
      this.deps.gateway,
      async (uow) => {
        const account = await loadAccountOrThrow(uow, input.organizationId, input.bankAccountId, { lock: true });
        const preview = await previewFor(uow, account, input.cutoffDate, input.statementBalanceCents);
        if (preview.latestClosed && input.cutoffDate <= preview.latestClosed.cutoffDate) {
          throw new ValidationError([{ field: 'cutoffDate', message: `El corte debe ser posterior al de la última conciliación cerrada (${preview.latestClosed.cutoffDate}).` }]);
        }
        const result = preview.result!;
        if (!result.canClose) {
          const reasons: string[] = [];
          if (result.differenceCents !== 0) reasons.push(`la diferencia es ${result.differenceCents} centavos (debe ser 0)`);
          if (result.unresolvedLines > 0) reasons.push(`hay ${result.unresolvedLines} renglón(es) del extracto sin resolver`);
          throw new BankReconciliationStateError(`No se puede cerrar: ${reasons.join(' y ')}.`);
        }
        const rec: BankReconciliation = {
          id: randomUUID(),
          organizationId: input.organizationId,
          bankAccountId: account.id,
          cutoffDate: input.cutoffDate,
          statementBalanceCents: input.statementBalanceCents,
          registerBalanceCents: result.registerBalanceCents,
          pendingCents: result.pendingCents,
          differenceCents: result.differenceCents,
          status: 'closed',
          closedBy: input.userId,
          closedAt: now,
          reopenedBy: null,
          reopenedAt: null,
          notes: input.notes?.trim().slice(0, 500) || null,
          version: 1,
          createdAt: now,
        };
        await uow.bankReconciliations.save(rec);
        await uow.bankLines.freeze(input.organizationId, account.id, input.cutoffDate, rec.id);
        await uow.bankMatches.freeze(input.organizationId, rec.id);
        await uow.outbox.add(bankReconciliationClosedEvent(rec, account.name));
        return rec;
      },
      { readCommitted: true },
    );
  }
}

/** Reabre la ÚLTIMA conciliación cerrada de la cuenta (con motivo): descongela sus renglones y emparejamientos. */
export class ReopenReconciliationUseCase {
  constructor(private readonly deps: BankDependencies) {}

  async execute(input: { organizationId: string; userId: string; reconciliationId: string; reason: string }): Promise<BankReconciliation> {
    const reason = input.reason?.trim() ?? '';
    if (reason.length < MIN_REASON) throw new ValidationError([{ field: 'reason', message: `Indica por qué se reabre (mínimo ${MIN_REASON} caracteres).` }]);
    const now = this.deps.clock();
    return inTransaction(this.deps.gateway, async (uow) => {
      const peek = await uow.bankReconciliations.findById(input.organizationId, input.reconciliationId);
      if (!peek) throw new BankReconciliationNotFoundError();
      const account = await loadAccountOrThrow(uow, input.organizationId, peek.bankAccountId, { lock: true });
      const rec = await uow.bankReconciliations.findById(input.organizationId, input.reconciliationId, { lock: true });
      if (!rec) throw new BankReconciliationNotFoundError();
      if (rec.status !== 'closed') throw new BankReconciliationStateError('Esta conciliación ya estaba reabierta.');
      const latest = await uow.bankReconciliations.findLatestClosed(input.organizationId, account.id);
      if (!latest || latest.id !== rec.id) throw new BankReconciliationStateError('Solo se reabre la última conciliación cerrada de la cuenta.');
      await uow.bankLines.unfreeze(input.organizationId, rec.id);
      await uow.bankMatches.unfreeze(input.organizationId, rec.id);
      const next: BankReconciliation = { ...rec, status: 'reopened', reopenedBy: input.userId, reopenedAt: now, notes: reason.slice(0, 500), version: rec.version + 1 };
      await uow.bankReconciliations.save(next, rec.version);
      await uow.outbox.add(bankReconciliationReopenedEvent(next, account.name, reason, input.userId));
      return next;
    });
  }
}

export class ListReconciliationsUseCase {
  constructor(private readonly reads: UnitOfWork) {}

  async execute(input: { organizationId: string; bankAccountId: string }): Promise<BankReconciliation[]> {
    await loadAccountOrThrow(this.reads, input.organizationId, input.bankAccountId);
    return this.reads.bankReconciliations.list(input.organizationId, input.bankAccountId);
  }
}

// ── Flujo de caja ────────────────────────────────────────────────────────────

/**
 * Flujo de caja proyectado: el saldo del registro de bancos (todas las cuentas activas más los movimientos sin cuenta) + la cartera por
 * vencimiento − la deuda por vencimiento. Solo lectura y derivado: no toca asientos.
 */
export class GetCashFlowUseCase {
  constructor(
    private readonly reads: UnitOfWork,
    private readonly clock: Clock,
    private readonly timezone: string,
  ) {}

  async execute(input: { organizationId: string; weeks?: number; asOf?: string }): Promise<CashFlow & { accounts: { id: string; name: string; balanceCents: number }[]; unassignedCents: number }> {
    const weeks = input.weeks ?? DEFAULT_CASH_FLOW_WEEKS;
    if (!Number.isInteger(weeks) || weeks < MIN_CASH_FLOW_WEEKS || weeks > MAX_CASH_FLOW_WEEKS) {
      throw new ValidationError([{ field: 'weeks', message: `Las semanas van de ${MIN_CASH_FLOW_WEEKS} a ${MAX_CASH_FLOW_WEEKS}.` }]);
    }
    const asOf = input.asOf ?? localDateOf(this.clock(), this.timezone);
    if (!isLocalDate(asOf)) throw new ValidationError([{ field: 'asOf', message: 'La fecha no es válida (AAAA-MM-DD).' }]);

    const accounts = await this.reads.bankAccounts.list(input.organizationId, { activeOnly: true });
    const balances: { id: string; name: string; balanceCents: number }[] = [];
    for (const account of accounts) {
      const [movements, lines] = await Promise.all([
        this.reads.bankMovements.listActiveByAccount(input.organizationId, account.id),
        this.reads.bankLines.listAll(input.organizationId, account.id),
      ]);
      balances.push({
        id: account.id,
        name: account.name,
        balanceCents: registerBalanceOf(
          account,
          movements.map((m) => ({ date: m.movementDate, amountCents: m.amountCents })),
          lines.filter((l) => l.status === 'external').map((l) => ({ date: l.lineDate, amountCents: l.amountCents })),
        ),
      });
    }
    // Lo cobrado y pagado por banco que todavía no tiene cuenta también es dinero real en bancos.
    const unassignedCents = (await this.reads.bankMovements.listActive(input.organizationId)).filter((m) => m.bankAccountId === null).reduce((acc, m) => acc + m.amountCents, 0);
    const openingCents = balances.reduce((acc, b) => acc + b.balanceCents, 0) + unassignedCents;

    const [receivables, payables] = await Promise.all([this.reads.receivables.listBalances(input.organizationId), this.reads.payables.listBalances(input.organizationId)]);
    const flow = buildCashFlow({
      asOf,
      weeks,
      openingCents,
      receivables: receivables.filter((r) => LIVE.includes(r.status)).map((r) => ({ dueDate: r.dueDate, balanceCents: balanceOf(r) })),
      payables: payables.filter((p) => LIVE.includes(p.status)).map((p) => ({ dueDate: p.dueDate, balanceCents: payableBalanceOf(p) })),
    });
    return { ...flow, accounts: balances, unassignedCents };
  }
}

