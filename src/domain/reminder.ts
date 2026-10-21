import { daysBetween } from './dates.js';
import { balanceOf, type Receivable } from './receivable.js';

/**
 * Configuración de los recordatorios de cobro de una organización.
 *
 * `enabled` es FALSE hasta que el Administrador lo enciende: un recordatorio le llega al CLIENTE de la organización (comunicación
 * externa) y no se manda sin esa decisión. Sin fila guardada rige `defaultReminderSettings` (apagado).
 */
export interface ReminderSettings {
  organizationId: string;
  enabled: boolean;
  /** Días de atraso desde los que se avisa por primera vez. */
  firstAfterDays: number;
  /** Cada cuántos días se repite el aviso de la misma partida. Mínimo 7: un recordatorio por partida y semana como máximo. */
  repeatEveryDays: number;
  /** Último día local en que corrió el proceso diario. */
  lastRunOn: string | null;
  updatedBy: string | null;
  updatedAt: Date | null;
}

export const MIN_REPEAT_DAYS = 7;
export const MAX_REPEAT_DAYS = 60;
export const MIN_FIRST_AFTER_DAYS = 1;
export const MAX_FIRST_AFTER_DAYS = 90;
/** Hora local de la organización desde la que el proceso diario puede enviar (no a medianoche). */
export const SEND_FROM_HOUR = 9;
/** Cuántas partidas se detallan en un correo: el resto se resume en el total. */
export const MAX_ITEMS_PER_REMINDER = 20;

export function defaultReminderSettings(organizationId: string): ReminderSettings {
  return { organizationId, enabled: false, firstAfterDays: 3, repeatEveryDays: MIN_REPEAT_DAYS, lastRunOn: null, updatedBy: null, updatedAt: null };
}

export interface ReminderItem {
  receivableId: string;
  documentNumber: string | null;
  dueDate: string;
  daysOverdue: number;
  balanceCents: number;
}

/** Lo que se le recordaría a UN cliente en una corrida: todas sus partidas que tocan hoy, en un solo mensaje. */
export interface CustomerReminderPlan {
  customerId: string;
  customerName: string;
  currencyCode: string;
  items: ReminderItem[];
  totalCents: number;
  /** Partidas que tocan hoy pero no caben en el detalle del correo. */
  extraItems: number;
  /** TODAS las partidas que cubre el aviso (no solo las detalladas): todas quedan registradas como avisadas. */
  receivableIds: string[];
}

/**
 * Qué partidas se recuerdan hoy y a quién.
 *
 * Una partida entra si tiene saldo, ya pasaron `firstAfterDays` días desde su vencimiento y no se le avisó en los últimos
 * `repeatEveryDays` días. Se agrupa por cliente: 31 facturas vencidas son UN correo con la lista, no 31 correos (eso es
 * acoso, no cobranza).
 *
 * Una partida de otra moneda que la del resto del cliente se avisa en su propio mensaje: sumar monedas distintas no tiene sentido.
 */
export function planReminders(
  receivables: readonly Receivable[],
  settings: Pick<ReminderSettings, 'firstAfterDays' | 'repeatEveryDays'>,
  asOf: string,
  lastRemindedOn: ReadonlyMap<string, string>,
): CustomerReminderPlan[] {
  const groups = new Map<string, { customerId: string; customerName: string; currencyCode: string; all: ReminderItem[] }>();
  for (const r of receivables) {
    if (r.customerId === '' || (r.status !== 'open' && r.status !== 'partial')) continue;
    const balance = balanceOf(r);
    if (balance <= 0) continue;
    const daysOverdue = daysBetween(r.dueDate, asOf);
    if (daysOverdue < settings.firstAfterDays) continue;
    const last = lastRemindedOn.get(r.id);
    if (last !== undefined && daysBetween(last, asOf) < settings.repeatEveryDays) continue;

    const key = `${r.customerId}|${r.currencyCode}`;
    let group = groups.get(key);
    if (!group) {
      group = { customerId: r.customerId, customerName: r.customerName, currencyCode: r.currencyCode, all: [] };
      groups.set(key, group);
    }
    group.all.push({ receivableId: r.id, documentNumber: r.documentNumber, dueDate: r.dueDate, daysOverdue, balanceCents: balance });
  }
  return [...groups.values()]
    .map((g): CustomerReminderPlan => {
      // Lo más atrasado primero: es lo que la persona tiene que leer.
      const sorted = [...g.all].sort((a, b) => b.daysOverdue - a.daysOverdue || a.receivableId.localeCompare(b.receivableId));
      return {
        customerId: g.customerId,
        customerName: g.customerName,
        currencyCode: g.currencyCode,
        items: sorted.slice(0, MAX_ITEMS_PER_REMINDER),
        extraItems: Math.max(0, sorted.length - MAX_ITEMS_PER_REMINDER),
        receivableIds: sorted.map((i) => i.receivableId),
        totalCents: sorted.reduce((acc, i) => acc + i.balanceCents, 0),
      };
    })
    .sort((a, b) => b.totalCents - a.totalCents || a.customerId.localeCompare(b.customerId));
}

/** Hora local (0-23) de un instante en una zona horaria. */
export function localHourOf(instant: Date, timeZone: string): number {
  const hour = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hourCycle: 'h23' }).format(instant);
  return Number(hour);
}
