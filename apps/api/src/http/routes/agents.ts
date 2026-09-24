// Agent routes (SPEC §8.15, SPEC-V2 §8.1). Owner actions resolve the agent first so a non-owner
// gets 403 and an unknown id 404 before any service call; business rules live in Services.
//
// v2: there is no free spawn and no seed retry — an agent only ever comes into existence through a
// paid purchase (routes/purchases.ts). Ownership is decided by `services.isOwner(id, ownerId)`
// against the agent row, never by comparing to `AgentPublic.ownerWallet`, which is null for an
// owner who holds a claim code rather than a wallet.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  MAX_HEARTBEAT_MIN, MIN_HEARTBEAT_MIN,
  type AgentDetail, type AgentLiveState, type AgentPublic, type OkResponse, type TopUpResponse,
} from '@vantra/shared';
import type { Deps } from '../../core/interfaces.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { isWalletAddress, ownerIdOf, sessionRateKey, type Auth } from '../auth.js';
import { paymentsOf, servicesOf } from '../context.js';
import { sanitizeTranscript, stripSensitive } from '../sanitize.js';
import { beforeQuery, idParams, limitQuery, parseBody } from '../validate.js';

const listQuery = z.object({
  status: z.enum(['alive', 'dead', 'all']).optional(),
  sort: z.enum(['treasury', 'revenue', 'age', 'profit', 'runway', 'born']).default('treasury'),
  dir: z.enum(['asc', 'desc']).default('desc'),
  q: z.string().trim().max(64).optional(),
  limit: limitQuery(50, 200),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
  owner: z.string().min(1).max(64).optional(),
});
const ledgerQuery = z.object({ limit: limitQuery(100, 500), before: beforeQuery });
const stepsQuery = z.object({ limit: limitQuery(30, 200) });
const agentEventsQuery = z.object({ limit: limitQuery(50, 200), before: beforeQuery });
const transcriptParams = idParams.extend({ stepId: z.coerce.number().int().positive() });
const graveyardQuery = z.object({ limit: limitQuery(100, 500), sort: z.enum(['recent', 'age', 'revenue']).default('recent') });

const heartbeatSchema = z.number().int().min(MIN_HEARTBEAT_MIN).max(MAX_HEARTBEAT_MIN);
const walletSchema = z.string().trim().refine(isWalletAddress, 'Invalid wallet address');
const withdrawBody = z.object({
  amountMicro: z.number().int().positive().optional(),
  payoutWallet: walletSchema.optional(),      // required once for a claim owner (SPEC-V2 §6.1)
});
const pauseBody = z.object({ paused: z.boolean() });
const terminateBody = z.object({ confirm: z.string().max(64) });
const patchBody = z.object({ shareStrategy: z.boolean().optional(), heartbeatMin: heartbeatSchema.optional() })
  .refine((b) => b.shareStrategy !== undefined || b.heartbeatMin !== undefined, 'Nothing to update');
const messageBody = z.object({ text: z.string().trim().min(1).max(1000) });
const recapitalizeBody = z.object({ txSig: z.string().min(1).max(128) });
const launchTokenBody = z.object({ ticker: z.string().trim().max(10).optional() });
const topUpBody = z.object({
  amountMicro: z.number().int().min(1),
  path: z.enum(['deposit', 'wallet']).default('deposit'),
});

// A top-up mints a keypair and reserves a deposit address, so it is capped per session the way
// POST /api/purchases is capped per IP.
export const TOPUP_RATE_LIMIT = { max: 10, timeWindow: '1 minute', keyGenerator: sessionRateKey } as const;

interface Owned { agent: AgentDetail; ownerId: string }

