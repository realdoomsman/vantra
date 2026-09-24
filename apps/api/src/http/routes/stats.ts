// Read-only observatory endpoints (SPEC §8.15, SPEC-V2 §8.1): health, stats, series, events,
// leaderboard, models. The pool routes moved to routes/treasury.ts.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { HealthResponse } from '@vantra/shared';
import type { Deps } from '../../core/interfaces.js';
import { servicesOf } from '../context.js';
import type { StatsCache } from '../stats-cache.js';
import { beforeQuery, limitQuery } from '../validate.js';

const seriesQuery = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) });
const eventsQuery = z.object({ limit: limitQuery(50, 200), before: beforeQuery, agentId: z.string().min(1).max(64).optional() });
const leaderboardQuery = z.object({ by: z.enum(['revenue', 'age', 'profit', 'treasury']).default('revenue'), limit: limitQuery(25, 100) });

export async function statsRoutes(app: FastifyInstance, deps: Deps, stats: StatsCache): Promise<void> {
  const { config } = deps;

  // `payments.simulateEnabled` (SPEC-V2 §5.9) is how the Pending page knows whether to offer the
  // SIMULATE PAYMENT button instead of guessing from the chain mode. `mainAgentId` is the flagship
  // the landing page is built around, resolved by the stats cache (operator override, else the
  // longest-lived living agent), so it is served from there rather than straight off config.
  app.get('/api/health', async (): Promise<HealthResponse> => ({
    ok: true,
    version: config.version,
    demo: config.demo.enabled,
    chain: { mode: deps.chain.mode, cluster: deps.chain.cluster },
    llm: deps.llm.mode,
    sandbox: deps.sandbox.name,
    payments: { mode: deps.chain.mode, simulateEnabled: deps.chain.mode === 'memory' },
    googleAuth: config.auth.google !== null,
    mainAgentId: await stats.mainAgentId(),
    tokenLaunch: config.token.launchEnabled,
  }));

  app.get('/api/stats', async () => stats.get());

  app.get('/api/stats/series', async (request) => {
    const { days } = seriesQuery.parse(request.query);
    return servicesOf(deps).series(days);
  });

  app.get('/api/events', async (request) => servicesOf(deps).events(eventsQuery.parse(request.query)));

  app.get('/api/leaderboard', async (request) => {
    const { by, limit } = leaderboardQuery.parse(request.query);
    return servicesOf(deps).leaderboard(by, limit);
  });

  app.get('/api/models', async () => deps.llm.models());
}
