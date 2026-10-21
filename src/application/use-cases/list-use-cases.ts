import { daysBetween, localDateOf } from '../../domain/dates.js';
import { ReceivableNotFoundError } from '../../domain/errors.js';
import { balanceOf, type CreditApplication, type CustomerAdvance, type Receivable } from '../../domain/receivable.js';
import type { Page, ReceivableFilters, UnitOfWork } from '../../domain/repositories.js';
import type { Clock } from '../ports.js';

export interface ListResult {
  page: Page<Receivable>;
  /** Fecha de corte usada para el filtro de vencidas. */
  asOf: string;
}

/**
 * Listado de cartera.
 *
 * La fecha de corte sale del propio servidor (el huso de la organización): un listado de vencidas no puede depender
 * de lo que diga la máquina de quien lo pide.
 */
export class ListReceivablesUseCase {
  constructor(
    private readonly reads: UnitOfWork,
    private readonly clock: Clock,
    private readonly timezone: string,
  ) {}

  async execute(input: { organizationId: string; filters: ReceivableFilters }): Promise<ListResult> {
    const asOf = input.filters.asOf ?? localDateOf(this.clock(), this.timezone);
    const page = await this.reads.receivables.list(input.organizationId, { ...input.filters, asOf });
    return { page, asOf };
  }
}

/** Una partida de cartera con lo aplicado ya derivado (el saldo nunca es un número guardado a mano). */
export class GetReceivableUseCase {
  constructor(private readonly reads: UnitOfWork) {}

  async execute(input: { organizationId: string; receivableId: string }): Promise<Receivable> {
    const receivable = await this.reads.receivables.findById(input.organizationId, input.receivableId);
    if (!receivable) throw new ReceivableNotFoundError();
    return receivable;
  }
}

export interface ReceivableDetail {
  receivable: Receivable;
  /** Lo que se le ha acreditado a esta partida, en orden de aplicación. */
  applications: CreditApplication[];
}

/**
 * Detalle de una partida: la partida y su historial de aplicaciones.
 *
 * Se lee en dos pasos porque el saldo y las aplicaciones son dos cosas distintas: el saldo es lo que queda, las
 * aplicaciones son por qué. Enseñar solo el saldo deja a la persona sin poder explicar de dónde sale.
 */
export class GetReceivableDetailUseCase {
  constructor(private readonly reads: UnitOfWork) {}

  async execute(input: { organizationId: string; receivableId: string }): Promise<ReceivableDetail> {
    const receivable = await this.reads.receivables.findById(input.organizationId, input.receivableId);
    if (!receivable) throw new ReceivableNotFoundError();
    const applications = await this.reads.creditApplications.listByReceivable(input.organizationId, [receivable.id]);
    return { receivable, applications };
  }
}

export interface CustomerStatement {
  customerId: string;
  asOf: string;
  receivables: Receivable[];
  /** Aplicaciones que reducen la deuda (notas de crédito; en el bloque B, también cobros). */
  applications: CreditApplication[];
  /** Saldos a favor del cliente (notas de crédito sin factura a la que aplicarlas). */
  advances: CustomerAdvance[];
  /** Suma de los saldos de las partidas: lo que el cliente debe. */
  receivableCents: number;
  /**
   * Saldo a favor de NOTAS DE CRÉDITO sin aplicar. Está en las cuentas por cobrar del libro mayor (su asiento acreditó al cliente),
   * por eso resta de la deuda en `netCents`.
   */
  advanceCents: number;
  /**
   * Anticipos de COBROS sin consumir. Viven en «anticipos de clientes» (un pasivo), NO en cuentas por cobrar: no entran en
   * `netCents`, o el estado de cuenta no cuadraría con el libro mayor.
   */
  customerAdvanceCents: number;
  /** Lo que el libro mayor muestra como `receivables` de ese cliente: la deuda menos el saldo a favor de notas de crédito. */
  netCents: number;
}

/**
 * Estado de cuenta de un cliente: sus partidas, lo que se le ha aplicado y su saldo.
 *
 * El `netCents` es el número que tiene que cuadrar con contabilidad (`receivables` del libro mayor): la deuda de
 * las partidas MENOS el saldo a favor que todavía no se aplicó.
 */
