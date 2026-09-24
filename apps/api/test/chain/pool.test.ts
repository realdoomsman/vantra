// The TREASURY service (SPEC-V2 §5.7). What replaced the seed pool: money arrives because something
// was sold, funding is a parameter rather than a constant, and an unexplained balance change is drift
// to be adopted, not a creator fee to be booked.
import { beforeEach, describe, expect, it } from 'vitest';
import { MIN_PURCHASE_MICRO, ETH_GAS_STIPEND_GWEI, usd, type WsMsg } from '@vantra/shared';
import { isChainError } from '../../src/chain/errors.js';
import { createMemoryChain, type MemoryChain } from '../../src/chain/memory.js';
import { createTreasuryService, type TreasuryAgentRef, type TreasuryService } from '../../src/chain/pool.js';
import { gweiToMicro } from '../../src/chain/price.js';
import { createBus } from '../../src/core/bus.js';
import { silentLogger } from '../../src/lib/log.js';
import { fakeTreasuryStore, fixedClock, testConfig, type FakeTreasuryStore } from './helpers.js';

const FLOAT_USD = 50;
const FUNDING = usd(9);              // what a $10 SPARK purchase puts into an agent
const ETH_PRICE = 150;
const GAS_MICRO = gweiToMicro(ETH_GAS_STIPEND_GWEI, ETH_PRICE);

let chain: MemoryChain;
let store: FakeTreasuryStore;
let treasury: TreasuryService;
let msgs: WsMsg[];
const clock = fixedClock(new Date('2026-03-01T12:00:00.000Z'));

function newAgent(n = 1): TreasuryAgentRef {
  return { id: `ag_test${n}`, name: `AGENT-${n}`, walletPubkey: chain.newKeypair().pubkey };
}

beforeEach(() => {
  const config = testConfig({ DEMO_TREASURY_USD: String(FLOAT_USD), ETH_PRICE_USD: String(ETH_PRICE) });
  chain = createMemoryChain(config, silentLogger, { clock });
  store = fakeTreasuryStore(clock);
  const bus = createBus(silentLogger);
  msgs = [];
  bus.onAny((m) => msgs.push(m));
  treasury = createTreasuryService({
    config, chain, bus, clock, log: silentLogger, store,
    wallet: chain.wallets.treasury, founderWallet: chain.wallets.founderFee,
  });
});

const treasuryMsgs = () => msgs.filter((m) => m.type === 'treasury');

describe('chain/treasury sync', () => {
  it('adopts the on-chain balance, prices ETH and writes a daily snapshot', async () => {
    const view = await treasury.sync();
    expect(view).toMatchObject({
      walletPubkey: chain.wallets.treasury.pubkey, usdcMicro: usd(FLOAT_USD), ethPriceUsd: ETH_PRICE,
      paused: false, agentsFunded: 0, fundedMicro: 0, purchasesMicro: 0, founderFeesMicro: 0,
    });
    expect(view.usdValueMicro).toBe(usd(FLOAT_USD) + gweiToMicro(view.ethGwei, ETH_PRICE));
    expect(view.lastSyncedAt).toBe(clock.now().toISOString());
    expect(store.snapshots.get('2026-03-01')).toEqual({ usdcMicro: usd(FLOAT_USD), ethGwei: view.ethGwei });
    expect(treasuryMsgs()).toHaveLength(1);
  });

  it('books nothing for an unexplained increase: a sale is the only source of revenue', async () => {
    await treasury.sync();
    await chain.faucet(chain.wallets.treasury.pubkey, usd(25), 'operator-top-up');
    const view = await treasury.sync();

    expect(store.txs).toHaveLength(0);              // no fee_in, no inflow — drift is just adopted
    expect(view.usdcMicro).toBe(usd(FLOAT_USD + 25));
    expect(view.purchasesMicro).toBe(0);
    expect(msgs.filter((m) => m.type === 'event')).toHaveLength(0);
  });

  it('reports paused as a health flag when it holds less than one purchase minimum', async () => {
    await treasury.sync();
    await chain.transferUsdc(chain.wallets.treasury.secret, chain.newKeypair().pubkey, usd(FLOAT_USD) - usd(3));
    const view = await treasury.sync();
    expect(view).toMatchObject({ usdcMicro: usd(3), paused: true });
    expect(usd(3)).toBeLessThan(MIN_PURCHASE_MICRO);
  });
});

