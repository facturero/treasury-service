import { EventHandler, InboxConsumer } from '@facturero/outbox-relay';
import type { Sequelize } from 'sequelize';
import {
  HandleInvoiceIssuedUseCase,
  HandleInvoiceVoidedUseCase,
  type InvoiceIssuedPayload,
  type InvoiceVoidedPayload,
} from '../../application/use-cases/receivable-use-cases.js';
import {
  HandleBillPostedUseCase,
  HandleBillVoidedUseCase,
  HandleWithholdingIssuedUseCase,
  type BillPostedPayload,
  type WithholdingIssuedPayload,
} from '../../application/use-cases/payable-event-use-cases.js';
import type { AccountingCatalogPort, UnitOfWorkGateway } from '../../application/ports.js';

/**
 * Eventos que consume treasury-service (ver asyncapi.yaml).
 *
 * Facturación (`billing.invoice.*`): la cartera se alimenta de las facturas emitidas y anuladas. Compras (`purchasing.bill.posted|voided`) y
 * fiscal (`fiscal.ec.withholding.issued`): las cuentas por pagar se alimentan de las facturas de compra contabilizadas y anuladas, y la retención
 * que cita una de ellas reduce su deuda. Tesorería NO se suscribe a
 * `plugin.activated|deactivated` a propósito: al desactivar el módulo el gateway ya oculta la pantalla, y si
 * tesorería dejara de consumir, al reactivarlo quedaría desfasada de contabilidad (que sí guarda los eventos y
 * reintenta). Los datos se conservan; lo que se apaga es la vía de entrada.
 */
export const CONSUMED_BINDINGS = [
  'billing.invoice.issued',
  'billing.invoice.voided',
  'purchasing.bill.posted',
  'purchasing.bill.voided',
  'fiscal.ec.withholding.issued',
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
  const billPosted = new HandleBillPostedUseCase(deps.uowGateway, deps.accounting, clock);
  const billVoided = new HandleBillVoidedUseCase(deps.uowGateway, clock);
  const withholdingIssued = new HandleWithholdingIssuedUseCase(deps.uowGateway, clock);

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
    {
      eventType: 'purchasing.bill.posted',
      handle: async (payload: unknown): Promise<void> => {
        const result = await billPosted.execute(payload as BillPostedPayload);
        if (result.outcome === 'skipped') console.info(`[treasury-service] factura de compra sin deuda por pagar: ${result.reason}`);
      },
    },
    {
      eventType: 'purchasing.bill.voided',
      handle: async (payload: unknown): Promise<void> => {
        const result = await billVoided.execute(payload as BillPostedPayload);
        if (result.outcome === 'skipped') console.info(`[treasury-service] anulación de factura de compra: ${result.reason}`);
      },
    },
    {
      eventType: 'fiscal.ec.withholding.issued',
      handle: async (payload: unknown): Promise<void> => {
        // Nunca lanza por «no hay deuda»: casi todas las retenciones son de compras que no pasaron por este módulo.
        const result = await withholdingIssued.execute(payload as WithholdingIssuedPayload);
        if (result.outcome === 'ignored' || result.outcome === 'pending') console.info(`[treasury-service] retención sin aplicar: ${result.reason}`);
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
