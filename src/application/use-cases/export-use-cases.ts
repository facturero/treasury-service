import { addDays, localDateOf } from '../../domain/dates.js';
import { ValidationError } from '../../domain/errors.js';
import type { Receivable } from '../../domain/receivable.js';
import type { PayableFilters, ReceivableFilters, UnitOfWork } from '../../domain/repositories.js';
import { agingCsv, payablesAgingCsv, payablesCsv, receivablesCsv, statementCsv, supplierStatementCsv, type ReportLang } from '../../domain/report-csv.js';
import type { Payable } from '../../domain/payable.js';
import { reportExportedEvent } from '../events.js';
import type { Clock, UnitOfWorkGateway } from '../ports.js';
import type { GetAgingUseCase, GetCustomerStatementUseCase } from './list-use-cases.js';
import type { GetPayablesAgingUseCase, GetSupplierStatementUseCase } from './payable-list-use-cases.js';
import { inTransaction } from './transaction.js';

export interface CsvFile {
  filename: string;
  csv: string;
  rowCount: number;
}

/** Tope de filas de un archivo: más que eso es un volcado, no un reporte; se pide filtrar. */
export const MAX_EXPORT_ROWS = 20_000;
const PAGE = 500;

/**
 * Exportar la cartera, la antigüedad o un estado de cuenta a CSV.
 *
 * Las lecturas no dejan rastro, pero un archivo SÍ: es la cartera de clientes con sus saldos saliendo del sistema. Por eso exportar
 * emite `treasury.report.exported` (qué reporte, con qué filtros, cuántas filas, quién) en la misma transacción que confirma que el
 * archivo se generó. El CSV se arma aquí (no en el navegador) para que no exista forma de sacarlo sin que quede constancia.
 */
export class ExportReportsUseCase {
  constructor(
    private readonly gateway: UnitOfWorkGateway,
    private readonly reads: UnitOfWork,
    private readonly getAging: GetAgingUseCase,
    private readonly getStatement: GetCustomerStatementUseCase,
    private readonly clock: Clock,
    private readonly timezone: string,
    private readonly getPayablesAging?: GetPayablesAgingUseCase,
    private readonly getSupplierStatement?: GetSupplierStatementUseCase,
  ) {}

  async receivables(input: { organizationId: string; userId: string; lang: ReportLang; filters: Omit<ReceivableFilters, 'page' | 'pageSize'> }): Promise<CsvFile> {
    const asOf = input.filters.asOf ?? localDateOf(this.clock(), this.timezone);
    const rows: Receivable[] = [];
    for (let page = 1; ; page += 1) {
      const result = await this.reads.receivables.list(input.organizationId, { ...input.filters, asOf, page, pageSize: PAGE });
      rows.push(...result.items);
      if (rows.length > MAX_EXPORT_ROWS) {
        throw new ValidationError([{ field: 'filters', message: `Son más de ${MAX_EXPORT_ROWS} filas: acota por fechas o por estado.` }]);
      }
      if (rows.length >= result.total || result.items.length === 0) break;
    }
    const { csv, rowCount } = receivablesCsv(input.lang, rows, asOf);
    await this.audit({ organizationId: input.organizationId, userId: input.userId, report: 'receivables', rowCount, filters: this.describe(input.filters, asOf) });
    return { filename: `cartera-${asOf}.csv`, csv, rowCount };
  }

  async aging(input: { organizationId: string; userId: string; lang: ReportLang; asOf?: string }): Promise<CsvFile> {
    const report = await this.getAging.execute({ organizationId: input.organizationId, asOf: input.asOf });
    const { csv, rowCount } = agingCsv(input.lang, report.customers, report.totals);
    await this.audit({ organizationId: input.organizationId, userId: input.userId, report: 'aging', rowCount, filters: { asOf: report.asOf } });
    return { filename: `antiguedad-${report.asOf}.csv`, csv, rowCount };
  }

  async statement(input: { organizationId: string; userId: string; lang: ReportLang; customerId: string; asOf?: string }): Promise<CsvFile> {
    const statement = await this.getStatement.execute({ organizationId: input.organizationId, customerId: input.customerId, asOf: input.asOf });
    const customerName = statement.receivables[0]?.customerName ?? '';
    const { csv, rowCount } = statementCsv(input.lang, { ...statement, customerName });
    await this.audit({
      organizationId: input.organizationId,
      userId: input.userId,
      report: 'statement',
      rowCount,
      filters: { asOf: statement.asOf },
      customerId: input.customerId,
    });
    return { filename: `estado-de-cuenta-${statement.asOf}.csv`, csv, rowCount };
  }

