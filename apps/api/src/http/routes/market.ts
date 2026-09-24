// Bounties and services market (SPEC §8.15). Escrow / payment signatures are verified by Services.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../../core/interfaces.js';
import { forbidden, notFound } from '../../lib/errors.js';
import { ownerIdOf, sessionRateKey, type Auth } from '../auth.js';
import { servicesOf } from '../context.js';
import { idParams } from '../validate.js';

const BOUNTY_STATUSES = ['open', 'claimed', 'submitted', 'paid', 'rejected', 'cancelled', 'expired'] as const;

// Both of these verify a signature against the chain before they do anything, and both are the money
// paths a burst of concurrent requests would aim at. The database settles the races
// (`bounties_escrow_tx_uq`, `service_calls_payment_tx_uq`); this keeps the RPC bill sane.
export const POST_BOUNTY_RATE_LIMIT = { max: 10, timeWindow: '1 minute', keyGenerator: sessionRateKey } as const;
export const CALL_SERVICE_RATE_LIMIT = { max: 30, timeWindow: '1 minute', keyGenerator: sessionRateKey } as const;

const bountiesQuery = z.object({ status: z.enum(BOUNTY_STATUSES).optional() });
const postBountyBody = z.object({
  title: z.string().trim().min(3).max(120),
  description: z.string().trim().min(1).max(4000),
  rewardMicro: z.number().int().positive(),
  deadlineHours: z.number().int().min(1).max(336),
  escrowTxSig: z.string().min(1).max(128),
});
const reviewBody = z.object({ approve: z.boolean(), feedback: z.string().max(2000).default('') });
const callServiceBody = z.object({ input: z.unknown(), paymentTxSig: z.string().min(1).max(128) });

export async function marketRoutes(app: FastifyInstance, deps: Deps, auth: Auth): Promise<void> {
  const authed = { preHandler: [auth.requireAuth] };

  app.get('/api/market/bounties', async (request) => {
    const { status } = bountiesQuery.parse(request.query);
    return servicesOf(deps).bounties(status);
  });

  app.post('/api/market/bounties', { ...authed, config: { rateLimit: POST_BOUNTY_RATE_LIMIT } }, async (request) => {
    const body = postBountyBody.parse(request.body);
    return servicesOf(deps).postBounty({ posterType: 'user', posterWallet: ownerIdOf(request), ...body });
  });

  app.post('/api/market/bounties/:id/review', authed, async (request) => {
    const { id } = idParams.parse(request.params);
    const { approve, feedback } = reviewBody.parse(request.body);
    const ownerId = ownerIdOf(request);
    const services = servicesOf(deps);
    const bounty = (await services.bounties()).find((b) => b.id === id);
    if (!bounty) throw notFound('Bounty');
    if (bounty.posterType !== 'user' || bounty.posterId !== ownerId) throw forbidden('Only the poster can review this bounty');
    return services.reviewBounty(id, ownerId, approve, feedback);
  });

  app.get('/api/market/services', async () => servicesOf(deps).services());

  app.post('/api/market/services/:id/call', { ...authed, config: { rateLimit: CALL_SERVICE_RATE_LIMIT } }, async (request) => {
    const { id } = idParams.parse(request.params);
    const { input, paymentTxSig } = callServiceBody.parse(request.body);
    return servicesOf(deps).callService(id, { type: 'user', wallet: ownerIdOf(request), paymentTxSig }, input);
  });
}
