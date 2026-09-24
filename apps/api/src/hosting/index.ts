import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Deps } from '../core/interfaces.js';
import { isApiError } from '../lib/errors.js';
import type { Logger } from '../lib/log.js';
import { type DeployContext, type DeployResult, createDeploymentStore, deploySite } from './deploy.js';
import {
  type LedgerHook, type PaymentRefund, type ServiceInvoker, createServiceInvoker, createServiceRunner, createServiceStore,
} from './service.js';
import { wakeSoon } from '../runtime/wake.js';
import { registerSites } from './static.js';
import { registerServiceEndpoint } from './svc.js';

// The seller's compute cost per handler run must be posted by economy/ledger.ts (the only writer of
// treasury columns), which is built after hosting. The integration agent supplies it either as an option
// here or by assigning `deps.hostingLedger` on the container's Deps object; it is read at call time.
export interface HostingDeps extends Deps { hostingLedger?: LedgerHook; hostingRefund?: PaymentRefund }
export interface HostingOptions { ledger?: LedgerHook; refund?: PaymentRefund }

export const sitesDirOf = (dataDir: string): string => path.join(dataDir, 'sites');

// GET /sites/:slug/* static hosting of deployed agent sites and POST /svc/:serviceId service endpoints. SPEC §8.15.
// Registered by http/server.ts as a Fastify plugin (before `ready()`) so hosting and the API share one listener.
export async function registerHosting(app: FastifyInstance, deps: Deps, opts: HostingOptions = {}): Promise<void> {
  const sitesDir = sitesDirOf(deps.config.dataDir);
  await mkdir(sitesDir, { recursive: true });
  const log = deps.log.child({ mod: 'hosting' });
  const runner = createServiceRunner(
    { sandbox: deps.sandbox, chain: deps.chain, clock: deps.clock, log, onSold: (agentId) => wakeSoon(deps, agentId, 'service_call') },
    createServiceStore(deps.db),
    lateLedgerHook(deps, opts),
    lateRefund(deps, opts),
  );

  await app.register(async (scope) => {
    scope.setErrorHandler(hostingErrorHandler(log));
    registerSites(scope, { sitesDir });
    registerServiceEndpoint(scope, { runner, secret: deps.config.sessionSecret, clock: deps.clock });
  });
}

// Everything the deploy_site tool needs, built from the container deps.
export function deployContext(deps: Deps): DeployContext {
  return {
    sandbox: deps.sandbox,
    store: createDeploymentStore(deps.db),
    sitesDir: sitesDirOf(deps.config.dataDir),
    sitesBaseUrl: deps.config.sitesBaseUrl,
    clock: deps.clock,
    log: deps.log.child({ mod: 'hosting' }),
  };
}

// Satisfies tools/ports.ts:DeployPort for the deploy_site tool (and the dead-site cleanup job via removeSite).
export function deployPort(deps: Deps): { deploySite(agentId: string, dir: string, slug: string): Promise<DeployResult> } {
  const ctx = deployContext(deps);
  return { deploySite: (agentId, dir, slug) => deploySite(ctx, agentId, dir, slug) };
}

// Satisfies tools/ports.ts:InternalServiceInvoker for the call_service tool.
export function serviceInvoker(deps: Deps, opts: HostingOptions = {}): ServiceInvoker {
  return createServiceInvoker({ sandbox: deps.sandbox, log: deps.log.child({ mod: 'hosting' }) }, lateLedgerHook(deps, opts));
}

// Resolves the ledger hook on every post so wiring it after construction still works.
function lateLedgerHook(deps: Deps, opts: HostingOptions): LedgerHook {
  return async (agentId, kind, amountMicro, memo, meta) => {
    const hook = opts.ledger ?? (deps as HostingDeps).hostingLedger;
    if (!hook) throw new Error('hosting: no ledger hook wired (set deps.hostingLedger or pass { ledger })');
    await hook(agentId, kind, amountMicro, memo, meta);
  };
}

// Same late binding for the refund transfer: it needs the agent key store, built after hosting.
function lateRefund(deps: Deps, opts: HostingOptions): PaymentRefund {
  return async (sellerAgentId, toWallet, amountMicro, memo) => {
    const hook = opts.refund ?? (deps as HostingDeps).hostingRefund;
    if (!hook) throw new Error('hosting: no refund port wired (set deps.hostingRefund or pass { refund })');
    return hook(sellerAgentId, toWallet, amountMicro, memo);
  };
}

export function hostingErrorHandler(log: Logger) {
  return (err: FastifyError | Error, req: FastifyRequest, reply: FastifyReply) => {
    if (isApiError(err)) return reply.code(err.status).send(err.toBody());
    const status = (err as FastifyError).statusCode;
    if (status !== undefined && status >= 400 && status < 500) {
      return reply.code(status).send({ error: { code: status === 413 ? 'PAYLOAD_TOO_LARGE' : 'BAD_REQUEST', message: err.message } });
    }
    log.error({ err, url: req.url }, 'hosting request failed');
    return reply.code(500).send({ error: { code: 'INTERNAL', message: 'Internal error' } });
  };
}

export { SITE_MAX_BYTES, createDeploymentStore, deploySite, removeSite, siteUrl, type DeployContext, type DeployResult, type DeploymentStore } from './deploy.js';
export { INTERNAL_CALL_HEADER, INTERNAL_CALL_TTL_MS, signInternalCall, verifyInternalCall } from './internal.js';
export {
  PAYMENT_MAX_AGE_MS, SERVICE_INPUT_MAX_BYTES, SERVICE_OUTPUT_MAX_BYTES, SERVICE_TIMEOUT_MS, createServiceInvoker,
  createServiceRunner, createServiceStore, sellerComputeMicro,
  type LedgerHook, type PaymentRefund, type ServiceCallOutcome, type ServiceCaller, type ServiceInvocation,
  type ServiceInvoker, type ServiceRunner, type ServiceStore,
} from './service.js';
export { SITE_ALLOWED_EXTENSIONS, SITE_CSP, SLUG_RE, isAllowedSiteFile, registerSites } from './static.js';
export { registerServiceEndpoint } from './svc.js';
