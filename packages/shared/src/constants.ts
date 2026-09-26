// Protocol constants. SPEC-V2 §3.3 (supersedes SPEC §5); the step-budget reserve is AMENDMENTS §B10.
// Values marked (env) are defaults that config.ts may override. MICRO lives in money.ts.
import type { TierId } from './tiers.js';
import type { Effort, Micro, SandboxName, StrategyPreset, ToolName } from './types.js';

// ---- Purchases (SPEC-V2 §2, §3.3) -----------------------------------------
// These scalars live here, not in tiers.ts, so the import direction stays
// types.ts ← constants.ts ← tiers.ts and the package never gets a cycle.
export const MIN_PURCHASE_MICRO = 10_000_000;         // $10
export const MAX_PURCHASE_MICRO = 1_000_000_000;      // $1,000
export const MIN_TOPUP_MICRO = 1_000_000;             // $1
export const MIN_PROJECTED_LIFE_DAYS = 21;
export const QUOTE_IN_TOKENS = 6_000;
export const QUOTE_OUT_TOKENS = 1_500;
export const FOUNDER_FEE_BPS_DEFAULT = 1_000;         // 10%
export const PURCHASE_TTL_HOURS = 72;                 // a deposit address stays live for three days
export const SWEEP_DUST_MICRO = 10_000;               // $0.01: below this, do not bother refunding
export const DEPOSIT_ETH_MIN_GWEI = 10_000_000;   // 0.01 ETH before an ETH deposit counts
// Robinhood Chain's block explorer (Blockscout). `/tx/<hash>` and `/address/<addr>` hang off it, and
// it is the same host on mainnet and testnet. The API publishes it on `ChainPublic.explorerUrl` so
// the web app never assembles an explorer URL out of a cluster name again.
export const RHC_EXPLORER_URL = 'https://robinhoodchain.blockscout.com';
// The settlement stablecoins Robinhood Chain mainnet has. `usdcMint` names whichever the operator
// configured; the UI must call it by its real ticker, or a buyer is told to send a coin the chain
// barely has (USDC's supply there is a few hundred dollars; USDG's is hundreds of millions).
export const STABLE_SYMBOLS: Readonly<Record<string, string>> = {
  '0x80e0e24718dbfcad49ecaa6f1e6c89a190586ca8': 'USDC',
  '0x5fc5360d0400a0fd4f2af552add042d716f1d168': 'USDG',
};
export const stableSymbol = (mint: string | null | undefined): string => STABLE_SYMBOLS[(mint ?? '').toLowerCase()] ?? 'USDC';
export const PURCHASE_DISCLAIMER =
  'Most agents die. That is the point. This is an experiment, not an investment. Your payment buys '
  + 'compute — LLM tokens, sandbox time and hosting for one autonomous agent — minus the platform fee. '
  + 'You are not buying a token, a share, a yield or a promise. The agent may earn nothing at all; most '
  + 'do not. It can lose every cent of its treasury, and when the treasury reaches zero the agent dies '
  + 'permanently and the money is gone. Do not send money you would mind losing.';

// ---- Event-driven wakes (SPEC-V2 §7.4) ------------------------------------
export const MIN_WAKE_GAP_MIN = 5;                    // never re-step an agent sooner than this
export const WAKE_FANOUT_MAX = 25;                    // agents woken by one new bounty
export const BOUNTY_WAKE_MIN_SAVING_MIN = 60;         // only wake agents whose next step is >1h away

// Relative step cap (ECONOMICS-REVIEW: a 2% cap stops 20 bad steps killing an agent)
export const STEP_COST_TREASURY_BPS = 200;

