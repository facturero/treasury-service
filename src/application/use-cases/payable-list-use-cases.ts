import { randomUUID } from 'node:crypto';
import { addDays, daysBetween, localDateOf } from '../../domain/dates.js';
import { OpeningBalanceAlreadyLoadedError, PayableNotFoundError, ValidationError } from '../../domain/errors.js';
import { payableBalanceOf, supplierAdvanceBalanceOf, type Payable, type PayableApplication, type PayableOpeningLoad, type SupplierAdvance } from '../../domain/payable.js';
import type { Page, PayableFilters, UnitOfWork } from '../../domain/repositories.js';
import { payableOpenedEvent, payableOpeningLoadedEvent } from '../events.js';
import type { AccountingCatalogPort, Clock, SupplierCatalogPort, SupplierInfo, UnitOfWorkGateway } from '../ports.js';
import { inTransaction, isUniqueViolation } from './transaction.js';

/** Días hacia adelante que cuenta «por vencer»: lo que hay que pagar pronto. */
export const DUE_SOON_DAYS = 7;

export interface PayableListResult {
  page: Page<Payable>;
  asOf: string;
}

/** Listado de deudas. La fecha de corte sale del servidor (el huso de la organización): «vencidas» no puede depender de quien lo pide. */
export class ListPayablesUseCase {
  constructor(private readonly reads: UnitOfWork, private readonly clock: Clock, private readonly timezone: string) {}

  async execute(input: { organizationId: string; filters: PayableFilters; dueSoon?: boolean }): Promise<PayableListResult> {
    const asOf = input.filters.asOf ?? localDateOf(this.clock(), this.timezone);
    // «Por vencer»: las vivas que vencen entre hoy y dentro de `DUE_SOON_DAYS` días.
    const filters = { ...input.filters, asOf, ...(input.dueSoon ? { dueBefore: addDays(asOf, DUE_SOON_DAYS) } : {}) };
    return { page: await this.reads.payables.list(input.organizationId, filters), asOf };
  }
}

export interface PayableDetail {
  payable: Payable;
  /** Lo que se le ha aplicado (pagos y retenciones), en orden. */
  applications: PayableApplication[];
}

export class GetPayableDetailUseCase {
  constructor(private readonly reads: UnitOfWork) {}

  async execute(input: { organizationId: string; payableId: string }): Promise<PayableDetail> {
    const payable = await this.reads.payables.findById(input.organizationId, input.payableId);
    if (!payable) throw new PayableNotFoundError();
    const applications = await this.reads.payableApplications.listByPayable(input.organizationId, [payable.id]);
    return { payable, applications };
  }
}

export interface SupplierStatement {
  supplierId: string;
  asOf: string;
  payables: Payable[];
  /** Aplicaciones vigentes (un pago anulado queda en el detalle de la deuda, no en el estado de cuenta). */
  applications: PayableApplication[];
  advances: SupplierAdvance[];
  /** Lo que la empresa le debe al proveedor: suma de los saldos de las deudas (neto de retenciones y pagos). */
  payableCents: number;
  /** Saldo a favor de la empresa por anticipos sin consumir. NO entra en `netCents` (vive en «anticipos a proveedores»). */
  advanceCents: number;
  /** Lo que el libro mayor muestra como `payables` de ese proveedor, con las salvedades de la retención (se asienta sin tercero). */
  netCents: number;
}

/** Estado de cuenta de un proveedor: sus deudas, lo aplicado y su saldo. */
export class GetSupplierStatementUseCase {
  constructor(private readonly reads: UnitOfWork, private readonly clock: Clock, private readonly timezone: string) {}

  async execute(input: { organizationId: string; supplierId: string; asOf?: string }): Promise<SupplierStatement> {
    const asOf = input.asOf ?? localDateOf(this.clock(), this.timezone);
    const payables = await this.reads.payables.listBalances(input.organizationId, { supplierId: input.supplierId });
    const applications = (payables.length ? await this.reads.payableApplications.listByPayable(input.organizationId, payables.map((p) => p.id)) : []).filter((a) => !a.reversedAt);
    const advances = await this.reads.supplierAdvances.listBySupplier(input.organizationId, input.supplierId);
    const payableCents = payables.reduce((acc, p) => acc + payableBalanceOf(p), 0);
    const advanceCents = advances.reduce((acc, a) => acc + supplierAdvanceBalanceOf(a), 0);
    return { supplierId: input.supplierId, asOf, payables, applications, advances, payableCents, advanceCents, netCents: payableCents };
  }
}

