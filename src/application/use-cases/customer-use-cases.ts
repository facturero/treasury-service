import type { CustomerTerms } from '../../domain/receivable.js';
import { ValidationError } from '../../domain/errors.js';
import type { UnitOfWork } from '../../domain/repositories.js';
import { customerTermsUpdatedEvent } from '../events.js';
import type { Clock, UnitOfWorkGateway } from '../ports.js';
import { inTransaction } from './transaction.js';

/** Lee las condiciones de crédito de un cliente. `null` = todavía no tiene ninguna (0 días, sin cupo). */
export class GetCustomerTermsUseCase {
  constructor(private readonly reads: UnitOfWork) {}

  async execute(input: { organizationId: string; customerId: string }): Promise<CustomerTerms | null> {
    return this.reads.customerTerms.find(input.organizationId, input.customerId);
  }
}

/**
 * Fija las condiciones de crédito de un cliente.
 *
 * Los días de crédito NO reescriben las partidas ya abiertas: se leen al abrir cada factura (ver
 * `HandleInvoiceIssuedUseCase`). Si se reescribieran, la antigüedad de la cartera mentiría hacia atrás.
 *
 * El evento lleva el valor ANTIGUO y el NUEVO: sin los dos, la bitácora no dice qué se cambió.
 */
export class SetCustomerTermsUseCase {
  constructor(
    private readonly gateway: UnitOfWorkGateway,
    private readonly clock: Clock,
  ) {}

  async execute(input: {
    organizationId: string;
    customerId: string;
    customerName?: string | null;
    creditDays: number;
    creditLimitCents: number | null;
    userId: string;
  }): Promise<CustomerTerms> {
    if (!Number.isInteger(input.creditDays) || input.creditDays < 0 || input.creditDays > 365) {
      throw new ValidationError([{ field: 'creditDays', message: 'Los días de crédito van de 0 a 365.' }]);
    }
    if (input.creditLimitCents !== null && (!Number.isInteger(input.creditLimitCents) || input.creditLimitCents < 0)) {
      throw new ValidationError([{ field: 'creditLimitCents', message: 'El cupo no puede ser negativo.' }]);
    }

    return inTransaction(this.gateway, async (uow) => {
      const previous = await uow.customerTerms.find(input.organizationId, input.customerId);
      const terms: CustomerTerms = {
        organizationId: input.organizationId,
        customerId: input.customerId,
        customerName: input.customerName ?? previous?.customerName ?? '',
        creditDays: input.creditDays,
        creditLimitCents: input.creditLimitCents,
        updatedBy: input.userId,
        updatedAt: this.clock(),
      };
      await uow.customerTerms.save(terms);
      await uow.outbox.add(
        customerTermsUpdatedEvent(terms, {
          creditDays: previous?.creditDays ?? 0,
          creditLimitCents: previous?.creditLimitCents ?? null,
        }),
      );
      return terms;
    });
  }
}
