import { EventHandler, InboxConsumer } from '@facturero/outbox-relay';
import type { Sequelize } from 'sequelize';
import {
  HandleInvoiceIssuedUseCase,
  HandleInvoiceVoidedUseCase,
  type InvoiceIssuedPayload,
  type InvoiceVoidedPayload,
} from '../../application/use-cases/receivable-use-cases.js';
import type { AccountingCatalogPort, UnitOfWorkGateway } from '../../application/ports.js';

/**
 * Eventos que consume treasury-service (ver asyncapi.yaml).
 *
 * Solo los de facturación: la cartera se alimenta de las facturas emitidas y anuladas. Tesorería NO se suscribe a
 * `plugin.activated|deactivated` a propósito: al desactivar el módulo el gateway ya oculta la pantalla, y si
 * tesorería dejara de consumir, al reactivarlo quedaría desfasada de contabilidad (que sí guarda los eventos y
 * reintenta). Los datos se conservan; lo que se apaga es la vía de entrada.
 */
export const CONSUMED_BINDINGS = [
  'billing.invoice.issued',
  'billing.invoice.voided',
] as const;

export interface ConsumerDeps {
  uowGateway: UnitOfWorkGateway;
  accounting: AccountingCatalogPort;
  systemUserId: string;
}

export function buildEventHandlers(deps: ConsumerDeps): EventHandler[] {
  const clock = () => new Date();
  const invoiceIssued = new HandleInvoiceIssuedUseCase(deps.uowGateway, deps.accounting, clock);
  const invoiceVoided = new HandleInvoiceVoidedUseCase(deps.uowGateway, deps.accounting, clock);

  return [
    {
      eventType: 'billing.invoice.issued',
      handle: async (payload: unknown): Promise<void> => {
        const result = await invoiceIssued.execute(payload as InvoiceIssuedPayload);
        if (result.outcome === 'skipped') {
          console.info(`[treasury-service] comprobante sin partida de cartera: ${result.reason}`);
        }
      },
    },
    {
      eventType: 'billing.invoice.voided',
      handle: async (payload: unknown): Promise<void> => {
        const result = await invoiceVoided.execute(payload as InvoiceVoidedPayload);
        if (result.outcome === 'skipped') {
          console.info(`[treasury-service] anulación sin partida de cartera: ${result.reason}`);
        }
      },
    },
  ];
}

export async function startEventConsumers(params: {
  sequelize: Sequelize;
  rabbitmqUrl: string;
  exchange: string;
  queue: string;
  handlers: EventHandler[];
}): Promise<void> {
  const consumer = new InboxConsumer({
    sequelize: params.sequelize,
    rabbitmqUrl: params.rabbitmqUrl,
    exchange: params.exchange,
    queue: params.queue,
    // La cola debe estar bindeada a los eventos que este servicio consume (ver asyncapi.yaml).
    bindings: [...CONSUMED_BINDINGS],
    handlers: params.handlers,
  });
  await consumer.start();
  console.log('[treasury-service] event consumers started');
}