export interface PayablesAgingBucket {
  /** Aún no vence y vence en más de `DUE_SOON_DAYS`. */
  currentCents: number;
  /** Aún no vence pero vence en los próximos `DUE_SOON_DAYS` días (incluido hoy): lo que hay que pagar pronto. */
  dueSoonCents: number;
  days1To30Cents: number;
  days31To60Cents: number;
  days61To90Cents: number;
  daysOver90Cents: number;
  totalCents: number;
}

export interface PayablesAgingSupplier extends PayablesAgingBucket {
  supplierId: string;
  supplierName: string;
}

export interface PayablesAgingReport {
  asOf: string;
  totals: PayablesAgingBucket;
  suppliers: PayablesAgingSupplier[];
}

const emptyBucket = (): PayablesAgingBucket => ({ currentCents: 0, dueSoonCents: 0, days1To30Cents: 0, days31To60Cents: 0, days61To90Cents: 0, daysOver90Cents: 0, totalCents: 0 });

function bucketOf(payable: Payable, asOf: string): keyof Omit<PayablesAgingBucket, 'totalCents'> {
  const daysOverdue = daysBetween(payable.dueDate, asOf);
  if (daysOverdue <= 0) return daysBetween(asOf, payable.dueDate) <= DUE_SOON_DAYS ? 'dueSoonCents' : 'currentCents';
  if (daysOverdue <= 30) return 'days1To30Cents';
  if (daysOverdue <= 60) return 'days31To60Cents';
  if (daysOverdue <= 90) return 'days61To90Cents';
  return 'daysOver90Cents';
}

/**
 * Antigüedad de lo que la empresa debe: por vencer pronto, corriente y vencido por tramos, por proveedor y en total. Solo entran las
 * deudas con saldo POSITIVO y vivas: una anulada con pagos encima deja saldo a favor y no es «deuda vencida».
 */
export class GetPayablesAgingUseCase {
  constructor(private readonly reads: UnitOfWork, private readonly clock: Clock, private readonly timezone: string) {}

  async execute(input: { organizationId: string; asOf?: string }): Promise<PayablesAgingReport> {
    const asOf = input.asOf ?? localDateOf(this.clock(), this.timezone);
    const totals = emptyBucket();
    const bySupplier = new Map<string, PayablesAgingSupplier>();
    for (const payable of await this.reads.payables.listBalances(input.organizationId)) {
      const balance = payableBalanceOf(payable);
      if (balance <= 0 || payable.status === 'cancelled') continue;
      const bucket = bucketOf(payable, asOf);
      let supplier = bySupplier.get(payable.supplierId);
      if (!supplier) {
        supplier = { supplierId: payable.supplierId, supplierName: payable.supplierName, ...emptyBucket() };
        bySupplier.set(payable.supplierId, supplier);
      }
      totals[bucket] += balance;
      totals.totalCents += balance;
      supplier[bucket] += balance;
      supplier.totalCents += balance;
    }
    return { asOf, totals, suppliers: [...bySupplier.values()].sort((a, b) => b.totalCents - a.totalCents) };
  }
}

export interface PayableOpeningLineInput {
  supplierId: string;
  documentNumber?: string | null;
  issueDate: string;
  /** Si no viene, vence el mismo día de la emisión. */
  dueDate?: string | null;
  amountCents: number;
}

/**
 * Carga de saldos iniciales de deudas a proveedores. Las deudas ya existentes no se recuperan solas: esta es la única vía honesta para
 * empezar con lo que la empresa ya debía. Una sola carga por fecha de corte, todo o nada, y NO genera asiento (contabilidad necesita su
 * propio asiento de apertura por el mismo total). Cada proveedor se valida contra compras.
 */
