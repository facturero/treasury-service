import { zValidator } from '@hono/zod-validator';
import { z, type ZodSchema } from 'zod';
import { RECEIVABLE_STATUSES, type ReceivableStatus } from '../../domain/receivable.js';
import { RECEIPT_METHODS, RECEIPT_STATUSES, type ReceiptStatus } from '../../domain/receipt.js';
import { PAYABLE_STATUSES, type PayableStatus } from '../../domain/payable.js';
import { PAYMENT_METHODS, PAYMENT_STATUSES, type PaymentStatus } from '../../domain/payment.js';
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
  bankAccountId: z.string().uuid().nullish(),
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

// ── Cuentas por pagar y pagos (bloque D) ─────────────────────────────────────

const payableStatusList = z.preprocess(
  (value) => {
    if (typeof value !== 'string') return value;
    const parts = value.split(',').map((x) => x.trim()).filter(Boolean);
    return parts.length ? parts : undefined;
  },
  z.array(z.enum(PAYABLE_STATUSES as unknown as [PayableStatus, ...PayableStatus[]])).min(1).optional(),
);

export const payableQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  supplierId: UUID.optional(),
  status: payableStatusList,
  overdueOnly: booleanFlag.optional(),
  /** Solo las que vencen en los próximos 7 días. */
  dueSoon: booleanFlag.optional(),
  asOf: LOCAL_DATE.optional(),
  from: LOCAL_DATE.optional(),
  to: LOCAL_DATE.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export const exportPayablesQuerySchema = payableQuerySchema.omit({ page: true, pageSize: true }).extend({ lang: reportLang });

const paymentStatusList = z.preprocess(
  (value) => {
    if (typeof value !== 'string') return value;
    const parts = value.split(',').map((x) => x.trim()).filter(Boolean);
    return parts.length ? parts : undefined;
  },
  z.array(z.enum(PAYMENT_STATUSES as unknown as [PaymentStatus, ...PaymentStatus[]])).min(1).optional(),
);

export const paymentQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  supplierId: UUID.optional(),
  status: paymentStatusList,
  from: LOCAL_DATE.optional(),
  to: LOCAL_DATE.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

