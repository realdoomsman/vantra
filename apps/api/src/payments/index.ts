// The payments service (SPEC-V2 §5.1): the whole purchase lifecycle behind the `Payments` contract
// declared in core/interfaces.ts. `createPayments` owns the deposit poller's lifetime; every other
// method is a thin, typed wrapper over one of the modules beside it.
import { claimOwnerId, isClaimOwnerId, type Micro, type Pace, type PurchasePath, type PurchasePublic } from '@vantra/shared';
import type { Payments } from '../core/interfaces.js';
import { users } from '../db/schema.js';
import { ApiError, badRequest, conflict, notFound } from '../lib/errors.js';
import { verifyClaimCode } from './claim.js';
import type { PaymentsDeps } from './deps.js';
import { createDepositPoller, type DepositPoller } from './poller.js';
import {
  cancelPurchase, createPurchase, getPurchase, nameAvailable, toPublic, topUp,
} from './purchase.js';
import { quotePurchase, tiersResponse } from './quote.js';
import { listOpenByOwner, loadPurchase, updatePurchase } from './repo.js';

// Every rejection of a claim code says exactly this, whatever went wrong: a wrong code, an unknown
// code and a dead purchase must be indistinguishable or the endpoint becomes an oracle.
const CLAIM_REJECTED = 'That claim code is not valid.';

export function createPayments(deps: PaymentsDeps): Payments {
  const poller: DepositPoller = createDepositPoller(deps);

  const publicOf = async (id: string): Promise<PurchasePublic> => {
    const row = await loadPurchase(deps.db, id);
    if (!row) throw notFound('Purchase');
    return toPublic(deps, row);
  };

  return {
    async start() {
      poller.start();
    },
    async stop() {
      poller.stop();
    },

    createPurchase: (input) => createPurchase(deps, input),
    getPurchase: (id) => getPurchase(deps, id),

    async listPurchases(ownerId) {
      const rows = await listOpenByOwner(deps.db, ownerId);
      return rows.map((row) => toPublic(deps, row));
    },

    async cancelPurchase(id, ownerId) {
      await cancelPurchase(deps, id, ownerId);
      await poller.pollOne(id);        // expiring now: refund anything above dust, sweep the rest
      return publicOf(id);
    },

    // A wallet buyer telling us about their own transfer. We verify it credited this purchase's
    // deposit address and then let the ordinary poll path do the rest.
    async attachPayment(id, txSig) {
      const row = await loadPurchase(deps.db, id);
      if (!row) throw notFound('Purchase');
      if (row.status !== 'pending') {
        if (row.status === 'received' && !row.agentId) await poller.pollOne(id);
        return toPublic(deps, row);
      }
      const transfer = await deps.chain.getUsdcTransfer(txSig);
      if (!transfer) throw badRequest('That transaction could not be found or is not a USDC transfer', 'INVALID_TX');
      if (transfer.to !== row.depositPubkey) {
        throw badRequest('That transaction did not pay this purchase', 'INVALID_TX');
      }
      if (!row.refundTo) await updatePurchase(deps.db, id, { refundTo: transfer.from });
      await poller.pollOne(id);
      return publicOf(id);
    },

    // CHAIN_MODE=memory only: the local payment simulator behind POST /api/purchases/:id/simulate-pay.
    async simulatePay(id, amountMicro, ethGwei) {
      if (deps.chain.mode !== 'memory' || !deps.chain.faucet) throw notFound('Simulated payment');
      const row = await loadPurchase(deps.db, id);
      if (!row) throw notFound('Purchase');
      if (row.status !== 'pending') throw conflict('CONFLICT', `This purchase is already ${row.status}`);
      const amount = assertSimAmount(amountMicro ?? row.quotedMicro, 'amountMicro');
      if (amount > 0) await deps.chain.faucet(row.depositPubkey, amount, 'sim-buyer');
      if (ethGwei !== undefined && assertSimAmount(ethGwei, 'ethGwei') > 0) {
        if (!deps.chain.faucetEth) throw notFound('Simulated payment');
        await deps.chain.faucetEth(row.depositPubkey, ethGwei);
      }
      await poller.pollOne(id);
      return publicOf(id);
    },

    topUp: (agentId, ownerId, amountMicro: Micro, path: PurchasePath) => topUp(deps, agentId, ownerId, amountMicro, path),

    quote: (amountMicro: Micro, pace?: Pace) => quotePurchase(deps, { amountMicro, ...(pace ? { pace } : {}) }),
    tiers: () => tiersResponse(deps),
    nameAvailable: (name) => nameAvailable(deps, name),

    // The claim code is the only credential on the no-wallet path. A hit mints (or re-uses) the owner
    // row so a buyer can claim before their money has even landed.
    async claim(code) {
      const row = await verifyClaimCode(deps.db, code, deps.config.sessionSecret);
      if (!row) throw new ApiError(401, 'INVALID_CLAIM_CODE', CLAIM_REJECTED);
      const ownerId = row.ownerId ?? claimOwnerId(row.id);
      const now = deps.clock.now();
      await deps.db.insert(users).values({
        wallet: ownerId,
        kind: isClaimOwnerId(ownerId) ? 'claim' : 'wallet',
        purchaseId: isClaimOwnerId(ownerId) ? row.id : null,
        createdAt: now,
        lastLoginAt: now,
      }).onConflictDoNothing({ target: users.wallet });
      return { ownerId };
    },

    pollNow: async (purchaseId) => (purchaseId ? poller.pollOne(purchaseId) : poller.tick()),
  };
}

function assertSimAmount(value: number, what: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw badRequest(`${what} must be a non-negative integer`);
  return value;
}

// The surface payments/ offers the rest of the server. `repo.ts` is deliberately not re-exported:
// the `purchases` table is written here and nowhere else.
export { createDepositPoller, DEPOSIT_POLL_BATCH, DEPOSIT_POLL_MIN_MS, type DepositPoller } from './poller.js';
export { fulfil, MAX_FULFIL_ATTEMPTS } from './fulfil.js';
export { generateClaimCode, hashClaimCode, verifyClaimCode } from './claim.js';
export { quotePurchase, tiersResponse, modelForTier, type ServerQuote } from './quote.js';
export { ownerIdOfPurchase, toPublic as purchaseToPublic } from './purchase.js';
export type { PaymentsDeps } from './deps.js';