export async function agentRoutes(app: FastifyInstance, deps: Deps, auth: Auth): Promise<void> {
  const services = () => servicesOf(deps);
  const authed = { preHandler: [auth.requireAuth] };

  // Loads the agent for an owner-only action: 401 signed out, 404 unknown, 403 someone else's.
  async function ownedAgent(request: FastifyRequest): Promise<Owned> {
    const ownerId = ownerIdOf(request);
    const { id } = idParams.parse(request.params);
    const agent = await services().getAgent(id, ownerId);
    if (!agent) throw notFound('Agent');
    if (!(await services().isOwner(id, ownerId))) throw forbidden('Only the owner can do that');
    return { agent, ownerId };
  }

  app.get('/api/agents', async (request) => {
    const q = listQuery.parse(request.query);
    return services().listAgents({ ...q, status: q.status ?? (q.owner ? 'all' : 'alive') });
  });

  app.get('/api/graveyard', async (request) => {
    const { limit, sort } = graveyardQuery.parse(request.query);
    return services().graveyard(limit, sort);
  });

  app.get('/api/agents/:id', { preHandler: [auth.optionalAuth] }, async (request) => {
    const { id } = idParams.parse(request.params);
    const agent = await services().getAgent(id, request.ownerId);
    if (!agent) throw notFound('Agent');
    return agent;
  });

  app.get('/api/agents/:id/ledger', async (request) => {
    const { id } = idParams.parse(request.params);
    return services().ledger(id, ledgerQuery.parse(request.query));
  });

  app.get('/api/agents/:id/steps', async (request) => {
    const { id } = idParams.parse(request.params);
    const { limit } = stepsQuery.parse(request.query);
    return services().steps(id, limit);
  });

  // The control board's in-flight view (SPEC-V2 §7.5): what the agent is doing right now, including
  // the tool calls of the step that has not finished yet. Public — it is the same data the WS
  // broadcasts, served to a page that just loaded.
  app.get('/api/agents/:id/live', async (request): Promise<AgentLiveState> => {
    const { id } = idParams.parse(request.params);
    return stripSensitive(await services().agentLive(id));
  });

  // Public (C25), but the owner-private sections of the STATUS block and of message_owner are
  // redacted for everyone except the owner (C21).
  app.get('/api/agents/:id/steps/:stepId/transcript', { preHandler: [auth.optionalAuth] }, async (request) => {
    const { id, stepId } = transcriptParams.parse(request.params);
    const view = await services().stepTranscript(id, stepId, request.ownerId);
    if (!view) throw notFound('Transcript');
    return sanitizeTranscript(view.transcript, { ownerView: view.ownerView });
  });

  app.get('/api/agents/:id/events', async (request) => {
    const { id } = idParams.parse(request.params);
    const { limit, before } = agentEventsQuery.parse(request.query);
    return services().events({ limit, before, agentId: id });
  });

  app.post('/api/agents/:id/withdraw', authed, async (request) => {
    const { agent, ownerId } = await ownedAgent(request);
    const { amountMicro, payoutWallet } = parseBody(withdrawBody, request);
    return services().withdraw(agent.id, ownerId, amountMicro, payoutWallet);
  });

  app.post('/api/agents/:id/revive', authed, async (request) => {
    const { agent, ownerId } = await ownedAgent(request);
    return services().revive(agent.id, ownerId);
  });

  app.post('/api/agents/:id/recapitalize', authed, async (request) => {
    const { agent, ownerId } = await ownedAgent(request);
    const { txSig } = recapitalizeBody.parse(request.body);
    return services().recapitalize(agent.id, ownerId, txSig);
  });

  // TOP UP FROM ANYWHERE: a fresh deposit address for an agent that already exists. Works for a
  // claim owner and a wallet owner alike; the founder fee applies exactly as it does at purchase.
  app.post(
    '/api/agents/:id/topup',
    { ...authed, config: { rateLimit: TOPUP_RATE_LIMIT } },
    async (request): Promise<TopUpResponse> => {
      const { agent, ownerId } = await ownedAgent(request);
      const { amountMicro, path } = topUpBody.parse(request.body);
      const purchase = await paymentsOf(deps).topUp(agent.id, ownerId, amountMicro, path);
      return { purchase: stripSensitive(purchase) };
    },
  );

  app.post('/api/agents/:id/pause', authed, async (request) => {
    const { agent, ownerId } = await ownedAgent(request);
    const { paused } = pauseBody.parse(request.body);
    return services().pause(agent.id, ownerId, paused);
  });

  app.post('/api/agents/:id/terminate', authed, async (request) => {
    const { agent, ownerId } = await ownedAgent(request);
    const { confirm } = terminateBody.parse(request.body);
    const expected = `TERMINATE ${agent.name}`;
    if (confirm !== expected) throw badRequest(`Type "${expected}" to confirm`, 'CONFIRM_MISMATCH');
    return services().terminate(agent.id, ownerId);
  });

  app.post('/api/agents/:id/launch-token', authed, async (request) => {
    const { agent, ownerId } = await ownedAgent(request);
    const { ticker } = launchTokenBody.parse(request.body);
    return services().launchToken(agent.id, ownerId, ticker);
  });

  app.patch('/api/agents/:id', authed, async (request) => {
    const { agent, ownerId } = await ownedAgent(request);
    const { shareStrategy, heartbeatMin } = patchBody.parse(request.body);
    let updated: AgentPublic = agent;
    if (shareStrategy !== undefined) updated = await services().setShareStrategy(agent.id, ownerId, shareStrategy);
    if (heartbeatMin !== undefined) updated = await services().setHeartbeat(agent.id, ownerId, heartbeatMin);
    return updated;
  });

  app.post('/api/agents/:id/message', authed, async (request): Promise<OkResponse> => {
    const { agent, ownerId } = await ownedAgent(request);
    const { text } = messageBody.parse(request.body);
    await services().messageAgent(agent.id, ownerId, text);
    return { ok: true };
  });
}
