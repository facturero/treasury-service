import { type Context, type MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { runWithActor } from '@facturero/outbox-relay';
import {
  AppError,
  ForbiddenError,
  OrganizationContextRequiredError,
  UserContextRequiredError,
} from '../../domain/errors.js';

export type ContextVariables = {
  organizationId: string;
  userId: string;
  countryCode: string;
  permissions: string[];
};

export function contextMiddleware(): MiddlewareHandler<{
  Variables: ContextVariables;
}> {
  return async (c, next) => {
    const orgId = c.req.header('X-Organization-Id');
    const userId = c.req.header('X-User-Id');
    const countryCode = c.req.header('X-Country-Code');
    const perms = c.req.header('X-Permissions');

    if (orgId) c.set('organizationId', orgId);
    if (userId) c.set('userId', userId);
    if (countryCode) c.set('countryCode', countryCode);
    if (perms) c.set('permissions', perms.split(',').map((p) => p.trim()));

    // Quien actúa viaja en un contexto asíncrono hasta el outbox: así CADA
    // evento publicado durante esta petición lleva actor/ip/request-id sin que
    // los casos de uso tengan que arrastrarlos uno a uno.
    await runWithActor(
      {
        actorId: userId ?? null,
        actorEmail: c.req.header('X-User-Email') ?? null,
        actorIp: c.req.header('X-Client-Ip') ?? null,
        requestId: c.req.header('X-Request-Id') ?? null,
      },
      () => next(),
    );
  };
}

export function requireOrganization(): MiddlewareHandler<{
  Variables: ContextVariables;
}> {
  return async (c, next) => {
    const orgId = c.get('organizationId');
    if (!orgId) throw new OrganizationContextRequiredError();
    await next();
  };
}

export function requireUser(): MiddlewareHandler<{
  Variables: ContextVariables;
}> {
  return async (c, next) => {
    const userId = c.get('userId');
    if (!userId) throw new UserContextRequiredError();
    await next();
  };
}

export function requirePermission(perm: string): MiddlewareHandler<{
  Variables: ContextVariables;
}> {
  return async (c, next) => {
    const perms = c.get('permissions') ?? [];
    if (!perms.includes(perm)) throw new ForbiddenError();
    await next();
  };
}

/** Un UNIQUE de MySQL que no se anticipó (p. ej. dos cargas de saldos con la misma fecha de corte) no es un 500. */
function isUniqueConstraintError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { name?: string }).name === 'SequelizeUniqueConstraintError';
}

/** Interbloqueo o espera de bloqueo agotada: dos operaciones tocaron lo mismo a la vez. Es reintentable, no un fallo del servidor. */
function isConcurrencyError(err: unknown): boolean {
  const e = err as { parent?: { code?: string }; original?: { code?: string } } | null;
  const code = e?.parent?.code ?? e?.original?.code;
  return code === 'ER_LOCK_DEADLOCK' || code === 'ER_LOCK_WAIT_TIMEOUT';
}

export function errorHandler(err: Error, c: Context): Response {
  if (err instanceof AppError) {
    // `@hono/otel` marca como error del span todo lo que llega a `onError`,
    // incluso un 404 o una validación fallida. En el servidor solo los 5xx son
    // error; el 4xx normal de negocio se limpia aquí.
    if (err.httpStatus < 500) c.error = undefined;
    return c.json(
      {
        code: err.code,
        message: err.message,
        ...(err.details ? { details: err.details } : {}),
      },
      err.httpStatus as 400,
    );
  }

  if (isUniqueConstraintError(err)) {
    c.error = undefined;
    return c.json({ code: 'CONFLICT', message: 'Ya existe un registro con esos datos.' }, 409);
  }

  // El validador de Hono lanza `HTTPException` (400) cuando el cuerpo no es JSON: es un error del cliente, no una avería.
  // Sin esto caía al final como «error no controlado» y respondía 500.
  if (err instanceof HTTPException && err.status < 500) {
    c.error = undefined;
    return c.json({ code: err.status === 400 ? 'INVALID_JSON' : 'BAD_REQUEST', message: err.status === 400 ? 'El cuerpo no es JSON válido.' : err.message }, err.status);
  }

  // Un cuerpo que no es JSON válido lo manda el cliente, no el servidor: es un 400, no un 500 que parezca avería.
  // (Este servicio no llama a `JSON.parse` en su código, así que un SyntaxError aquí solo puede venir del cuerpo.)
  if (err instanceof SyntaxError && err.name === 'SyntaxError') {
    c.error = undefined;
    return c.json({ code: 'INVALID_JSON', message: 'El cuerpo no es JSON válido.' }, 400);
  }

  if (isConcurrencyError(err)) {
    c.error = undefined;
    return c.json({ code: 'CONCURRENT_UPDATE', message: 'Otra operación estaba modificando lo mismo. Vuelve a intentarlo.' }, 409);
  }

  console.error('[treasury-service] error no controlado:', err);
  return c.json({ code: 'INTERNAL_ERROR', message: 'Error interno del servidor.' }, 500);
}