  async payables(input: { organizationId: string; userId: string; lang: ReportLang; filters: Omit<PayableFilters, 'page' | 'pageSize'>; dueSoon?: boolean }): Promise<CsvFile> {
    const asOf = input.filters.asOf ?? localDateOf(this.clock(), this.timezone);
    if (input.dueSoon) input = { ...input, filters: { ...input.filters, dueBefore: addDays(asOf, 7) } };
    const rows: Payable[] = [];
    for (let page = 1; ; page += 1) {
      const result = await this.reads.payables.list(input.organizationId, { ...input.filters, asOf, page, pageSize: PAGE });
      rows.push(...result.items);
      if (rows.length > MAX_EXPORT_ROWS) throw new ValidationError([{ field: 'filters', message: `Son más de ${MAX_EXPORT_ROWS} filas: acota por fechas o por estado.` }]);
      if (rows.length >= result.total || result.items.length === 0) break;
    }
    const { csv, rowCount } = payablesCsv(input.lang, rows, asOf);
    const filters: Record<string, unknown> = { asOf };
    const f = input.filters;
    if (f.q) filters.q = f.q;
    if (f.supplierId) filters.supplierId = f.supplierId;
    if (f.status?.length) filters.status = f.status;
    if (f.overdueOnly) filters.overdueOnly = true;
    if (f.dueBefore) filters.dueBefore = f.dueBefore;
    if (f.from) filters.from = f.from;
    if (f.to) filters.to = f.to;
    await this.audit({ organizationId: input.organizationId, userId: input.userId, report: 'payables', rowCount, filters });
    return { filename: `por-pagar-${asOf}.csv`, csv, rowCount };
  }

  async payablesAging(input: { organizationId: string; userId: string; lang: ReportLang; asOf?: string }): Promise<CsvFile> {
    const report = await this.getPayablesAging!.execute({ organizationId: input.organizationId, asOf: input.asOf });
    const { csv, rowCount } = payablesAgingCsv(input.lang, report.suppliers, report.totals);
    await this.audit({ organizationId: input.organizationId, userId: input.userId, report: 'payables_aging', rowCount, filters: { asOf: report.asOf } });
    return { filename: `antiguedad-por-pagar-${report.asOf}.csv`, csv, rowCount };
  }

  async supplierStatement(input: { organizationId: string; userId: string; lang: ReportLang; supplierId: string; asOf?: string }): Promise<CsvFile> {
    const statement = await this.getSupplierStatement!.execute({ organizationId: input.organizationId, supplierId: input.supplierId, asOf: input.asOf });
    const supplierName = statement.payables[0]?.supplierName ?? '';
    const { csv, rowCount } = supplierStatementCsv(input.lang, { ...statement, supplierName });
    await this.audit({ organizationId: input.organizationId, userId: input.userId, report: 'supplier_statement', rowCount, filters: { asOf: statement.asOf }, supplierId: input.supplierId });
    return { filename: `estado-de-cuenta-proveedor-${statement.asOf}.csv`, csv, rowCount };
  }

  /** Solo los filtros que de verdad se aplicaron (la bitácora no guarda claves vacías). */
  private describe(filters: Omit<ReceivableFilters, 'page' | 'pageSize'>, asOf: string): Record<string, unknown> {
    const out: Record<string, unknown> = { asOf };
    if (filters.q) out.q = filters.q;
    if (filters.customerId) out.customerId = filters.customerId;
    if (filters.status?.length) out.status = filters.status;
    if (filters.overdueOnly) out.overdueOnly = true;
    if (filters.from) out.from = filters.from;
    if (filters.to) out.to = filters.to;
    return out;
  }

  private async audit(input: { organizationId: string; userId: string; report: 'receivables' | 'aging' | 'statement' | 'payables' | 'payables_aging' | 'supplier_statement'; rowCount: number; filters: Record<string, unknown>; customerId?: string; supplierId?: string }): Promise<void> {
    await inTransaction(this.gateway, async (uow) => {
      await uow.outbox.add(
        reportExportedEvent({
          organizationId: input.organizationId,
          report: input.report,
          filters: input.filters,
          rowCount: input.rowCount,
          exportedBy: input.userId,
          customerId: input.customerId,
          supplierId: input.supplierId,
        }),
      );
    });
  }
}
