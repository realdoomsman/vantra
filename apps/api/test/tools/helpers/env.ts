// Shared fixtures for the tool-registry tests: a real Postgres test database (the tools talk to drizzle
// directly, so a fake query builder would test the fake), fake ports, a frozen clock and a recording bus.
import { sql } from 'drizzle-orm';
import pg from 'pg';
import type {
  ChainAdapter, Clock, CoreDeps, EventBus, LlmRouter, SandboxDriver, SandboxExecResult, SandboxFile,
  SearchProvider, SearchResult, ToolContext, ToolExecOpts,
} from '../../../src/core/interfaces.js';
import type { Micro, ModelInfo, ToolName, WsMsg } from '@vantra/shared';
import { ALL_TOOLS, DEFAULT_MODEL, estimateMicro, priceUsage } from '@vantra/shared';
import { loadConfig, type Config } from '../../../src/config.js';
import { createDb, type Db } from '../../../src/db/client.js';
import * as schema from '../../../src/db/schema.js';
import type { AgentRow } from '../../../src/db/schema.js';
import { silentLogger } from '../../../src/lib/log.js';
import type { DeployPort, EscrowPort, InternalServiceInvoker, PaymentsPort, ToolPorts } from '../../../src/tools/ports.js';

export const TEST_DATABASE_URL = process.env['TOOLS_TEST_DATABASE_URL'] ?? 'postgres://localhost:5432/vantra_tools_test';

// Truncated before every test that touches the database; `users` is the root of every FK chain.
const TRUNCATE_TABLES = [
  'ledger', 'decisions', 'events', 'steps', 'projects', 'deployments', 'owner_messages', 'service_calls',
  'services', 'bounties', 'forks', 'withdrawals', 'deposits_seen', 'agent_keys', 'agents', 'users',
];

export interface TestDb { db: Db; close(): Promise<void>; reset(): Promise<void> }

// Test files run in parallel workers against one database, so each file holds this advisory lock for
// its whole run: truncating between tests is then safe. The lock is session-scoped on a dedicated
// client, so a crashed worker releases it when its connection drops.
const SUITE_LOCK_ID = 0x72_75_6e_77;   // 'runw'

