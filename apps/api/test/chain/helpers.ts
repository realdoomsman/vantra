// Shared fixtures for the chain tests: a Config built from an explicit env (never process.env),
// plus a tiny in-memory TreasuryStore so treasury accounting can be asserted without Postgres.
import type { FeedEvent, TreasuryTx } from '@vantra/shared';
import { loadConfig, type Config } from '../../src/config.js';
import type { Clock } from '../../src/core/interfaces.js';
import type { PoolRow } from '../../src/db/schema.js';
import type {
  TreasuryEventInsert, TreasuryPatch, TreasuryStore, TreasuryTxInsert,
} from '../../src/chain/poolStore.js';

export const TEST_KEY_HEX = 'ab'.repeat(32);

export function testConfig(env: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    KEY_ENCRYPTION_KEY: TEST_KEY_HEX,
    SESSION_SECRET: 'test-session-secret-at-least-32-chars',
    CHAIN_MODE: 'memory',
    ...env,
  });
}

export function fixedClock(start = new Date('2026-03-01T12:00:00.000Z')): Clock & { set(d: Date): void } {
  let at = start;
  return { now: () => at, set: (d) => { at = d; } };
}

export interface FakeTreasuryStore extends TreasuryStore {
  row: PoolRow;
  txs: TreasuryTxInsert[];
  events: TreasuryEventInsert[];
  snapshots: Map<string, { usdcMicro: number; ethGwei: number }>;
}

export function fakeTreasuryStore(clock: Clock): FakeTreasuryStore {
  let nextEventId = 1;
  const store: FakeTreasuryStore = {
    row: {
      id: 1, walletPubkey: '', usdcMicro: 0, ethGwei: 0, ethPriceUsd: 0,
      agentsFunded: 0, fundedMicro: 0, purchasesMicro: 0, founderFeesMicro: 0,
      paused: false, lastSyncedAt: null,
    },
    txs: [],
    events: [],
    snapshots: new Map(),

    async load(walletPubkey, ethPriceUsd) {
      if (store.row.walletPubkey !== walletPubkey) {
        store.row = { ...store.row, walletPubkey, ethPriceUsd, usdcMicro: 0, ethGwei: 0, lastSyncedAt: null };
      }
      return store.row;
    },

    async update(patch: TreasuryPatch, txs: TreasuryTxInsert[], event?: TreasuryEventInsert) {
      store.row = { ...store.row, ...patch };
      store.txs.push(...txs.map((t) => ({ ...t, ts: t.ts ?? clock.now() })));
      let feed: FeedEvent | null = null;
      if (event) {
        store.events.push(event);
        feed = { id: nextEventId++, ts: clock.now().toISOString(), kind: 'treasury', meta: {}, ...event };
      }
      return { row: store.row, event: feed };
    },

    async hasPurchaseTx(purchaseId) {
      return store.txs.some((t) => (t.kind === 'purchase' || t.kind === 'topup')
        && (t.meta as { purchaseId?: string } | undefined)?.purchaseId === purchaseId);
    },

    async snapshot(day, usdcMicro, ethGwei) {
      store.snapshots.set(day, { usdcMicro, ethGwei });
    },

    async listTxs({ limit }) {
      return store.txs.slice(-limit).reverse().map((t, i): TreasuryTx => ({
        id: store.txs.length - i, ts: (t.ts ?? clock.now()).toISOString(), kind: t.kind,
        amountMicro: t.amountMicro, txSig: t.txSig, agentId: t.agentId, agentName: null,
      }));
    },
  };
  return store;
}
