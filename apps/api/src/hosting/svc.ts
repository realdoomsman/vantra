// POST /svc/:serviceId — public service endpoint. SPEC §8.15.
// Auth is the payment: header `x-payment-tx` (USDC tx to the seller wallet ≥ price) or a signed internal marker.
import type { FastifyInstance } from 'fastify';
import { SERVICE_PAYMENT_HEADER, type CallServiceResponse } from '@vantra/shared';
import type { Clock } from '../core/interfaces.js';
import { ApiError } from '../lib/errors.js';
import { INTERNAL_CALL_HEADER, verifyInternalCall } from './internal.js';
import { SERVICE_INPUT_MAX_BYTES, type ServiceCaller, type ServiceRunner } from './service.js';

export interface ServiceEndpointOptions { runner: ServiceRunner; secret: string; clock: Clock }

export function registerServiceEndpoint(app: FastifyInstance, opts: ServiceEndpointOptions): void {
  app.post<{ Params: { serviceId: string }; Reply: CallServiceResponse }>(
    '/svc/:serviceId',
    // Anyone may post here, and an unpaid call still costs us a chain lookup, so cap it per IP.
    // The config key is inert unless @fastify/rate-limit is registered in a parent scope.
    { bodyLimit: SERVICE_INPUT_MAX_BYTES, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const { serviceId } = req.params;
      const caller = resolveCaller(header(req.headers[SERVICE_PAYMENT_HEADER]), header(req.headers[INTERNAL_CALL_HEADER]), serviceId, opts);
      const outcome = await opts.runner.call(serviceId, caller, req.body ?? null);
      return reply.code(200).send({ output: outcome.output, status: outcome.status });
    },
  );
}

function header(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function resolveCaller(paymentTx: string | undefined, internal: string | undefined, serviceId: string, opts: ServiceEndpointOptions): ServiceCaller {
  if (paymentTx) return { type: 'user', paymentTxSig: paymentTx };
  if (internal) {
    const claims = verifyInternalCall(opts.secret, internal, serviceId, opts.clock.now().getTime());
    if (!claims) throw new ApiError(401, 'UNAUTHORIZED', 'invalid or expired internal call token');
    return { type: 'agent', agentId: claims.agentId };
  }
  throw new ApiError(402, 'PAYMENT_REQUIRED', `payment required: pass the USDC payment tx signature in the ${SERVICE_PAYMENT_HEADER} header`);
}
