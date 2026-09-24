// In-memory Payments for the HTTP tests. Same recording/failOnce shape as FakeServices.
//
// `getPurchase` deliberately returns an object carrying the three fields that must never leave the
// process — `claimCode`, `ownerId`, `depositSecretEnc` — so `GET /api/purchases/:id` is proved to
// strip them rather than merely never being handed them.
import {
  FOUNDER_FEE_BPS_DEFAULT, MAX_PURCHASE_MICRO, MIN_PURCHASE_MICRO, claimOwnerId, normalizeClaimCode,
  quoteFor, tierForMicro, DEFAULT_CATALOG,
  type Micro, type NameAvailableResponse, type Pace, type PurchasePublic, type PurchaseQuote,
  type TiersResponse,
} from '@vantra/shared';
import type { CreatePurchaseInput, Payments } from '../../../src/core/interfaces.js';
import { ApiError, notFound } from '../../../src/lib/errors.js';
import { CLAIM_CODE, PURCHASE_ID, makePurchase, makeTiers } from './fixtures.js';

const mockFast = DEFAULT_CATALOG.find((m) => m.id === 'mock-fast')!;

export interface RecordedPaymentCall { method: keyof Payments; args: unknown[] }

export interface FakePayments extends Payments {
  calls: RecordedPaymentCall[];
  purchases: Map<string, PurchasePublic>;
  /** Codes that resolve to an owner id. Anything else is an INVALID_CLAIM_CODE, with one message. */
  codes: Map<string, string>;
  lastClaimCode: string | null;
  failOnce(method: keyof Payments, err: Error): void;
  callsTo(method: keyof Payments): RecordedPaymentCall[];
}

// The shape the real repo row would have if a careless `toPublic` leaked it.
const leaky = (p: PurchasePublic): PurchasePublic =>
  ({ ...p, claimCode: 'RW-LEAK-LEAK-LEAK-LEAK', ownerId: claimOwnerId(p.id), depositSecretEnc: 'deadbeef' } as PurchasePublic);

export function createFakePayments(): FakePayments {
  const failures = new Map<keyof Payments, Error>();
  const purchases = new Map<string, PurchasePublic>([[PURCHASE_ID, makePurchase()]]);
  const codes = new Map<string, string>([[normalizeClaimCode(CLAIM_CODE), claimOwnerId(PURCHASE_ID)]]);

  const fake = {
    calls: [] as RecordedPaymentCall[],
    purchases,
    codes,
    lastClaimCode: null as string | null,
    failOnce: (method: keyof Payments, err: Error) => { failures.set(method, err); },
    callsTo: (method: keyof Payments) => fake.calls.filter((c) => c.method === method),
  } as FakePayments;

  const get = (id: string): PurchasePublic => {
    const p = purchases.get(id);
    if (!p) throw notFound('Purchase');
    return p;
  };

  const quote = (amountMicro: Micro, pace?: Pace): PurchaseQuote & { diesOn: string | null } => {
    const q = quoteFor({ amountMicro, feeBps: FOUNDER_FEE_BPS_DEFAULT, model: mockFast, pace });
    return { ...q, diesOn: q.runwayDays === null ? null : '2026-11-08T00:00:00.000Z' };
  };

  const impl: Payments = {
    async start() { /* no poller in tests */ },
    async stop() { /* no poller in tests */ },

    async createPurchase(input: CreatePurchaseInput) {
      if (input.amountMicro < MIN_PURCHASE_MICRO) throw new ApiError(400, 'BELOW_MINIMUM', 'Minimum purchase is $10');
      if (input.amountMicro > MAX_PURCHASE_MICRO) throw new ApiError(400, 'ABOVE_MAXIMUM', 'Maximum purchase is $1,000');
      const id = `pu_${String(purchases.size).padStart(10, 'b')}`;
      const q = quote(input.amountMicro, input.pace);
      const purchase = makePurchase({
        id, path: input.path, agentName: input.name.toUpperCase(),
        quotedMicro: input.amountMicro, feeMicro: q.feeMicro, fundingMicro: q.fundingMicro,
        quotedTierId: tierForMicro(input.amountMicro).id, quote: q,
      });
      purchases.set(id, purchase);
      // Only the deposit path mints a claim code: a wallet buyer already has a session.
      const claimCode = input.path === 'wallet' ? null : CLAIM_CODE;
      if (claimCode) {
        codes.set(normalizeClaimCode(claimCode), claimOwnerId(id));
        fake.lastClaimCode = claimCode;
      }
      return { purchase: leaky(purchase), claimCode };
    },

    async getPurchase(id) {
      const p = purchases.get(id);
      return p ? leaky(p) : null;
    },
    async listPurchases() { return [...purchases.values()]; },
    async cancelPurchase(id) { return { ...get(id), status: 'expired' }; },
    async attachPayment(id) { return { ...get(id), status: 'received', receivedMicro: get(id).quotedMicro }; },
    async simulatePay(id, amountMicro) {
      const p = get(id);
      return { ...p, status: 'spawned', receivedMicro: amountMicro ?? p.quotedMicro, agentId: 'ag_spawned000' };
    },
    async topUp(agentId, _ownerId, amountMicro) {
      return makePurchase({ id: 'pu_topup00000', kind: 'topup', topupAgentId: agentId, quotedMicro: amountMicro, agentName: null });
    },
    quote(amountMicro, pace) { return quote(amountMicro, pace); },
    tiers(): TiersResponse { return makeTiers(); },
    async nameAvailable(name): Promise<NameAvailableResponse> {
      const taken = name.trim().toUpperCase() === 'ALPHA';
      return { name: name.trim().toUpperCase(), available: !taken, reason: taken ? 'That name is taken' : null };
    },
    async claim(code) {
      const ownerId = codes.get(normalizeClaimCode(code));
      if (!ownerId) throw new ApiError(401, 'INVALID_CLAIM_CODE', 'That claim code is not valid.');
      return { ownerId };
    },
    async pollNow() { /* no poller in tests */ },
  };

  for (const method of Object.keys(impl) as (keyof Payments)[]) {
    const original = impl[method] as (...args: unknown[]) => unknown;
    (fake as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => {
      fake.calls.push({ method, args });
      const err = failures.get(method);
      if (err) {
        failures.delete(method);
        // `quote`/`tiers` are synchronous, so the failure must throw rather than reject.
        throw err;
      }
      return original.apply(impl, args);
    };
  }
  return fake;
}