describe('chain/treasury fundAgent', () => {
  it('sends the funding and the gas stipend, and books both against the treasury', async () => {
    const agent = newAgent();
    const payout = await treasury.fundAgent(agent, FUNDING);

    expect(payout).toMatchObject({ fundingMicro: FUNDING, gasGwei: ETH_GAS_STIPEND_GWEI, gasMicro: GAS_MICRO, ethPriceUsd: ETH_PRICE });
    expect(payout.fundingSig).toBeTruthy();
    expect(await chain.getUsdcBalance(agent.walletPubkey)).toBe(FUNDING);
    expect(await chain.getEthBalance(agent.walletPubkey)).toBe(ETH_GAS_STIPEND_GWEI);

    expect(store.txs.filter((t) => t.agentId === agent.id)).toEqual([
      expect.objectContaining({ kind: 'funding', amountMicro: -FUNDING, txSig: payout.fundingSig, agentId: agent.id }),
      expect.objectContaining({ kind: 'gas', amountMicro: -GAS_MICRO, txSig: payout.gasSig, agentId: agent.id }),
    ]);
    expect(store.row).toMatchObject({ usdcMicro: usd(FLOAT_USD) - FUNDING, agentsFunded: 1, fundedMicro: FUNDING });
    expect(treasuryMsgs().at(-1)).toMatchObject({ treasury: { usdcMicro: usd(FLOAT_USD) - FUNDING, fundedMicro: FUNDING } });
  });

  it('funds each agent the amount its own buyer paid for', async () => {
    await treasury.fundAgent(newAgent(1), usd(9));
    await treasury.fundAgent(newAgent(2), usd(22.5));
    expect(store.row).toMatchObject({ agentsFunded: 2, fundedMicro: usd(31.5), usdcMicro: usd(FLOAT_USD) - usd(31.5) });
  });

  it('syncs first so a fresh boot can fund before the first scheduled sync', async () => {
    expect(store.row.lastSyncedAt).toBeNull();
    await treasury.fundAgent(newAgent(), FUNDING);
    expect(store.row.lastSyncedAt).not.toBeNull();
  });

  it('refuses when the treasury cannot cover the funding', async () => {
    await expect(treasury.fundAgent(newAgent(), usd(FLOAT_USD + 1)))
      .rejects.toSatisfy((e) => isChainError(e, 'treasury_dry'));
    expect(store.row.agentsFunded).toBe(0);
  });

  it('refuses a non-positive funding amount', async () => {
    await expect(treasury.fundAgent(newAgent(), 0)).rejects.toSatisfy((e) => isChainError(e, 'invalid_amount'));
  });

  // A top-up legitimately reaches an agent that already holds money, so skipping is opt-in and spawn
  // is the only caller that asks for it.
  it('pays a top-up even though the agent already holds funds, but skips a spawn retry', async () => {
    const agent = newAgent();
    await treasury.fundAgent(agent, FUNDING);
    const topUp = await treasury.fundAgent(agent, usd(5));
    expect(topUp.fundingSig).toBeTruthy();
    expect(await chain.getUsdcBalance(agent.walletPubkey)).toBe(FUNDING + usd(5));

    const retry = await treasury.fundAgent(agent, FUNDING, { skipIfHeld: true });
    expect(retry).toMatchObject({ fundingSig: null, gasSig: null, gasGwei: 0, gasMicro: 0 });
    expect(await chain.getUsdcBalance(agent.walletPubkey)).toBe(FUNDING + usd(5));
    expect(store.row.agentsFunded).toBe(2);
  });

  it('pays only the missing half when the gas transfer already landed', async () => {
    const agent = newAgent();
    await chain.faucetEth(agent.walletPubkey, ETH_GAS_STIPEND_GWEI);
    const payout = await treasury.fundAgent(agent, FUNDING);
    expect(payout.gasSig).toBeNull();
    expect(payout.fundingSig).toBeTruthy();
    expect(store.txs.filter((t) => t.agentId === agent.id).map((t) => t.kind)).toEqual(['funding']);
  });
});

