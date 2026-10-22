import type { Context } from 'hono';
import type { CsvFile } from '../../application/use-cases/export-use-cases.js';
import type { ContextVariables } from './middlewares.js';

export type Vars = { Variables: ContextVariables };
export type Ctx = Context<Vars>;

/** Un CSV descargable. BOM al inicio: sin él Excel abre el archivo en la codificación equivocada y los acentos se ven mal. */
export const csvResponse = (c: Ctx, file: CsvFile) =>
  c.body(`\uFEFF${file.csv}`, 200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${file.filename}"`,
    // Es información financiera de la organización: que ningún intermediario la guarde.
    'Cache-Control': 'no-store',
  });

export const org = (c: Ctx) => c.get('organizationId');
export const user = (c: Ctx) => c.get('userId');
