import { randomUUID } from 'node:crypto';
import { addDays } from '../../domain/dates.js';
import { OpeningBalanceAlreadyLoadedError, ValidationError } from '../../domain/errors.js';
import type { OpeningBalanceLoad, Receivable } from '../../domain/receivable.js';
import { openingBalanceLoadedEvent, receivableOpenedEvent } from '../events.js';
import type { AccountingCatalogPort, Clock, CustomerCatalogPort, CustomerInfo, UnitOfWorkGateway } from '../ports.js';
import { inTransaction, isUniqueViolation } from './transaction.js';

export interface OpeningBalanceLineInput {
  customerId: string;
  customerName?: string | null;
  documentNumber?: string | null;
  issueDate: string;
  /** Si no viene, el servidor lo calcula con los días de crédito del cliente. */
  dueDate?: string | null;
  amountCents: number;
}

/**
 * Carga de saldos iniciales de cartera.
 *
 * La cartera nace VACÍA: las facturas ya emitidas no se recuperan solas. Esta es la única vía honesta para
 * empezar con lo que el cliente ya debía, y por eso es una operación de Administrador (`opening_balance:load`).
 *
 * Reglas:
 * - **una sola carga por fecha de corte**: repetirla duplicaría la cartera (`UNIQUE (organization_id, cutoff_date)`).
 * - **todo o nada**: las partidas y la cabecera se escriben en la misma transacción.
 * - cada partida es `initial_balance` y su `source_id` es `${loadId}:${indice}`: así el origen de cada línea se
 *   puede reconstruir y no colisiona con el id de un comprobante.
 */
export class LoadOpeningBalancesUseCase {
  constructor(
    private readonly gateway: UnitOfWorkGateway,
    private readonly accounting: AccountingCatalogPort,
    private readonly customers: CustomerCatalogPort,
    private readonly clock: Clock,
  ) {}

  async execute(input: {
    organizationId: string;
    cutoffDate: string;
    reason: string;
    lines: OpeningBalanceLineInput[];
    userId: string;
  }): Promise<OpeningBalanceLoad> {
    if (!input.cutoffDate) {
      throw new ValidationError([{ field: 'cutoffDate', message: 'La fecha de corte es obligatoria.' }]);
    }
    if (!input.reason || input.reason.trim().length < 3) {
      throw new ValidationError([{ field: 'reason', message: 'El motivo es obligatorio.' }]);
    }
    if (!input.lines.length) {
      throw new ValidationError([{ field: 'lines', message: 'La carga necesita al menos una línea.' }]);
    }
    for (const [index, line] of input.lines.entries()) {
      if (!line.customerId) {
        throw new ValidationError([{ field: `lines[${index}].customerId`, message: 'El cliente es obligatorio.' }]);
      }
      if (!Number.isInteger(line.amountCents) || line.amountCents <= 0) {
        throw new ValidationError([{ field: `lines[${index}].amountCents`, message: 'El importe debe ser mayor que cero.' }]);
      }
      if (line.dueDate && line.dueDate < line.issueDate) {
        throw new ValidationError([{ field: `lines[${index}].dueDate`, message: 'El vencimiento no puede ser anterior a la emisión.' }]);
      }
    }

    // La moneda la dice la contabilidad de la organización: sin ella el saldo inicial quedaría en una moneda
    // inventada y la prueba de oro (cartera == libro mayor) no cuadraría nunca.
    const settings = await this.accounting.getSettings(input.organizationId);
    if (!settings) {
      throw new ValidationError([
        { field: 'currencyCode', message: 'La organización no tiene contabilidad configurada: no se sabe la moneda de los saldos iniciales.' },
      ]);
    }
    const currencyCode = settings.baseCurrency;

    // Los clientes se consultan FUERA de la transacción (es una llamada HTTP). Cada uno una sola vez, aunque tenga varias
    // líneas. Un cliente que no existe en ESTA organización es un 422 con el índice de la línea; un servicio caído es 502,
    // nunca «no existe»: el nombre y la identificación que se guardan son los del catálogo, no los que mande el cliente.
    const found = new Map<string, CustomerInfo | null>();
    for (const line of input.lines) {
      if (!found.has(line.customerId)) found.set(line.customerId, await this.customers.findById(input.organizationId, line.customerId));
    }
    const missing = input.lines.flatMap((line, index) =>
      found.get(line.customerId) ? [] : [{ field: `lines[${index}].customerId`, message: 'El cliente no existe en esta organización.' }],
    );
    if (missing.length) throw new ValidationError(missing);

    const now = this.clock();
    const loadId = randomUUID();
    const totalCents = input.lines.reduce((acc, line) => acc + line.amountCents, 0);

    return inTransaction(
      this.gateway,
      async (uow): Promise<OpeningBalanceLoad> => {
        const existing = await uow.openingBalanceLoads.findByCutoff(input.organizationId, input.cutoffDate);
        if (existing) {
          throw new OpeningBalanceAlreadyLoadedError(input.cutoffDate);
        }

        const load: OpeningBalanceLoad = {
          id: loadId,
          organizationId: input.organizationId,
          cutoffDate: input.cutoffDate,
          loadedBy: input.userId,
          reason: input.reason.trim(),
          totalCents,
          createdAt: now,
        };

        for (const [index, line] of input.lines.entries()) {
          const customer = found.get(line.customerId)!;
          const terms = await uow.customerTerms.find(input.organizationId, line.customerId);
          const dueDate = line.dueDate ?? addDays(line.issueDate, terms?.creditDays ?? 0);
          const receivable: Receivable = {
            id: randomUUID(),
            organizationId: input.organizationId,
            customerId: line.customerId,
            customerName: customer.businessName,
            customerIdentification: customer.identification,
            sourceType: 'initial_balance',
            sourceId: `${loadId}:${index}`,
            documentNumber: line.documentNumber ?? null,
            issueDate: line.issueDate,
            dueDate,
            currencyCode,
            originalCents: line.amountCents,
            status: 'open',
            version: 1,
            createdAt: now,
            updatedAt: now,
            appliedCents: 0,
          };
          await uow.receivables.save(receivable);
          // Cada partida abierta también avisa: la bitácora tiene que poder mostrar qué entró en la cartera.
          await uow.outbox.add(receivableOpenedEvent(receivable));
        }

        try {
          await uow.openingBalanceLoads.save(load);
        } catch (err) {
          // Dos cargas simultáneas de la misma fecha de corte: la segunda se rinde (la clave única lo dice).
          if (isUniqueViolation(err)) throw new OpeningBalanceAlreadyLoadedError(input.cutoffDate);
          throw err;
        }

        // Un solo evento con el total de la carga: es lo que se lee en la bitácora («se cargaron X de saldo inicial»).
        await uow.outbox.add(openingBalanceLoadedEvent(load, input.lines.length));
        return load;
      },
      { readCommitted: true },
    );
  }
}
