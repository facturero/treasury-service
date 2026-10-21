import { localDateOf } from '../../domain/dates.js';
import { CatalogUnavailableError, RemindersDisabledError, ValidationError, type ErrorDetail } from '../../domain/errors.js';
import type { UnitOfWork } from '../../domain/repositories.js';
import {
  defaultReminderSettings,
  localHourOf,
  MAX_FIRST_AFTER_DAYS,
  MAX_REPEAT_DAYS,
  MIN_FIRST_AFTER_DAYS,
  MIN_REPEAT_DAYS,
  planReminders,
  SEND_FROM_HOUR,
  type CustomerReminderPlan,
  type ReminderSettings,
} from '../../domain/reminder.js';
import { receivableOverdueEvent, reminderSettingsUpdatedEvent } from '../events.js';
import type { Clock, CustomerCatalogPort, OrganizationCatalogPort, UnitOfWorkGateway } from '../ports.js';
import { inTransaction, isUniqueViolation } from './transaction.js';

/** Firma del correo cuando la organización todavía no completó su perfil. */
const FALLBACK_ORGANIZATION_NAME = 'Su proveedor';

/** Lee la configuración de recordatorios. Sin fila guardada rige el valor por defecto: APAGADO. */
export class GetReminderSettingsUseCase {
  constructor(private readonly reads: UnitOfWork) {}

  async execute(input: { organizationId: string }): Promise<ReminderSettings> {
    return (await this.reads.reminderSettings.find(input.organizationId)) ?? defaultReminderSettings(input.organizationId);
  }
}

/**
 * Enciende, apaga o ajusta los recordatorios. Es el único punto donde se decide que a los clientes de la organización les llegue un
 * correo de cobro: por eso el permiso es aparte (`reminder:manage`, solo Administrador) y el cambio queda en la bitácora con el valor
 * anterior y el nuevo.
 */
export class SetReminderSettingsUseCase {
  constructor(
    private readonly gateway: UnitOfWorkGateway,
    private readonly clock: Clock,
  ) {}

  async execute(input: {
    organizationId: string;
    enabled: boolean;
    firstAfterDays: number;
    repeatEveryDays: number;
    userId: string;
  }): Promise<ReminderSettings> {
    const errors: ErrorDetail[] = [];
    if (!Number.isInteger(input.firstAfterDays) || input.firstAfterDays < MIN_FIRST_AFTER_DAYS || input.firstAfterDays > MAX_FIRST_AFTER_DAYS) {
      errors.push({ field: 'firstAfterDays', message: `Los días de atraso van de ${MIN_FIRST_AFTER_DAYS} a ${MAX_FIRST_AFTER_DAYS}.` });
    }
    if (!Number.isInteger(input.repeatEveryDays) || input.repeatEveryDays < MIN_REPEAT_DAYS || input.repeatEveryDays > MAX_REPEAT_DAYS) {
      errors.push({ field: 'repeatEveryDays', message: `El aviso se repite cada ${MIN_REPEAT_DAYS} a ${MAX_REPEAT_DAYS} días (un recordatorio por semana como máximo).` });
    }
    if (errors.length > 0) throw new ValidationError(errors);

    return inTransaction(this.gateway, async (uow) => {
      const previous = (await uow.reminderSettings.find(input.organizationId)) ?? defaultReminderSettings(input.organizationId);
      const next: ReminderSettings = {
        ...previous,
        enabled: input.enabled,
        firstAfterDays: input.firstAfterDays,
        repeatEveryDays: input.repeatEveryDays,
        // Encender de nuevo después de un tiempo no hereda «hoy ya corrí»: el proceso del día debe poder salir.
        lastRunOn: input.enabled && !previous.enabled ? null : previous.lastRunOn,
        updatedBy: input.userId,
        updatedAt: this.clock(),
      };
      await uow.reminderSettings.save(next);
      await uow.outbox.add(reminderSettingsUpdatedEvent(next, previous));
      return next;
    });
  }
}

export interface ReminderPreviewCustomer {
  plan: CustomerReminderPlan;
  /** `null` = el cliente no tiene correo (o ya no existe): no recibiría nada. */
  email: string | null;
}

export interface ReminderPreview {
  asOf: string;
  enabled: boolean;
  customers: ReminderPreviewCustomer[];
  receivableCount: number;
  withoutEmailCount: number;
}

export interface ReminderDependencies {
  gateway: UnitOfWorkGateway;
  reads: UnitOfWork;
  customers: CustomerCatalogPort;
  organizations: OrganizationCatalogPort;
  clock: Clock;
  /** Huso con el que se decide «hoy» (el mismo de la antigüedad de cartera). */
  timezone: string;
}

/** Qué partidas tocan hoy según la configuración y lo ya avisado. */
async function planFor(deps: ReminderDependencies, settings: ReminderSettings, asOf: string): Promise<CustomerReminderPlan[]> {
  const receivables = await deps.reads.receivables.listBalances(settings.organizationId);
  const last = await deps.reads.reminders.lastRemindedOn(settings.organizationId, receivables.map((r) => r.id));
  return planReminders(receivables, settings, asOf, last);
}

/**
 * «¿A quién le avisaría hoy?» SIN enviar nada. Sirve para decidir antes de encender los recordatorios y para ver, con los recordatorios
 * ya encendidos, quién se quedaría sin aviso por no tener correo. Funciona aunque estén apagados.
 */
export class PreviewRemindersUseCase {
  constructor(private readonly deps: ReminderDependencies) {}

