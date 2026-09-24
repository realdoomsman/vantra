// The treasury and its ledger (SPEC-V2 §8.3), replacing the v1 pool routes in stats.ts.
// Public: the wallet that receives the net of every purchase and funds every agent is the one
// number a buyer most needs to be able to check without asking anyone.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { TreasuryPublic, TreasuryTx } from '@vantra/shared';
import type { Deps } from '../../core/interfaces.js';
import { servicesOf } from '../context.js';
import { beforeQuery, limitQuery } from '../validate.js';

const treasuryTxsQuery = z.object({ limit: limitQuery(50, 500), before: beforeQuery });

export async function treasuryRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  app.get('/api/treasury', async (): Promise<TreasuryPublic> => servicesOf(deps).treasury());

  app.get('/api/treasury/txs', async (request): Promise<TreasuryTx[]> =>
    servicesOf(deps).treasuryTxs(treasuryTxsQuery.parse(request.query)));
}
