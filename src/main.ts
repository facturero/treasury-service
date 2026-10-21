import './infrastructure/telemetry/otel.js';
import { serve } from '@hono/node-server';
import { OutboxRelay } from '@facturero/outbox-relay';
import { config } from './infrastructure/config.js';
import { sequelize } from './infrastructure/persistence/sequelize.js';
import './infrastructure/persistence/models.js';
import { readOnlyRepositories, SequelizeUnitOfWorkFactory } from './infrastructure/persistence/repositories.js';
import { HttpAccountingCatalog, HttpCustomerCatalog, HttpOrganizationCatalog } from './infrastructure/catalogs/http-catalogs.js';
import { buildEventHandlers, startEventConsumers } from './infrastructure/messaging/consumer.js';
import {
  GetAgingUseCase,
  GetCustomerStatementUseCase,
  GetReceivableDetailUseCase,
  GetReceivableUseCase,
  ListReceivablesUseCase,
} from './application/use-cases/list-use-cases.js';
import { GetCustomerTermsUseCase, SetCustomerTermsUseCase } from './application/use-cases/customer-use-cases.js';
import { ExportReportsUseCase } from './application/use-cases/export-use-cases.js';
import {
  GetReminderSettingsUseCase,
  PreviewRemindersUseCase,
  RunDueRemindersUseCase,
  RunRemindersUseCase,
  SetReminderSettingsUseCase,
} from './application/use-cases/reminder-use-cases.js';
import { LoadOpeningBalancesUseCase } from './application/use-cases/opening-balance-use-case.js';
import {
  CreateReceiptUseCase,
  GetReceiptUseCase,
  ListReceiptsUseCase,
  PostReceiptUseCase,
  UpdateReceiptUseCase,
  VoidReceiptUseCase,
} from './application/use-cases/receipt-use-cases.js';
import { createApp } from './interface/http/app.js';

async function main(): Promise<void> {
  // NO se llama a `sequelize.sync()`: la migración (initContainer treasury-migrate) es la fuente de verdad del esquema.
  await sequelize.authenticate();

  let relay: OutboxRelay | undefined;
  const uow = new SequelizeUnitOfWorkFactory((tx) => relay?.attachToTransaction(tx));
  const repos = readOnlyRepositories;
  const clock = () => new Date();
  const accounting = new HttpAccountingCatalog(config.ACCOUNTING_SERVICE_URL);
  const customers = new HttpCustomerCatalog(config.CUSTOMER_SERVICE_URL);
  const receiptDeps = { gateway: uow, accounting, customers, clock };
  const organizations = new HttpOrganizationCatalog(config.ORGANIZATION_SERVICE_URL);
  const reminderDeps = { gateway: uow, reads: repos, customers, organizations, clock, timezone: config.ORG_TIMEZONE };
  const getAging = new GetAgingUseCase(repos, clock, config.ORG_TIMEZONE);
  const getStatement = new GetCustomerStatementUseCase(repos, clock, config.ORG_TIMEZONE);
  const runReminders = new RunRemindersUseCase(reminderDeps);

  const app = createApp({
    useCases: {
      listReceivables: new ListReceivablesUseCase(repos, clock, config.ORG_TIMEZONE),
      getReceivable: new GetReceivableUseCase(repos),
      getReceivableDetail: new GetReceivableDetailUseCase(repos),
      getStatement,
      getAging,
      getCustomerTerms: new GetCustomerTermsUseCase(repos),
      setCustomerTerms: new SetCustomerTermsUseCase(uow, clock),
      loadOpeningBalances: new LoadOpeningBalancesUseCase(uow, accounting, customers, clock),
      listReceipts: new ListReceiptsUseCase(repos),
      getReceipt: new GetReceiptUseCase(repos),
      createReceipt: new CreateReceiptUseCase(receiptDeps),
      updateReceipt: new UpdateReceiptUseCase(receiptDeps),
      postReceipt: new PostReceiptUseCase(receiptDeps),
      voidReceipt: new VoidReceiptUseCase(receiptDeps),
      exportReports: new ExportReportsUseCase(uow, repos, getAging, getStatement, clock, config.ORG_TIMEZONE),
      getReminderSettings: new GetReminderSettingsUseCase(repos),
      setReminderSettings: new SetReminderSettingsUseCase(uow, clock),
      previewReminders: new PreviewRemindersUseCase(reminderDeps),
      runReminders,
    },
    corsOrigin: config.CORS_ORIGIN,
  });

  serve({ fetch: app.fetch, port: config.PORT });
  console.log(`[treasury-service] corriendo en puerto ${config.PORT}`);

  if (config.RABBITMQ_URL) {
    relay = new OutboxRelay({ sequelize, rabbitmqUrl: config.RABBITMQ_URL, exchange: 'crm.events' });
    await relay.start();
    console.log('[treasury-service] outbox relay activo');

    await startEventConsumers({
      sequelize,
      rabbitmqUrl: config.RABBITMQ_URL,
      exchange: 'crm.events',
      queue: 'treasury-service.events',
      handlers: buildEventHandlers({ uowGateway: uow, accounting, systemUserId: 'system' }),
    });

    // El proceso diario de recordatorios necesita el relay (publica el evento que convierte en correo). Se mira cada pocos minutos:
    // que se llame de más no cuesta nada porque `lastRunOn` y el UNIQUE por (partida, día) lo absorben.
    if (config.REMINDER_CHECK_MINUTES > 0) {
      const due = new RunDueRemindersUseCase(repos, runReminders, clock, config.ORG_TIMEZONE);
      let running = false;
      const tick = async () => {
        if (running) return;
        running = true;
        try {
          await due.execute();
        } catch (err) {
          console.error('[treasury-service] el proceso de recordatorios falló:', err);
        } finally {
          running = false;
        }
      };
      setInterval(() => void tick(), config.REMINDER_CHECK_MINUTES * 60_000).unref();
      void tick();
    }
  } else {
    console.warn('[treasury-service] RABBITMQ_URL no configurado: los eventos NO se publican ni consumen (tampoco corren los recordatorios)');
  }
}

main().catch((err) => {
  console.error('[treasury-service] error al iniciar:', err);
  process.exit(1);
});