export class LoadPayableOpeningBalancesUseCase {
  constructor(
    private readonly gateway: UnitOfWorkGateway,
    private readonly accounting: AccountingCatalogPort,
    private readonly suppliers: SupplierCatalogPort,
    private readonly clock: Clock,
  ) {}

  async execute(input: { organizationId: string; cutoffDate: string; reason: string; lines: PayableOpeningLineInput[]; userId: string }): Promise<PayableOpeningLoad> {
    if (!input.cutoffDate) throw new ValidationError([{ field: 'cutoffDate', message: 'La fecha de corte es obligatoria.' }]);
    if (!input.reason || input.reason.trim().length < 3) throw new ValidationError([{ field: 'reason', message: 'El motivo es obligatorio.' }]);
    if (!input.lines.length) throw new ValidationError([{ field: 'lines', message: 'La carga necesita al menos una línea.' }]);
    for (const [index, line] of input.lines.entries()) {
      if (!line.supplierId) throw new ValidationError([{ field: `lines[${index}].supplierId`, message: 'El proveedor es obligatorio.' }]);
      if (!Number.isInteger(line.amountCents) || line.amountCents <= 0) throw new ValidationError([{ field: `lines[${index}].amountCents`, message: 'El importe debe ser mayor que cero.' }]);
      if (line.dueDate && line.dueDate < line.issueDate) throw new ValidationError([{ field: `lines[${index}].dueDate`, message: 'El vencimiento no puede ser anterior a la emisión.' }]);
    }
    const settings = await this.accounting.getSettings(input.organizationId);
    if (!settings) throw new ValidationError([{ field: 'currencyCode', message: 'La organización no tiene contabilidad configurada: no se sabe la moneda de los saldos iniciales.' }]);

    // Los proveedores se consultan FUERA de la transacción (HTTP), una vez cada uno. No existe → 422 con el índice; servicio caído → 502.
    const found = new Map<string, SupplierInfo | null>();
    for (const line of input.lines) if (!found.has(line.supplierId)) found.set(line.supplierId, await this.suppliers.findById(input.organizationId, line.supplierId));
    const missing = input.lines.flatMap((line, index) => (found.get(line.supplierId) ? [] : [{ field: `lines[${index}].supplierId`, message: 'El proveedor no existe en esta organización.' }]));
    if (missing.length) throw new ValidationError(missing);

    const now = this.clock();
    const loadId = randomUUID();
    const totalCents = input.lines.reduce((acc, l) => acc + l.amountCents, 0);

    return inTransaction(
      this.gateway,
      async (uow) => {
        if (await uow.payableOpeningLoads.findByCutoff(input.organizationId, input.cutoffDate)) throw new OpeningBalanceAlreadyLoadedError(input.cutoffDate);
        const load: PayableOpeningLoad = { id: loadId, organizationId: input.organizationId, cutoffDate: input.cutoffDate, loadedBy: input.userId, reason: input.reason.trim(), totalCents, createdAt: now };
        for (const [index, line] of input.lines.entries()) {
          const supplier = found.get(line.supplierId)!;
          const payable: Payable = {
            id: randomUUID(),
            organizationId: input.organizationId,
            supplierId: supplier.id,
            supplierName: supplier.legalName,
            supplierIdentification: supplier.identification,
            sourceType: 'initial_balance',
            sourceId: `${loadId}:${index}`,
            documentNumber: line.documentNumber ?? null,
            internalNumber: null,
            issueDate: line.issueDate,
            dueDate: line.dueDate ?? addDays(line.issueDate, 0),
            currencyCode: settings.baseCurrency,
            originalCents: line.amountCents,
            status: 'open',
            version: 1,
            createdAt: now,
            updatedAt: now,
            appliedCents: 0,
          };
          await uow.payables.save(payable);
          await uow.outbox.add(payableOpenedEvent(payable));
        }
        try {
          await uow.payableOpeningLoads.save(load);
        } catch (err) {
          if (isUniqueViolation(err)) throw new OpeningBalanceAlreadyLoadedError(input.cutoffDate);
          throw err;
        }
        await uow.outbox.add(payableOpeningLoadedEvent(load, input.lines.length));
        return load;
      },
      { readCommitted: true },
    );
  }
}
