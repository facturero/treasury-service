import { CatalogUnavailableError } from '../../domain/errors.js';
import type {
  AccountingCatalogPort,
  AccountingSettingsInfo,
  CustomerCatalogPort,
  CustomerInfo,
  OrganizationCatalogPort,
} from '../../application/ports.js';
import type { CollectionRole } from '../../domain/accounting-rules.js';

const TIMEOUT_MS = 8_000;

interface AccountingSettingsResponse {
  configured: boolean;
  settings: {
    baseCurrency: string;
    timezone: string;
    autoPosting: boolean;
    autoPostingFrom: string | null;
    paymentMethodRoles: Record<string, CollectionRole> | null;
  } | null;
}

/**
 * Contabilidad (accounting-service) consultada por HTTP server-to-server.
 *
 * Tesorería llama a contabilidad DIRECTO (sin pasar por el gateway), así que pone ella misma las cabeceras que
 * contabilidad espera. Si contabilidad no responde se LANZA `CatalogUnavailableError` (502): dar por inexistente
 * un ajuste que no se pudo consultar dejaría la cartera y el libro mayor descuadrados sin que nadie lo note.
 */
export class HttpAccountingCatalog implements AccountingCatalogPort {
  constructor(private readonly baseUrl: string) {}

  async getSettings(organizationId: string): Promise<AccountingSettingsInfo | null> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/accounting/settings`, {
        headers: {
          'X-Organization-Id': organizationId,
          'X-User-Id': 'treasury-service',
          // `account:read` es lo que pide contabilidad para leer su configuración; sin él responde 403.
          'X-Permissions': 'account:read',
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      console.warn(`[treasury-service] no se pudo consultar la contabilidad: ${(err as Error).message}`);
      throw new CatalogUnavailableError();
    }
    if (response.status === 404) return null;
    if (!response.ok) {
      console.warn(`[treasury-service] la contabilidad respondió ${response.status}`);
      throw new CatalogUnavailableError();
    }
    const data = (await response.json()) as AccountingSettingsResponse;
    if (!data.configured || !data.settings) return null;
    return {
      baseCurrency: data.settings.baseCurrency,
      timezone: data.settings.timezone,
      autoPosting: data.settings.autoPosting,
      autoPostingFrom: data.settings.autoPostingFrom,
      paymentMethodRoles: data.settings.paymentMethodRoles,
    };
  }
}

/**
 * Clientes (customer-service), server-to-server: pone ella misma las cabeceras que customer-service espera del gateway.
 *
 * A diferencia de otros adaptadores del proyecto, aquí un fallo NO se convierte en «no existe»: 404 es `null`, y cualquier otra
 * cosa (red, 5xx, 403) es `CatalogUnavailableError`. Un saldo inicial a nombre de un cliente que en realidad solo estaba
 * inaccesible dejaría la cartera con deudas de nadie.
 */
export class HttpCustomerCatalog implements CustomerCatalogPort {
  constructor(private readonly baseUrl: string) {}

  async findById(organizationId: string, customerId: string): Promise<CustomerInfo | null> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/customers/${encodeURIComponent(customerId)}`, {
        headers: { 'X-Organization-Id': organizationId, 'X-User-Id': 'treasury-service', 'X-Permissions': 'customer:read' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      console.warn(`[treasury-service] no se pudo consultar customer-service: ${(err as Error).message}`);
      throw new CatalogUnavailableError('No se pudo consultar a los clientes. Reintenta en un momento.');
    }
    if (response.status === 404) return null;
    if (!response.ok) {
      console.warn(`[treasury-service] customer-service respondió ${response.status}`);
      throw new CatalogUnavailableError('No se pudo consultar a los clientes. Reintenta en un momento.');
    }
    const data = (await response.json()) as { id: string; businessName?: string | null; identification?: string | null; email?: string | null };
    return { id: data.id, businessName: data.businessName ?? '', identification: data.identification ?? null, email: data.email?.trim() || null };
  }
}

/**
 * Organización (organization-service), server-to-server: solo para firmar el recordatorio con el nombre de quien cobra.
 * A diferencia de lo demás, un 404 (perfil sin completar) es `null`, no un error: se firma con un texto genérico.
 */
export class HttpOrganizationCatalog implements OrganizationCatalogPort {
  constructor(private readonly baseUrl: string) {}

  async getDisplayName(organizationId: string): Promise<string | null> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/organizations/me`, {
        headers: { 'X-Organization-Id': organizationId, 'X-User-Id': 'treasury-service', 'X-Permissions': 'organization:read' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      console.warn(`[treasury-service] no se pudo consultar organization-service: ${(err as Error).message}`);
      throw new CatalogUnavailableError('No se pudo consultar los datos de la organización. Reintenta en un momento.');
    }
    if (response.status === 404) return null;
    if (!response.ok) {
      console.warn(`[treasury-service] organization-service respondió ${response.status}`);
      throw new CatalogUnavailableError('No se pudo consultar los datos de la organización. Reintenta en un momento.');
    }
    const data = (await response.json()) as { legalName?: string | null; tradeName?: string | null };
    return data.tradeName?.trim() || data.legalName?.trim() || null;
  }
}
