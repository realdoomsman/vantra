// The launchpad (launchpad spec §5). The directory and a coin's detail are public; creating a launch
// needs a wallet session; confirming, simulating a launch and switching the model are the dev's alone —
// Services checks the session's owner id against `launch.devWallet` with `sameAddress`. The two
// simulate routes exist only on the memory chain, exactly like POST /api/purchases/:id/simulate-pay.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  STRATEGY_PRESETS,
  type LaunchDetail, type LaunchListResponse, type LaunchPrepareResponse, type LaunchPublic, type StrategyPreset,
} from '@vantra/shared';
import type { Deps } from '../../core/interfaces.js';
import {
  LAUNCH_DESCRIPTION_MAX, LAUNCH_INSTRUCTIONS_MAX, LAUNCH_LIST_MAX, LAUNCH_NAME_MAX, LAUNCH_URL_MAX, SIMULATE_FEES_MAX_USD,
} from '../../economy/launch.js';
import { notFound } from '../../lib/errors.js';
import { ownerIdOf, sessionRateKey, type Auth } from '../auth.js';
import { servicesOf } from '../context.js';
import { idParams, limitQuery } from '../validate.js';

// Preparing a launch mints a keypair and an agent, so it is capped per session like buying one.
export const LAUNCH_RATE_LIMIT = { max: 10, timeWindow: '1 minute', keyGenerator: sessionRateKey } as const;
export const CONFIRM_RATE_LIMIT = { max: 20, timeWindow: '1 minute', keyGenerator: sessionRateKey } as const;

const STRATEGY_IDS = STRATEGY_PRESETS.map((p) => p.id) as [StrategyPreset, ...StrategyPreset[]];

// Shape only; every business rule (ticker alphabet, the live tax cap, URL forms, the logo being the
// dev's own upload, "at least one of strategy/instructions") is Services'. Optional text accepts null,
// '' or an absent key.
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();
const prepareBody = z.object({
  name: z.string().trim().min(1).max(LAUNCH_NAME_MAX),
  ticker: z.string().trim().min(2).max(11),
  description: z.string().trim().max(LAUNCH_DESCRIPTION_MAX).default(''),
  logoImageId: optionalText(64),
  website: optionalText(LAUNCH_URL_MAX),
  twitter: optionalText(LAUNCH_URL_MAX),
  telegram: optionalText(LAUNCH_URL_MAX),
  creatorTaxBps: z.number().int().min(0),
  strategy: z.enum(STRATEGY_IDS).nullable().optional(),
  instructions: optionalText(LAUNCH_INSTRUCTIONS_MAX),
});
const listQuery = z.object({
  sort: z.enum(['new', 'fees', 'burned', 'runway']).default('new'),
  limit: limitQuery(50, LAUNCH_LIST_MAX),
  offset: z.coerce.number().int().min(0).default(0),
});
const confirmBody = z.object({ txSig: z.string().trim().min(1).max(128) });
const modelBody = z.object({ model: z.string().trim().min(1).max(128) });
const simulateFeesBody = z.object({ amountUsd: z.number().positive().max(SIMULATE_FEES_MAX_USD) });

export async function launchRoutes(app: FastifyInstance, deps: Deps, auth: Auth): Promise<void> {
  const services = () => servicesOf(deps);
  const authed = { preHandler: [auth.requireAuth] };

  app.get('/api/launches', async (request): Promise<LaunchListResponse> => services().listLaunches(listQuery.parse(request.query)));

  app.get('/api/launches/:id', async (request): Promise<LaunchDetail> => {
    const { id } = idParams.parse(request.params);
    const detail = await services().launchDetail(id);
    if (!detail) throw notFound('Launch');
    return detail;
  });

  // The agent profile asks whether this agent is a coin's AI; 404 means it was bought, not launched.
  app.get('/api/agents/:id/launch', async (request): Promise<LaunchDetail> => {
    const { id } = idParams.parse(request.params);
    const detail = await services().agentLaunch(id);
    if (!detail) throw notFound('Launch');
    return detail;
  });

  app.post(
    '/api/launches',
    { ...authed, config: { rateLimit: LAUNCH_RATE_LIMIT } },
    async (request, reply): Promise<LaunchPrepareResponse> => {
      const body = prepareBody.parse(request.body);
      const prepared = await services().prepareLaunch(ownerIdOf(request), {
        name: body.name, ticker: body.ticker, description: body.description,
        logoImageId: body.logoImageId ?? null, website: body.website ?? null,
        twitter: body.twitter ?? null, telegram: body.telegram ?? null,
        creatorTaxBps: body.creatorTaxBps, strategy: body.strategy ?? null, instructions: body.instructions ?? null,
      });
      return reply.status(201).send(prepared);
    },
  );

  app.post(
    '/api/launches/:id/confirm',
    { ...authed, config: { rateLimit: CONFIRM_RATE_LIMIT } },
    async (request): Promise<LaunchPublic> => {
      const { id } = idParams.parse(request.params);
      const { txSig } = confirmBody.parse(request.body);
      return services().confirmLaunch(id, ownerIdOf(request), txSig);
    },
  );

  app.post('/api/launches/:id/model', authed, async (request): Promise<LaunchPublic> => {
    const { id } = idParams.parse(request.params);
    const { model } = modelBody.parse(request.body);
    return services().setLaunchModel(id, ownerIdOf(request), model);
  });

  // Memory chain only: a local tester launches a coin and pays it fees with no chain and no wallet.
  if (deps.chain.mode === 'memory') {
    app.post('/api/launches/:id/simulate-launch', authed, async (request): Promise<LaunchPublic> => {
      const { id } = idParams.parse(request.params);
      return services().simulateLaunch(id, ownerIdOf(request));
    });

    app.post('/api/launches/:id/simulate-fees', async (request): Promise<LaunchPublic> => {
      const { id } = idParams.parse(request.params);
      const { amountUsd } = simulateFeesBody.parse(request.body);
      return services().simulateLaunchFees(id, amountUsd);
    });
  }
}
