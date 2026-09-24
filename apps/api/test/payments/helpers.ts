// Payments harness: real Postgres, the real in-memory chain, the real treasury service, and a fake
// `Services` that stands in for economy/ — it inserts the agent row and moves the money exactly as
// spawn does, so fulfilment is exercised end to end without depending on the runtime.
//
// It takes the same advisory lock as the economy/runtime harness, so the files serialise on one
// database instead of racing.
import { eq } from 'drizzle-orm';
import pg from 'pg';
import {
  DEFAULT_CATALOG, estimateMicro, type AgentPublic, type Micro, type ModelInfo, type WsMsg,
} from '@vantra/shared';
import { createMemoryChain, type MemoryChain } from '../../src/chain/memory.js';
import { loadConfig, type Config } from '../../src/config.js';
import { createBus } from '../../src/core/bus.js';
import type { Clock, LlmRouter, Payments, Services, SpawnInput } from '../../src/core/interfaces.js';
import { createDb, type Db } from '../../src/db/client.js';
import { agents, ledger, purchases, users, type AgentRow, type PurchaseRow } from '../../src/db/schema.js';
import { treasuryService } from '../../src/economy/treasury.js';
import { newAgentId } from '../../src/lib/ids.js';
import { silentLogger } from '../../src/lib/log.js';
import { createPayments } from '../../src/payments/index.js';
import type { PaymentsDeps } from '../../src/payments/deps.js';

export const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'] ?? 'postgres://localhost:5432/vantra_runtime_test';
const LOCK_ID = 872_401;
const LOCK_TIMEOUT_MS = 60_000;

const TABLES = [
  'sessions', 'auth_nonces', 'agent_keys', 'ledger', 'steps', 'decisions', 'projects', 'events', 'pool_txs',
  'pool_snapshots', 'pool', 'deposits_seen', 'bounties', 'service_calls', 'services', 'forks', 'withdrawals',
  'owner_messages', 'deployments', 'purchases', 'agents', 'users',
];

export class TestClock implements Clock {
  constructor(private at: Date = new Date('2026-03-01T12:00:00.000Z')) {}
  now(): Date { return new Date(this.at); }
  set(date: Date): void { this.at = date; }
  advance(ms: number): void { this.at = new Date(this.at.getTime() + ms); }
  advanceHours(hours: number): void { this.advance(hours * 3_600_000); }
}

export interface SpawnCall extends SpawnInput { at: Date }
export interface TopUpCall { agentId: string; purchaseId: string; amountMicro: Micro }

export interface PaymentsHarness {
  config: Config;
  db: Db;
  deps: PaymentsDeps;
  chain: MemoryChain;
  clock: TestClock;
  payments: Payments;
  messages: WsMsg[];
  spawns: SpawnCall[];
  topUps: TopUpCall[];
  /** Make the next spawn (or top-up credit) fail, once. */
  failNextSpawn(message: string): void;
  loadPurchase(id: string): Promise<PurchaseRow>;
  seedAgent(input?: { name?: string; ownerWallet?: string; tier?: AgentRow['tier']; status?: AgentRow['status'] }): Promise<AgentRow>;
  close(): Promise<void>;
}

export interface HarnessOptions {
  env?: NodeJS.ProcessEnv;
  now?: Date;
  models?: ModelInfo[];
}

