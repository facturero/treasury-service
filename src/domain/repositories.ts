import type { Receipt, ReceiptAdvanceUse, ReceiptStatus } from './receipt.js';
import type { ReminderSettings } from './reminder.js';
import type {
  CreditApplication,
  CustomerAdvance,
  CustomerAdvanceApplication,
  CustomerTerms,
  OpeningBalanceLoad,
  Receivable,
  ReceivableSourceType,
  ReceivableStatus,
} from './receivable.js';

export interface DomainEvent {
  eventId: string;
  aggregateType: string;
  aggregateId: string;
  type: string;
  payload: Record<string, unknown>;
  occurredAt: Date;
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ReceivableFilters {
  customerId?: string;
  status?: ReceivableStatus[];
  /** Solo las partidas ya vencidas (`due_date` anterior a la fecha de corte). */
  overdueOnly?: boolean;
  /** Fecha de corte para el filtro de vencidas (`AAAA-MM-DD`). */
  asOf?: string;
  /** Rango de fecha de emisión. */
  from?: string;
  to?: string;
  /** Busca en el número de documento y en el nombre del cliente. */
  q?: string;
  page: number;
  pageSize: number;
}

export interface ReceivableRepository {
  /** Con `lock`, bloquea la fila hasta el final de la transacción (aplicar notas de crédito, anular). */
  findById(organizationId: string, id: string, options?: { lock?: boolean }): Promise<Receivable | null>;
  /**
   * Busca por el documento que la originó. `UNIQUE (organization_id, source_type, source_id)`: es la idempotencia
   * de la cartera (el mismo evento reintentado no abre dos partidas).
   */
  findBySource(organizationId: string, sourceType: ReceivableSourceType, sourceId: string): Promise<Receivable | null>;
  /** Listado paginado. `appliedCents` ya viene derivado: el repositorio lo calcula al leer. */
  list(organizationId: string, filters: ReceivableFilters): Promise<Page<Receivable>>;
  /**
   * Todas las partidas con saldo de la organización (antigüedad de cartera, estado de cuenta). Sin paginar: son
   * reportes, y una tabla a medias daría un total mentiroso.
   */
  listBalances(organizationId: string, options?: { customerId?: string }): Promise<Receivable[]>;
  /**
   * Inserta la partida (`expectedVersion` ausente) o la actualiza si nadie la cambió desde que se leyó
   * (`expectedVersion` presente). La comparación de versión es lo que impide que dos personas se pisen.
   */
  save(receivable: Receivable, expectedVersion?: number): Promise<void>;
  /** Suma aplicada por partida (cobros + notas de crédito). Es lo que convierte el importe original en saldo. */
  appliedCentsOf(organizationId: string, receivableIds: readonly string[]): Promise<Map<string, number>>;
}

export interface CreditApplicationRepository {
  /** Todas las aplicaciones de un conjunto de partidas (para derivar el saldo). */
  listByReceivable(organizationId: string, receivableIds: readonly string[]): Promise<CreditApplication[]>;
  /**
   * Una nota de crédito (o un cobro) no se aplica dos veces a la misma partida: lo garantiza
   * `UNIQUE (organization_id, receivable_id, source_type, source_id)`.
   */
  add(application: CreditApplication): Promise<void>;
  /**
   * Marca como anuladas las aplicaciones de un comprobante (un recibo anulado). NO las borra. Devuelve las que cambiaron, para que
   * quien anula sepa qué partidas recalcular.
   */
  reverseBySource(organizationId: string, sourceType: CreditApplication['sourceType'], sourceId: string, at: Date): Promise<CreditApplication[]>;
}

export interface CustomerAdvanceRepository {
  findById(organizationId: string, id: string, options?: { lock?: boolean }): Promise<CustomerAdvance | null>;
  findByOrigin(organizationId: string, origin: CustomerAdvance['origin'], originId: string): Promise<CustomerAdvance | null>;
  /** Saldos a favor del cliente, con lo consumido ya derivado. */
  listByCustomer(organizationId: string, customerId: string): Promise<CustomerAdvance[]>;
  /** Saldos a favor del cliente que todavía se pueden aplicar a una factura. */
  listApplicable(organizationId: string, customerId: string, invoiceId: string): Promise<CustomerAdvance[]>;
  save(advance: CustomerAdvance, expectedVersion?: number): Promise<void>;
  appliedCentsOf(organizationId: string, advanceIds: readonly string[]): Promise<Map<string, number>>;
}

export interface CustomerAdvanceApplicationRepository {
  listByAdvance(organizationId: string, advanceIds: readonly string[]): Promise<CustomerAdvanceApplication[]>;
  add(application: CustomerAdvanceApplication): Promise<void>;
}

export interface CustomerTermsRepository {
  find(organizationId: string, customerId: string): Promise<CustomerTerms | null>;
  save(terms: CustomerTerms): Promise<void>;
}

export interface OpeningBalanceLoadRepository {
  findByCutoff(organizationId: string, cutoffDate: string): Promise<OpeningBalanceLoad | null>;
  save(load: OpeningBalanceLoad): Promise<void>;
}

export interface ReceiptFilters {
  customerId?: string;
  status?: ReceiptStatus[];
  from?: string;
  to?: string;
  /** Busca en el número, la referencia y el nombre del cliente. */
  q?: string;
  page: number;
  pageSize: number;
}

export interface ReceiptRepository {
  /** Con `lock`, bloquea la fila del recibo hasta el final de la transacción (contabilizar, anular). Trae sus líneas y anticipos. */
  findById(organizationId: string, id: string, options?: { lock?: boolean }): Promise<Receipt | null>;
  list(organizationId: string, filters: ReceiptFilters): Promise<Page<Receipt>>;
  /** Inserta (`expectedVersion` ausente) o actualiza con control de versión. Reemplaza las líneas y los anticipos del borrador. */
  save(receipt: Receipt, expectedVersion?: number): Promise<void>;
  /** Siguiente número de la serie (organización, año). Bloquea la fila del contador: una sola persona a la vez. */
  nextSequence(organizationId: string, year: number): Promise<number>;
}

/** Lo que un recibo contabilizado consumió de anticipos anteriores. */
export interface ReceiptAdvanceUseRepository {
  add(organizationId: string, receiptId: string, use: ReceiptAdvanceUse, at: Date): Promise<void>;
  /** Marca como anulados (no borra) los consumos de un recibo. */
  reverseByReceipt(organizationId: string, receiptId: string, at: Date): Promise<void>;
}

export interface ReminderSettingsRepository {
  /** `null` = la organización nunca guardó la configuración (rige el valor por defecto: apagado). */
  find(organizationId: string): Promise<ReminderSettings | null>;
  /** Organizaciones con los recordatorios encendidos (las recorre el proceso diario). */
  listEnabled(): Promise<ReminderSettings[]>;
  save(settings: ReminderSettings): Promise<void>;
}

export interface ReminderRepository {
  /** Último día en que se avisó cada partida (solo las que se avisaron alguna vez). */
  lastRemindedOn(organizationId: string, receivableIds: readonly string[]): Promise<Map<string, string>>;
  /**
   * Registra que se avisó una partida un día. `UNIQUE (receivable_id, reminder_date)`: si ya estaba, LANZA la violación (el
   * proceso diario corrido dos veces el mismo día no avisa dos veces la misma partida).
   */
  add(entry: { organizationId: string; receivableId: string; customerId: string; reminderDate: string; trigger: 'scheduled' | 'manual'; sentBy: string | null; at: Date }): Promise<void>;
}

export interface OutboxRepository {
  add(event: DomainEvent): Promise<void>;
}

export interface UnitOfWork {
  receivables: ReceivableRepository;
  creditApplications: CreditApplicationRepository;
  advances: CustomerAdvanceRepository;
  advanceApplications: CustomerAdvanceApplicationRepository;
  customerTerms: CustomerTermsRepository;
  openingBalanceLoads: OpeningBalanceLoadRepository;
  receipts: ReceiptRepository;
  receiptAdvanceUses: ReceiptAdvanceUseRepository;
  reminderSettings: ReminderSettingsRepository;
  reminders: ReminderRepository;
  outbox: OutboxRepository;
}
