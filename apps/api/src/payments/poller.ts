// The deposit poller (SPEC-V2 §5.3): the only thing that decides a purchase has been paid.
//
// It runs on its own interval — it never touches runtime/scheduler.ts — and walks pending purchases
// oldest first, one at a time, because every tick costs RPC calls. What it learns is always persisted
// (`amount_micro`, `usdc_micro`, `eth_gwei`, `refund_to`), which is what lets the Pending page say
// "received $4.00 of $10.00 — send $6.00 more" instead of just spinning.
import {
  DEPOSIT_ETH_MIN_GWEI, MIN_TOPUP_MICRO, SWEEP_DUST_MICRO, bpsOf, fmtUsd, paceHeartbeat, tierById,
  tierForMicro, type Micro, type ToolName,
} from '@vantra/shared';
import { shortAddr } from '../chain/verify.js';
import { getProtocolWallets } from '../chain/wallets.js';
import { decryptSecret, wipeSecret } from '../chain/keys.js';
import { gweiToMicro } from '../chain/price.js';
import { addEvent } from '../economy/events.js';
import { treasuryService } from '../economy/treasury.js';
import type { SweepOut } from '../core/interfaces.js';
import type { PurchaseRow } from '../db/schema.js';
import { errorMessage } from '../lib/errors.js';
import type { PaymentsDeps } from './deps.js';
import { fulfil, MAX_FULFIL_ATTEMPTS } from './fulfil.js';
import { modelForTier } from './quote.js';
import { duePurchases, loadPurchase, stalledFulfilments, transition, updatePurchase } from './repo.js';

export const DEPOSIT_POLL_BATCH = 25;
export const DEPOSIT_POLL_MIN_MS = { memory: 0, robinhood: 8_000 } as const;
const REFUND_SENDER_SCAN = 10;

export interface DepositPoller {
  start(): void;
  stop(): void;
  /** One pass over the due purchases plus any fulfilment that is still owed. */
  tick(): Promise<void>;
  /** Everything a tick would do, for one purchase, now. Used by simulate-pay, attach and tests. */
  pollOne(purchaseId: string): Promise<void>;
}

interface Observed {
  usdcMicro: Micro;
  ethGwei: number;
  ethValueMicro: Micro;
  ethPriceUsd: number;
  grossMicro: Micro;
  refundTo: string | null;
}