export class GetCustomerStatementUseCase {
  constructor(
    private readonly reads: UnitOfWork,
    private readonly clock: Clock,
    private readonly timezone: string,
  ) {}

  async execute(input: { organizationId: string; customerId: string; asOf?: string }): Promise<CustomerStatement> {
    const asOf = input.asOf ?? localDateOf(this.clock(), this.timezone);
    const receivables = await this.reads.receivables.listBalances(input.organizationId, { customerId: input.customerId });
    const applications = (receivables.length
      ? await this.reads.creditApplications.listByReceivable(
          input.organizationId,
          receivables.map((r) => r.id),
        )
      : []
    ).filter((a) => !a.reversedAt); // un cobro anulado deja su aplicación en la historia (detalle), no en el estado de cuenta
    const advances = await this.reads.advances.listByCustomer(input.organizationId, input.customerId);

    const receivableCents = receivables.reduce((acc, r) => acc + balanceOf(r), 0);
    const open = (a: CustomerAdvance) => a.originalCents - a.appliedCents;
    const advanceCents = advances.filter((a) => a.origin === 'credit_note').reduce((acc, a) => acc + open(a), 0);
    const customerAdvanceCents = advances.filter((a) => a.origin === 'receipt').reduce((acc, a) => acc + open(a), 0);
    return {
      customerId: input.customerId,
      asOf,
      receivables,
      applications,
      advances,
      receivableCents,
      advanceCents,
      customerAdvanceCents,
      netCents: receivableCents - advanceCents,
    };
  }
}

export interface AgingBucket {
  currentCents: number;
  days1To30Cents: number;
  days31To60Cents: number;
  days61To90Cents: number;
  daysOver90Cents: number;
  totalCents: number;
}

export interface AgingCustomer extends AgingBucket {
  customerId: string;
  customerName: string;
}

export interface AgingReport {
  asOf: string;
  totals: AgingBucket;
  customers: AgingCustomer[];
}

const emptyBucket = (): AgingBucket => ({
  currentCents: 0,
  days1To30Cents: 0,
  days31To60Cents: 0,
  days61To90Cents: 0,
  daysOver90Cents: 0,
  totalCents: 0,
});

/**
 * Antigüedad de la cartera: lo que está corriente y lo que está vencido, por tramos de días.
 *
 * Solo entran las partidas con saldo POSITIVO: una partida anulada con nota de crédito encima deja saldo en contra
 * (el cliente debe menos de lo que decía la factura), y eso no es «cartera vencida».
 */
export class GetAgingUseCase {
  constructor(
    private readonly reads: UnitOfWork,
    private readonly clock: Clock,
    private readonly timezone: string,
  ) {}

  async execute(input: { organizationId: string; asOf?: string }): Promise<AgingReport> {
    const asOf = input.asOf ?? localDateOf(this.clock(), this.timezone);
    const receivables = await this.reads.receivables.listBalances(input.organizationId);
    const totals = emptyBucket();
    const byCustomer = new Map<string, AgingCustomer>();

    for (const receivable of receivables) {
      const balance = balanceOf(receivable);
      if (balance <= 0) continue;
      const daysOverdue = daysBetween(receivable.dueDate, asOf);
      const bucket = daysOverdue <= 0 ? 'currentCents' : bucketOf(daysOverdue);
      let customer = byCustomer.get(receivable.customerId);
      if (!customer) {
        customer = { customerId: receivable.customerId, customerName: receivable.customerName, ...emptyBucket() };
        byCustomer.set(receivable.customerId, customer);
      }
      totals[bucket] += balance;
      totals.totalCents += balance;
      customer[bucket] += balance;
      customer.totalCents += balance;
    }

    return {
      asOf,
      totals,
      customers: [...byCustomer.values()].sort((a, b) => b.totalCents - a.totalCents),
    };
  }
}

function bucketOf(daysOverdue: number): keyof Omit<AgingBucket, 'totalCents'> {
  if (daysOverdue <= 30) return 'days1To30Cents';
  if (daysOverdue <= 60) return 'days31To60Cents';
  if (daysOverdue <= 90) return 'days61To90Cents';
  return 'daysOver90Cents';
}
