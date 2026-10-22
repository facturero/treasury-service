import { randomUUID } from 'node:crypto';
import type { BankMovement, BankMovementSource } from '../../domain/bank.js';
import { BankReconciledError, ValidationError } from '../../domain/errors.js';
import type { DomainEvent, UnitOfWork } from '../../domain/repositories.js';
import { bankMovementReversedEvent } from '../events.js';

/**
 * El REGISTRO de bancos: cada cobro o pago contabilizado por banco deja un movimiento con signo, en la MISMA transacción que lo contabiliza.
 * Estos ayudantes los usan los casos de uso de cobros y pagos; viven aquí para que la regla sea una sola.
 */

/**
 * Comprueba la cuenta bancaria elegida en un cobro o pago (borrador): solo con rol contable `bank`, existente, activa y en la misma moneda.
 * Sin cuenta elegida no es un error: el movimiento queda «sin asignar» y se asigna después.
 */
export async function assertBankAccountChoice(
  uow: UnitOfWork,
  organizationId: string,
  doc: { accountRole: 'cash' | 'bank'; bankAccountId: string | null; currencyCode: string },
): Promise<void> {
  if (doc.bankAccountId === null) return;
  if (doc.accountRole !== 'bank') {
    throw new ValidationError([{ field: 'bankAccountId', message: 'La cuenta bancaria solo aplica cuando el dinero entra o sale por bancos (no por caja).' }]);
  }
  const account = await uow.bankAccounts.findById(organizationId, doc.bankAccountId);
  if (!account) throw new ValidationError([{ field: 'bankAccountId', message: 'La cuenta bancaria no existe en esta organización.' }]);
  if (!account.isActive) throw new ValidationError([{ field: 'bankAccountId', message: 'La cuenta bancaria está desactivada.' }]);
  if (account.currencyCode !== doc.currencyCode) throw new ValidationError([{ field: 'bankAccountId', message: 'La cuenta bancaria está en otra moneda.' }]);
}

/**
 * Deja el movimiento de un cobro (+) o pago (−) contabilizado por banco. Idempotente por origen (`UNIQUE (org, source_type, source_id)`).
 * Un cobro o pago que solo consume anticipos (importe 0) o que va por caja no mueve el banco.
 */
export async function recordBankMovement(
  uow: UnitOfWork,
  input: {
    organizationId: string;
    sourceType: Extract<BankMovementSource, 'receipt' | 'payment'>;
    sourceId: string;
    accountRole: 'cash' | 'bank';
    bankAccountId: string | null;
    date: string;
    /** Con signo: + entra, − sale. */
    amountCents: number;
    reference: string | null;
    description: string;
    userId: string | null;
    now: Date;
  },
): Promise<void> {
  if (input.accountRole !== 'bank' || input.amountCents === 0) return;
  if (await uow.bankMovements.findBySource(input.organizationId, input.sourceType, input.sourceId)) return;
  const movement: BankMovement = {
    id: randomUUID(),
    organizationId: input.organizationId,
    bankAccountId: input.bankAccountId,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    movementDate: input.date,
    amountCents: input.amountCents,
    reference: input.reference,
    description: input.description.slice(0, 300),
    kind: null,
    status: 'active',
    createdBy: input.userId,
    version: 1,
    createdAt: input.now,
    updatedAt: input.now,
  };
  await uow.bankMovements.save(movement);
}

/**
 * Revierte el movimiento al anular el cobro o pago. Si estaba emparejado con un renglón del extracto:
 *  - dentro de una conciliación CERRADA → 409 `BANK_RECONCILED` (se reabre la conciliación primero);
 *  - si no, se deshace el emparejamiento COMPLETO del renglón (los demás movimientos de ese renglón quedan libres: la suma ya no cuadra) y
 *    el renglón vuelve a «sin emparejar».
 *
 * Devuelve el evento `treasury.bank_movement.reversed` SOLO si deshizo un emparejamiento (lo demás ya lo dice la anulación del cobro, pago o
 * ajuste); quien llama lo publica en su propia transacción.
 *
 * Orden de bloqueos: cuenta → renglón → movimiento (el mismo que usa emparejar y conciliar), para no interbloquearse con quien está emparejando.
 */
export async function reverseBankMovement(
  uow: UnitOfWork,
  input: { organizationId: string; sourceType: BankMovementSource; sourceId: string; now: Date },
): Promise<DomainEvent | null> {
  const peek = await uow.bankMovements.findBySource(input.organizationId, input.sourceType, input.sourceId);
  if (!peek || peek.status === 'reversed') return null;
  // Primero la cuenta: conciliar, emparejar y anular se turnan por ella (orden cuenta → renglón → movimiento en todas partes).
  if (peek.bankAccountId) await uow.bankAccounts.findById(input.organizationId, peek.bankAccountId, { lock: true });
  const peekMatch = await uow.bankMatches.findByMovement(input.organizationId, peek.id);
  const line = peekMatch ? await uow.bankLines.findById(input.organizationId, peekMatch.lineId, { lock: true }) : null;
  const movement = await uow.bankMovements.findById(input.organizationId, peek.id, { lock: true });
  if (!movement || movement.status === 'reversed') return null;
  const match = await uow.bankMatches.findByMovement(input.organizationId, movement.id, { lock: true });
  if (match) {
    if (match.reconciliationId) throw new BankReconciledError('Este movimiento ya está dentro de una conciliación bancaria cerrada: reabre la conciliación antes de anularlo.');
    await uow.bankMatches.removeByLine(input.organizationId, match.lineId);
    if (line) await uow.bankLines.save({ ...line, status: 'unmatched', updatedAt: input.now });
  }
  const reversed: BankMovement = { ...movement, status: 'reversed', version: movement.version + 1, updatedAt: input.now };
  await uow.bankMovements.save(reversed, movement.version);
  return match ? bankMovementReversedEvent(reversed, true) : null;
}
