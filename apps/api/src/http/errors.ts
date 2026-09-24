// Every failure leaves as `{ error: { code, message } }` (SPEC §8.15), including Fastify's own
// parser/limit errors and rate-limit rejections. 5xx details stay in the log.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import type { ApiErrorBody } from '@vantra/shared';
import { errorMessage, isApiError } from '../lib/errors.js';
import type { Logger } from '../lib/log.js';

const CODE_BY_STATUS: Record<number, string> = {
  400: 'BAD_REQUEST', 401: 'UNAUTHORIZED', 403: 'FORBIDDEN', 404: 'NOT_FOUND', 405: 'METHOD_NOT_ALLOWED',
  409: 'CONFLICT', 413: 'PAYLOAD_TOO_LARGE', 415: 'UNSUPPORTED_MEDIA_TYPE', 429: 'RATE_LIMITED', 503: 'UNAVAILABLE',
};

// Paths that are never a page of the web app, so a miss is a JSON 404 rather than the SPA shell.
const NON_PAGE_PREFIXES = ['/api/', '/ws', '/sites/', '/svc/'];

export const envelope = (code: string, message: string): ApiErrorBody => ({ error: { code, message } });

export function toErrorResponse(err: unknown, log: Logger): { status: number; body: ApiErrorBody } {
  if (isApiError(err)) return { status: err.status, body: err.toBody() };
  if (err instanceof ZodError) return { status: 400, body: envelope('BAD_REQUEST', formatZod(err)) };
  const status = statusOf(err);
  if (status >= 500) {
    log.error({ err }, 'unhandled request error');
    return { status, body: envelope('INTERNAL', 'Internal error') };
  }
  return { status, body: envelope(CODE_BY_STATUS[status] ?? 'BAD_REQUEST', errorMessage(err)) };
}

function statusOf(err: unknown): number {
  const code = (err as { statusCode?: unknown })?.statusCode;
  return typeof code === 'number' && code >= 400 && code <= 599 ? code : 500;
}

function formatZod(err: ZodError): string {
  return err.issues.map((i) => `${i.path.join('.') || 'value'}: ${i.message}`).join('; ');
}

export function isPageRequest(request: FastifyRequest): boolean {
  if (request.method !== 'GET') return false;
  const path = request.url.split('?')[0] ?? '';
  if (NON_PAGE_PREFIXES.some((p) => path.startsWith(p) || path === p.replace(/\/$/, ''))) return false;
  return (request.headers.accept ?? '').includes('text/html');
}

export function registerErrorHandling(app: FastifyInstance, log: Logger, opts: { spaFallback: boolean }): void {
  app.setErrorHandler((err: unknown, _request: FastifyRequest, reply: FastifyReply) => {
    const { status, body } = toErrorResponse(err, log);
    return reply.status(status).send(body);
  });
  app.setNotFoundHandler((request, reply) => {
    // A deep link into the SPA is a real page, not a miss: serve the shell with 200 and let the router decide.
    if (opts.spaFallback && isPageRequest(request)) {
      return reply.code(200).header('cache-control', 'no-cache').sendFile('index.html');
    }
    return reply.status(404).send(envelope('NOT_FOUND', `${request.method} ${request.url.split('?')[0]} not found`));
  });
}
