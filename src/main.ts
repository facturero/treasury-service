import './infrastructure/telemetry/otel.js';
import { serve } from '@hono/node-server';
import { OutboxRelay } from '@facturero/outbox-relay';
import { config } from './infrastructure/config.js';
import { sequelize } from './infrastructure/persistence/sequelize.js';
import './infrastructure/persistence/models.js';
import { readOnlyRepositories, SequelizeUnitOfWorkFactory } from './infrastructure/persistence/repositories.js';
import { HttpAccountingCatalog, HttpCustomerCatalog, HttpOrganizationCatalog, HttpSupplierCatalog } from './infrastructure/catalogs/http-catalogs.js';
import { buildEventHandlers, startEventConsumers } from './infrastructure/messaging/consumer.js';
import {
  GetAgingUseCase,
  GetCustomerStatementUseCase,
  GetReceivableDetailUseCase,
  GetReceivableUseCase,
  ListReceivablesUseCase,
} from './application/use-cases/list-use-cases.js';
import { GetCustomerTermsUseCase, SetCustomerTermsUseCase } from './application/use-cases/customer-use-cases.js';
import {
  GetPayableDetailUseCase,
  GetPayablesAgingUseCase,
  GetSupplierStatementUseCase,
  ListPayablesUseCase,
  LoadPayableOpeningBalancesUseCase,
} from './application/use-cases/payable-list-use-cases.js';
import {
  ApprovePaymentUseCase,
  CreatePaymentUseCase,
  GetPaymentSettingsUseCase,
  GetPaymentUseCase,
  ListPaymentsUseCase,
  PostPaymentUseCase,
  SetPaymentSettingsUseCase,
  UpdatePaymentUseCase,
  VoidPaymentUseCase,
} from './application/use-cases/payment-use-cases.js';
import { ExportReportsUseCase } from './application/use-cases/export-use-cases.js';
import {
  AssignMovementAccountUseCase,
  CreateBankAccountUseCase,
  GetBankAccountUseCase,
  ImportStatementUseCase,
  ListBankAccountsUseCase,
  ListBankLinesUseCase,
  ListBankMovementsUseCase,
  PreviewStatementUseCase,
  UpdateBankAccountUseCase,
} from './application/use-cases/bank-account-use-cases.js';
import {
  CloseReconciliationUseCase,
  GetCashFlowUseCase,
  ListReconciliationsUseCase,
  MarkLineExternalUseCase,
  MatchLineUseCase,
  MatchManyUseCase,
  PostBankAdjustmentUseCase,
  PreviewReconciliationUseCase,
  ReopenReconciliationUseCase,
  SuggestMatchesUseCase,
  UnmarkLineExternalUseCase,
  UnmatchLineUseCase,
  VoidBankAdjustmentUseCase,
} from './application/use-cases/bank-reconcile-use-cases.js';
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
  const suppliers = new HttpSupplierCatalog(config.PURCHASING_SERVICE_URL);
  const paymentDeps = { gateway: uow, accounting, suppliers, clock };
  const getPayablesAging = new GetPayablesAgingUseCase(repos, clock, config.ORG_TIMEZONE);
  const getSupplierStatement = new GetSupplierStatementUseCase(repos, clock, config.ORG_TIMEZONE);
  const bankDeps = { gateway: uow, accounting, clock };
  const getCashFlow = new GetCashFlowUseCase(repos, clock, config.ORG_TIMEZONE);
  const matchLine = new MatchLineUseCase(bankDeps);

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
      exportReports: new ExportReportsUseCase(uow, repos, getAging, getStatement, clock, config.ORG_TIMEZONE, getPayablesAging, getSupplierStatement, getCashFlow),
      getReminderSettings: new GetReminderSettingsUseCase(repos),
      setReminderSettings: new SetReminderSettingsUseCase(uow, clock),
      previewReminders: new PreviewRemindersUseCase(reminderDeps),
      runReminders,
      listPayables: new ListPayablesUseCase(repos, clock, config.ORG_TIMEZONE),
      getPayableDetail: new GetPayableDetailUseCase(repos),
      getPayablesAging,
      getSupplierStatement,
      loadPayableOpeningBalances: new LoadPayableOpeningBalancesUseCase(uow, accounting, suppliers, clock),
      listPayments: new ListPaymentsUseCase(repos),
      getPayment: new GetPaymentUseCase(repos),
      createPayment: new CreatePaymentUseCase(paymentDeps),
      updatePayment: new UpdatePaymentUseCase(paymentDeps),
      approvePayment: new ApprovePaymentUseCase(paymentDeps),
      postPayment: new PostPaymentUseCase(paymentDeps),
      voidPayment: new VoidPaymentUseCase(paymentDeps),
      getPaymentSettings: new GetPaymentSettingsUseCase(repos),
      setPaymentSettings: new SetPaymentSettingsUseCase(uow, clock),
      listBankAccounts: new ListBankAccountsUseCase(repos),
      getBankAccount: new GetBankAccountUseCase(repos),
      createBankAccount: new CreateBankAccountUseCase(bankDeps),
      updateBankAccount: new UpdateBankAccountUseCase(bankDeps),
      previewStatement: new PreviewStatementUseCase(repos),
      importStatement: new ImportStatementUseCase(bankDeps),
      listBankLines: new ListBankLinesUseCase(repos),
      listBankMovements: new ListBankMovementsUseCase(repos),
      assignMovementAccount: new AssignMovementAccountUseCase(bankDeps),
      suggestMatches: new SuggestMatchesUseCase(repos),
      matchLine,
      matchMany: new MatchManyUseCase(matchLine),
      unmatchLine: new UnmatchLineUseCase(bankDeps),
      markLineExternal: new MarkLineExternalUseCase(bankDeps),
      unmarkLineExternal: new UnmarkLineExternalUseCase(bankDeps),
      postBankAdjustment: new PostBankAdjustmentUseCase(bankDeps),
      voidBankAdjustment: new VoidBankAdjustmentUseCase(bankDeps),
      previewReconciliation: new PreviewReconciliationUseCase(repos),
      closeReconciliation: new CloseReconciliationUseCase(bankDeps),
      reopenReconciliation: new ReopenReconciliationUseCase(bankDeps),
      listReconciliations: new ListReconciliationsUseCase(repos),
      getCashFlow,
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