describe('chain/treasury purchase bookkeeping', () => {
  const purchase = { purchaseId: 'pu_abcdefghij', grossMicro: usd(25), feeMicro: usd(2.5), usdcInflowMicro: usd(22.5), txSig: 'sig1', kind: 'purchase' as const };

  it('books the gross, the founder fee and the net that landed', async () => {
    await treasury.sync();
    await treasury.recordPurchase(purchase);

    const view = await treasury.current();
    expect(view).toMatchObject({
      usdcMicro: usd(FLOAT_USD) + usd(22.5), purchasesMicro: usd(25), founderFeesMicro: usd(2.5),
      founderFeeBps: 1000, founderWallet: chain.wallets.founderFee,
    });
    // The panel must name the address the fee actually reaches: memory mode derives it rather than
    // reading FOUNDER_FEE_WALLET, and reporting "none configured" there would be a lie.
    expect(chain.wallets.founderFee).not.toBe(chain.wallets.treasury.pubkey);
    expect(store.txs.at(-1)).toMatchObject({
      kind: 'purchase', amountMicro: usd(22.5), txSig: 'sig1',
      meta: { purchaseId: 'pu_abcdefghij', grossMicro: usd(25), feeMicro: usd(2.5) },
    });
  });

  it('is idempotent: a retried fulfilment cannot book the same purchase twice', async () => {
    await treasury.recordPurchase(purchase);
    await treasury.recordPurchase(purchase);
    expect(store.txs.filter((t) => t.kind === 'purchase')).toHaveLength(1);
    expect(store.row.purchasesMicro).toBe(usd(25));
  });

  it('credits swept ETH to the treasury when a buyer paid in ETH', async () => {
    await treasury.recordPurchase({ ...purchase, usdcInflowMicro: 0, ethGweiInflow: 2_000_000_000 });
    expect(store.row.ethGwei).toBe(2_000_000_000);
    expect(store.row.usdcMicro).toBe(0);
  });

  it('refuses negative amounts', async () => {
    await expect(treasury.recordPurchase({ ...purchase, feeMicro: -1 }))
      .rejects.toSatisfy((e) => isChainError(e, 'invalid_amount'));
  });
});

describe('chain/treasury gas and inflows', () => {
  it('tops up an agent below the threshold and skips one above it', async () => {
    const agent = newAgent();
    await treasury.sync();
    const topUp = await treasury.topUpGas(agent);
    expect(topUp).toMatchObject({ gwei: ETH_GAS_STIPEND_GWEI, gasMicro: GAS_MICRO, ethPriceUsd: ETH_PRICE });
    expect(await chain.getEthBalance(agent.walletPubkey)).toBe(ETH_GAS_STIPEND_GWEI);
    expect(store.txs.at(-1)).toMatchObject({ kind: 'gas', amountMicro: -GAS_MICRO, agentId: agent.id });

    expect(await treasury.topUpGas(agent)).toBeNull();
  });

  it('records a withdraw fee, a royalty and an expired-purchase sweep as inflows', async () => {
    await treasury.sync();
    await treasury.recordInflow('withdraw_fee', usd(4), 'sig-fee', 'ag_test1');
    await treasury.recordInflow('sweep', usd(2), 'sig-sweep', null);
    expect(store.txs.map((t) => t.kind)).toEqual(['withdraw_fee', 'sweep']);
    expect(store.row.usdcMicro).toBe(usd(FLOAT_USD + 6));
  });

  it('refuses a non-positive inflow', async () => {
    await expect(treasury.recordInflow('royalty', 0, null, null)).rejects.toSatisfy((e) => isChainError(e, 'invalid_amount'));
    await expect(treasury.recordInflow('refund', -5, null, null)).rejects.toSatisfy((e) => isChainError(e, 'invalid_amount'));
  });

  it('lists treasury transactions newest first', async () => {
    await treasury.sync();
    await treasury.fundAgent(newAgent(), FUNDING);
    const txs = await treasury.listTxs({ limit: 10 });
    expect(txs.map((t) => t.kind)).toEqual(['gas', 'funding']);
    expect(txs[0]!.ts).toBe(clock.now().toISOString());
  });

  it('serialises concurrent payouts and syncs', async () => {
    const agents = [newAgent(1), newAgent(2), newAgent(3)];
    await Promise.all([treasury.sync(), ...agents.map((a) => treasury.fundAgent(a, FUNDING)), treasury.sync()]);
    expect(store.row.agentsFunded).toBe(3);
    expect(store.row.usdcMicro).toBe(usd(FLOAT_USD) - 3 * FUNDING);
    expect(await chain.getUsdcBalance(chain.wallets.treasury.pubkey)).toBe(store.row.usdcMicro);
  });
});
