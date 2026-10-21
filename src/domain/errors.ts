export interface ErrorDetail {
  field: string;
  message: string;
}

export abstract class AppError extends Error {
  abstract readonly code: string;
  abstract readonly httpStatus: number;
  readonly details?: ErrorDetail[];

  constructor(message: string, details?: ErrorDetail[]) {
    super(message);
    this.name = new.target.name;
    this.details = details;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class ValidationError extends AppError {
  readonly code = 'VALIDATION_ERROR';
  readonly httpStatus = 422;
  /** El mensaje resume los problemas (así se lee en un log o en una alerta); `details` dice cuál campo falló. */
  constructor(details: ErrorDetail[], message?: string) {
    super(message ?? (details.map((d) => d.message).join(' ') || 'La petición no es válida.'), details);
  }
}

export class OrganizationContextRequiredError extends AppError {
  readonly code = 'ORG_CONTEXT_REQUIRED';
  readonly httpStatus = 401;
  constructor(message = 'Falta el contexto de organización.') { super(message); }
}

export class UserContextRequiredError extends AppError {
  readonly code = 'USER_CONTEXT_REQUIRED';
  readonly httpStatus = 401;
  constructor(message = 'Falta el contexto de usuario.') { super(message); }
}

export class ForbiddenError extends AppError {
  readonly code = 'FORBIDDEN';
  readonly httpStatus = 403;
  constructor(message = 'Permiso insuficiente.') { super(message); }
}

/**
 * Un catálogo (contabilidad) que no responde NO es «no existe»: es un fallo del servidor. Se lanza 502 para que quien llama
 * reintente en vez de guardar que el dato no existe.
 */
export class CatalogUnavailableError extends AppError {
  readonly code = 'CATALOG_UNAVAILABLE';
  readonly httpStatus = 502;
  constructor(message = 'No se pudo consultar la contabilidad. Reintenta en un momento.') { super(message); }
}

export class ConcurrentUpdateError extends AppError {
  readonly code = 'CONCURRENT_UPDATE';
  readonly httpStatus = 409;
  constructor(message = 'Otra persona modificó esto a la vez. Vuelve a cargarlo.') { super(message); }
}

// ── Cartera ──────────────────────────────────────────────────────────────────

export class ReceivableNotFoundError extends AppError {
  readonly code = 'RECEIVABLE_NOT_FOUND';
  readonly httpStatus = 404;
  constructor(message = 'Partida de cartera no encontrada.') { super(message); }
}

export class CustomerNotFoundError extends AppError {
  readonly code = 'CUSTOMER_NOT_FOUND';
  readonly httpStatus = 404;
  constructor(message = 'Cliente no encontrado.') { super(message); }
}

/** Una carga de saldos iniciales por fecha de corte: repetarla duplicaría la cartera. */
export class OpeningBalanceAlreadyLoadedError extends AppError {
  readonly code = 'OPENING_BALANCE_ALREADY_LOADED';
  readonly httpStatus = 409;
  constructor(cutoffDate: string) {
    super(`Ya hay una carga de saldos iniciales con fecha de corte ${cutoffDate}.`);
  }
}

/** La partida tiene cobros aplicados: anularla dejaría el cobro sin respaldo (hay que anular antes el recibo). */
export class ReceivableHasApplicationsError extends AppError {
  readonly code = 'RECEIVABLE_HAS_APPLICATIONS';
  readonly httpStatus = 409;
  constructor(message = 'La partida tiene importes aplicados: hay que anular antes el cobro que la cubrió.') { super(message); }
}

// ── Cobros ───────────────────────────────────────────────────────────────────

export class ReceiptNotFoundError extends AppError {
  readonly code = 'RECEIPT_NOT_FOUND';
  readonly httpStatus = 404;
  constructor(message = 'Cobro no encontrado.') { super(message); }
}

/** Una acción que el estado actual del cobro no permite (editar uno contabilizado, anular un borrador…). */
export class ReceiptStateError extends AppError {
  readonly code = 'INVALID_RECEIPT_STATE';
  readonly httpStatus = 409;
  constructor(message: string) { super(message); }
}

/** El excedente de este cobro (un anticipo) ya lo consumió otro cobro: hay que anular primero ese. */
export class ReceiptAdvanceInUseError extends AppError {
  readonly code = 'RECEIPT_ADVANCE_IN_USE';
  readonly httpStatus = 409;
  constructor(message = 'El anticipo de este cobro ya lo consumió otro cobro: anula primero ese cobro.') { super(message); }
}

/** «Enviar ahora» con los recordatorios apagados: son comunicación externa y solo salen si el Administrador los encendió. */
export class RemindersDisabledError extends AppError {
  readonly code = 'REMINDERS_DISABLED';
  readonly httpStatus = 409;
  constructor(message = 'Los recordatorios de cobro están apagados: actívalos primero en su configuración.') { super(message); }
}
