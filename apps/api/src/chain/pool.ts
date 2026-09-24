// TREASURY wallet (SPEC-V2 §5.7, was the seed pool): balances, price, agent funding, gas stipends and
// the purchase bookkeeping. The `pool` row is the expected balance; payouts and recorded inflows adjust
// it and `sync` adopts the chain balance, logging any difference as drift — there is no creator-fee
// inference any more, because every cent that arrives is either a purchase sweep or an operator top-up.
// One mutex serialises payouts against syncs so a balance read never straddles a transfer.
import {
  GAS_TOPUP_THRESHOLD_GWEI, ETH_GAS_STIPEND_GWEI, fmtUsd,
  type FeedEvent, type Micro, type TreasuryPublic, type TreasuryTx, type TreasuryTxKind,
} from '@vantra/shared';
import type { Config } from '../config.js';
import type { ChainAdapter, Clock, EventBus } from '../core/interfaces.js';
import type { PoolRow } from '../db/schema.js';
import type { Logger } from '../lib/log.js';
import { ChainError } from './errors.js';
import { Mutex } from './mutex.js';
import { gweiToMicro } from './price.js';
import type { TreasuryStore, TreasuryTxInsert } from './poolStore.js';
import type { Signer } from './wallets.js';

export const TREASURY_SYNC_INTERVAL_MS = 60_000;
const ETH_DRIFT_WARN_GWEI = 50_000_000;   // 0.05 ETH of unexplained outflow (gas stays well below this)

export interface TreasuryAgentRef { id: string; name: string; walletPubkey: string }
export interface FundingPayout {
  fundingMicro: Micro;
  fundingSig: string | null;      // null when the agent already held the funding (retry after a partial failure)
  gasGwei: number; gasSig: string | null; gasMicro: Micro;
  ethPriceUsd: number;
}
export interface GasTopUp { gwei: number; sig: string; gasMicro: Micro; ethPriceUsd: number }
export type TreasuryInflowKind = Extract<TreasuryTxKind, 'withdraw_fee' | 'royalty' | 'refund' | 'sweep'>;

export interface RecordPurchaseInput {
  purchaseId: string;
  grossMicro: Micro;              // everything the buyer sent, USDC + valued ETH
  feeMicro: Micro;                // the founder fee, already paid out of the deposit address
  usdcInflowMicro: Micro;         // what actually landed in the treasury's USDC balance
  ethGweiInflow?: number;         // ETH swept in from an ETH-paid deposit
  txSig: string | null;
  kind: 'purchase' | 'topup';
  agentId?: string | null;        // set for a top-up
}

export interface FundAgentOpts {
  // Spawn retries after a partial failure pass this so a funding transfer is never made twice; a
  // top-up must always transfer, because the agent legitimately already holds money.
  skipIfHeld?: boolean;
}

export interface TreasuryService {
  readonly walletPubkey: string;
  current(): Promise<TreasuryPublic>;                                  // from the row; no chain call
  sync(): Promise<TreasuryPublic>;                                     // every 60s: balances, price, snapshot
  fundAgent(agent: TreasuryAgentRef, amountMicro: Micro, opts?: FundAgentOpts): Promise<FundingPayout>;
  topUpGas(agent: TreasuryAgentRef): Promise<GasTopUp | null>;         // null when above threshold or the treasury cannot pay
  /** Exactly `gwei` of ETH to the agent, no threshold check (a launched agent's activation stipend).
   *  Throws ChainError('treasury_dry') when the treasury cannot cover it. */
  sendGas(agent: TreasuryAgentRef, gwei: number): Promise<GasTopUp>;
  recordPurchase(input: RecordPurchaseInput): Promise<void>;           // idempotent per purchase id
  recordInflow(kind: TreasuryInflowKind, amountMicro: Micro, txSig: string | null, agentId: string | null): Promise<void>;
  listTxs(q: { limit: number; before?: number }): Promise<TreasuryTx[]>;
}

export interface TreasuryServiceDeps {
  config: Config; chain: ChainAdapter; bus: EventBus; clock: Clock; log: Logger;
  store: TreasuryStore; wallet: Signer;
  // Pubkey only, and the EFFECTIVE one: in memory mode it is derived rather than configured, and the
  // panel must name the address the fee actually reaches rather than reporting "none".
  founderWallet: string | null;
}

