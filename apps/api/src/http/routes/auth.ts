// The wallet credential (SPEC §8.14, SPEC-V2 §6.1): nonce → personal_sign → session cookie; logout;
// demo sign-in when DEMO=1. The other credential — a claim code — mints the same cookie from
// routes/purchases.ts; both resolve to an OWNER ID, which is all `Services` ever sees.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AuthNonceResponse, OkResponse } from '@vantra/shared';
import type { Deps } from '../../core/interfaces.js';
import { canonicalWallet, isWalletAddress, SIGNATURE_RE, type Auth } from '../auth.js';
import { servicesOf } from '../context.js';

export const AUTH_RATE_LIMIT = { max: 20, timeWindow: '1 minute' } as const;

// Every address that reaches the store is canonicalized here, so the nonce issued for one spelling
// is found again by any other spelling of the same address (EIP-55 casing is not identity).
const walletSchema = z.string().trim().refine(isWalletAddress, 'Invalid wallet address').transform(canonicalWallet);
const nonceQuery = z.object({ wallet: walletSchema });
const verifyBody = z.object({
  wallet: walletSchema,
  // Shape, not length: an ECDSA signature is exactly `0x` + 130 hex, and anything else can be
  // rejected before it reaches recovery.
  signature: z.string().regex(SIGNATURE_RE, 'Invalid signature'),
  message: z.string().min(1).max(512),
});
// Demo owners are `demo-wallet-<n>` (SPEC §8.18), not real pubkeys.
const demoBody = z.object({ wallet: z.string().regex(/^[A-Za-z0-9_-]{3,64}$/, 'Invalid demo wallet') });

export async function authRoutes(app: FastifyInstance, deps: Deps, auth: Auth): Promise<void> {
  const limited = { config: { rateLimit: AUTH_RATE_LIMIT } };

  app.get('/api/auth/nonce', limited, async (request): Promise<AuthNonceResponse> => {
    const { wallet } = nonceQuery.parse(request.query);
    return { message: await auth.issueNonce(wallet) };
  });

  app.post('/api/auth/verify', limited, async (request, reply) => {
    const body = verifyBody.parse(request.body);
    await auth.verifySignIn(body);
    await auth.signIn(reply, body.wallet);
    return servicesOf(deps).me(body.wallet);
  });

  app.post('/api/auth/logout', async (request, reply): Promise<OkResponse> => {
    await auth.signOut(request, reply);
    return { ok: true };
  });

  if (deps.config.demo.enabled) {
    app.post('/api/auth/demo', async (request, reply) => {
      const { wallet } = demoBody.parse(request.body);
      await auth.signIn(reply, wallet);
      return servicesOf(deps).me(wallet);
    });
  }
}