// Cheap reachability probe for module scope: returns false when Postgres is down or the schema was
// never pushed, so the suite can skip instead of failing the run on a machine without a database.
export async function testDbAvailable(): Promise<boolean> {
  const handle = createDb(TEST_DATABASE_URL, { max: 1 });
  try {
    await handle.db.execute(sql`select 1 from bounties limit 1`);
    return true;
  } catch {
    return false;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

// Acquires the suite lock and opens a pool. Call it from beforeAll and close() it from afterAll.
export async function lockTestDb(): Promise<TestDb> {
  const gate = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await gate.connect();
  await gate.query('select pg_advisory_lock($1)', [SUITE_LOCK_ID]);
  const handle = createDb(TEST_DATABASE_URL, { max: 4 });
  return {
    db: handle.db,
    close: async () => {
      await handle.close().catch(() => undefined);
      await gate.end().catch(() => undefined);
    },
    reset: async () => {
      await handle.db.execute(sql.raw(`truncate ${TRUNCATE_TABLES.join(', ')} restart identity cascade`));
    },
  };
}

export class FixedClock implements Clock {
  constructor(private current = new Date('2026-03-01T12:00:00.000Z')) {}
  now(): Date { return new Date(this.current); }
  advance(ms: number): void { this.current = new Date(this.current.getTime() + ms); }
  set(d: Date): void { this.current = new Date(d); }
}

export interface RecordingBus extends EventBus { readonly sent: WsMsg[] }

export function recordingBus(): RecordingBus {
  const sent: WsMsg[] = [];
  return {
    sent,
    emit: (msg) => { sent.push(msg); },
    on: () => () => undefined,
    onAny: () => () => undefined,
  };
}

export const TEST_MODELS: ModelInfo[] = [
  { id: 'claude-sonnet-5', provider: 'anthropic', label: 'Claude Sonnet 5', tier: 'strong', inputPerM: 2, outputPerM: 10, contextK: 1000, supportsEffort: true, thinking: 'adaptive', enabled: true },
  { id: 'claude-haiku-4-5', provider: 'anthropic', label: 'Claude Haiku 4.5', tier: 'fast', inputPerM: 1, outputPerM: 5, contextK: 200, supportsEffort: false, thinking: 'none', enabled: true },
];

export function fakeLlm(models: ModelInfo[] = TEST_MODELS): LlmRouter {
  return {
    mode: 'mock',
    models: () => models,
    resolve: (id) => {
      const m = models.find((x) => x.id === id);
      if (!m) throw new Error(`unknown model ${id}`);
      return m;
    },
    complete: () => Promise.reject(new Error('not used in tool tests')),
    cheapest: () => models.reduce((a, b) => (estimateMicro(a, 3000, 600) <= estimateMicro(b, 3000, 600) ? a : b)),
    estimateMicro: (model, inTok, outTok) => priceUsage(model, { inputTokens: inTok, outputTokens: outTok, cacheReadTokens: 0, cacheWriteTokens: 0 }),
    refreshPricing: () => Promise.resolve(),
  };
}

export interface FakeSandbox extends SandboxDriver {
  files: Map<string, string>;
  execs: { command: string; timeoutMs: number; stdin?: string }[];
  execResult: SandboxExecResult;
}

export function fakeSandbox(): FakeSandbox {
  const files = new Map<string, string>();
  const execs: FakeSandbox['execs'] = [];
  const sandbox: FakeSandbox = {
    name: 'local',
    files,
    execs,
    execResult: { stdout: 'ok', stderr: '', exitCode: 0, cpuMs: 1_000, timedOut: false },
    ensure: () => Promise.resolve(),
    exec: (_agentId, command, opts) => {
      execs.push({ command, timeoutMs: opts.timeoutMs, ...(opts.stdin === undefined ? {} : { stdin: opts.stdin }) });
      return Promise.resolve(sandbox.execResult);
    },
    writeFile: (_agentId, p, content) => { files.set(p, content); return Promise.resolve(); },
    readFile: (_agentId, p, maxBytes) => {
      const content = files.get(p);
      if (content === undefined) return Promise.reject(new Error(`no such file: ${p}`));
      return Promise.resolve(content.slice(0, maxBytes));
    },
    listFiles: (_agentId, p) => {
      const prefix = p === '.' ? '' : `${p}/`;
      const out: SandboxFile[] = [...files.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([k, v]) => ({ path: k, bytes: Buffer.byteLength(v), dir: false }));
      return Promise.resolve(out);
    },
    exportDir: () => Promise.resolve({ bytes: 0, files: 0 }),
    destroy: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    start: () => Promise.resolve(),
  };
  return sandbox;
}

export function fakeSearch(results: SearchResult[] = [], name: SearchProvider['name'] = 'brave'): SearchProvider {
  return { name, search: (_q, count) => Promise.resolve(results.slice(0, count)) };
}

export function fakeChain(balances: Record<string, { usdc: Micro; sol: number }> = {}): ChainAdapter {
  return {
    mode: 'memory', cluster: 'memory', usdcMint: 'USDC',
    newKeypair: () => ({ pubkey: `pk_${Math.random().toString(36).slice(2, 10)}`, secret: new Uint8Array(64) }),
    getUsdcBalance: (pk) => Promise.resolve(balances[pk]?.usdc ?? 0),
    getEthBalance: (pk) => Promise.resolve(balances[pk]?.sol ?? 0),
    getTokenBalance: () => Promise.resolve(0),
    transferUsdc: () => Promise.resolve({ sig: 'sig_transfer' }),
    transferEth: () => Promise.resolve({ sig: 'sig_sol' }),
    listUsdcInflows: () => Promise.resolve([]),
    getUsdcTransfer: () => Promise.resolve(null),
    sweepUsdc: () => Promise.resolve({ sig: 'sig_sweep' }),
    sweepEth: () => Promise.resolve({ sig: 'sig_sweep_sol' }),
    ethPriceUsd: () => Promise.resolve(150),
    swap: () => Promise.resolve({ sig: 'sig_swap', inAmount: 0, outAmount: 0 }),
    quoteUsdcOut: () => Promise.resolve(0),
  };
}

export interface FakePorts extends ToolPorts {
  payments: PaymentsPort & { transfers: { agentId: string; to: string; amountMicro: Micro; memo: string }[] };
  escrow: EscrowPort & { payouts: { to: string; amountMicro: Micro; memo: string }[] };
  invoker: InternalServiceInvoker & { calls: { serviceId: string; agentId: string; input: unknown }[]; result: Awaited<ReturnType<InternalServiceInvoker['invoke']>> };
  deploy: DeployPort & { deploys: { agentId: string; dir: string; slug: string }[] };
}

export function fakePorts(): FakePorts {
  const transfers: FakePorts['payments']['transfers'] = [];
  const payouts: FakePorts['escrow']['payouts'] = [];
  const calls: FakePorts['invoker']['calls'] = [];
  const deploys: FakePorts['deploy']['deploys'] = [];
  const invoker: FakePorts['invoker'] = {
    calls,
    result: { callId: 1, status: 'ok', output: { answer: 42 }, cpuMs: 120 },
    invoke: (serviceId, agentId, input) => {
      calls.push({ serviceId, agentId, input });
      return Promise.resolve(invoker.result);
    },
  };
  return {
    payments: {
      transfers,
      transferFromAgent: (agentId, to, amountMicro, memo) => {
        transfers.push({ agentId, to, amountMicro, memo });
        return Promise.resolve(`sig_pay_${transfers.length}`);
      },
    },
    escrow: {
      pubkey: 'ESCROW_WALLET',
      payouts,
      payout: (to, amountMicro, memo) => {
        payouts.push({ to, amountMicro, memo });
        return Promise.resolve(`sig_escrow_${payouts.length}`);
      },
    },
    invoker,
    deploy: {
      deploys,
      deploySite: (agentId, dir, slug) => {
        deploys.push({ agentId, dir, slug });
        return Promise.resolve({ slug, url: `http://localhost:8787/sites/${slug}/`, bytes: 2048, files: 3 });
      },
    },
    trading: { execute: () => Promise.resolve({ ok: true, message: 'traded' }) },
  };
}

export function testConfig(): Config {
  return loadConfig({ NODE_ENV: 'test', DATABASE_URL: TEST_DATABASE_URL, CHAIN_MODE: 'memory', LLM_PROVIDER: 'mock', SANDBOX_DRIVER: 'local' });
}

export interface TestDeps extends CoreDeps {
  bus: RecordingBus;
  clock: FixedClock;
  sandbox: FakeSandbox;
}

export function testDeps(db: Db, over: Partial<CoreDeps> = {}): TestDeps {
  return {
    config: testConfig(),
    db,
    clock: new FixedClock(),
    chain: fakeChain(),
    sandbox: fakeSandbox(),
    search: fakeSearch(),
    llm: fakeLlm(),
    bus: recordingBus(),
    log: silentLogger,
    ...over,
  } as TestDeps;
}

let agentSeq = 0;

export interface AgentOptions {
  name?: string;
  ownerWallet?: string;
  treasuryMicro?: Micro;
  enabledTools?: ToolName[];
  memory?: string[];
  status?: AgentRow['status'];
}

// Inserts the owner + agent rows the tools read. Returns the full row, which is also the ToolContext agent.
export async function seedAgent(db: Db, clock: Clock, opts: AgentOptions = {}): Promise<AgentRow> {
  const n = ++agentSeq;
  const name = opts.name ?? `AGENT-${n}`;
  const ownerWallet = opts.ownerWallet ?? `owner_${n}`;
  const now = clock.now();
  await db.insert(schema.users).values({ wallet: ownerWallet, createdAt: now, lastLoginAt: now }).onConflictDoNothing();
  const [row] = await db.insert(schema.agents).values({
    id: `ag_${String(n).padStart(10, '0')}`,
    name,
    ownerWallet,
    status: opts.status ?? 'alive',
    bornAt: now,
    directive: 'Earn more than you spend.',
    enabledTools: opts.enabledTools ?? ALL_TOOL_NAMES,
    model: DEFAULT_MODEL,
    effort: 'medium',
    walletPubkey: `wallet_${name.toLowerCase()}`,
    deploySlug: name.toLowerCase(),
    treasuryMicro: opts.treasuryMicro ?? 10_000_000,
    fundingMicro: 10_000_000,
    memory: opts.memory ?? [],
    lastRentAt: now,
    createdAt: now,
    updatedAt: now,
  }).returning();
  return row!;
}

// Mirrors the ToolName union by construction. It used to be a hand-written copy and had already
// drifted (it was missing `trade`), which quietly narrowed every test that fans out over it.
export const ALL_TOOL_NAMES: ToolName[] = [...ALL_TOOLS];

export function ctxFor(agent: AgentRow, round = 0): ToolContext {
  return { agent, stepId: 1, round, log: silentLogger };
}

export const execOpts = (remainingMs = 120_000): ToolExecOpts => ({ signal: new AbortController().signal, remainingMs });

export { schema };
