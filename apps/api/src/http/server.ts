// Fastify app assembly (SPEC §8.14–§8.16, AMENDMENTS C25/C27): CORS for PUBLIC_URL with credentials,
// signed cookies, per-route rate limits, CSRF guard, security headers, JSON error envelope, WS,
// API routes, hosted agent sites and (in production) the built web app with SPA fallback.
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance, type onRequestAsyncHookHandler } from 'fastify';
import { CLIENT_HEADER, CLIENT_HEADER_VALUE } from '@vantra/shared';
import type { Deps } from '../core/interfaces.js';
import { registerHosting } from '../hosting/index.js';
import { ApiError, badRequest, forbidden } from '../lib/errors.js';
import { createAuth, type AuthStore } from './auth.js';
import { createDbAuthStore } from './auth-store.js';
import { registerErrorHandling } from './errors.js';
import { agentRoutes } from './routes/agents.js';
import { authRoutes } from './routes/auth.js';
import { googleAuthRoutes } from './routes/googleAuth.js';
import { launchRoutes } from './routes/launches.js';
import { marketRoutes } from './routes/market.js';
import { meRoutes } from './routes/me.js';
import { purchaseRoutes } from './routes/purchases.js';
import { statsRoutes } from './routes/stats.js';
import { rpcRoutes } from './routes/rpc.js';
import { treasuryRoutes } from './routes/treasury.js';
import { registerWebApp } from './static.js';
import { createStatsCache } from './stats-cache.js';
import { registerWs } from './ws.js';

export const BODY_LIMIT_BYTES = 256 * 1024;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export type HostingPlugin = (app: FastifyInstance, deps: Deps) => Promise<void>;

export interface AppOptions {
  hosting?: HostingPlugin | null;   // default: hosting/registerHosting; null skips it (tests)
  authStore?: AuthStore;            // default: the db-backed store
  webDist?: string;                 // default: apps/web/dist (production only)
}

export async function createApp(deps: Deps, opts: AppOptions = {}): Promise<FastifyInstance> {
  const { config } = deps;
  const log = deps.log.child({ mod: 'http' });
  const allowedOrigins = [...new Set([config.publicUrl, config.apiUrl])];

  // Fastify's own logger stays off; failures are logged through deps.log by the error handler.
  const app = Fastify({ logger: false, bodyLimit: BODY_LIMIT_BYTES, trustProxy: config.isProduction });
  registerJsonParser(app);

  await app.register(cors, {
    origin: allowedOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type', CLIENT_HEADER],
  });
  await app.register(cookie, { secret: config.sessionSecret });
  await app.register(rateLimit, {
    global: false,
    errorResponseBuilder: (_request, ctx) => new ApiError(429, 'RATE_LIMITED', `Too many requests, retry in ${ctx.after}`),
  });
  const spaFallback = config.isProduction ? await registerWebApp(app, log, opts.webDist) : false;
  registerErrorHandling(app, log, { spaFallback });

  app.decorateRequest('ownerId', null);
  app.addHook('onRequest', securityHeaders(config.isProduction));
  app.addHook('onRequest', csrfGuard(allowedOrigins));

  const auth = createAuth(config, opts.authStore ?? createDbAuthStore(deps.db));
  const stats = createStatsCache(deps);
  app.addHook('onClose', async () => stats.close());

  await registerWs(app, deps, stats);
  await authRoutes(app, deps, auth);
  await googleAuthRoutes(app, deps, auth);
  await meRoutes(app, deps, auth);
  await purchaseRoutes(app, deps, auth);
  await agentRoutes(app, deps, auth);
  await launchRoutes(app, deps, auth);
  await marketRoutes(app, deps, auth);
  await statsRoutes(app, deps, stats);
  await treasuryRoutes(app, deps);
  await rpcRoutes(app, deps);

  const hosting = opts.hosting === undefined ? registerHosting : opts.hosting;
  if (hosting) await app.register(async (child) => hosting(child, deps));

  return app;
}

// `fetch()` sends `content-type: application/json` even for a bodiless POST (revive, retry-seed,
// logout), so an empty body means "no fields" rather than a malformed request.
function registerJsonParser(app: FastifyInstance): void {
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser<string>('application/json', { parseAs: 'string' }, (_request, body, done) => {
    const text = body.trim();
    if (text === '') return done(null, {});
    try {
      done(null, JSON.parse(text));
    } catch {
      done(badRequest('Body is not valid JSON'), undefined);
    }
  });
}

function securityHeaders(isProduction: boolean): onRequestAsyncHookHandler {
  return async (request, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'strict-origin-when-cross-origin');
    reply.header('permissions-policy', 'camera=(), microphone=(), geolocation=()');
    if (isProduction) reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
    const path = pathOf(request.url);
    if (path.startsWith('/api/')) {
      reply.header('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
      reply.header('x-frame-options', 'DENY');
    } else if (!path.startsWith('/sites/')) {
      reply.header('x-frame-options', 'DENY');   // hosted agent sites may be embedded; the app may not
    }
  };
}

function csrfGuard(allowedOrigins: string[]): onRequestAsyncHookHandler {
  return async (request) => {
    if (SAFE_METHODS.has(request.method) || !pathOf(request.url).startsWith('/api/')) return;
    if (request.headers[CLIENT_HEADER] !== CLIENT_HEADER_VALUE) throw forbidden(`Missing ${CLIENT_HEADER} header`);
    const origin = request.headers.origin;
    if (origin && !allowedOrigins.includes(origin.replace(/\/+$/, ''))) throw forbidden('Cross-origin request rejected');
    // Hosted agent sites share this origin unless the operator gave them their own hostname. Their
    // CSP sandbox already strips them of it, but a page that somehow kept it must still not be able
    // to spend a visitor's session (hosting/static.ts:SITE_CSP).
    if (isFromHostedSite(request.headers.referer)) throw forbidden('Requests from hosted agent sites are rejected');
  };
}

function isFromHostedSite(referer: string | undefined): boolean {
  if (!referer) return false;
  try {
    return new URL(referer).pathname.startsWith('/sites/');
  } catch {
    return false;
  }
}

const pathOf = (url: string): string => url.split('?')[0] ?? url;
