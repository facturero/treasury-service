import { zValidator } from '@hono/zod-validator';
import { z, type ZodSchema } from 'zod';
import { RECEIVABLE_STATUSES, type ReceivableStatus } from '../../domain/receivable.js';
import { RECEIPT_METHODS, RECEIPT_STATUSES, type ReceiptStatus } from '../../domain/receipt.js';
import { ValidationError } from '../../domain/errors.js';

const UUID = z.string().uuid('El identificador no es válido.');
const LOCAL_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'La fecha debe tener el formato AAAA-MM-DD.');
const CENTS = z.number().int('Los importes van en centavos enteros.').min(0, 'El importe no puede ser negativo.').max(Number.MAX_SAFE_INTEGER);
const optionalText = (max: number) => z.string().trim().max(max).nullish().transform((v) => v || null);

/**
 * Estado de cartera, admite varios separados por coma (`?status=open,partial`).
 *
 * En una pantalla se filtran por bloques («ver las abiertas y las parciales»): una sola casilla obligaría a dos
 * peticiones, y la lista quedaría a medias entre una y otra.
 */
const statusList = z.preprocess(
  (value) => {
    if (typeof value !== 'string') return value;
    const parts = value.split(',').map((s) => s.trim()).filter(Boolean);
    return parts.length ? parts : undefined;
  },
  z.array(z.enum(RECEIVABLE_STATUSES as unknown as [ReceivableStatus, ...ReceivableStatus[]])).min(1).optional(),
);

/** Las banderas de query llegan como texto: `?overdueOnly=true`. */
const booleanFlag = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

export const receivableQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  customerId: UUID.optional(),
  status: statusList,
  overdueOnly: booleanFlag.optional(),
  asOf: LOCAL_DATE.optional(),
  from: LOCAL_DATE.optional(),
  to: LOCAL_DATE.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

/** Idioma de los encabezados del CSV (el de la interfaz de quien exporta). */
const reportLang = z.enum(['es', 'en', 'fr']).default('es');

/** La cartera exportada lleva los MISMOS filtros que la pantalla, pero sin paginar: un archivo a medias daría un total mentiroso. */
export const exportReceivablesQuerySchema = receivableQuerySchema.omit({ page: true, pageSize: true }).extend({ lang: reportLang });
export const exportAgingQuerySchema = z.object({ asOf: LOCAL_DATE.optional(), lang: reportLang });
export const exportStatementQuerySchema = z.object({ asOf: LOCAL_DATE.optional(), lang: reportLang });

/** Configuración de los recordatorios: `strict` para que un campo mal escrito falle en vez de ignorarse. */
export const reminderSettingsSchema = z
  .object({
    enabled: z.boolean(),
    firstAfterDays: z.number().int('Los días de atraso son un número entero.'),
    repeatEveryDays: z.number().int('Los días de repetición son un número entero.'),
  })
  .strict();

export const statementQuerySchema = z.object({
  asOf: LOCAL_DATE.optional(),
});

export const agingQuerySchema = z.object({
  asOf: LOCAL_DATE.optional(),
});

/**
 * Condiciones de crédito de un cliente.
 *
 * `customerName` es opcional: si no viene, se conserva el nombre que ya estaba guardado (o queda vacío). Es un dato
 * de lectura, no de cálculo: el plazo y el cupo son los que mandan.
 */
export const customerTermsSchema = z
  .object({
    creditDays: z.number().int('Los días de crédito son un número entero.').min(0).max(365),
    creditLimitCents: CENTS.nullable(),
    customerName: optionalText(300),
  })
  .strict();

const openingBalanceLineSchema = z
  .object({
    customerId: UUID,
    customerName: optionalText(300),
    documentNumber: optionalText(60),
    issueDate: LOCAL_DATE,
    dueDate: LOCAL_DATE.nullish(),
    amountCents: z.number().int().positive('El importe debe ser mayor que cero.').max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

/**
 * Carga de saldos iniciales.
 *
 * La fecha de corte es obligatoria y es la que hace única la carga (`UNIQUE (organization_id, cutoff_date)`): repetirla
 * duplicaría la cartera, así que el servidor la rechaza.
 */
export const openingBalanceSchema = z
  .object({
    cutoffDate: LOCAL_DATE,
    reason: z.string().trim().min(3, 'Indica el motivo de la carga.').max(300),
    lines: z.array(openingBalanceLineSchema).min(1, 'La carga necesita al menos una línea.').max(500),
  })
  .strict();

/** Valida el cuerpo y responde con el formato de error del servicio (`VALIDATION_ERROR` + campos), no con el de zod. */
export function validateJson<T extends ZodSchema>(schema: T) {
  return zValidator('json', schema, (result) => {
    if (!result.success) {
      throw new ValidationError(result.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })));
    }
  });
}

export function validateQuery<T extends ZodSchema>(schema: T) {
  return zValidator('query', schema, (result) => {
    if (!result.success) {
      throw new ValidationError(result.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })));
    }
  });
}

// ── Cobros ───────────────────────────────────────────────────────────────────

const receiptStatusList = z.preprocess(
  (value) => {
    if (typeof value !== 'string') return value;
    const parts = value.split(',').map((x) => x.trim()).filter(Boolean);
    return parts.length ? parts : undefined;
  },
  z.array(z.enum(RECEIPT_STATUSES as unknown as [ReceiptStatus, ...ReceiptStatus[]])).min(1).optional(),
);

export const receiptQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  customerId: UUID.optional(),
  status: receiptStatusList,
  from: LOCAL_DATE.optional(),
  to: LOCAL_DATE.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

const receiptBody = {
  receiptDate: LOCAL_DATE,
  method: z.enum(RECEIPT_METHODS as unknown as [string, ...string[]]),
  accountRole: z.enum(['cash', 'bank']).nullish(),
  reference: optionalText(100),
  totalCents: CENTS,
  lines: z
    .array(
      z
        .object({
          receivableId: UUID,
          appliedCents: z.number().int('Los importes van en centavos enteros.').positive('Lo aplicado debe ser mayor que cero.').max(Number.MAX_SAFE_INTEGER),
        })
        .strict(),
    )
    .max(200, 'Un cobro admite hasta 200 deudas.'),
  advanceUses: z
    .array(
      z
        .object({
          advanceId: UUID,
          usedCents: z.number().int('Los importes van en centavos enteros.').positive('Lo que se consume debe ser mayor que cero.').max(Number.MAX_SAFE_INTEGER),
        })
        .strict(),
    )
    .max(50)
    .optional(),
  notes: optionalText(500),
};

/** Alta de un cobro (borrador). El cliente va en el cuerpo: es de quién se cobra y no cambia después. */
export const createReceiptSchema = z.object({ customerId: UUID, ...receiptBody }).strict();

/** Edición de un borrador. `expectedVersion` (opcional) evita pisar lo que otra persona cambió. */
export const updateReceiptSchema = z.object({ ...receiptBody, expectedVersion: z.number().int().min(1).optional() }).strict();

export const voidReceiptSchema = z
  .object({ reason: z.string().trim().min(5, 'Indica el motivo de la anulación (mínimo 5 caracteres).').max(300) })
  .strict();