  async execute(input: { organizationId: string }): Promise<ReminderPreview> {
    const settings = (await this.deps.reads.reminderSettings.find(input.organizationId)) ?? defaultReminderSettings(input.organizationId);
    const asOf = localDateOf(this.deps.clock(), this.deps.timezone);
    const plans = await planFor(this.deps, settings, asOf);
    const customers: ReminderPreviewCustomer[] = [];
    for (const plan of plans) {
      const info = await this.deps.customers.findById(input.organizationId, plan.customerId);
      customers.push({ plan, email: info?.email ?? null });
    }
    return {
      asOf,
      enabled: settings.enabled,
      customers,
      receivableCount: plans.reduce((acc, p) => acc + p.receivableIds.length, 0),
      withoutEmailCount: customers.filter((c) => c.email === null).length,
    };
  }
}

export interface ReminderRunResult {
  runDate: string;
  customersReminded: number;
  receivablesReminded: number;
  customersWithoutEmail: number;
  /** Clientes que otra corrida (otra réplica, «enviar ahora») ya avisó ese mismo día. */
  customersAlreadyReminded: number;
}

/**
 * Corre los recordatorios de UNA organización: un evento `treasury.receivable.overdue` por cliente con todas sus partidas que tocan hoy.
 *
 * Idempotente por (partida, día): el registro de lo avisado y el evento se escriben en la MISMA transacción y el UNIQUE
 * (partida, día) hace que una segunda corrida del mismo día no avise otra vez. Las llamadas HTTP (correo del cliente, nombre de la
 * organización) van FUERA de la transacción.
 *
 * Se niega si los recordatorios están apagados, también cuando lo pide una persona: nunca sale un correo al cliente sin que el
 * Administrador lo haya encendido.
 */
export class RunRemindersUseCase {
  constructor(private readonly deps: ReminderDependencies) {}

  async execute(input: { organizationId: string; trigger: 'scheduled' | 'manual'; userId: string | null }): Promise<ReminderRunResult> {
    const { deps } = this;
    const settings = await deps.reads.reminderSettings.find(input.organizationId);
    if (!settings?.enabled) throw new RemindersDisabledError();

    const runDate = localDateOf(deps.clock(), deps.timezone);
    const plans = await planFor(deps, settings, runDate);
    const result: ReminderRunResult = { runDate, customersReminded: 0, receivablesReminded: 0, customersWithoutEmail: 0, customersAlreadyReminded: 0 };

    if (plans.length > 0) {
      const organizationName = (await deps.organizations.getDisplayName(input.organizationId)) ?? FALLBACK_ORGANIZATION_NAME;
      for (const plan of plans) {
        // Un catálogo caído detiene la corrida (se reintenta en la próxima vuelta): lo ya avisado queda protegido por el UNIQUE.
        const customer = await deps.customers.findById(input.organizationId, plan.customerId);
        if (!customer?.email) {
          result.customersWithoutEmail += 1;
          continue;
        }
        const email = customer.email;
        try {
          await inTransaction(deps.gateway, async (uow) => {
            const at = deps.clock();
            for (const receivableId of plan.receivableIds) {
              await uow.reminders.add({
                organizationId: input.organizationId,
                receivableId,
                customerId: plan.customerId,
                reminderDate: runDate,
                trigger: input.trigger,
                sentBy: input.userId,
                at,
              });
            }
            await uow.outbox.add(
              receivableOverdueEvent({
                organizationId: input.organizationId,
                organizationName,
                plan,
                email,
                runDate,
                trigger: input.trigger,
                triggeredBy: input.userId,
              }),
            );
          });
          result.customersReminded += 1;
          result.receivablesReminded += plan.receivableIds.length;
        } catch (err) {
          if (!isUniqueViolation(err)) throw err;
          result.customersAlreadyReminded += 1;
        }
      }
    }

    await inTransaction(deps.gateway, async (uow) => {
      const current = (await uow.reminderSettings.find(input.organizationId)) ?? settings;
      // No pisa lo que otra persona haya cambiado mientras corría: solo anota el día.
      await uow.reminderSettings.save({ ...current, lastRunOn: runDate });
    });
    return result;
  }
}

/**
 * El proceso diario: para cada organización con los recordatorios encendidos, si ya es hora local de enviar y hoy todavía no corrió,
 * la corre. Se invoca cada pocos minutos; que se llame de más no cuesta nada porque `lastRunOn` y el UNIQUE por (partida, día) lo
 * absorben.
 */
export class RunDueRemindersUseCase {
  constructor(
    private readonly reads: UnitOfWork,
    private readonly run: RunRemindersUseCase,
    private readonly clock: Clock,
    private readonly timezone: string,
    private readonly log: (message: string) => void = (m) => console.log(m),
  ) {}

  /** Devuelve cuántas organizaciones corrieron. Un fallo en una no detiene a las demás. */
  async execute(): Promise<number> {
    const now = this.clock();
    if (localHourOf(now, this.timezone) < SEND_FROM_HOUR) return 0;
    const today = localDateOf(now, this.timezone);
    let ran = 0;
    for (const settings of await this.reads.reminderSettings.listEnabled()) {
      if (settings.lastRunOn === today) continue;
      try {
        const r = await this.run.execute({ organizationId: settings.organizationId, trigger: 'scheduled', userId: null });
        ran += 1;
        this.log(`[treasury-service] recordatorios ${settings.organizationId}: ${r.customersReminded} cliente(s), ${r.receivablesReminded} partida(s)`);
      } catch (err) {
        const reason = err instanceof CatalogUnavailableError ? 'un catálogo no responde' : (err as Error).message;
        this.log(`[treasury-service] recordatorios ${settings.organizationId} no corrieron (${reason}); se reintenta`);
      }
    }
    return ran;
  }
}
