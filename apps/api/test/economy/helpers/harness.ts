// Real Postgres, real in-memory chain, scripted LLM/tools/sandbox. Test files serialise on one
// advisory lock so they can truncate the database between tests without racing each other.
import { eq } from 'drizzle-orm';
import pg from 'pg';
import {
  DEFAULT_HEARTBEAT_MIN, type AgentStatus, type Effort, type OwnerKind, type TierId, type ToolName, type WsMsg,
} from '@vantra/shared';
import { createMemoryLaunchpad } from '../../../src/chain/launchpad.js';
import { createMemoryChain, type MemoryChain } from '../../../src/chain/memory.js';
import { loadConfig, type Config } from '../../../src/config.js';
import { createBus } from '../../../src/core/bus.js';
import type { Clock, Deps } from '../../../src/core/interfaces.js';
import { createDb, type Db } from '../../../src/db/client.js';
import { agents, users, type AgentRow } from '../../../src/db/schema.js';
import { createServices } from '../../../src/economy/index.js';
import { saveAgentKey } from '../../../src/economy/wallets.js';
import { newAgentId } from '../../../src/lib/ids.js';
import { silentLogger } from '../../../src/lib/log.js';
import { fakeLlm, fakeSandbox, fakeTools, type FakeLlm, type FakeSandbox, type FakeTools, type FakeToolSpec, type ToolHandler } from './fakes.js';

export const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'] ?? 'postgres://localhost:5432/vantra_runtime_test';
// A wallet the operator has verified as a genuine outside customer. Deposits from anyone else land as
// `pending` (runtime/deposits.ts), so tests that exercise external revenue fund from this one.
export const EXTERNAL_PAYER = 'known-customer';
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

export interface HarnessOptions {
  env?: NodeJS.ProcessEnv;
  llm?: FakeLlm;
  tools?: Record<string, FakeToolSpec | ToolHandler>;
  now?: Date;
}

export interface SeedAgentInput {
  name?: string; ownerWallet?: string; ownerKind?: OwnerKind; status?: AgentStatus; model?: string; effort?: Effort;
  tools?: ToolName[]; directive?: string; treasuryMicro?: number; fundingMicro?: number;
  tier?: TierId | null; purchaseId?: string | null; payoutWallet?: string | null;
  revenueExternalMicro?: number; heartbeatMin?: number; bornAt?: Date; lastRentAt?: Date;
  nextStepAt?: Date | null; sleepUntil?: Date | null; forkedFrom?: string | null; fund?: number;
}

export interface Harness {
  config: Config;
  db: Db;
  deps: Deps;
  chain: MemoryChain;
  clock: TestClock;
  llm: FakeLlm;
  tools: FakeTools;
  sandbox: FakeSandbox;
  messages: WsMsg[];
  seedAgent(input?: SeedAgentInput): Promise<AgentRow>;
  fund(pubkey: string, amountMicro: number, from?: string): Promise<string>;
  reload(agentId: string): Promise<AgentRow>;
  close(): Promise<void>;
}

export async function createHarness(opts: HarnessOptions = {}): Promise<Harness> {
  const config = loadConfig({
    NODE_ENV: 'test', LOG_LEVEL: 'silent', CHAIN_MODE: 'memory', LLM_PROVIDER: 'mock', SANDBOX_DRIVER: 'local',
    DATABASE_URL: TEST_DATABASE_URL, SESSION_SECRET: 'test-session-secret-long-enough-for-zod', KEY_ENCRYPTION_KEY: 'ab'.repeat(32),
    DEMO_TREASURY_USD: '500', EXTERNAL_PAYER_WALLETS: EXTERNAL_PAYER, ...opts.env,
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
  const llm = opts.llm ?? fakeLlm();
  const tools = fakeTools(opts.tools ?? {});
  const sandbox = fakeSandbox();

  const deps: Deps = {
    config, db: handle.db, clock, bus, log: silentLogger, chain, sandbox, llm, tools,
    launchpad: createMemoryLaunchpad(config, chain, silentLogger),
    search: { name: 'none', search: async () => [] },
  };
  deps.services = createServices(deps);

  let seq = 0;
  return {
    config, db: handle.db, deps, chain, clock, llm, tools, sandbox, messages,

    async seedAgent(input: SeedAgentInput = {}) {
      const now = clock.now();
      const id = newAgentId();
      const name = input.name ?? `AGENT-${++seq}`;
      const ownerWallet = input.ownerWallet ?? `owner-${name.toLowerCase()}`;
      const ownerKind = input.ownerKind ?? 'wallet';
      const keypair = chain.newKeypair();
      await handle.db.insert(users)
        .values({ wallet: ownerWallet, kind: ownerKind, payoutWallet: input.payoutWallet ?? null, createdAt: now, lastLoginAt: now })
        .onConflictDoUpdate({
          target: users.wallet,
          set: { kind: ownerKind, ...(input.payoutWallet === undefined ? {} : { payoutWallet: input.payoutWallet }) },
        });
      const [row] = await handle.db.insert(agents).values({
        id, name, ownerWallet, ownerKind,
        tier: input.tier ?? null,
        purchaseId: input.purchaseId ?? null,
        status: input.status ?? 'alive',
        bornAt: input.bornAt ?? now,
        directive: input.directive ?? 'Earn real money.',
        enabledTools: input.tools ?? [],
        model: input.model ?? 'mock-fast',
        effort: input.effort ?? 'medium',
        heartbeatMin: input.heartbeatMin ?? DEFAULT_HEARTBEAT_MIN,
        walletPubkey: keypair.pubkey,
        deploySlug: name.toLowerCase(),
        treasuryMicro: input.treasuryMicro ?? 10_000_000,
        fundingMicro: input.fundingMicro ?? 10_000_000,
        revenueExternalMicro: input.revenueExternalMicro ?? 0,
        lastRentAt: input.lastRentAt ?? input.bornAt ?? now,
        nextStepAt: input.nextStepAt === undefined ? now : input.nextStepAt,
        sleepUntil: input.sleepUntil ?? null,
        forkedFrom: input.forkedFrom ?? null,
        createdAt: now, updatedAt: now,
      }).returning();
      await saveAgentKey(deps, handle.db, id, keypair.secret);
      // Pre-funding matches the opening treasury and is marked as already seen, so the first deposit
      // scan does not book the fixture as external revenue.
      const fund = input.fund ?? input.treasuryMicro ?? 10_000_000;
      if (fund > 0) {
        const { sig } = await chain.faucet(keypair.pubkey, fund, 'genesis-test');
        const [seeded] = await handle.db.update(agents).set({ lastDepositSig: sig }).where(eq(agents.id, id)).returning();
        return seeded!;
      }
      return row!;
    },

    async fund(pubkey, amountMicro, from = 'customer-1') {
      const { sig } = await chain.faucet(pubkey, amountMicro, from);
      return sig;
    },

    async reload(agentId) {
      const [row] = await handle.db.select().from(agents).where(eq(agents.id, agentId));
      return row!;
    },

    async close() {
      await lock.release();
      await handle.close();
    },
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
