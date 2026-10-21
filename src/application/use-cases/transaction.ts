import type { UnitOfWork } from '../../domain/repositories.js';
import type { UnitOfWorkGateway } from '../ports.js';

/** Corre `work` dentro de una transacción: confirma si termina, deshace si lanza. */
export async function inTransaction<T>(
  gateway: UnitOfWorkGateway,
  work: (uow: UnitOfWork) => Promise<T>,
  options?: { readCommitted?: boolean },
): Promise<T> {
  const uow = await gateway.begin(options);
  try {
    const result = await work(uow);
    await uow.commit();
    return result;
  } catch (err) {
    await uow.rollback();
    throw err;
  }
}

/** Un UNIQUE de MySQL que no se anticipó (dos entregas del mismo evento a la vez) no es un fallo: es un duplicado. */
export function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { name?: string; parent?: { code?: string }; original?: { code?: string } };
  if (e.name === 'SequelizeUniqueConstraintError') return true;
  const code = e.parent?.code ?? e.original?.code;
  return code === 'ER_DUP_ENTRY' || code === 'ER_DUP_KEY';
}
