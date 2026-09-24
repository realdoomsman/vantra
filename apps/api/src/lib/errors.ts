import type { ApiErrorBody, ApiErrorCode } from '@vantra/shared';

// Thrown by services and routes; the HTTP layer maps it to `{ error: { code, message } }` with `status`.
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ApiErrorCode | string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  toBody(): ApiErrorBody {
    return { error: { code: this.code, message: this.message } };
  }
}

export const isApiError = (e: unknown): e is ApiError => e instanceof ApiError;

/**
 * A configuration problem the operator has to fix, thrown by config.ts and core/preflight.ts. The
 * message is the whole report and is written to be read by the person who owns the .env — so the
 * boot handler prints it alone. A JavaScript stack trace pointing into dist/ tells that reader
 * nothing and buries the one paragraph that matters.
 */
export class ConfigError extends Error {
  readonly operatorFacing = true;
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export const isConfigError = (e: unknown): e is ConfigError => e instanceof ConfigError;

export const badRequest = (message: string, code: ApiErrorCode | string = 'BAD_REQUEST', details?: unknown) => new ApiError(400, code, message, details);
export const unauthorized = (message = 'Sign in required') => new ApiError(401, 'UNAUTHORIZED', message);
export const forbidden = (message = 'Not allowed') => new ApiError(403, 'FORBIDDEN', message);
export const notFound = (what = 'Resource') => new ApiError(404, 'NOT_FOUND', `${what} not found`);
export const conflict = (code: ApiErrorCode | string, message: string) => new ApiError(409, code, message);
export const rateLimited = (message = 'Too many requests') => new ApiError(429, 'RATE_LIMITED', message);
export const internal = (message = 'Internal error') => new ApiError(500, 'INTERNAL', message);

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// Postgres 23505. Several invariants the application also checks (one live agent per wallet, one
// bounty per escrow deposit, one call per payment tx) are races the database settles, so their
// callers turn the violation back into the 409 the caller was expecting. Returns the constraint name
// ('' when the driver did not report one), or null when this was not a unique violation.
interface PgErrorLike { code?: unknown; constraint?: unknown; cause?: { code?: unknown; constraint?: unknown } }
export function uniqueViolation(e: unknown): string | null {
  const info = (e ?? {}) as PgErrorLike;
  const code = info.code ?? info.cause?.code;
  if (code !== '23505') return null;
  const constraint = info.constraint ?? info.cause?.constraint;
  return typeof constraint === 'string' ? constraint : '';
}