export async function createPaymentsHarness(opts: HarnessOptions = {}): Promise<PaymentsHarness> {
  const config = loadConfig({
    NODE_ENV: 'test', LOG_LEVEL: 'silent', CHAIN_MODE: 'memory', LLM_PROVIDER: 'mock', SANDBOX_DRIVER: 'local',
    DATABASE_URL: TEST_DATABASE_URL, SESSION_SECRET: 'test-session-secret-long-enough-for-zod',
    KEY_ENCRYPTION_KEY: 'ab'.repeat(32), DEMO_TREASURY_USD: '0', ...opts.env,
  });

  const handle = createDb(config.databaseUrl, { max: 4 });
  const lock = await acquireLock(handle.pool);
  await truncate(handle.pool);

  const clock = new TestClock(opts.now);
  const bus = createBus(silentLogger);
  const messages: WsMsg[] = [];
  bus.onAny((msg) => messages.push(msg));

  const chain = createMemoryChain(config, silentLogger);
  chain.useClock(clock);

  const spawns: SpawnCall[] = [];
  const topUps: TopUpCall[] = [];
  let failNext: string | null = null;

  const deps = {
    config, db: handle.db, clock, bus, log: silentLogger, chain,
    llm: mockRouter(opts.models),
    sandbox: null as never,
    search: { name: 'none' as const, search: async () => [] },
  } as unknown as PaymentsDeps;

  // Everything fulfilment asks of economy/, and nothing else.
  deps.services = {
    // Mirrors economy/spawn.ts closely enough to be worth asserting against: the row, the wallet, the
    // treasury payout and a `funding` ledger row carrying the signature.
    async spawn(input: SpawnInput): Promise<AgentPublic> {
      if (failNext) { const m = failNext; failNext = null; throw new Error(m); }
      spawns.push({ ...input, at: clock.now() });
      const row = await insertAgent(handle.db, chain, clock, input);
      const payout = await treasuryService(deps).fundAgent(
        { id: row.id, name: row.name, walletPubkey: row.walletPubkey }, input.fundingMicro, { skipIfHeld: true },
      );
      await handle.db.insert(ledger).values({
        agentId: row.id, kind: 'funding', amountMicro: input.fundingMicro, balanceAfterMicro: input.fundingMicro,
        memo: 'purchase funding', txSig: payout.fundingSig, counterparty: treasuryService(deps).walletPubkey,
        settled: true, meta: { purchaseId: input.purchaseId, tierId: input.tierId },
      });
      await handle.db.update(agents)
        .set({ treasuryMicro: input.fundingMicro, fundingMicro: input.fundingMicro }).where(eq(agents.id, row.id));
      return { id: row.id, name: row.name } as AgentPublic;
    },
    async creditTopUp(agentId: string, purchaseId: string, amountMicro: Micro): Promise<AgentPublic> {
      if (failNext) { const m = failNext; failNext = null; throw new Error(m); }
      topUps.push({ agentId, purchaseId, amountMicro });
      const [row] = await handle.db.select().from(agents).where(eq(agents.id, agentId));
      const payout = await treasuryService(deps).fundAgent(
        { id: row!.id, name: row!.name, walletPubkey: row!.walletPubkey }, amountMicro,
      );
      await handle.db.insert(ledger).values({
        agentId, kind: 'recapitalize', amountMicro, balanceAfterMicro: row!.treasuryMicro + amountMicro,
        memo: 'top-up', txSig: payout.fundingSig, settled: true, meta: { purchaseId, via: 'topup' },
      });
      const [updated] = await handle.db.update(agents)
        .set({ treasuryMicro: row!.treasuryMicro + amountMicro }).where(eq(agents.id, agentId)).returning();
      return { id: updated!.id, name: updated!.name } as AgentPublic;
    },
  } as unknown as Services;

  const payments = createPayments(deps);
  deps.payments = payments;

  return {
    config, db: handle.db, deps, chain, clock, payments, messages, spawns, topUps,

    failNextSpawn(message: string) { failNext = message; },

    async loadPurchase(id: string) {
      const [row] = await handle.db.select().from(purchases).where(eq(purchases.id, id));
      return row!;
    },

    async seedAgent(input = {}) {
      const now = clock.now();
      const name = input.name ?? 'INCUMBENT';
      const ownerWallet = input.ownerWallet ?? 'owner-wallet';
      await handle.db.insert(users).values({ wallet: ownerWallet, createdAt: now, lastLoginAt: now })
        .onConflictDoNothing({ target: users.wallet });
      const [row] = await handle.db.insert(agents).values({
        id: newAgentId(), name, ownerWallet, ownerKind: 'wallet',
        tier: input.tier ?? 'SPARK', status: input.status ?? 'alive',
        directive: 'Earn real money.', model: 'mock-fast', walletPubkey: chain.newKeypair().pubkey,
        deploySlug: name.toLowerCase(), treasuryMicro: 9_000_000, fundingMicro: 9_000_000,
        bornAt: now, lastRentAt: now, createdAt: now, updatedAt: now,
      }).returning();
      return row!;
    },

    async close() {
      payments.stop();
      await lock.release();
      await handle.close();
    },
  };
}

/** The agent row and its wallet; the caller then has the treasury pay it. */
async function insertAgent(db: Db, chain: MemoryChain, clock: Clock, input: SpawnInput): Promise<AgentRow> {
  const now = clock.now();
  const id = input.agentId ?? newAgentId();
  const keypair = chain.newKeypair();
  await db.insert(users).values({
    wallet: input.ownerWallet, kind: input.ownerKind, createdAt: now, lastLoginAt: now,
  }).onConflictDoNothing({ target: users.wallet });
  const [row] = await db.insert(agents).values({
    id, name: input.name, ownerWallet: input.ownerWallet, ownerKind: input.ownerKind,
    tier: input.tierId, purchaseId: input.purchaseId, status: 'alive',
    directive: input.directive, enabledTools: input.tools, model: input.model, effort: input.effort,
    heartbeatMin: input.heartbeatMin, walletPubkey: keypair.pubkey, deploySlug: input.name.toLowerCase(),
    bornAt: now, lastRentAt: now, createdAt: now, updatedAt: now,
  }).returning();
  return row!;
}

/** Just enough LlmRouter for quoting: the mock catalog, or whatever a test hands it. */
export function mockRouter(models?: ModelInfo[]): LlmRouter {
  const catalog = models ?? DEFAULT_CATALOG.filter((m) => m.provider === 'mock');
  return {
    mode: 'mock',
    models: () => catalog,
    resolve: (id) => catalog.find((m) => m.id === id) ?? catalog[0]!,
    cheapest: () => [...catalog].sort((a, b) => estimateMicro(a, 3000, 600) - estimateMicro(b, 3000, 600))[0]!,
    estimateMicro: (model, inTok, outTok) => estimateMicro(model, inTok, outTok),
    refreshPricing: async () => undefined,
    complete: async () => { throw new Error('the payments harness never completes'); },
  };
}

async function acquireLock(pool: pg.Pool): Promise<{ release(): Promise<void> }> {
  const client = await pool.connect();
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    const { rows } = await client.query<{ locked: boolean }>('select pg_try_advisory_lock($1) as locked', [LOCK_ID]);
    if (rows[0]?.locked) break;
    if (Date.now() > deadline) {
      client.release();
      throw new Error('timed out waiting for the test database lock');
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return {
    async release() {
      await client.query('select pg_advisory_unlock($1)', [LOCK_ID]).catch(() => undefined);
      client.release();
    },
  };
}

async function truncate(pool: pg.Pool): Promise<void> {
  await pool.query(`truncate table ${TABLES.join(', ')} restart identity cascade`);
}

/** Puts USDC into the treasury so funding can happen without a real purchase sweep. */
export async function fundTreasury(h: PaymentsHarness, amountMicro: Micro): Promise<void> {
  await h.chain.faucet(h.chain.wallets.treasury.pubkey, amountMicro, 'operator');
  await treasuryService(h.deps).sync();
}
