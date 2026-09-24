// `pnpm ready` — the command you run after pasting keys into .env. (`pnpm run doctor` is the same
// thing. Never bare `pnpm doctor`: `doctor` is one of pnpm's own built-in commands, so that form runs
// pnpm's unrelated config check, prints nothing from here, and exits 0 — a false all-clear.)
//
// It CHECKS; it never assumes. Every line is produced by actually doing the thing: a real Postgres
// connection, a real completion against each provider key you have set, a real Robinhood Chain RPC
// round trip through apps/api/src/chain/evm.ts, a real container started through
// apps/api/src/sandbox/docker.ts. Nothing here reads a flag and reports success.
//
// Statuses: PASS (proved working) · FAIL (proved broken, remedy printed) · WARN (works, but you
// should know) · SKIP (not configured, where to get it printed). Exit code 0 only when every
// REQUIRED check passed.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import Docker from 'dockerode';
import { erc20Abi, getAddress, isAddress } from 'viem';
import {
  DEFAULT_CATALOG, ETH_GAS_STIPEND_GWEI, SANDBOX_TOOLS, TIERS, fmtUsd, sameAddress, type ModelInfo, type ModelProvider,
} from '@vantra/shared';
import { loadSecret, pubkeyOfSecret } from '../chain/keys.js';
import type { ChainAdapter, LlmProvider } from '../core/interfaces.js';
import { createEvmChain, publicClientFor } from '../chain/evm.js';
import { USDC_ADDRESSES, loadConfig, type Config } from '../config.js';
import { CHAIN_IDS, configContradictions } from '../core/preflight.js';
import { createDb } from '../db/client.js';
import { API_ROOT, REPO_ROOT, loadDotenv } from '../lib/env.js';
import { silentLogger } from '../lib/log.js';
import { buildCatalog, catalogEnv } from '../llm/catalog.js';
import { LlmCallError } from '../llm/errors.js';
import { createRouter } from '../llm/router.js';
import { createDockerSandbox } from '../sandbox/docker.js';
import { createBraveSearch } from '../search/brave.js';
import { createTavilySearch } from '../search/tavily.js';

// ---------------------------------------------------------------------------
// Result model
// ---------------------------------------------------------------------------

export type CheckStatus = 'pass' | 'fail' | 'warn' | 'skip';

export interface Check {
  /** Stable id so tests and docs can name a line. */
  id: string;
  /** Left-hand label the founder reads. */
  title: string;
  status: CheckStatus;
  /** What was actually observed. Never a secret. */
  detail: string;
  /** Exactly what to do about it. Mandatory for fail and skip. */
  remedy?: string;
  /** Counts toward the verdict: every required check must PASS. */
  required: boolean;
  ms?: number;
}

export interface Section {
  name: string;
  checks: Check[];
}

export interface Verdict {
  /** Every required check passed. */
  ready: boolean;
  /** Ready AND actually pointed at mainnet with ALLOW_MAINNET=1. */
  realMoney: boolean;
  /** Required checks that did not pass, in the order they ran. */
  blockers: Check[];
  /** Non-blocking things worth knowing. */
  warnings: Check[];
  counts: Record<CheckStatus, number>;
}

/** Pure: the verdict is a function of the checks and the cluster, nothing else. */
export function verdictOf(sections: Section[], chain: { cluster: string; allowMainnet: boolean }): Verdict {
  const checks = sections.flatMap((s) => s.checks);
  const counts: Record<CheckStatus, number> = { pass: 0, fail: 0, warn: 0, skip: 0 };
  for (const c of checks) counts[c.status] += 1;
  const blockers = checks.filter((c) => c.required && c.status !== 'pass');
  const warnings = checks.filter((c) => !c.required && (c.status === 'warn' || c.status === 'fail'));
  const ready = blockers.length === 0;
  return { ready, realMoney: ready && chain.cluster === 'mainnet' && chain.allowMainnet, blockers, warnings, counts };
}

// ---------------------------------------------------------------------------
// Where to buy each key. These strings are the SKIP lines and they mirror KEYS-TO-BUY.md.
// ---------------------------------------------------------------------------

export const BUY_LINES = {
  ANTHROPIC_API_KEY:
    'Buy it: console.anthropic.com -> Billing (add $20) -> API keys -> Create key. Paste into .env as '
    + 'ANTHROPIC_API_KEY=sk-ant-... and set LLM_PROVIDER=router. (KEYS-TO-BUY.md step 3)',
  OPENAI_API_KEY:
    'Buy it: platform.openai.com -> Billing (add $5) -> platform.openai.com/api-keys -> Create new secret key. '
    + 'Paste into .env as OPENAI_API_KEY=sk-... (needed for the SPARK tier). (KEYS-TO-BUY.md step 3)',
  OPENROUTER_API_KEY:
    'Buy it: openrouter.ai/credits (add $5) -> openrouter.ai/keys -> Create key. Paste into .env as '
    + 'OPENROUTER_API_KEY=sk-or-... (KEYS-TO-BUY.md step 3)',
  BRAVE_API_KEY:
    'Get it free: brave.com/search/api -> subscribe to the Free plan (2,000 queries/month, card required, $0). '
    + 'Paste the subscription token into .env as BRAVE_API_KEY= and set SEARCH_PROVIDER=brave. (KEYS-TO-BUY.md step 4)',
  TAVILY_API_KEY:
    'Get it free: tavily.com -> sign up (1,000 queries/month, no card). Paste into .env as TAVILY_API_KEY= '
    + 'and set SEARCH_PROVIDER=tavily. (KEYS-TO-BUY.md step 4)',
} as const;

// ---------------------------------------------------------------------------
// Constants the checks assert against
// ---------------------------------------------------------------------------

/**
 * The Robinhood Chain ids. This is how the doctor knows RHC_RPC_URL points where you think it does.
 * One copy, shared with core/preflight.ts, so the boot refusal and this report can never disagree.
 */
export { CHAIN_IDS };

/** The settlement token is a 6-decimal ERC-20 (USDC and USDG both are). Anything else is not it. */
export const USDC_DECIMALS = 6;

export const GWEI_PER_ETH = 1_000_000_000;
/** Below this the treasury cannot reliably pay the gas stipends of the agents it funds. */
export const MIN_TREASURY_ETH = 0.05;
/** Tokens the probe completion is allowed to produce. Costs a small fraction of one cent. */
export const PROBE_MAX_TOKENS = 64;
export const PROBE_SYSTEM = 'You are a health check. Reply with exactly: ok';
export const PROBE_PROMPT = 'ping';
/** Agent id the docker check uses. Matches AGENT_ID_RE and is destroyed at the end of the check. */
export const DOCTOR_AGENT_ID = 'doctor-probe';
export const DOCTOR_SENTINEL = 'vantra-doctor-ok';

const TIMEOUT = { db: 15_000, llm: 60_000, search: 20_000, rpc: 20_000, docker: 120_000 } as const;

type KeyedProvider = Exclude<ModelProvider, 'mock'>;
const LLM_PROVIDERS: readonly KeyedProvider[] = ['anthropic', 'openai', 'openrouter'];
const KEY_ENV: Record<KeyedProvider, keyof typeof BUY_LINES> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

class Timeout extends Error {}

