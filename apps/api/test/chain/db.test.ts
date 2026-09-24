// Postgres-backed tests for the SQL in poolStore.ts (the treasury store). They run only when
// DATABASE_URL_TEST points at a database with the schema applied:
//   createdb vantra_chain_test && DATABASE_URL=postgres://localhost:5432/vantra_chain_test pnpm db:push
//   DATABASE_URL_TEST=postgres://localhost:5432/vantra_chain_test pnpm --filter @vantra/api test
import { sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { usd, type WsMsg } from '@vantra/shared';
import { createMemoryChain } from '../../src/chain/memory.js';
import { createTreasuryService } from '../../src/chain/pool.js';
import { TREASURY_ROW_ID, createTreasuryStore } from '../../src/chain/poolStore.js';
import { createBus } from '../../src/core/bus.js';
import { createDb, type DbHandle } from '../../src/db/client.js';
import { agents, users } from '../../src/db/schema.js';
import { silentLogger } from '../../src/lib/log.js';
import { fixedClock, testConfig } from './helpers.js';

const url = process.env.DATABASE_URL_TEST;
let handle: DbHandle;

describe.skipIf(!url)('chain over postgres', () => {
  const clock = fixedClock(new Date('2026-03-01T12:00:00.000Z'));
  const store = () => createTreasuryStore(handle.db, clock);

  beforeEach(async () => {
    handle ??= createDb(url!, { max: 2 });
    await handle.db.execute(sql`truncate table pool, pool_txs, pool_snapshots, purchases, users, agents, events restart identity cascade`);
  });

  afterAll(async () => { await handle?.close(); });

  it('creates the singleton treasury row and keeps it across loads', async () => {
    const first = await store().load('TREASURYWALLET1', 150);
    expect(first).toMatchObject({ id: TREASURY_ROW_ID, walletPubkey: 'TREASURYWALLET1', usdcMicro: 0, ethPriceUsd: 150, paused: false });
    await store().update({ usdcMicro: usd(500), lastSyncedAt: clock.now() }, []);
    expect(await store().load('TREASURYWALLET1', 150)).toMatchObject({ usdcMicro: usd(500), walletPubkey: 'TREASURYWALLET1' });
  });

  it('resets balances when the operator repoints the treasury wallet', async () => {
    await store().load('TREASURYWALLET1', 150);
    await store().update({ usdcMicro: usd(500), lastSyncedAt: clock.now() }, []);
    const moved = await store().load('TREASURYWALLET2', 150);
    expect(moved).toMatchObject({ walletPubkey: 'TREASURYWALLET2', usdcMicro: 0, ethGwei: 0, lastSyncedAt: null });
  });

  it('writes pool_txs and the treasury feed event in one transaction', async () => {
    await store().load('TREASURYWALLET1', 150);
    const { row, event } = await store().update(
      { usdcMicro: usd(490), agentsFunded: 1, fundedMicro: usd(9) },
      [
        { kind: 'funding', amountMicro: -usd(9), txSig: 'sig-funding', agentId: null },
        { kind: 'gas', amountMicro: -750_000, txSig: 'sig-gas', agentId: null },
      ],
      { agentId: null, agentName: 'AGENT-1', text: 'Funded AGENT-1: −$9.00', amountMicro: -usd(9) },
    );
    expect(row).toMatchObject({ usdcMicro: usd(490), agentsFunded: 1 });
    expect(event).toMatchObject({ kind: 'treasury', agentName: 'AGENT-1', amountMicro: -usd(9), meta: {} });
    expect(typeof event!.id).toBe('number');

    const txs = await store().listTxs({ limit: 10 });
    expect(txs.map((t) => t.kind)).toEqual(['gas', 'funding']);
    expect(txs[1]).toMatchObject({ amountMicro: -usd(9), txSig: 'sig-funding', agentName: null });
    expect(await store().listTxs({ limit: 10, before: txs[1]!.id })).toEqual([]);
  });

  // The guard that stops a retried fulfilment booking the same purchase twice.
  it('finds a purchase or top-up row by the purchase id in its meta', async () => {
    await store().load('TREASURYWALLET1', 150);
    await store().update({}, [
      { kind: 'purchase', amountMicro: usd(22.5), txSig: 'sig-a', agentId: null, meta: { purchaseId: 'pu_aaaaaaaaaa', grossMicro: usd(25), feeMicro: usd(2.5) } },
      { kind: 'topup', amountMicro: usd(9), txSig: 'sig-b', agentId: null, meta: { purchaseId: 'pu_bbbbbbbbbb' } },
      { kind: 'withdraw_fee', amountMicro: usd(1), txSig: 'sig-c', agentId: null },
    ]);
    expect(await store().hasPurchaseTx('pu_aaaaaaaaaa')).toBe(true);
    expect(await store().hasPurchaseTx('pu_bbbbbbbbbb')).toBe(true);
    expect(await store().hasPurchaseTx('pu_cccccccccc')).toBe(false);
  });

  it('upserts the daily snapshot', async () => {
    await store().load('TREASURYWALLET1', 150);
    await store().snapshot('2026-03-01', usd(500), 10);
    await store().snapshot('2026-03-01', usd(480), 9);
    const rows = await handle.db.execute<{ usdc_micro: string; eth_gwei: string }>(sql`select usdc_micro, eth_gwei from pool_snapshots`);
    expect(rows.rows).toHaveLength(1);
    expect(Number(rows.rows[0]!.usdc_micro)).toBe(usd(480));
  });

  it('funds an agent end to end: memory chain + drizzle store', async () => {
    const config = testConfig({ DEMO_TREASURY_USD: '50' });
    const chain = createMemoryChain(config, silentLogger, { clock });
    const bus = createBus(silentLogger);
    const seen: WsMsg[] = [];
    bus.onAny((m) => seen.push(m));
    const treasury = createTreasuryService({
      config, chain, bus, clock, log: silentLogger, store: store(),
      wallet: chain.wallets.treasury, founderWallet: chain.wallets.founderFee,
    });

    const agent = { id: 'ag_dbtest001', name: 'AGENT-DB', walletPubkey: chain.newKeypair().pubkey };
    await handle.db.insert(users).values({ wallet: 'owner-wallet' });
    await handle.db.insert(agents).values({
      id: agent.id, name: agent.name, ownerWallet: 'owner-wallet', directive: 'survive',
      model: 'mock-fast', walletPubkey: agent.walletPubkey, deploySlug: 'agent-db',
    });

    await treasury.recordPurchase({
      purchaseId: 'pu_dbtest0001', grossMicro: usd(10), feeMicro: usd(1), usdcInflowMicro: usd(9),
      txSig: 'sig-sweep', kind: 'purchase',
    });
    const payout = await treasury.fundAgent(agent, usd(9));
    expect(payout.fundingSig).toBeTruthy();
    expect(await chain.getUsdcBalance(agent.walletPubkey)).toBe(usd(9));

    // fundAgent syncs first (the row had never been synced), which adopts the chain's $50 float over
    // the booked $9, and then moves $9 out to the agent.
    const view = await treasury.current();
    expect(view).toMatchObject({
      usdcMicro: usd(41), agentsFunded: 1, fundedMicro: usd(9), purchasesMicro: usd(10), founderFeesMicro: usd(1),
    });
    const txs = await treasury.listTxs({ limit: 10 });
    expect(txs.map((t) => [t.kind, t.agentName])).toEqual([['gas', 'AGENT-DB'], ['funding', 'AGENT-DB'], ['purchase', null]]);
    expect(seen.filter((m) => m.type === 'treasury')).not.toHaveLength(0);
  });
});
