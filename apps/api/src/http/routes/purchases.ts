// Buying an agent (SPEC-V2 §8.2). Everything a buyer needs before they have an identity:
// the tier table, a quote, a name check, a purchase with a one-time deposit address and a claim
// code, and the claim route that turns that code into the same `rw_session` a wallet gets.
//
// Public on purpose: a purchase id is an unguessable 10-character nanoid and the buyer may have no
// session at all. Nothing here ever returns the deposit secret, the claim-code hash or the owner id
// — `stripSensitive` is a second, independent pass over every purchase payload that leaves.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  ALL_TOOLS, DIRECTIVE_MAX_CHARS, isWalletlessOwnerId,
  type CreatePurchaseResponse, type Me, type NameAvailableResponse, type PurchasePublic,
  type QuoteResponse, type TiersResponse, type ToolName,
} from '@vantra/shared';
import type { Deps } from '../../core/interfaces.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { ownerIdOf, type Auth } from '../auth.js';
import { paymentsOf, servicesOf } from '../context.js';
import { stripSensitive } from '../sanitize.js';
import { idParams, parseBody } from '../validate.js';

// Per-IP budgets (SPEC-V2 §11 D). Creating a purchase mints a keypair and reserves a name; claiming
// is the one credential check an attacker could grind; quoting and the name check are cheap reads.
export const PURCHASE_RATE_LIMIT = { max: 10, timeWindow: '1 minute' } as const;
export const CLAIM_RATE_LIMIT = { max: 10, timeWindow: '1 minute' } as const;
export const QUOTE_RATE_LIMIT = { max: 60, timeWindow: '1 minute' } as const;
export const NAME_AVAILABLE_RATE_LIMIT = { max: 60, timeWindow: '1 minute' } as const;
export const ATTACH_RATE_LIMIT = { max: 20, timeWindow: '1 minute' } as const;

const paceSchema = z.enum(['patient', 'steady', 'eager']);
const pathSchema = z.enum(['deposit', 'wallet']);
const amountSchema = z.number().int().min(1);

const createBody = z.object({
  amountMicro: amountSchema,
  name: z.string().trim().min(1).max(32),
  directive: z.string().trim().min(1).max(DIRECTIVE_MAX_CHARS),
  // Only "is this a tool at all"; whether the chosen tier unlocks it is Payments' call, because the
  // answer changes if the buyer overpays into a higher tier (SPEC-V2 §5.2, §5.3).
  tools: z.array(z.enum(ALL_TOOLS as readonly [ToolName, ...ToolName[]])).max(ALL_TOOLS.length).optional(),
  pace: paceSchema.optional(),
  path: pathSchema.default('deposit'),
  forkOf: z.string().min(1).max(64).optional(),
});
const quoteBody = z.object({ amountMicro: amountSchema, pace: paceSchema.optional() });
const claimBody = z.object({ code: z.string().trim().min(8).max(64) });
const attachBody = z.object({ txSig: z.string().min(1).max(128) });
const simulateBody = z.object({
  amountMicro: amountSchema.optional(),
  ethGwei: z.number().int().min(1).max(1_000_000_000_000).optional(),
});
const nameQuery = z.object({ name: z.string().trim().min(1).max(32) });

// Defence in depth: the buyer's own view of their purchase is the one payload that sits next to the
// deposit secret in the database, so it goes through the sanitizer on the way out.
const publicPurchase = (p: PurchasePublic): PurchasePublic => stripSensitive(p);

export async function purchaseRoutes(app: FastifyInstance, deps: Deps, auth: Auth): Promise<void> {
  const payments = () => paymentsOf(deps);

  app.get('/api/tiers', async (): Promise<TiersResponse> => payments().tiers());

  app.post('/api/quote', { config: { rateLimit: QUOTE_RATE_LIMIT } }, async (request): Promise<QuoteResponse> => {
    const { amountMicro, pace } = quoteBody.parse(request.body);
    return payments().quote(amountMicro, pace);
  });

  app.get(
    '/api/purchases/name-available',
    { config: { rateLimit: NAME_AVAILABLE_RATE_LIMIT } },
    async (request): Promise<NameAvailableResponse> => {
      const { name } = nameQuery.parse(request.query);
      return payments().nameAvailable(name);
    },
  );

  // Public. `path: 'wallet'` is the only variant that needs an identity up front, and it needs a
  // real wallet: a claim identity has nothing to pay from and must use the deposit address.
  app.post(
    '/api/purchases',
    { preHandler: [auth.optionalAuth], config: { rateLimit: PURCHASE_RATE_LIMIT } },
    async (request, reply): Promise<CreatePurchaseResponse> => {
      const body = createBody.parse(request.body);
      let ownerWallet: string | undefined;
      if (body.path === 'wallet') {
        ownerWallet = ownerIdOf(request);
        if (isWalletlessOwnerId(ownerWallet)) {
          throw badRequest('A claim-code or Google identity has no wallet to pay from. Use the deposit address instead.');
        }
      }
      const created = await payments().createPurchase({ ...body, ownerWallet });
      return reply.status(201).send({ purchase: publicPurchase(created.purchase), claimCode: created.claimCode });
    },
  );

  app.get('/api/purchases/:id', async (request): Promise<PurchasePublic> => {
    const { id } = idParams.parse(request.params);
    const purchase = await payments().getPurchase(id);
    if (!purchase) throw notFound('Purchase');
    return publicPurchase(purchase);
  });

  // A buyer who paid from their own wallet can point the server straight at the transaction rather
  // than waiting for the next poll tick.
  app.post('/api/purchases/:id/attach', { config: { rateLimit: ATTACH_RATE_LIMIT } }, async (request): Promise<PurchasePublic> => {
    const { id } = idParams.parse(request.params);
    const { txSig } = attachBody.parse(request.body);
    return publicPurchase(await payments().attachPayment(id, txSig));
  });

  app.post('/api/purchases/:id/cancel', { preHandler: [auth.requireAuth] }, async (request): Promise<PurchasePublic> => {
    const { id } = idParams.parse(request.params);
    return publicPurchase(await payments().cancelPurchase(id, ownerIdOf(request)));
  });

  // The claim code is the only credential on the no-wallet path, so a hit mints exactly the session
  // a wallet would get. A miss, an expired purchase and a refunded one are indistinguishable.
  app.post('/api/claim', { config: { rateLimit: CLAIM_RATE_LIMIT } }, async (request, reply): Promise<Me> => {
    const { code } = claimBody.parse(request.body);
    const { ownerId } = await payments().claim(code);
    await auth.signIn(reply, ownerId);
    return servicesOf(deps).me(ownerId);
  });

  // Memory chain only, exactly like POST /api/auth/demo: fauceting a deposit address is how a local
  // tester buys an agent with no chain and no money (SPEC-V2 §5.9).
  if (deps.chain.mode === 'memory') {
    app.post('/api/purchases/:id/simulate-pay', async (request): Promise<PurchasePublic> => {
      const { id } = idParams.parse(request.params);
      const { amountMicro, ethGwei } = parseBody(simulateBody, request);
      return publicPurchase(await payments().simulatePay(id, amountMicro, ethGwei));
    });
  }
}