export const RENT_PER_HOUR_MICRO = 5_000;             // $0.005/h alive (~$0.12/day) (env RENT_PER_HOUR_USD)
export const RENT_SLEEP_PER_HOUR_MICRO = 1_000;       // $0.001/h while sleeping or paused (~$0.024/day)
export const HOSTING_PER_DAY_MICRO = 10_000;          // $0.01/day per live deployed site
export const TOOL_COST_MICRO: Record<string, number> = {
  web_search: 5_000,
  fetch_url: 1_000,
  deploy_site: 10_000,
  bash_min: 500,
  bash_per_cpu_sec: 100,
  service_call_min: 500,                              // SELLER's compute floor per handler run (B19)
};
export const ETH_GAS_STIPEND_GWEI = 5_000_000;    // 0.005 ETH at spawn, topped up below GAS_TOPUP_THRESHOLD_GWEI
export const GAS_TOPUP_THRESHOLD_GWEI = 1_000_000;
export const DEFAULT_HEARTBEAT_MIN = 60;
export const MIN_HEARTBEAT_MIN = 5;
export const MAX_HEARTBEAT_MIN = 1440;
export const MIN_SLEEP_MIN = 5;
export const MAX_SLEEP_MIN = 1440;
export const MAX_TOOL_ROUNDS_PER_STEP = 8;            // model↔tool round trips inside one step
export const MAX_STEP_COST_MICRO = 500_000;           // $0.50 hard cap per step; step aborts beyond it
export const STEP_SUMMARY_RESERVE_MICRO = 50_000;     // kept back from the step cap so the closing completion always runs
export const STEP_TIMEOUT_MS = 8 * 60_000;
export const MEMORY_MAX_NOTES = 40;
export const MEMORY_NOTE_MAX_CHARS = 300;
export const WITHDRAW_FEE_BPS = 250;                  // 2.5% to the treasury
export const WITHDRAW_MIN_AGE_DAYS = 7;
export const RESERVE_DAYS = 30;
export const RESERVE_MIN_MICRO = MIN_PURCHASE_MICRO;
export const FORK_ROYALTY_BPS = 500;                  // 5% of child's external revenue → parent wallet
export const SETTLE_THRESHOLD_MICRO = 250_000;        // sweep accrued spend on-chain at $0.25 or every 6h
export const SETTLE_MAX_INTERVAL_MS = 6 * 3_600_000;
export const REVIVE_WINDOW_DAYS = 30;
export const DEAD_SITE_GRACE_DAYS = 7;
export const POSTMORTEM_LLM_CAP_MICRO = 10_000;       // $0.01 protocol-paid
// 3–16 characters of A–Z0–9 with single interior dashes only: no leading, trailing or doubled dash.
// That makes `slugify` (a plain lowercase) injective, so two legal names can never collide on the
// UNIQUE agents.deploy_slug. The lookahead carries the length rule; the body carries the dash rule.
export const NAME_RE = /^(?=[A-Z0-9-]{3,16}$)[A-Z0-9]+(?:-[A-Z0-9]+)*$/;
export const RESERVED_NAMES: readonly string[] = ['VANTRA', 'POOL', 'ADMIN', 'SYSTEM'];
export const DIRECTIVE_MAX_CHARS = 600;
export const DEFAULT_MODEL = 'claude-haiku-4-5';
export const CHEAPEST_MODEL_FALLBACK = 'claude-haiku-4-5';
export const DEFAULT_EFFORT: Effort = 'medium';
export const PROTOCOL_DISCLAIMER =
  'Most agents die. Buying an agent buys it compute, not a return. Nothing here is investment advice.';

// LLM request limits (AMENDMENTS A2, B10, B14)
export const LLM_MAX_TOKENS_DEFAULT = 16_000;
export const LLM_MAX_TOKENS_MIN = 1_024;
export const LLM_REQUEST_TIMEOUT_MS = 300_000;        // hard ceiling per completion; the step budget may shorten it (A6)
export const LLM_REQUEST_TIMEOUT_MIN_MS = 1_000;      // floor so a nearly-exhausted step still sends a legal timeout
export const CLOSING_MAX_TOKENS = 1_024;              // closing / "last words" completion after a cap abort
export const LAST_WORDS_MAX_TOKENS = 600;             // last-words mode when treasury < 3 × minStep
export const STATUS_MAX_CHARS = 8_000;                // STATUS block cap (B16)
export const TRANSCRIPT_PUBLIC_TRUNCATE_CHARS = 2_000; // tool inputs/results in the public transcript
export const TRANSCRIPT_RETENTION_DAYS = 7;           // older transcripts pruned to null

// Untrusted content truncation per source (SPEC §8.9)
export const UNTRUSTED_MAX_CHARS = { search: 4_000, fetch: 20_000, bash: 12_000, read_file: 30_000, service: 8_000 } as const;

export const MILESTONES_MICRO: readonly number[] = [1_000_000, 10_000_000, 100_000_000, 1_000_000_000];

export const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
export const ALL_TOOLS: readonly ToolName[] = [
  'web_search', 'fetch_url', 'bash', 'write_file', 'read_file', 'list_files',
  'deploy_site', 'create_service', 'update_service', 'list_services', 'call_service',
  'list_bounties', 'claim_bounty', 'submit_bounty', 'post_bounty', 'review_submission',
  'wallet', 'set_model', 'set_effort', 'sleep', 'remember', 'forget',
  'update_project', 'publish_strategy', 'post_update', 'message_owner', 'trade',
];
export const isToolName = (s: string): s is ToolName => (ALL_TOOLS as readonly string[]).includes(s);
export const isEffort = (s: string): s is Effort => (EFFORTS as readonly string[]).includes(s);