const paymentBody = {
  paymentDate: LOCAL_DATE,
  method: z.enum(PAYMENT_METHODS as unknown as [string, ...string[]]),
  accountRole: z.enum(['cash', 'bank']).nullish(),
  bankAccountId: z.string().uuid().nullish(),
  reference: optionalText(100),
  totalCents: CENTS,
  lines: z
    .array(
      z
        .object({
          payableId: UUID,
          appliedCents: z.number().int('Los importes van en centavos enteros.').positive('Lo aplicado debe ser mayor que cero.').max(Number.MAX_SAFE_INTEGER),
        })
        .strict(),
    )
    .max(200, 'Un pago admite hasta 200 facturas.'),
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

/** Alta de un pago (borrador). El proveedor va en el cuerpo: es a quién se paga y no cambia después. */
export const createPaymentSchema = z.object({ supplierId: UUID, ...paymentBody }).strict();
export const updatePaymentSchema = z.object({ ...paymentBody, expectedVersion: z.number().int().min(1).optional() }).strict();
export const voidPaymentSchema = z.object({ reason: z.string().trim().min(5, 'Indica el motivo de la anulación (mínimo 5 caracteres).').max(300) }).strict();

/** Umbral de aprobación: `null` = sin aprobación. */
export const paymentSettingsSchema = z.object({ approvalThresholdCents: z.number().int('El umbral va en centavos enteros.').positive('El umbral debe ser mayor que cero.').max(Number.MAX_SAFE_INTEGER).nullable() }).strict();

const payableOpeningLineSchema = z
  .object({
    supplierId: UUID,
    documentNumber: optionalText(60),
    issueDate: LOCAL_DATE,
    dueDate: LOCAL_DATE.nullish(),
    amountCents: z.number().int().positive('El importe debe ser mayor que cero.').max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

export const payableOpeningBalanceSchema = z
  .object({
    cutoffDate: LOCAL_DATE,
    reason: z.string().trim().min(3, 'Indica el motivo de la carga.').max(300),
    lines: z.array(payableOpeningLineSchema).min(1, 'La carga necesita al menos una línea.').max(500),
  })
  .strict();


// ── Bancos, extractos y conciliación (bloque E) ──────────────────────────────

/** Importe con signo (el saldo de apertura de una cuenta o de un extracto puede ser negativo: sobregiro). */
const SIGNED_CENTS = z.number().int('Los importes van en centavos enteros.').min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
const COLUMN = z.number().int().min(1).max(50);

export const importProfileSchema = z
  .object({
    delimiter: z.enum([',', ';', '\t']),
    skipRows: z.number().int().min(0).max(50),
    dateColumn: COLUMN,
    dateFormat: z.enum(['DD/MM/YYYY', 'YYYY-MM-DD', 'MM/DD/YYYY', 'DD-MM-YYYY']),
    descriptionColumn: COLUMN,
    referenceColumn: COLUMN.nullable(),
    amountMode: z.enum(['signed', 'debit_credit']),
    amountColumn: COLUMN.nullable(),
    debitColumn: COLUMN.nullable(),
    creditColumn: COLUMN.nullable(),
    invertSign: z.boolean(),
    decimalSeparator: z.enum(['.', ',']),
    balanceColumn: COLUMN.nullable(),
  })
  .strict();

export const createBankAccountSchema = z
  .object({
    name: z.string().trim().min(1, 'La cuenta necesita un nombre.').max(80),
    bankName: z.string().trim().min(1, 'Indica el banco.').max(120),
    accountType: z.enum(['checking', 'savings']),
    accountLast4: z.string().trim().max(4).nullish().transform((v) => v || null),
    openingBalanceCents: SIGNED_CENTS,
    openingDate: LOCAL_DATE,
    importProfile: importProfileSchema.nullish().transform((v) => v ?? null),
  })
  .strict();

export const updateBankAccountSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    bankName: z.string().trim().min(1).max(120).optional(),
    accountLast4: z.string().trim().max(4).nullable().optional(),
    openingBalanceCents: SIGNED_CENTS.optional(),
    openingDate: LOCAL_DATE.optional(),
    isActive: z.boolean().optional(),
    importProfile: importProfileSchema.nullable().optional(),
    expectedVersion: z.number().int().min(1).optional(),
  })
  .strict();

export const bankAccountsQuerySchema = z.object({ activeOnly: booleanFlag.optional() });

/** El CSV viaja dentro del JSON (el navegador lo lee con `File.text()`): tope de 2 MB de texto, más lo que ocupa el escape. */
export const statementBodySchema = z
  .object({
    csv: z.string().min(1, 'El archivo está vacío.').max(2_200_000, 'El archivo pasa de 2 MB: divídelo por periodos.'),
    fileName: z.string().trim().max(200).nullish().transform((v) => v || null),
    profile: importProfileSchema.nullish().transform((v) => v ?? null),
    saveProfile: z.boolean().optional(),
  })
  .strict();

const lineStatusList = z.preprocess(
  (value) => {
    if (typeof value !== 'string') return value;
    const parts = value.split(',').map((s) => s.trim()).filter(Boolean);
    return parts.length ? parts : undefined;
  },
  z.array(z.enum(['unmatched', 'matched', 'external'])).min(1).optional(),
);

export const bankLinesQuerySchema = z.object({
  status: lineStatusList,
  from: LOCAL_DATE.optional(),
  to: LOCAL_DATE.optional(),
  q: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

export const bankMovementsQuerySchema = z.object({
  bankAccountId: z.union([z.literal('none'), UUID]).optional(),
  status: z.preprocess(
    (value) => {
      if (typeof value !== 'string') return value;
      const parts = value.split(',').map((s) => s.trim()).filter(Boolean);
      return parts.length ? parts : undefined;
    },
    z.array(z.enum(['active', 'reversed'])).min(1).optional(),
  ),
  matched: booleanFlag.optional(),
  from: LOCAL_DATE.optional(),
  to: LOCAL_DATE.optional(),
  q: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

export const assignAccountSchema = z.object({ bankAccountId: UUID }).strict();

export const matchLineSchema = z.object({ movementIds: z.array(UUID).min(1, 'Elige al menos un movimiento.').max(50), method: z.enum(['manual', 'suggested']).default('manual') }).strict();
export const matchManySchema = z
  .object({
    pairs: z.array(z.object({ lineId: UUID, movementIds: z.array(UUID).min(1).max(50) }).strict()).min(1).max(200),
    method: z.enum(['manual', 'suggested']).default('suggested'),
  })
  .strict();
export const markExternalSchema = z.object({ reason: z.string().trim().min(5, 'Indica por qué ya está contabilizado (mínimo 5 caracteres).').max(300) }).strict();

export const bankAdjustmentSchema = z
  .object({
    bankAccountId: UUID,
    kind: z.enum(['bank_fee', 'interest', 'other_in', 'other_out']),
    date: LOCAL_DATE,
    amountCents: z.number().int('Los importes van en centavos enteros.').positive('El importe debe ser mayor que cero.').max(Number.MAX_SAFE_INTEGER),
    description: z.string().trim().min(3, 'Describe el ajuste (mínimo 3 caracteres).').max(200),
    reference: optionalText(100),
    lineId: UUID.nullish().transform((v) => v ?? null),
  })
  .strict();
export const voidAdjustmentSchema = z.object({ reason: z.string().trim().min(5, 'Indica el motivo de la anulación (mínimo 5 caracteres).').max(300) }).strict();

export const reconciliationQuerySchema = z.object({ cutoffDate: LOCAL_DATE, statementBalanceCents: z.coerce.number().int().optional() });
export const closeReconciliationSchema = z
  .object({ cutoffDate: LOCAL_DATE, statementBalanceCents: SIGNED_CENTS, notes: optionalText(500) })
  .strict();
export const reopenReconciliationSchema = z.object({ reason: z.string().trim().min(5, 'Indica por qué se reabre (mínimo 5 caracteres).').max(300) }).strict();

export const cashFlowQuerySchema = z.object({ weeks: z.coerce.number().int().min(1).max(26).optional(), asOf: LOCAL_DATE.optional() });
export const exportCashFlowQuerySchema = cashFlowQuerySchema.extend({ lang: reportLang });
