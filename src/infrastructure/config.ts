import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  // 3018: 3016 es accounting y 3017 purchasing; ningún otro servicio lo ocupa.
  PORT: z.coerce.number().int().positive().default(3018),
  DB_HOST: z.string().min(1),
  DB_PORT: z.coerce.number().int().positive().default(3306),
  DB_USER: z.string().min(1),
  DB_PASSWORD: z.string().default(''),
  DB_NAME: z.string().min(1),
  RABBITMQ_URL: z.string().optional(),
  CORS_ORIGIN: z.string().default('*'),
  INTERNAL_USER_ID: z.string().default('00000000-0000-0000-0000-000000000000'),
  // Clientes (server-to-server): los saldos iniciales solo se aceptan a nombre de un cliente que exista.
  CUSTOMER_SERVICE_URL: z.string().default('http://customer-service-node:3004'),
  // Compras (server-to-server): los pagos y saldos iniciales solo se aceptan a nombre de un proveedor que exista.
  PURCHASING_SERVICE_URL: z.string().default('http://purchasing-service-node:3017'),
  // Organización (server-to-server): el nombre con el que se firma el recordatorio de cobro.
  ORGANIZATION_SERVICE_URL: z.string().default('http://organization-service:3002'),
  // Contabilidad (server-to-server, sin pasar por el gateway): moneda base, huso y reglas de cobro.
  ACCOUNTING_SERVICE_URL: z.string().default('http://accounting-service-node:3016'),
  /**
   * Huso con el que se resuelve la fecha de corte de los reportes (vencidas, antigüedad).
   *
   * Las LECTURAS no consultan contabilidad a propósito: si contabilidad está caída, el listado de vencidas
   * seguiría funcionando. El default es el huso de Ecuador; el evento de factura sí usa el huso de contabilidad
   * (tiene que ser EXACTAMENTE el mismo, si no la fecha contable y la de cartera se separan un día).
   */
  ORG_TIMEZONE: z.string().default('America/Guayaquil'),
  // Cada cuántos minutos el proceso diario mira si alguna organización tiene recordatorios por enviar. 0 = no corre (solo «enviar ahora»).
  REMINDER_CHECK_MINUTES: z.coerce.number().int().min(0).default(15),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
    .join('\n');
  console.error(`Configuración de entorno inválida:\n${issues}`);
  process.exit(1);
}

export type AppConfig = z.infer<typeof schema>;
export const config: AppConfig = parsed.data;