export function createDepositPoller(deps: PaymentsDeps): DepositPoller {
  const minIntervalMs = DEPOSIT_POLL_MIN_MS[deps.chain.mode];
  let timer: NodeJS.Timeout | null = null;
  let running = false;

  async function tick(): Promise<void> {
    if (running) return;              // a slow chain must never stack ticks on top of each other
    running = true;
    try {
      const now = deps.clock.now();
      const handled = new Set<string>();
      for (const row of await duePurchases(deps.db, now, minIntervalMs, DEPOSIT_POLL_BATCH)) {
        handled.add(row.id);
        await step(row).catch((e) => deps.log.warn({ purchaseId: row.id, err: e }, 'deposit poll failed'));
      }
      // Money that arrived but has not become an agent yet: retry until MAX_FULFIL_ATTEMPTS. One attempt
      // per tick — a purchase this tick already tried waits for the next one.
      for (const row of await stalledFulfilments(deps.db, MAX_FULFIL_ATTEMPTS, DEPOSIT_POLL_BATCH)) {
        if (handled.has(row.id)) continue;
        await fulfil(deps, row.id).catch((e) => deps.log.warn({ purchaseId: row.id, err: e }, 'fulfilment retry failed'));
      }
    } finally {
      running = false;
    }
  }

  async function pollOne(purchaseId: string): Promise<void> {
    const row = await loadPurchase(deps.db, purchaseId);
    if (!row) return;
    if (row.status === 'pending') await step(row);
    else if (row.status === 'received' && !row.agentId) await fulfil(deps, row.id);
  }

  /** One purchase: look at the chain, persist what is there, then receive, expire, or wait. */
  async function step(row: PurchaseRow): Promise<void> {
    const seen = await observe(row);
    const now = deps.clock.now();
    const patch = {
      usdcMicro: seen.usdcMicro,
      ethGwei: seen.ethGwei,
      ethValueMicro: seen.ethValueMicro,
      ethPriceUsd: seen.ethPriceUsd,
      amountMicro: seen.grossMicro,
      lastPolledAt: now,
      ...(row.refundTo === null && seen.refundTo ? { refundTo: seen.refundTo } : {}),
    };
    const updated = await updatePurchase(deps.db, row.id, patch);

    if (seen.grossMicro >= receiveFloor(deps, updated)) {
      await receive(updated, seen);
      return;
    }
    if (updated.expiresAt.getTime() <= now.getTime()) await expire(updated, seen);
  }

  async function observe(row: PurchaseRow): Promise<Observed> {
    const usdcMicro = await deps.chain.getUsdcBalance(row.depositPubkey);
    const ethGwei = deps.config.chain.acceptEthDeposits ? await deps.chain.getEthBalance(row.depositPubkey) : 0;
    const ethPriceUsd = ethGwei > 0 ? await deps.chain.ethPriceUsd() : row.ethPriceUsd;
    // Dust ETH is ignored: below the floor it is not a payment, it is a rounding remainder.
    const ethValueMicro = ethGwei >= DEPOSIT_ETH_MIN_GWEI ? gweiToMicro(ethGwei, ethPriceUsd) : 0;
    let refundTo = row.refundTo;
    if (!refundTo && usdcMicro > 0) {
      const inflows = await deps.chain.listUsdcInflows(row.depositPubkey, null, REFUND_SENDER_SCAN);
      refundTo = inflows.at(-1)?.from ?? null;      // newest first, so the last row is the first sender
    }
    return { usdcMicro, ethGwei, ethValueMicro, ethPriceUsd, grossMicro: usdcMicro + ethValueMicro, refundTo };
  }

  // ---- receive -------------------------------------------------------------

  /**
   * The tier is derived from what actually arrived, not from what was quoted: overpaying upgrades the
   * buyer, and the fee, the funding, the model and the heartbeat are all recomputed from the gross.
   */
  async function receive(row: PurchaseRow, seen: Observed): Promise<void> {
    const isTopUp = row.kind === 'topup';
    const tier = isTopUp ? tierForMicro(row.quotedMicro) : tierForMicro(seen.grossMicro);
    const feeMicro = bpsOf(seen.grossMicro, row.feeBps);
    const fundingMicro = seen.grossMicro - feeMicro;
    const model = modelForTier(deps, tier);
    const heartbeatMin = deps.config.economy.heartbeatOverrideMin ?? paceHeartbeat(tier, fundingMicro, model, row.pace);

    const received = await transition(deps.db, row.id, ['pending'], {
      status: 'received',
      amountMicro: seen.grossMicro,
      usdcMicro: seen.usdcMicro,
      ethGwei: seen.ethGwei,
      ethValueMicro: seen.ethValueMicro,
      ethPriceUsd: seen.ethPriceUsd,
      feeMicro,
      fundingMicro,
      ...(isTopUp ? {} : {
        tier: tier.id,
        model: model.id,
        effort: tier.effort,
        heartbeatMin,
        tools: upgradeTools(row.tools, row.quotedTier, tier.id),
      }),
    });
    if (!received) return;            // another worker received it first
    deps.log.info(
      { purchaseId: row.id, status: 'received', grossMicro: seen.grossMicro, tier: received.tier ?? tier.id },
      'purchase received',
    );
    await fulfil(deps, row.id);
  }

  // ---- expire / refund -----------------------------------------------------

  async function expire(row: PurchaseRow, seen: Observed): Promise<void> {
    if (seen.grossMicro === 0) {
      await finish(row, 'expired', {});
      deps.log.info({ purchaseId: row.id, status: 'expired', grossMicro: 0, tier: row.tier }, 'purchase expired unpaid');
      return;
    }
    const refundable = seen.grossMicro >= SWEEP_DUST_MICRO && !!row.refundTo;
    const wallets = getProtocolWallets(deps.config);
    const destination = refundable ? row.refundTo! : wallets.treasury.pubkey;
    let sig: string | null = null;
    try {
      sig = await drain(row, seen, destination);
    } catch (e) {
      // Leave the row pending with its secret intact: a failed sweep must never lose the money.
      deps.log.error({ purchaseId: row.id, err: e }, 'expiry sweep failed; leaving the deposit in place');
      await updatePurchase(deps.db, row.id, { spawnError: `sweep failed: ${errorMessage(e)}` });
      return;
    }

    if (refundable) {
      await finish(row, 'refunded', { refundSig: sig });
      await addEvent(deps, deps.db, {
        kind: 'purchase', amountMicro: seen.grossMicro,
        text: `Underpaid purchase refunded: ${fmtUsd(seen.grossMicro)} back to ${shortAddr(row.refundTo!)}`,
        meta: { purchaseId: row.id, refundTo: row.refundTo },
      });
      deps.log.info({ purchaseId: row.id, status: 'refunded', grossMicro: seen.grossMicro, tier: row.tier }, 'purchase refunded');
      return;
    }
    if (seen.usdcMicro > 0) await treasuryService(deps).recordInflow('sweep', seen.usdcMicro, sig, null);
    await finish(row, 'expired', { sweepSig: sig });
    deps.log.info({ purchaseId: row.id, status: 'expired', grossMicro: seen.grossMicro, tier: row.tier }, 'purchase expired; residue swept');
  }

  /** Empties the deposit address to one destination. The treasury pays the fees, so nothing is left behind. */
  async function drain(row: PurchaseRow, seen: Observed, to: string): Promise<string | null> {
    if (!row.depositSecretEnc || !row.depositIv || !row.depositTag) return null;
    const wallets = getProtocolWallets(deps.config);
    const secret = decryptSecret({ enc: row.depositSecretEnc, iv: row.depositIv, tag: row.depositTag }, deps.config.keyEncryptionKey);
    try {
      let sig: string | null = null;
      if (seen.usdcMicro > 0) {
        const outs: SweepOut[] = [{ to, amount: seen.usdcMicro }];
        sig = (await deps.chain.sweepUsdc(secret, wallets.treasury.secret, outs, `VANTRA ${row.id}`)).sig;
      }
      if (seen.ethGwei > 0) {
        const solSig = (await deps.chain.sweepEth(secret, wallets.treasury.secret, to, seen.ethGwei)).sig;
        sig ??= solSig;
      }
      return sig;
    } finally {
      wipeSecret(secret);
    }
  }

  const finish = (row: PurchaseRow, status: 'expired' | 'refunded', extra: Record<string, unknown>) =>
    transition(deps.db, row.id, ['pending'], {
      status, depositSecretEnc: null, depositIv: null, depositTag: null, ...extra,
    });

  return {
    start() {
      if (timer) return;
      timer = setInterval(() => { void tick(); }, deps.config.economy.depositPollMs);
      timer.unref?.();
      deps.log.info({ everyMs: deps.config.economy.depositPollMs, mode: deps.chain.mode }, 'deposit poller started');
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    tick,
    pollOne,
  };
}

/** A top-up can be any amount from $1; a spawn has to clear the configured purchase minimum. */
const receiveFloor = (deps: PaymentsDeps, row: PurchaseRow): Micro =>
  row.kind === 'topup' ? MIN_TOPUP_MICRO : deps.config.economy.minPurchaseMicro;

/**
 * An upgrade never takes capability away: keep whatever the buyer picked that the new tier still
 * allows, and add everything the new tier unlocks on top.
 */
function upgradeTools(chosen: ToolName[] | null, fromTierId: string, toTierId: string): ToolName[] {
  const from = tierById(fromTierId)?.enabledTools ?? [];
  const to = tierById(toTierId)?.enabledTools ?? [];
  const kept = (chosen ?? to).filter((t) => to.includes(t));
  const unlocked = to.filter((t) => !from.includes(t));
  return [...new Set([...kept, ...unlocked])];
}
