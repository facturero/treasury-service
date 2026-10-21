import type { UnitOfWork } from '../domain/repositories.js';
import type { CollectionRole } from '../domain/accounting-rules.js';

/** UnitOfWork que además sabe cerrar su transacción. Los casos de uso de escritura lo obtienen del gateway y hacen commit explícito. */
export interface WriteUnitOfWork extends UnitOfWork {
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

/** Abre unidades de trabajo de escritura. La implementación real abre una transacción de Sequelize; en tests, repos en memoria. */
export interface UnitOfWorkGateway {
  /**
   * `readCommitted`: cada sentencia ve lo último confirmado en vez de la instantánea del primer SELECT. Hace falta
   * cuando la transacción lee una suma DESPUÉS de esperar un bloqueo (aplicar una nota de crédito espera el bloqueo de
   * la partida): con REPEATABLE READ esa suma sale de una instantánea anterior a la espera y no ve lo que confirmó
   * quien tenía el bloqueo.
   */
  begin(options?: { readCommitted?: boolean }): Promise<WriteUnitOfWork>;
}

export type Clock = () => Date;

/** Ajustes contables de la organización, tal como los expone `GET /accounting/settings`. */
export interface AccountingSettingsInfo {
  /** Moneda base de la contabilidad (los importes que no están en ella se bloquean). */
  baseCurrency: string;
  /** Zona horaria con la que se convierte un instante a fecha de calendario. */
  timezone: string;
  /** Si la contabilidad asienta sola. Apagada, contabilidad deja todo en «Pendientes». */
  autoPosting: boolean;
  /** Fecha desde la que contabilidad asienta; lo anterior se ignora. */
  autoPostingFrom: string | null;
  /** Roles de cobro por forma de pago, con la override de la organización. */
  paymentMethodRoles: Record<string, CollectionRole> | null;
}

/**
 * Contabilidad (accounting-service), consultada por HTTP server-to-server.
 *
 * Si no responde se lanza `CatalogUnavailableError` (502): un catálogo caído NO es «no hay contabilidad», y dar por
 * inexistente lo que no se pudo consultar dejaría la cartera y el libro mayor descuadrados sin que nadie lo note.
 */
export interface AccountingCatalogPort {
  /** `null` = la organización no tiene contabilidad configurada (entonces tesorería no abre partidas). */
  getSettings(organizationId: string): Promise<AccountingSettingsInfo | null>;
}

/** Lo que tesorería necesita saber de un cliente para guardarlo en una partida. */
export interface CustomerInfo {
  id: string;
  businessName: string;
  identification: string | null;
  /** A dónde se manda el recordatorio de cobro. `null` = el cliente no tiene correo: no se le avisa. */
  email: string | null;
}

/**
 * Clientes (customer-service), consultados por HTTP server-to-server.
 *
 * `null` = el cliente NO existe en esa organización. Si el servicio no responde se lanza `CatalogUnavailableError` (502):
 * un catálogo caído no es «no existe», y rechazar una carga por eso (o aceptarla) sería decidir a ciegas.
 */
export interface CustomerCatalogPort {
  findById(organizationId: string, customerId: string): Promise<CustomerInfo | null>;
}

/**
 * Datos de la organización (organization-service), consultados por HTTP server-to-server: el nombre con el que se firma el
 * recordatorio que le llega al cliente. Caído → `CatalogUnavailableError` (la corrida se reintenta; no se manda un correo sin firma).
 */
export interface OrganizationCatalogPort {
  /** Razón social o nombre comercial. `null` = la organización todavía no completó su perfil. */
  getDisplayName(organizationId: string): Promise<string | null>;
}