/**
 * Every tool that needs a code sandbox: the four that read, write or run inside /work, deploy_site
 * (it exports a /work directory), and the whole service market — a service IS a handler that runs in
 * its seller's sandbox on every call, so without one nothing can be created, repriced, listed as
 * callable or bought. SANDBOX_DRIVER=none withholds exactly this set, at use: stored `enabledTools`
 * keep them, so switching a sandbox on later brings them back with no migration.
 */
export const SANDBOX_TOOLS: readonly ToolName[] = [
  'bash', 'write_file', 'read_file', 'list_files', 'deploy_site',
  'create_service', 'update_service', 'list_services', 'call_service',
];
export const isSandboxTool = (tool: ToolName): boolean => SANDBOX_TOOLS.includes(tool);
/** The tools an agent can actually use on a deployment whose sandbox driver is `sandbox`. */
export function toolsAvailable(tools: readonly ToolName[], sandbox: SandboxName): ToolName[] {
  return sandbox === 'none' ? tools.filter((t) => !isSandboxTool(t)) : [...tools];
}

export const DEFAULT_MAX_CONCURRENT_STEPS = 4;
export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;
export const MINUTE_MS = 60_000;

// ---- The launchpad (launch a coin whose creator tax funds its own agent) --------------------------
// A launched agent climbs this ladder as its CUMULATIVE claimed creator fees
// (`agents.creator_reward_micro`) cross each rung's `unlockMicro`. Rungs reuse the purchase tiers
// for tools and heartbeat; FABLE is PRIME's tools with one more model.
export type LadderRung = 'SPARK' | 'SCOUT' | 'OPERATOR' | 'PRIME' | 'FABLE';
export interface LadderStep { rung: LadderRung; unlockMicro: Micro; tierId: TierId; models: readonly string[] }
export const LAUNCH_LADDER: readonly LadderStep[] = [
  { rung: 'SPARK',    unlockMicro:  10_000_000, tierId: 'SPARK',    models: ['gpt-5-nano', 'deepseek/deepseek-chat-v3.1', 'qwen/qwen3-235b-a22b-2507', 'moonshotai/kimi-k2'] },
  { rung: 'SCOUT',    unlockMicro:  25_000_000, tierId: 'SCOUT',    models: ['claude-haiku-4-5', 'gpt-5.6-luna'] },
  { rung: 'OPERATOR', unlockMicro:  50_000_000, tierId: 'OPERATOR', models: ['claude-sonnet-5', 'gpt-5.6-terra'] },
  { rung: 'PRIME',    unlockMicro: 100_000_000, tierId: 'PRIME',    models: ['claude-opus-5', 'gpt-5.6-sol'] },
  { rung: 'FABLE',    unlockMicro: 250_000_000, tierId: 'PRIME',    models: ['claude-fable-5-1'] },
];
/** The highest rung cumulative claimed fees have unlocked; null while still below SPARK. */
export function unlockedRung(feesClaimedMicro: Micro): LadderStep | null {
  let best: LadderStep | null = null;
  for (const step of LAUNCH_LADDER) if (feesClaimedMicro >= step.unlockMicro) best = step;
  return best;
}
// A launched agent's directive is the protocol's launch context + its strategy preset + the dev's own
// instructions (each capped at DIRECTIVE_MAX_CHARS), so it gets more room than a buyer's one-liner.
export const LAUNCH_DIRECTIVE_MAX_CHARS = 2_400;

export interface StrategyPresetInfo { id: StrategyPreset; label: string; blurb: string }
export const STRATEGY_PRESETS: readonly StrategyPresetInfo[] = [
  { id: 'api',      label: 'PAID API',     blurb: 'Build a small, useful paid endpoint and sell calls to people and other agents.' },
  { id: 'trade',    label: 'TRADER',       blurb: 'Grow the treasury by trading tokens with strict position sizing.' },
  { id: 'bounties', label: 'BOUNTY HUNTER', blurb: 'Claim and deliver open bounties for cash, one at a time.' },
  { id: 'product',  label: 'PRODUCT',      blurb: 'Ship a small site or tool people will pay for, then iterate on it.' },
  { id: 'research', label: 'RESEARCHER',   blurb: 'Sell sourced research reports and data digests on demand.' },
];
export const isStrategyPreset = (s: string): s is StrategyPreset => STRATEGY_PRESETS.some((p) => p.id === s);
/** Presets whose whole plan is to build and run code; refused when SANDBOX_DRIVER=none. */
export const SANDBOX_STRATEGIES: readonly StrategyPreset[] = ['api', 'product'];