export function createTreasuryService(deps: TreasuryServiceDeps): TreasuryService {
  const { config, chain, bus, clock, log, store, wallet, founderWallet } = deps;
  const healthFloorMicro = config.economy.minPurchaseMicro;
  const lock = new Mutex();
  let rowPromise: Promise<PoolRow> | null = null;

  const load = (): Promise<PoolRow> => (rowPromise ??= store.load(wallet.pubkey, config.chain.ethPriceUsd));

  function toPublic(row: PoolRow): TreasuryPublic {
    return {
      walletPubkey: row.walletPubkey,
      usdcMicro: row.usdcMicro,
      ethGwei: row.ethGwei,
      ethPriceUsd: row.ethPriceUsd,
      usdValueMicro: row.usdcMicro + gweiToMicro(row.ethGwei, row.ethPriceUsd),
      agentsFunded: row.agentsFunded,
      fundedMicro: row.fundedMicro,
      purchasesMicro: row.purchasesMicro,
      founderFeesMicro: row.founderFeesMicro,
      founderFeeBps: config.economy.founderFeeBps,
      founderWallet,
      // A health flag only: agents are funded from their own buyer's money, so a thin treasury blocks
      // nothing — it just means a purchase sweep has not settled yet.
      paused: row.paused || row.usdcMicro < healthFloorMicro,
      lastSyncedAt: row.lastSyncedAt?.toISOString() ?? null,
    };
  }

  function commit(row: PoolRow, event: FeedEvent | null): PoolRow {
    rowPromise = Promise.resolve(row);
    if (event) bus.emit({ type: 'event', event });
    bus.emit({ type: 'treasury', treasury: toPublic(row) });
    return row;
  }

  async function sync(): Promise<TreasuryPublic> {
    const row = await load();
    const [usdc, eth, ethPriceUsd] = await Promise.all([
      chain.getUsdcBalance(wallet.pubkey),
      chain.getEthBalance(wallet.pubkey),
      chain.ethPriceUsd(),
    ]);

    const usdcDrift = usdc - row.usdcMicro;
    if (usdcDrift !== 0) {
      log[usdcDrift < 0 ? 'warn' : 'info'](
        { driftMicro: usdcDrift, onchainMicro: usdc },
        'treasury USDC differs from the booked balance; adopting the chain balance',
      );
    }
    const ethDrift = row.lastSyncedAt ? eth - row.ethGwei : 0;
    if (ethDrift < -ETH_DRIFT_WARN_GWEI) {
      log.warn({ expectedGwei: row.ethGwei, onchainGwei: eth }, 'treasury ETH dropped more than gas explains');
    }

    const now = clock.now();
    const result = await store.update({
      usdcMicro: usdc, ethGwei: eth, ethPriceUsd, paused: usdc < healthFloorMicro, lastSyncedAt: now,
    }, []);
    await store.snapshot(day(now), usdc, eth);
    return toPublic(commit(result.row, null));
  }

  async function fundAgent(agent: TreasuryAgentRef, amountMicro: Micro, opts: FundAgentOpts): Promise<FundingPayout> {
    if (!Number.isSafeInteger(amountMicro) || amountMicro <= 0) {
      throw new ChainError('invalid_amount', `funding must be a positive integer, got ${amountMicro}`);
    }
    let row = await load();
    if (!row.lastSyncedAt) {      // first payout after boot: the row's balance is still unknown
      await sync();
      row = await load();
    }
    if (row.usdcMicro < amountMicro) {
      throw new ChainError('treasury_dry', `treasury holds ${fmtUsd(row.usdcMicro)}, this agent needs ${fmtUsd(amountMicro)}`);
    }
    const [ethPriceUsd, agentEth, agentUsdc] = await Promise.all([
      chain.ethPriceUsd(),
      chain.getEthBalance(agent.walletPubkey),
      chain.getUsdcBalance(agent.walletPubkey),
    ]);

    const alreadyHeld = opts.skipIfHeld === true && agentUsdc >= amountMicro;
    const gasSig = agentEth < ETH_GAS_STIPEND_GWEI ? (await chain.transferEth(wallet.secret, agent.walletPubkey, ETH_GAS_STIPEND_GWEI)).sig : null;
    const fundingSig = alreadyHeld ? null : (await chain.transferUsdc(wallet.secret, agent.walletPubkey, amountMicro, 'VANTRA funding')).sig;
    if (alreadyHeld) log.warn({ agentId: agent.id }, 'agent already holds its funding; skipped the USDC transfer');

    const gasGwei = gasSig ? ETH_GAS_STIPEND_GWEI : 0;
    const gasMicro = gweiToMicro(gasGwei, ethPriceUsd);
    const paidMicro = fundingSig ? amountMicro : 0;
    const txs: TreasuryTxInsert[] = [];
    if (fundingSig) txs.push({ kind: 'funding', amountMicro: -amountMicro, txSig: fundingSig, agentId: agent.id });
    if (gasSig) txs.push({ kind: 'gas', amountMicro: -gasMicro, txSig: gasSig, agentId: agent.id });
    const usdcMicro = row.usdcMicro - paidMicro;
    const result = await store.update({
      usdcMicro,
      ethGwei: Math.max(0, row.ethGwei - gasGwei),
      paused: usdcMicro < healthFloorMicro,
      agentsFunded: row.agentsFunded + (fundingSig ? 1 : 0),
      fundedMicro: row.fundedMicro + paidMicro,
    }, txs);
    commit(result.row, null);
    log.info({ agentId: agent.id, fundingSig, gasSig, amountMicro }, 'agent funded');
    return { fundingMicro: amountMicro, fundingSig, gasGwei, gasSig, gasMicro, ethPriceUsd };
  }

  async function topUpGas(agent: TreasuryAgentRef): Promise<GasTopUp | null> {
    const agentEth = await chain.getEthBalance(agent.walletPubkey);
    if (agentEth >= GAS_TOPUP_THRESHOLD_GWEI) return null;
    const row = await load();
    if (row.ethGwei < ETH_GAS_STIPEND_GWEI) {
      log.warn({ agentId: agent.id, treasuryGwei: row.ethGwei }, 'treasury cannot afford a gas top-up');
      return null;
    }
    const paid = await payGas(row, agent, ETH_GAS_STIPEND_GWEI);
    log.info({ agentId: agent.id, sig: paid.sig }, 'gas topped up');
    return paid;
  }

  async function sendGas(agent: TreasuryAgentRef, gwei: number): Promise<GasTopUp> {
    if (!Number.isSafeInteger(gwei) || gwei <= 0) throw new ChainError('invalid_amount', `gas stipend must be a positive integer of gwei, got ${gwei}`);
    let row = await load();
    if (!row.lastSyncedAt) {      // first payout after boot: the row's balance is still unknown
      await sync();
      row = await load();
    }
    if (row.ethGwei < gwei) {
      throw new ChainError('treasury_dry', `treasury holds ${row.ethGwei} gwei of ETH, the stipend for ${agent.name} needs ${gwei}`);
    }
    const paid = await payGas(row, agent, gwei);
    log.info({ agentId: agent.id, gwei, sig: paid.sig }, 'gas stipend sent');
    return paid;
  }

  // One ETH payout to an agent's wallet, recorded on the treasury ledger as a `gas` row.
  async function payGas(row: PoolRow, agent: TreasuryAgentRef, gwei: number): Promise<GasTopUp> {
    const ethPriceUsd = await chain.ethPriceUsd();
    const { sig } = await chain.transferEth(wallet.secret, agent.walletPubkey, gwei);
    const gasMicro = gweiToMicro(gwei, ethPriceUsd);
    const result = await store.update(
      { ethGwei: Math.max(0, row.ethGwei - gwei) },
      [{ kind: 'gas', amountMicro: -gasMicro, txSig: sig, agentId: agent.id }],
    );
    commit(result.row, null);
    return { gwei, sig, gasMicro, ethPriceUsd };
  }

  // The net of a purchase landing from the deposit address. Idempotent: fulfilment is retried, and the
  // founder fee and the gross must be counted exactly once.
  async function recordPurchase(input: RecordPurchaseInput): Promise<void> {
    const { purchaseId, grossMicro, feeMicro, usdcInflowMicro, txSig, kind } = input;
    for (const [what, value] of [['grossMicro', grossMicro], ['feeMicro', feeMicro], ['usdcInflowMicro', usdcInflowMicro]] as const) {
      if (!Number.isSafeInteger(value) || value < 0) throw new ChainError('invalid_amount', `${what} must be a non-negative integer, got ${value}`);
    }
    if (await store.hasPurchaseTx(purchaseId)) {
      log.info({ purchaseId }, 'purchase already booked on the treasury; skipping');
      return;
    }
    const row = await load();
    const usdcMicro = row.usdcMicro + usdcInflowMicro;
    const ethGwei = row.ethGwei + Math.max(0, input.ethGweiInflow ?? 0);
    const result = await store.update(
      {
        usdcMicro,
        ethGwei,
        paused: usdcMicro < healthFloorMicro,
        purchasesMicro: row.purchasesMicro + grossMicro,
        founderFeesMicro: row.founderFeesMicro + feeMicro,
      },
      [{
        kind, amountMicro: grossMicro - feeMicro, txSig, agentId: input.agentId ?? null,
        meta: { purchaseId, grossMicro, feeMicro },
      }],
    );
    commit(result.row, null);
  }

  async function recordInflow(kind: TreasuryInflowKind, amountMicro: Micro, txSig: string | null, agentId: string | null): Promise<void> {
    if (!Number.isSafeInteger(amountMicro) || amountMicro <= 0) throw new ChainError('invalid_amount', `inflow must be a positive integer, got ${amountMicro}`);
    const row = await load();
    const usdcMicro = row.usdcMicro + amountMicro;
    const result = await store.update({ usdcMicro, paused: usdcMicro < healthFloorMicro }, [{ kind, amountMicro, txSig, agentId }]);
    commit(result.row, null);
  }

  return {
    walletPubkey: wallet.pubkey,
    current: async () => toPublic(await load()),
    sync: () => lock.run(sync),
    fundAgent: (agent, amountMicro, opts = {}) => lock.run(() => fundAgent(agent, amountMicro, opts)),
    topUpGas: (agent) => lock.run(() => topUpGas(agent)),
    sendGas: (agent, gwei) => lock.run(() => sendGas(agent, gwei)),
    recordPurchase: (input) => lock.run(() => recordPurchase(input)),
    recordInflow: (kind, amount, sig, agentId) => lock.run(() => recordInflow(kind, amount, sig, agentId)),
    listTxs: (q) => store.listTxs(q),
  };
}

const day = (d: Date): string => d.toISOString().slice(0, 10);
