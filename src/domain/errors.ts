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

// ── Cuentas por pagar y pagos ────────────────────────────────────────────────

export class PayableNotFoundError extends AppError {
  readonly code = 'PAYABLE_NOT_FOUND';
  readonly httpStatus = 404;
  constructor(message = 'Deuda con el proveedor no encontrada.') { super(message); }
}

export class PaymentNotFoundError extends AppError {
  readonly code = 'PAYMENT_NOT_FOUND';
  readonly httpStatus = 404;
  constructor(message = 'Pago no encontrado.') { super(message); }
}

/** Una acción que el estado actual del pago no permite (editar uno contabilizado, anular un borrador, contabilizar sin la aprobación…). */
export class PaymentStateError extends AppError {
  readonly code = 'INVALID_PAYMENT_STATE';
  readonly httpStatus = 409;
  constructor(message: string) { super(message); }
}

/** El pago llega al umbral de aprobación y todavía no lo aprobó otra persona. */
export class PaymentApprovalRequiredError extends AppError {
  readonly code = 'PAYMENT_APPROVAL_REQUIRED';
  readonly httpStatus = 409;
  constructor(message = 'Este pago llega al umbral de aprobación: otra persona debe aprobarlo antes de contabilizarlo.') { super(message); }
}

/** Separación de funciones: quien creó el pago no lo aprueba (ni quien lo aprobó puede ser el mismo que lo creó). */
export class PaymentSelfApprovalError extends AppError {
  readonly code = 'PAYMENT_SELF_APPROVAL';
  readonly httpStatus = 403;
  constructor(message = 'Quien creó el pago no puede aprobarlo: debe hacerlo otra persona.') { super(message); }
}

/** El excedente de este pago (un anticipo) ya lo consumió otro pago: hay que anular primero ese. */
export class PaymentAdvanceInUseError extends AppError {
  readonly code = 'PAYMENT_ADVANCE_IN_USE';
  readonly httpStatus = 409;
  constructor(message = 'El anticipo de este pago ya lo consumió otro pago: anula primero ese pago.') { super(message); }
}


// ── Bancos, extractos y conciliación ─────────────────────────────────────────

export class BankAccountNotFoundError extends AppError {
  readonly code = 'BANK_ACCOUNT_NOT_FOUND';
  readonly httpStatus = 404;
  constructor(message = 'Cuenta bancaria no encontrada.') { super(message); }
}

export class BankMovementNotFoundError extends AppError {
  readonly code = 'BANK_MOVEMENT_NOT_FOUND';
  readonly httpStatus = 404;
  constructor(message = 'Movimiento bancario no encontrado.') { super(message); }
}

export class BankStatementLineNotFoundError extends AppError {
  readonly code = 'BANK_LINE_NOT_FOUND';
  readonly httpStatus = 404;
  constructor(message = 'Renglón del extracto no encontrado.') { super(message); }
}

export class BankReconciliationNotFoundError extends AppError {
  readonly code = 'BANK_RECONCILIATION_NOT_FOUND';
  readonly httpStatus = 404;
  constructor(message = 'Conciliación no encontrada.') { super(message); }
}

/** El mismo archivo ya se importó en esta cuenta (el hash de su contenido es único por cuenta). */
export class BankStatementAlreadyImportedError extends AppError {
  readonly code = 'BANK_STATEMENT_ALREADY_IMPORTED';
  readonly httpStatus = 409;
  constructor(message = 'Este extracto ya se importó en esta cuenta.') { super(message); }
}

/** Un emparejamiento que no cuadra o que el estado de las partes no permite (otra persona ya lo emparejó, importes distintos…). */
export class BankMatchError extends AppError {
  readonly code = 'BANK_MATCH_INVALID';
  readonly httpStatus = 409;
  constructor(message: string, details?: ErrorDetail[]) { super(message, details); }
}

/** Lo que se quiere cambiar ya está dentro de una conciliación cerrada: hay que reabrirla primero. */
export class BankReconciledError extends AppError {
  readonly code = 'BANK_RECONCILED';
  readonly httpStatus = 409;
  constructor(message = 'Esto ya está dentro de una conciliación cerrada: reábrela primero.') { super(message); }
}

export class BankReconciliationStateError extends AppError {
  readonly code = 'INVALID_RECONCILIATION_STATE';
  readonly httpStatus = 409;
  constructor(message: string) { super(message); }
}