async function withTimeout<T>(label: string, ms: number, run: () => Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      run(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Timeout(`${label} did not answer within ${Math.round(ms / 1000)}s`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * A message a non-engineer can act on. Node's socket failures often arrive as an AggregateError with
 * an empty message and the real reason buried in `errors`, which would otherwise print a blank line
 * next to FAIL — the one thing a diagnostic must never do.
 */
export function msg(e: unknown): string {
  if (e instanceof AggregateError) {
    const inner = e.errors.map(msg).filter(Boolean).join('; ');
    if (inner) return inner;
  }
  if (e instanceof Error) {
    const code = (e as { code?: unknown }).code;
    const suffix = typeof code === 'string' && code !== '' ? ` (${code})` : '';
    if (e.message) return `${e.message}${suffix}`;
    return suffix ? suffix.slice(2, -1) : e.name;
  }
  return String(e);
}
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim().slice(0, 240);

/** An EIP-55 checksummed address, or null with the reason. */
export function parsePubkey(value: string): { pubkey: string } | { error: string } {
  const trimmed = value.trim();
  if (trimmed === '') return { error: 'empty' };
  if (!trimmed.startsWith('0x')) return { error: 'not an address (expected 0x followed by 40 hex characters)' };
  // Strict: an all-lowercase address is accepted (there is no checksum to disagree with) and returned
  // EIP-55 checksummed, but a mixed-case address whose checksum does not match is a corrupted paste and
  // is refused here rather than at the first transfer.
  if (!isAddress(trimmed)) {
    return { error: `not an address, or its EIP-55 checksum does not match: ${trimmed.length} characters, expected 0x plus 40 hex` };
  }
  return { pubkey: getAddress(trimmed) };
}

/** ETH at full gwei precision, never scientific notation, never rounded down to a friendly lie. */
export function fmtEth(gwei: number): string {
  return `${trimDecimals((gwei / GWEI_PER_ETH).toFixed(9))} ETH`;
}

/** Exact USD for a completion whose cost is far below one cent, so it never prints as "$0.00". */
export function fmtExactUsd(usd: number): string {
  if (usd === 0) return '$0';
  if (usd >= 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1e-8) return '<$0.00000001';
  return `$${trimDecimals(usd.toFixed(8))}`;
}

/** "1.500000000" -> "1.5", "0.000000000" -> "0". Only touches digits after the point. */
function trimDecimals(fixed: string): string {
  return fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed;
}

// ---------------------------------------------------------------------------
// Check recorder
// ---------------------------------------------------------------------------

class Recorder {
  readonly sections: Section[] = [];
  private current: Section | null = null;

  section(name: string): void {
    this.current = { name, checks: [] };
    this.sections.push(this.current);
  }

  add(check: Check): Check {
    if (!this.current) this.section('CHECKS');
    this.current!.checks.push(check);
    return check;
  }

  pass(id: string, title: string, detail: string, opts: { required?: boolean; ms?: number } = {}): Check {
    return this.add({ id, title, status: 'pass', detail, required: opts.required ?? true, ...(opts.ms === undefined ? {} : { ms: opts.ms }) });
  }

  fail(id: string, title: string, detail: string, remedy: string, opts: { required?: boolean; ms?: number } = {}): Check {
    return this.add({ id, title, status: 'fail', detail, remedy, required: opts.required ?? true, ...(opts.ms === undefined ? {} : { ms: opts.ms }) });
  }

  warn(id: string, title: string, detail: string, remedy: string): Check {
    return this.add({ id, title, status: 'warn', detail, remedy, required: false });
  }

  skip(id: string, title: string, detail: string, remedy: string, opts: { required?: boolean } = {}): Check {
    return this.add({ id, title, status: 'skip', detail, remedy, required: opts.required ?? false });
  }

  has(id: string): boolean {
    return this.sections.some((s) => s.checks.some((c) => c.id === id && c.status === 'pass'));
  }
}

// ---------------------------------------------------------------------------
// 1. Config and secrets
// ---------------------------------------------------------------------------

interface WalletInfo {
  treasury: { pubkey: string; secret: Uint8Array } | null;
  escrow: { pubkey: string } | null;
  founderFee: string | null;
  protocolFee: string | null;
}

function checkEnvFile(r: Recorder): void {
  const envPath = path.join(REPO_ROOT, '.env');
  if (existsSync(envPath)) {
    r.pass('env.file', '.env file', envPath);
    return;
  }
  r.fail('env.file', '.env file', `not found at ${envPath}`,
    `Run: cp ${path.join(REPO_ROOT, '.env.example')} ${envPath}  — then open it and paste your keys in.`);
}

function checkConfig(r: Recorder): Config | null {
  try {
    const config = loadConfig();
    const flags = [
      `NODE_ENV=${config.env}`, `CHAIN_MODE=${config.chain.mode}`, `LLM_PROVIDER=${config.llm.provider}`,
      `SANDBOX_DRIVER=${config.sandbox.driver}`, `founder fee ${config.economy.founderFeeBps / 100}%`,
    ];
    r.pass('config.load', 'Config parses', flags.join(' · '));
    return config;
  } catch (e) {
    r.fail('config.load', 'Config parses', oneLine(msg(e)),
      'Open .env and fix exactly the variable named in the message above, then run `pnpm ready` again. '
      + 'Every variable is documented in .env.example.');
    return null;
  }
}

/**
 * The boot refusals from core/preflight.ts, reported instead of thrown. Every problem here is one
 * the server will NOT start with, which is a harder statement than "this check failed": it is the
 * difference between "VANTRA runs but is pretending" and "VANTRA will not run at all".
 */
export function preflightChecks(config: Config): Check[] {
  const problems = configContradictions(config);
  if (problems.length === 0) {
    return [{
      id: 'preflight.boot',
      title: 'Server would start',
      status: 'pass',
      detail: 'no configuration contradicts itself — nothing here would make VANTRA look real while it is not',
      required: true,
    }];
  }
  return problems.map((p) => ({
    id: `preflight.${p.id}`,
    title: 'Server REFUSES to start',
    status: 'fail' as const,
    detail: oneLine(p.problem),
    remedy: p.remedy,
    required: true,
  }));
}

function checkPreflight(r: Recorder, config: Config): void {
  for (const c of preflightChecks(config)) r.add(c);
}

function checkSecrets(r: Recorder, env: NodeJS.ProcessEnv): void {
  const session = (env.SESSION_SECRET ?? '').trim();
  if (session.length >= 32) {
    r.pass('env.session', 'SESSION_SECRET', `${session.length} characters (signs your login cookies and every claim code)`);
  } else if (session.length === 0) {
    r.fail('env.session', 'SESSION_SECRET', 'not set — the server would boot on a public development default',
      'Run: openssl rand -base64 48   then put the output in .env as SESSION_SECRET=');
  } else {
    r.fail('env.session', 'SESSION_SECRET', `only ${session.length} characters; 32 is the minimum`,
      'Run: openssl rand -base64 48   then replace SESSION_SECRET= in .env with the output');
  }

  const kek = (env.KEY_ENCRYPTION_KEY ?? '').trim();
  if (/^[0-9a-fA-F]{64}$/.test(kek)) {
    r.pass('env.kek', 'KEY_ENCRYPTION_KEY', '64 hex characters (AES-256-GCM over every agent and deposit private key)');
  } else if (kek === '') {
    r.fail('env.kek', 'KEY_ENCRYPTION_KEY', 'not set — agent private keys would be encrypted with a public development key',
      'Run: openssl rand -hex 32   then put the output in .env as KEY_ENCRYPTION_KEY=. '
      + 'Set it ONCE: changing it later makes every stored agent wallet unreadable.');
  } else if (/^0+$/.test(kek)) {
    r.fail('env.kek', 'KEY_ENCRYPTION_KEY', 'is all zeroes — that is the development placeholder, not a key',
      'Run: openssl rand -hex 32   then replace KEY_ENCRYPTION_KEY= in .env with the output');
  } else {
    r.fail('env.kek', 'KEY_ENCRYPTION_KEY', `must be exactly 64 hex characters; got ${kek.length} characters`,
      'Run: openssl rand -hex 32   then replace KEY_ENCRYPTION_KEY= in .env with the output');
  }
}

function checkWallets(r: Recorder, env: NodeJS.ProcessEnv): WalletInfo {
  const info: WalletInfo = { treasury: null, escrow: null, founderFee: null, protocolFee: null };

  // Two signers: the secret must load AND the address is printed so you can fund it.
  for (const [id, title, variable, hint] of [
    ['wallet.treasury', 'TREASURY_WALLET_SECRET', 'TREASURY_WALLET_SECRET',
      'It receives the 90% of every purchase and funds each agent. The server signs with it.'],
    ['wallet.escrow', 'ESCROW_WALLET_SECRET', 'ESCROW_WALLET_SECRET',
      'It holds bounty rewards between posting and payout. The server signs with it.'],
  ] as const) {
    const raw = (env[variable] ?? '').trim();
    if (raw === '') {
      r.fail(id, title, 'not set', `${hint} Create one:\n`
        + '    openssl rand -hex 32\n'
        + `  then put the output in .env as ${variable}=0x<that hex>. Run \`pnpm ready\` again: this line then `
        + 'prints the address derived from it, and that is the address you fund.');
      continue;
    }
    try {
      const secret = loadSecret(raw);
      const pubkey = pubkeyOfSecret(secret);
      const shape = raw.startsWith('[') ? 'inline JSON bytes'
        : raw.includes('/') || raw.endsWith('.json') ? `key file ${raw}`
        : 'hex private key';
      r.pass(id, title, `${pubkey}  (from ${shape})`);
      if (variable === 'TREASURY_WALLET_SECRET') info.treasury = { pubkey, secret };
      else info.escrow = { pubkey };
    } catch (e) {
      r.fail(id, title, oneLine(msg(e)),
        `${variable} takes a 32-byte private key as 0x-hex, or the path to a JSON byte array holding one. `
        + 'Check the path exists and that you did not paste the PUBLIC address by mistake.');
    }
  }

  // Two destinations: addresses only, we never sign for them.
  for (const [id, variable, what] of [
    ['wallet.founder', 'FOUNDER_FEE_WALLET', 'your cut — 10% of every purchase lands here, straight from the buyer'],
    ['wallet.protocol', 'PROTOCOL_FEE_WALLET', 'where agents’ metered spend is swept, so your provider bill is reimbursed'],
  ] as const) {
    const raw = (env[variable] ?? '').trim();
    if (raw === '') {
      r.fail(id, variable, 'not set', `This is ${what}. Use the receiving ADDRESS of a wallet you control:\n`
        + '    a MetaMask/Rabby account or a hardware wallet, added to Robinhood Chain (chain id '
        + `${CHAIN_IDS.mainnet})\n`
        + `  then put that 0x… address in .env as ${variable}=. Never put a private key here.`);
      continue;
    }
    const parsed = parsePubkey(raw);
    if ('error' in parsed) {
      r.fail(id, variable, parsed.error,
        `${variable} must be a public 0x ADDRESS (42 characters), not a private key and not a file path.`);
      continue;
    }
    r.pass(id, variable, `${parsed.pubkey}  (${what})`);
    if (variable === 'FOUNDER_FEE_WALLET') info.founderFee = parsed.pubkey;
    else info.protocolFee = parsed.pubkey;
  }

  const addresses = [
    ['TREASURY_WALLET_SECRET', info.treasury?.pubkey],
    ['ESCROW_WALLET_SECRET', info.escrow?.pubkey],
    ['FOUNDER_FEE_WALLET', info.founderFee],
    ['PROTOCOL_FEE_WALLET', info.protocolFee],
  ].filter((pair): pair is [string, string] => typeof pair[1] === 'string');
  if (addresses.length === 4) {
    const seen = new Map<string, string>();
    const clashes: string[] = [];
    for (const [name, address] of addresses) {
      const first = seen.get(address);
      if (first) clashes.push(`${first} and ${name} are the same wallet`);
      else seen.set(address, name);
    }
    if (clashes.length === 0) {
      r.pass('wallet.distinct', 'Four separate wallets', 'treasury, escrow, founder fee and protocol fee are all different addresses');
    } else {
      r.fail('wallet.distinct', 'Four separate wallets', clashes.join('; '),
        'Generate a separate keypair for each of the four. Pointing two variables at one wallet makes your '
        + 'margin, the agents’ money and the escrow indistinguishable in the ledger.');
    }
  }

  return info;
}

// ---------------------------------------------------------------------------
// 2. Database
// ---------------------------------------------------------------------------

interface SnapshotTable { name: string; columns: Record<string, { name: string }> }
interface Snapshot { tables: Record<string, SnapshotTable> }

/** The newest drizzle snapshot in apps/api/drizzle/meta — the schema the migrations add up to. */
export function latestSnapshot(metaDir: string): { tag: string; tables: Map<string, Set<string>> } {
  const files = readdirSync(metaDir).filter((f) => /^\d+_snapshot\.json$/.test(f)).sort();
  const file = files[files.length - 1];
  if (!file) throw new Error(`no drizzle snapshots in ${metaDir}`);
  const snapshot = JSON.parse(readFileSync(path.join(metaDir, file), 'utf8')) as Snapshot;
  const tables = new Map<string, Set<string>>();
  for (const table of Object.values(snapshot.tables)) {
    tables.set(table.name, new Set(Object.values(table.columns).map((c) => c.name)));
  }
  return { tag: file.replace('_snapshot.json', ''), tables };
}

/** Pure: what the live database is missing relative to the migrations. */
export function schemaDrift(
  expected: Map<string, Set<string>>,
  actual: Map<string, Set<string>>,
): { missingTables: string[]; missingColumns: string[]; extraTables: string[] } {
  const missingTables: string[] = [];
  const missingColumns: string[] = [];
  for (const [table, columns] of expected) {
    const live = actual.get(table);
    if (!live) {
      missingTables.push(table);
      continue;
    }
    for (const column of columns) if (!live.has(column)) missingColumns.push(`${table}.${column}`);
  }
  const extraTables = [...actual.keys()].filter((t) => !expected.has(t) && !t.startsWith('__drizzle'));
  return { missingTables: missingTables.sort(), missingColumns: missingColumns.sort(), extraTables: extraTables.sort() };
}

function dbName(url: string): string {
  try {
    return new URL(url).pathname.replace(/^\//, '') || '(default)';
  } catch {
    return '(unparseable DATABASE_URL)';
  }
}

async function checkDatabase(r: Recorder, config: Config): Promise<void> {
  const name = dbName(config.databaseUrl);
  const handle = createDb(config.databaseUrl, { max: 1 });
  try {
    let version: string;
    const started = Date.now();
    try {
      const res = await withTimeout('Postgres', TIMEOUT.db, () => handle.pool.query<{ v: string }>('select version() as v'));
      version = (res.rows[0]?.v ?? 'postgres').split(' ').slice(0, 2).join(' ');
    } catch (e) {
      const code = (e as { code?: string } | null)?.code;
      if (code === '3D000') {
        // The server answered; it just has no such database. Two separate facts, two separate lines.
        r.pass('db.server', 'Postgres running', `answered on ${config.databaseUrl.replace(/:[^:@/]*@/, ':****@')}`);
        r.fail('db.exists', `Database "${name}"`, 'does not exist', `Run: createdb ${name} && pnpm db:push`);
        return;
      }
      if (code === '28P01' || code === '28000') {
        r.fail('db.server', 'Postgres running', `authentication rejected (${oneLine(msg(e))})`,
          'Fix the username/password in DATABASE_URL in .env. Locally the usual value is '
          + 'postgres://localhost:5432/vantra with no password.');
        r.skip('db.exists', `Database "${name}"`, 'not checked — could not log in', 'Fix the login above first.', { required: true });
        return;
      }
      r.fail('db.server', 'Postgres running', oneLine(msg(e)),
        'Start Postgres (macOS: `brew services start postgresql@14`) or point DATABASE_URL in .env at your database.');
      r.skip('db.exists', `Database "${name}"`, 'not checked — no server', 'Start Postgres first.', { required: true });
      return;
    }
    r.pass('db.server', 'Postgres running', version, { ms: Date.now() - started });
    r.pass('db.exists', `Database "${name}"`, 'exists and accepts connections');

    // Schema currency: compare the live columns against the newest drizzle snapshot.
    const metaDir = path.join(API_ROOT, 'drizzle', 'meta');
    let expected: ReturnType<typeof latestSnapshot>;
    try {
      expected = latestSnapshot(metaDir);
    } catch (e) {
      r.fail('db.schema', 'Schema up to date', oneLine(msg(e)), `Expected drizzle snapshots in ${metaDir}. Run: pnpm db:generate`);
      return;
    }
    const rows = await withTimeout('Postgres', TIMEOUT.db, () => handle.pool.query<{ table_name: string; column_name: string }>(
      `select table_name, column_name from information_schema.columns where table_schema = 'public'`,
    ));
    const actual = new Map<string, Set<string>>();
    for (const row of rows.rows) {
      const set = actual.get(row.table_name) ?? new Set<string>();
      set.add(row.column_name);
      actual.set(row.table_name, set);
    }
    const drift = schemaDrift(expected.tables, actual);
    const summary = `${expected.tables.size} tables expected at migration ${expected.tag}`;
    if (drift.missingTables.length === 0 && drift.missingColumns.length === 0) {
      const extra = drift.extraTables.length > 0 ? ` · ${drift.extraTables.length} extra table(s): ${drift.extraTables.join(', ')}` : '';
      r.pass('db.schema', 'Schema up to date', `${summary}, all present${extra}`);
    } else {
      const parts: string[] = [];
      if (drift.missingTables.length > 0) parts.push(`missing tables: ${drift.missingTables.join(', ')}`);
      if (drift.missingColumns.length > 0) {
        const shown = drift.missingColumns.slice(0, 8).join(', ');
        parts.push(`missing columns: ${shown}${drift.missingColumns.length > 8 ? ` (+${drift.missingColumns.length - 8} more)` : ''}`);
      }
      r.fail('db.schema', 'Schema up to date', `${summary}; ${parts.join('; ')}`,
        'Run: pnpm db:push   (development — applies the schema directly)\n'
        + '  or: pnpm db:migrate   (a database that has had migrations applied before)');
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// 3. Brains — one real call per key
// ---------------------------------------------------------------------------

const apiKeyOf = (config: Config, provider: KeyedProvider): string | null => ({
  anthropic: config.llm.anthropicApiKey,
  openai: config.llm.openaiApiKey,
  openrouter: config.llm.openrouterApiKey,
}[provider]);

function probeConfig(config: Config, provider: KeyedProvider, allowed: string[]): Config {
  return {
    ...config,
    llm: {
      provider: 'router',
      anthropicApiKey: provider === 'anthropic' ? config.llm.anthropicApiKey : null,
      openaiApiKey: provider === 'openai' ? config.llm.openaiApiKey : null,
      openrouterApiKey: provider === 'openrouter' ? config.llm.openrouterApiKey : null,
      allowedModels: allowed,
      x402: null,
    },
  };
}

/** Cheapest enabled model of one provider, honouring LLM_ALLOWED_MODELS when it leaves any. */
function probeModelFor(config: Config, provider: KeyedProvider): { config: Config; model: ModelInfo } | null {
  for (const allowed of [config.llm.allowedModels, []]) {
    const candidate = probeConfig(config, provider, allowed);
    let models: ModelInfo[];
    try {
      models = buildCatalog(catalogEnv(candidate)).models;
    } catch {
      continue;
    }
    const usable = models.filter((m) => m.enabled && m.provider === provider);
    if (usable.length === 0) continue;
    const cheapest = usable.reduce((best, m) => (m.inputPerM * 3 + m.outputPerM < best.inputPerM * 3 + best.outputPerM ? m : best));
    return { config: candidate, model: cheapest };
  }
  return null;
}

/** Turns a provider failure into the one sentence that fixes it. */
export function llmRemedy(provider: KeyedProvider, status: number | undefined, message: string, model: string): string {
  const variable = KEY_ENV[provider];
  const low = message.toLowerCase();
  if (status === 401 || status === 403) {
    return `The key was rejected. Re-copy it from the provider's dashboard into .env as ${variable}= — check for a `
      + 'missing character, a trailing space, or surrounding quotes. Then run `pnpm ready` again.';
  }
  if (status === 404 || low.includes('model_not_found') || low.includes('does not exist')) {
    return `Your key works but this account cannot use "${model}". Either enable that model with the provider, or `
      + `name a model you do have in LLM_ALLOWED_MODELS= in .env.`;
  }
  if (low.includes('credit') || low.includes('quota') || low.includes('insufficient') || low.includes('billing')) {
    return `The key is valid but the account is out of money. Top it up (${BUY_LINES[variable].replace(/^(Buy|Get) it: /, '')})`;
  }
  if (status === 429) {
    return 'Rate limited. Wait a minute and run `pnpm ready` again. If it keeps happening, the account is on a '
      + 'free/low tier — add credit to raise the limit.';
  }
  if (status !== undefined && status >= 500) {
    return `The provider returned a server error (HTTP ${status}). This is their outage, not your setup. Try again in a few minutes.`;
  }
  if (low.includes('network') || low.includes('timeout') || low.includes('did not answer')) {
    return 'Could not reach the provider. Check this machine is online and that no VPN or firewall is blocking it.';
  }
  return `Unexpected failure. The message above is verbatim from the provider. Verify ${variable} in .env first.`;
}

/**
 * Test seam, mirroring createRouter's own `providers` option: it lets the suite drive the real
 * check function with a provider whose answer is known, so the PASS branch is covered without a key.
 */
export interface DoctorDeps {
  llmProviders?: Partial<Record<ModelProvider, LlmProvider>>;
  /** Same idea for the search check: the provider's own fetch seam. */
  searchFetch?: (input: string, init?: RequestInit) => Promise<Response>;
}

async function checkOneProvider(r: Recorder, config: Config, provider: KeyedProvider, deps: DoctorDeps): Promise<void> {
  const variable = KEY_ENV[provider];
  const key = apiKeyOf(config, provider);
  const title = `${provider} key`;
  if (!key) {
    r.skip(`llm.${provider}`, title, `${variable} is not set`, BUY_LINES[variable]);
    return;
  }
  const picked = probeModelFor(config, provider);
  if (!picked) {
    r.fail(`llm.${provider}`, title, `key is set but no ${provider} model survives LLM_ALLOWED_MODELS`,
      `Remove ${provider} models from LLM_ALLOWED_MODELS in .env, or leave LLM_ALLOWED_MODELS empty to allow the whole catalog.`,
      { required: false });
    return;
  }
  const { model } = picked;
  const router = createRouter({
    config: picked.config,
    log: silentLogger,
    ...(deps.llmProviders ? { providers: deps.llmProviders } : {}),
  });
  const started = Date.now();
  try {
    const res = await withTimeout(provider, TIMEOUT.llm, () => router.complete({
      model: model.id,
      system: PROBE_SYSTEM,
      messages: [{ role: 'user', content: [{ type: 'text', text: PROBE_PROMPT }] }],
      tools: [],
      maxTokens: PROBE_MAX_TOKENS,
      agentId: DOCTOR_AGENT_ID,
      remainingMs: TIMEOUT.llm,
    }));
    const ms = Date.now() - started;
    const u = res.usage;
    const exact = (u.inputTokens * model.inputPerM + u.outputTokens * model.outputPerM) / 1e6;
    const reply = res.content.flatMap((c) => (c.type === 'text' ? [c.text] : [])).join(' ').trim().slice(0, 40);
    r.pass(`llm.${provider}`, title,
      `${res.model} answered in ${ms} ms · ${u.inputTokens} in / ${u.outputTokens} out tokens · this call cost `
      + `${fmtExactUsd(exact)}${reply ? ` · said "${reply}"` : ` · stop=${res.stopReason}`}`,
      { required: false, ms });
  } catch (e) {
    const ms = Date.now() - started;
    const status = e instanceof LlmCallError ? e.status : undefined;
    r.fail(`llm.${provider}`, title, oneLine(msg(e)), llmRemedy(provider, status, msg(e), model.id), { required: false, ms });
  }
}

/** Section 3 on its own, so the suite can drive it with a known provider. */
export async function brainChecks(config: Config, deps: DoctorDeps = {}): Promise<Check[]> {
  const r = new Recorder();
  r.section('brains');
  await checkBrains(r, config, deps);
  return r.sections[0]!.checks;
}

async function checkBrains(r: Recorder, config: Config, deps: DoctorDeps): Promise<void> {
  for (const provider of LLM_PROVIDERS) await checkOneProvider(r, config, provider, deps);

  const working = LLM_PROVIDERS.filter((p) => r.has(`llm.${p}`));
  if (working.length > 0) {
    r.pass('llm.any', 'At least one real brain', `${working.join(', ')} answered a live request`);
  } else {
    r.fail('llm.any', 'At least one real brain', 'no provider key made a successful call',
      `Agents cannot think without one. Cheapest start: ${BUY_LINES.ANTHROPIC_API_KEY}`);
  }

  if (config.llm.provider === 'router') {
    r.pass('llm.mode', 'LLM_PROVIDER', 'router — agents use the real models');
  } else if (working.length > 0) {
    r.fail('llm.mode', 'LLM_PROVIDER', `is "${config.llm.provider}" — your keys work but every agent is still thinking with the scripted mock`,
      'Set LLM_PROVIDER=router in .env. This is the single line that turns the simulation into the product.');
  } else {
    r.fail('llm.mode', 'LLM_PROVIDER', `is "${config.llm.provider}" — agents run on scripted mock responses, not a real model`,
      'Add a provider key (see above), then set LLM_PROVIDER=router in .env.');
  }

  // Which tiers can actually run the model they are sold with. Judged against the catalog the app
  // would really build — keys that ANSWERED, plus LLM_ALLOWED_MODELS — not against the default list,
  // because a narrow LLM_ALLOWED_MODELS silently substitutes a model exactly like a missing key does.
  const enabled = enabledModelIds(config, working);
  const unavailable = TIERS.filter((t) => !enabled.has(t.modelId));
  if (unavailable.length === 0) {
    r.pass('llm.tiers', 'Every tier gets its own model', TIERS.map((t) => `${t.id}→${t.modelId}`).join(' · '));
    return;
  }
  const missingKeys = [...new Set(
    unavailable
      .map((t) => DEFAULT_CATALOG.find((m) => m.id === t.modelId)?.provider)
      .filter((p): p is KeyedProvider => p !== undefined && p !== 'mock' && !working.includes(p)),
  )];
  const remedy = missingKeys.length > 0
    ? `Add the provider key for ${missingKeys.join(' and ')}, or accept that the buyer gets a substitute model.`
    : 'You have the key, so this is LLM_ALLOWED_MODELS in .env excluding the model. Add those model ids to it, '
      + 'or leave LLM_ALLOWED_MODELS empty to allow every model you have a key for.';
  r.fail('llm.tiers', 'Every tier gets its own model',
    `${unavailable.map((t) => `${t.id} wants ${t.modelId}`).join(', ')} — ${unavailable.length === 1 ? 'that tier' : 'those tiers'} would silently run a different model`,
    remedy, { required: false });
}

/** Model ids the running app would actually serve, given the keys that answered. */
function enabledModelIds(config: Config, working: readonly KeyedProvider[]): Set<string> {
  const asRouter: Config = {
    ...config,
    llm: {
      provider: 'router',
      anthropicApiKey: working.includes('anthropic') ? config.llm.anthropicApiKey : null,
      openaiApiKey: working.includes('openai') ? config.llm.openaiApiKey : null,
      openrouterApiKey: working.includes('openrouter') ? config.llm.openrouterApiKey : null,
      allowedModels: config.llm.allowedModels,
      x402: null,
    },
  };
  try {
    return new Set(buildCatalog(catalogEnv(asRouter)).models.filter((m) => m.enabled).map((m) => m.id));
  } catch {
    return new Set();          // no key answered: buildCatalog throws, and no tier can have its model
  }
}

// ---------------------------------------------------------------------------
// 4. Search
// ---------------------------------------------------------------------------

/** Section 4 on its own, so the suite can drive it with a known answer. */
export async function searchChecks(config: Config, deps: DoctorDeps = {}): Promise<Check[]> {
  const r = new Recorder();
  r.section('search');
  await checkSearch(r, config, deps);
  return r.sections[0]!.checks;
}

async function checkSearch(r: Recorder, config: Config, deps: DoctorDeps): Promise<void> {
  const brave = config.search.braveApiKey;
  const tavily = config.search.tavilyApiKey;
  if (!brave && !tavily) {
    r.skip('search.key', 'Web search', 'no BRAVE_API_KEY or TAVILY_API_KEY set — SCOUT and above lose the web_search tool',
      BUY_LINES.BRAVE_API_KEY);
    return;
  }
  const which: 'brave' | 'tavily' = brave ? 'brave' : 'tavily';
  const fetchImpl = deps.searchFetch ?? fetch;
  const provider = which === 'brave'
    ? createBraveSearch(brave!, silentLogger, fetchImpl)
    : createTavilySearch(tavily!, silentLogger, fetchImpl);
  const started = Date.now();
  try {
    const results = await withTimeout(which, TIMEOUT.search, () => provider.search('robinhood chain usdc bridge', 3));
    const ms = Date.now() - started;
    if (results.length === 0) {
      r.warn('search.key', 'Web search', `${which} answered in ${ms} ms but returned no results for a normal query`,
        'The key works. If this repeats, check the plan is active in the provider dashboard.');
      return;
    }
    r.pass('search.key', 'Web search', `${which} returned ${results.length} results in ${ms} ms · top hit "${results[0]!.title.slice(0, 60)}"`,
      { required: false, ms });
  } catch (e) {
    r.fail('search.key', 'Web search', oneLine(msg(e)),
      `The ${which} key was rejected or unreachable. Re-copy it into .env as ${which === 'brave' ? 'BRAVE_API_KEY' : 'TAVILY_API_KEY'}= `
      + `and confirm the plan is active. ${which === 'brave' ? BUY_LINES.BRAVE_API_KEY : BUY_LINES.TAVILY_API_KEY}`,
      { required: false });
    return;
  }
  if (config.search.provider === 'none') {
    r.warn('search.mode', 'SEARCH_PROVIDER', `is "none", so the working ${which} key is never used`,
      `Set SEARCH_PROVIDER=${which} in .env to give agents the web_search tool.`);
  } else {
    r.pass('search.mode', 'SEARCH_PROVIDER', `${config.search.provider} — agents have the web_search tool`, { required: false });
  }
}

// ---------------------------------------------------------------------------
// 5. Chain
// ---------------------------------------------------------------------------

async function checkChain(r: Recorder, config: Config, wallets: WalletInfo): Promise<void> {
  const { cluster, rpcUrl, usdcMint } = config.chain;
  const client = publicClientFor(config.chain);
  // Provider endpoints carry the key in the path (Alchemy) or the query (most others). Mask both.
  const shownUrl = rpcUrl.replace(/(\/v2\/)[^/?#]+/i, '$1****').replace(/([?&]api[-_]?key=)[^&]+/i, '$1****');

  if (config.chain.mode === 'robinhood') {
    r.pass('chain.mode', 'CHAIN_MODE', 'robinhood — real deposit addresses, real transfers');
  } else {
    r.fail('chain.mode', 'CHAIN_MODE', `is "${config.chain.mode}" — purchases are simulated in memory and no money moves`,
      'Set CHAIN_MODE=robinhood in .env once the four wallets above are set. Keep RHC_NETWORK=testnet until you have '
      + 'watched a few testnet purchases go through.');
  }

  let reachable = false;
  const started = Date.now();
  try {
    const head = await withTimeout('Robinhood Chain RPC', TIMEOUT.rpc, () => client.getBlockNumber());
    reachable = true;
    r.pass('chain.rpc', 'Robinhood Chain RPC reachable', `${shownUrl} · head block ${head}`, { ms: Date.now() - started });
  } catch (e) {
    r.fail('chain.rpc', 'Robinhood Chain RPC reachable', `${shownUrl}: ${oneLine(msg(e))}`,
      'Check this machine is online. The public endpoint https://rpc.mainnet.chain.robinhood.com works but is rate '
      + 'limited and carries no SLA; for anything real put your own provider endpoint in RHC_RPC_URL in .env.');
  }

  if (!reachable) {
    for (const [id, title] of [['chain.network', 'RPC is the network you think'], ['chain.usdc-contract', 'USDC contract valid'],
      ['chain.eth', 'Treasury ETH'], ['chain.usdc', 'Treasury USDC']] as const) {
      r.skip(id, title, 'not checked — the RPC did not answer', 'Fix the RPC connection above first.', { required: true });
    }
    moneyMode(r, cluster);
    return;
  }

  // Network identity, proved by eth_chainId rather than by trusting the URL.
  try {
    const chainId = await withTimeout('Robinhood Chain RPC', TIMEOUT.rpc, () => client.getChainId());
    const expected = CHAIN_IDS[cluster];
    const actualName = Object.entries(CHAIN_IDS).find(([, id]) => id === chainId)?.[0] ?? 'an unknown chain';
    if (chainId === expected) {
      const money = cluster === 'mainnet' ? 'REAL money' : 'practice money';
      r.pass('chain.network', 'RPC is the network you think',
        `RHC_NETWORK=${cluster} and the endpoint really answers chain id ${chainId} (${money})`);
    } else {
      r.fail('chain.network', 'RPC is the network you think',
        `RHC_NETWORK=${cluster} is chain id ${expected}, but RHC_RPC_URL answers chain id ${chainId} (${actualName})`,
        `Either set RHC_NETWORK=${actualName === 'an unknown chain' ? 'testnet' : actualName} or change RHC_RPC_URL `
        + 'to an endpoint for the network you meant. Getting this wrong sends real purchases to a chain nobody watches.');
    }
  } catch (e) {
    r.fail('chain.network', 'RPC is the network you think', oneLine(msg(e)), 'Retry; if it persists, use a different RPC endpoint.');
  }

  // The settlement token must be a real 6-decimal ERC-20 on THIS network, or every purchase silently fails.
  const builtIn = Object.entries(USDC_ADDRESSES).find(([, a]) => sameAddress(a, usdcMint))?.[0] ?? null;
  // Telling him to "clear USDC_ADDRESS" when it is already the built-in address is a dead end: the token
  // is right and the endpoint is wrong. Say which of the two it is.
  const tokenRemedy = builtIn === 'usdc'
    ? 'That IS the canonical mainnet USDC, so the endpoint is the problem: RHC_RPC_URL is not a Robinhood Chain '
      + 'mainnet endpoint. Fix the network line above and this one fixes itself.'
    : 'Set USDC_ADDRESS in .env to the settlement token that exists on this network. Mainnet USDC is '
      + `${USDC_ADDRESSES.usdc}; USDG (deeper liquidity) is ${USDC_ADDRESSES.usdg}. Testnet has no canonical one — `
      + 'bridge test USDC and name the address it lands at.';
  try {
    const token = getAddress(usdcMint);
    const [decimals, symbol] = await withTimeout('Robinhood Chain RPC', TIMEOUT.rpc, async () => Promise.all([
      client.readContract({ address: token, abi: erc20Abi, functionName: 'decimals' }),
      client.readContract({ address: token, abi: erc20Abi, functionName: 'symbol' }),
    ]));
    if (decimals !== USDC_DECIMALS) {
      r.fail('chain.usdc-contract', 'USDC contract valid',
        `${token} (${symbol}) reports ${decimals} decimals; the settlement token must have ${USDC_DECIMALS}`, tokenRemedy);
    } else {
      const provenance = builtIn ? `the built-in ${builtIn.toUpperCase()} address` : 'your USDC_ADDRESS override';
      r.pass('chain.usdc-contract', 'USDC contract valid', `${token} · ${symbol} · ${decimals} decimals (${provenance})`);
    }
  } catch (e) {
    // No code at the address, or an address that is not an ERC-20 at all: both land here, because an
    // eth_call against nothing reverts rather than answering.
    r.fail('chain.usdc-contract', 'USDC contract valid',
      `${usdcMint} is not a readable ERC-20 on ${cluster}: ${oneLine(msg(e))}`, tokenRemedy);
  }

  if (!wallets.treasury) {
    r.skip('chain.eth', 'Treasury ETH', 'no treasury wallet loaded', 'Set TREASURY_WALLET_SECRET in .env (see above).', { required: true });
    r.skip('chain.usdc', 'Treasury USDC', 'no treasury wallet loaded', 'Set TREASURY_WALLET_SECRET in .env (see above).', { required: false });
    moneyMode(r, cluster);
    return;
  }

  // Deliberately goes through the real adapter, so this line proves chain/evm.ts talks to the network.
  let chain: ChainAdapter;
  try {
    chain = createEvmChain(config, silentLogger);
  } catch (e) {
    r.fail('chain.eth', 'Treasury ETH', oneLine(msg(e)), 'Fix the wallet variables reported above.');
    return;
  }
  const treasury = wallets.treasury.pubkey;

  try {
    const gwei = await withTimeout('Robinhood Chain RPC', TIMEOUT.rpc, () => chain.getEthBalance(treasury));
    // Every agent is spawned with one gas stipend, so that is the unit the treasury is measured in.
    const agents = Math.floor(gwei / ETH_GAS_STIPEND_GWEI);
    const fund = cluster === 'testnet'
      ? `Fund ${treasury} from the Robinhood Chain testnet faucet, or bridge test ETH to it.`
      : `Send at least ${MIN_TREASURY_ETH} ETH to ${treasury} from an exchange or a bridge.`;
    if (gwei === 0) {
      r.fail('chain.eth', 'Treasury ETH',
        `${treasury} holds 0 ETH — it cannot pay a single transaction fee, and one agent's gas stipend is `
        + `${fmtEth(ETH_GAS_STIPEND_GWEI)}`,
        fund);
    } else if (gwei < MIN_TREASURY_ETH * GWEI_PER_ETH) {
      r.fail('chain.eth', 'Treasury ETH',
        `${treasury} holds ${fmtEth(gwei)}; one agent's gas stipend is ${fmtEth(ETH_GAS_STIPEND_GWEI)}, so this covers about ${agents} agent(s)`,
        fund);
    } else {
      r.pass('chain.eth', 'Treasury ETH',
        `${treasury} holds ${fmtEth(gwei)} · gas stipend per agent ${fmtEth(ETH_GAS_STIPEND_GWEI)} · enough for roughly ${agents} agents`);
    }
  } catch (e) {
    r.fail('chain.eth', 'Treasury ETH', oneLine(msg(e)),
      'The RPC answered eth_blockNumber but not eth_getBalance. Retry, or switch RHC_RPC_URL.');
  }

  try {
    const micro = await withTimeout('Robinhood Chain RPC', TIMEOUT.rpc, () => chain.getUsdcBalance(treasury));
    const detail = `${treasury} holds ${fmtUsd(micro)} USDC`;
    if (micro > 0) {
      r.pass('chain.usdc', 'Treasury USDC', `${detail} — float available`, { required: false });
    } else {
      r.warn('chain.usdc', 'Treasury USDC', `${detail} — no float`,
        cluster === 'testnet'
          ? `Bridge test USDC to ${treasury}. Not required: each purchase funds its own agent.`
          : `Send some USDC to ${treasury} as working float. Not required: each purchase funds its own agent, but a float absorbs timing gaps.`);
    }
  } catch (e) {
    r.fail('chain.usdc', 'Treasury USDC', oneLine(msg(e)),
      `Retry; if it persists the RPC is not serving eth_call against ${usdcMint}.`, { required: false });
  }

  moneyMode(r, cluster);
}

/** Never blocks: testnet is the right place to be until purchases have been watched end to end. */
function moneyMode(r: Recorder, cluster: string): void {
  if (cluster === 'mainnet') {
    r.pass('chain.money', 'Money mode', 'mainnet with ALLOW_MAINNET=1 — purchases move real USDC', { required: false });
    return;
  }
  r.warn('chain.money', 'Money mode', `${cluster} — the USDC here is play money`,
    'When testnet purchases have worked end to end: set RHC_NETWORK=mainnet AND ALLOW_MAINNET=1 in .env, '
    + 'clear USDC_ADDRESS so the built-in mainnet USDC is used, point RHC_RPC_URL at a mainnet endpoint, and fund '
    + 'the treasury with real ETH.');
}

// ---------------------------------------------------------------------------
// 6. Sandbox
// ---------------------------------------------------------------------------

async function checkSandbox(r: Recorder, config: Config): Promise<void> {
  const image = config.sandbox.image;

  if (config.sandbox.driver === 'none') {
    r.warn('sandbox.driver', 'SANDBOX_DRIVER',
      `none — no agent code runs anywhere; withheld from every agent: ${SANDBOX_TOOLS.join(', ')}`,
      'Deliberate on a host without Docker. To give agents bash, files, sites and paid services, run on a host with a '
      + 'Docker daemon and set SANDBOX_DRIVER=docker; stored agent tools come back with no migration.');
    return;
  }
  if (config.sandbox.driver === 'docker') {
    r.pass('sandbox.driver', 'SANDBOX_DRIVER', 'docker — agent code runs inside a locked-down container');
  } else {
    r.fail('sandbox.driver', 'SANDBOX_DRIVER', `is "${config.sandbox.driver}" — agent bash would run directly on this machine`,
      'Set SANDBOX_DRIVER=docker in .env (or none on a host that cannot run Docker). The server refuses to start with '
      + 'local when NODE_ENV=production, so this must be fixed before you deploy.');
  }

  const docker = new Docker();
  try {
    await withTimeout('Docker', TIMEOUT.docker, () => docker.ping());
    const version = await withTimeout('Docker', TIMEOUT.docker, () => docker.version());
    r.pass('sandbox.daemon', 'Docker running', `engine ${version.Version} (API ${version.ApiVersion}) on ${version.Os}/${version.Arch}`);
  } catch (e) {
    r.fail('sandbox.daemon', 'Docker running', oneLine(msg(e)),
      'Install OrbStack (orbstack.dev, free, the lightest option on a Mac) or Docker Desktop, then open it once so the '
      + 'engine starts. Verify with: docker info');
    r.skip('sandbox.image', 'Sandbox image built', 'not checked — no Docker', 'Install and start Docker first.', { required: true });
    r.skip('sandbox.run', 'A container actually runs', 'not checked — no Docker', 'Install and start Docker first.', { required: true });
    return;
  }

  try {
    const info = await withTimeout('Docker', TIMEOUT.docker, () => docker.getImage(image).inspect());
    const size = typeof info.Size === 'number' ? ` · ${Math.round(info.Size / 1e6)} MB` : '';
    r.pass('sandbox.image', 'Sandbox image built', `${image}${size}`);
  } catch {
    r.fail('sandbox.image', 'Sandbox image built', `image "${image}" is not on this machine`,
      `Run: docker build -t ${image} docker/sandbox   (takes a couple of minutes the first time)`);
    r.skip('sandbox.run', 'A container actually runs', 'not checked — no image', 'Build the image first.', { required: true });
    return;
  }

  // The real driver, the real container. Nothing here is a dry run.
  const sandbox = createDockerSandbox({ image, network: config.sandbox.network, log: silentLogger });
  const started = Date.now();
  try {
    await withTimeout('Docker', TIMEOUT.docker, async () => {
      await sandbox.ensure(DOCTOR_AGENT_ID);
      const exec = await sandbox.exec(DOCTOR_AGENT_ID, `echo ${DOCTOR_SENTINEL}; node --version; whoami`, { timeoutMs: 20_000 });
      if (exec.exitCode !== 0 || !exec.stdout.includes(DOCTOR_SENTINEL)) {
        throw new Error(`container ran but returned exit ${exec.exitCode}: ${oneLine(exec.stderr || exec.stdout)}`);
      }
      await sandbox.writeFile(DOCTOR_AGENT_ID, 'doctor.txt', DOCTOR_SENTINEL);
      const back = await sandbox.readFile(DOCTOR_AGENT_ID, 'doctor.txt', 1024);
      if (back.trim() !== DOCTOR_SENTINEL) throw new Error('the container filesystem did not return what was written to it');
      const [, node, user] = exec.stdout.split('\n');
      r.pass('sandbox.run', 'A container actually runs',
        `started ${image}, ran a command as ${user?.trim() ?? 'the sandbox user'} (node ${node?.trim() ?? '?'}), wrote and read a file back`,
        { ms: Date.now() - started });
    });
  } catch (e) {
    r.fail('sandbox.run', 'A container actually runs', oneLine(msg(e)),
      `Try it by hand: docker run --rm ${image} echo hi   — if that fails, Docker itself is the problem; if it works, `
      + `check that the "${config.sandbox.network}" network can be created (docker network ls).`,
      { ms: Date.now() - started });
  } finally {
    await sandbox.destroy(DOCTOR_AGENT_ID).catch(() => undefined);
  }

  if (config.sandbox.egressFiltered) {
    r.pass('sandbox.egress', 'Agent network locked down', 'SANDBOX_EGRESS_FILTERED=1 — the host firewall rules are declared installed');
  } else {
    r.fail('sandbox.egress', 'Agent network locked down',
      'SANDBOX_EGRESS_FILTERED=0 — an agent running bash could reach private addresses that the fetch_url tool refuses',
      'On your own laptop this is fine. On the server: install the firewall rules from docs/OPERATIONS.md, then set '
      + 'SANDBOX_EGRESS_FILTERED=1 in .env. The server refuses to start without it when NODE_ENV=production.');
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const useColor = (): boolean => process.stdout.isTTY === true && !process.env.NO_COLOR;

const PAINT: Record<CheckStatus, string> = { pass: '32', fail: '31', warn: '33', skip: '90' };
const LABEL: Record<CheckStatus, string> = { pass: 'PASS', fail: 'FAIL', warn: 'WARN', skip: 'SKIP' };

function paint(text: string, code: string): string {
  return useColor() ? `[${code}m${text}[0m` : text;
}

export function renderCheck(c: Check, titleWidth: number): string[] {
  const head = `${paint(LABEL[c.status], PAINT[c.status])}  ${c.title.padEnd(titleWidth)}  ${c.detail}`;
  const lines = [head];
  if (c.remedy && c.status !== 'pass') {
    for (const line of c.remedy.split('\n')) lines.push(paint(`        ${line.startsWith('    ') ? line : `→ ${line}`}`, '36'));
  }
  return lines;
}

export function render(sections: Section[], verdict: Verdict, config: Config | null): string {
  const out: string[] = [];
  const width = Math.min(34, Math.max(18, ...sections.flatMap((s) => s.checks.map((c) => c.title.length))));
  out.push('');
  out.push(paint('VANTRA DOCTOR', '1'));
  out.push('Everything below was actually tried, not assumed.');
  for (const section of sections) {
    out.push('');
    out.push(paint(`── ${section.name} ${'─'.repeat(Math.max(0, 64 - section.name.length))}`, '1'));
    for (const check of section.checks) out.push(...renderCheck(check, width));
  }
  out.push('');
  out.push(paint('─'.repeat(68), '90'));
  const { pass, fail, warn, skip } = verdict.counts;
  out.push(`${pass} passed · ${fail} failed · ${warn} warnings · ${skip} skipped`);
  out.push('');

  if (verdict.realMoney) {
    out.push(paint('  READY FOR REAL MONEY  ', '1;42'));
    out.push('Every required check passed and you are pointed at mainnet. Purchases will move real USDC and your');
    out.push(`fee wallet will receive ${config ? config.economy.founderFeeBps / 100 : 10}% of every one of them.`);
  } else if (verdict.ready) {
    out.push(paint('  READY — BUT ON PRACTICE MONEY  ', '1;43'));
    out.push('Every required check passed. The app works end to end; the USDC on this network is not real.');
    out.push('Buy a few agents yourself and watch them, then go live:');
    out.push('  1. Put a Robinhood Chain mainnet RPC URL in RHC_RPC_URL.');
    out.push('  2. Clear USDC_ADDRESS so the built-in mainnet USDC address is used.');
    out.push('  3. Set RHC_NETWORK=mainnet and ALLOW_MAINNET=1.');
    out.push('  4. Fund the treasury with real ETH for gas.');
    out.push('  5. Run `pnpm ready` once more — it should say READY FOR REAL MONEY.');
  } else {
    out.push(paint('  NOT READY  ', '1;41'));
    out.push(`${verdict.blockers.length} thing${verdict.blockers.length === 1 ? '' : 's'} to do, in this order:`);
    out.push('');
    const numWidth = String(verdict.blockers.length).length;
    verdict.blockers.forEach((c, i) => {
      const n = `${String(i + 1).padStart(numWidth)}.`;
      const indent = ' '.repeat(n.length + 3);
      out.push(`  ${n} ${paint(c.title, '1')} — ${c.detail}`);
      for (const line of (c.remedy ?? '').split('\n')) out.push(paint(`${indent}${line.trim()}`, '36'));
      out.push('');
    });
  }
  if (verdict.warnings.length > 0) {
    out.push(paint('Not blocking, but worth knowing:', '90'));
    for (const c of verdict.warnings) out.push(paint(`  · ${c.title}: ${c.detail}`, '90'));
  }
  out.push('');
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface DoctorResult { sections: Section[]; verdict: Verdict; config: Config | null }

export async function runDoctor(deps: DoctorDeps = {}): Promise<DoctorResult> {
  const r = new Recorder();

  r.section('1. CONFIGURATION');
  checkEnvFile(r);
  const config = checkConfig(r);
  checkSecrets(r, process.env);
  const wallets = checkWallets(r, process.env);

  if (!config) {
    const verdict = verdictOf(r.sections, { cluster: 'testnet', allowMainnet: false });
    return { sections: r.sections, verdict, config: null };
  }
  checkPreflight(r, config);

  r.section('2. DATABASE');
  await checkDatabase(r, config);

  r.section('3. BRAINS (one real API call per key)');
  await checkBrains(r, config, deps);

  r.section('4. WEB SEARCH');
  await checkSearch(r, config, deps);

  r.section('5. CHAIN');
  await checkChain(r, config, wallets);

  r.section('6. SANDBOX');
  await checkSandbox(r, config);

  const allowMainnet = ['1', 'true', 'yes'].includes((process.env.ALLOW_MAINNET ?? '').toLowerCase());
  const verdict = verdictOf(r.sections, { cluster: config.chain.cluster, allowMainnet });
  return { sections: r.sections, verdict, config };
}

const isEntrypoint = process.argv[1] !== undefined
  && path.resolve(process.argv[1]).includes(path.join('scripts', 'doctor'));

if (isEntrypoint) {
  loadDotenv();
  const result = await runDoctor();
  process.stdout.write(render(result.sections, result.verdict, result.config));
  process.exit(result.verdict.ready ? 0 : 1);
}
