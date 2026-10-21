import { localDateOf } from '../../domain/dates.js';
import { ValidationError } from '../../domain/errors.js';
import type { Receivable } from '../../domain/receivable.js';
import type { ReceivableFilters, UnitOfWork } from '../../domain/repositories.js';
import { agingCsv, receivablesCsv, statementCsv, type ReportLang } from '../../domain/report-csv.js';
import { reportExportedEvent } from '../events.js';
import type { Clock, UnitOfWorkGateway } from '../ports.js';
import type { GetAgingUseCase, GetCustomerStatementUseCase } from './list-use-cases.js';
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

  private async audit(input: { organizationId: string; userId: string; report: 'receivables' | 'aging' | 'statement'; rowCount: number; filters: Record<string, unknown>; customerId?: string }): Promise<void> {
    await inTransaction(this.gateway, async (uow) => {
      await uow.outbox.add(
        reportExportedEvent({
          organizationId: input.organizationId,
          report: input.report,
          filters: input.filters,
          rowCount: input.rowCount,
          exportedBy: input.userId,
          customerId: input.customerId,
        }),
      );
    });
  }
}
