// The signed-in identity (SPEC-V2 §6, §8.1). One shape for both credentials: a wallet session and
// a claim-code session return the same `Me`, differing only in `ownerKind` and where money can be
// withdrawn to.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { CustodialWallet, CustodialWithdrawResponse, Me } from '@vantra/shared';
import type { Deps } from '../../core/interfaces.js';
import { isWalletAddress, ownerIdOf, sessionRateKey, type Auth } from '../auth.js';
import { servicesOf } from '../context.js';

// A claim owner has no pubkey of their own, so this is the one place they name where a withdrawal
// should land. Capped per session: it writes, and it is the only owner-settings route.
export const PAYOUT_WALLET_RATE_LIMIT = { max: 10, timeWindow: '1 minute', keyGenerator: sessionRateKey } as const;
// Withdrawals move real money and each one costs the treasury a fee, so they are rate limited per session.
export const WITHDRAW_RATE_LIMIT = { max: 6, timeWindow: '1 minute', keyGenerator: sessionRateKey } as const;

const payoutWalletBody = z.object({
  wallet: z.string().trim().refine(isWalletAddress, 'Invalid wallet address'),
});

const withdrawBody = z.object({
  to: z.string().trim().refine(isWalletAddress, 'Invalid wallet address'),
  amountMicro: z.number().int().positive(),
});

export async function meRoutes(app: FastifyInstance, deps: Deps, auth: Auth): Promise<void> {
  app.get('/api/me', { preHandler: [auth.requireAuth] }, async (request): Promise<Me> =>
    servicesOf(deps).me(ownerIdOf(request)));

  app.post(
    '/api/me/payout-wallet',
    { preHandler: [auth.requireAuth], config: { rateLimit: PAYOUT_WALLET_RATE_LIMIT } },
    async (request): Promise<Me> => {
      const { wallet } = payoutWalletBody.parse(request.body);
      return servicesOf(deps).setPayoutWallet(ownerIdOf(request), wallet);
    },
  );

  app.get('/api/me/wallet', { preHandler: [auth.requireAuth] }, async (request): Promise<CustodialWallet> =>
    servicesOf(deps).custodialWallet(ownerIdOf(request)));

  app.post(
    '/api/me/withdraw',
    { preHandler: [auth.requireAuth], config: { rateLimit: WITHDRAW_RATE_LIMIT } },
    async (request): Promise<CustodialWithdrawResponse> => {
      const { to, amountMicro } = withdrawBody.parse(request.body);
      return servicesOf(deps).withdrawCustodial(ownerIdOf(request), to, amountMicro);
    },
  );
}
