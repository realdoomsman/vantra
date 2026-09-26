// Zod-parsed environment → typed Config. SPEC-V2 §5.8 (supersedes SPEC §8.2): the $VANTRA token, the
// holding gate and the seed are gone; purchases, the founder fee and the deposit poller take their place.
import { createRequire } from 'node:module';
import path from 'node:path';
import { z } from 'zod';
import {
  DEFAULT_MAX_CONCURRENT_STEPS, FOUNDER_FEE_BPS_DEFAULT, MAX_HEARTBEAT_MIN, MAX_PURCHASE_MICRO,
  MIN_PURCHASE_MICRO, PURCHASE_TTL_HOURS, microToUsd, usd,
} from '@vantra/shared';
import { REPO_ROOT } from './lib/env.js';
import { ConfigError } from './lib/errors.js';
import { AGENT_NETWORK_DEFAULT } from './sandbox/egress.js';

// Settlement stablecoins on Robinhood Chain. Both are 6-decimal ERC-20s, so every Micro calculation is
// unchanged; USDG is the deeper-liquidity alternative an operator selects by naming it in USDC_ADDRESS.
// Testnet has no canonical stablecoin: bridge one and name its address explicitly.
export const USDC_ADDRESSES = {
  usdc: '0x80e0e24718dbFcad49ECAA6F1e6C89A190586cA8',
  usdg: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
} as const;

// The Pons V2 factory reverts CreatorTaxTooHigh above maxCreatorTaxBps() — 1000 (10%) on mainnet today —
// so a greedier number would fail every launch. Refuse it at boot rather than at the first launch.
export const PONS_CREATOR_TAX_BPS_MAX = 1_000;

// How often the deposit poller looks at pending purchases (SPEC-V2 §5.3). Memory mode is free, so it
// ticks fast enough that a simulated payment completes inside one request; robinhood mode pays per RPC call.
export const DEPOSIT_POLL_MS_DEFAULT = { memory: 2_000, robinhood: 10_000 } as const;

export const FOUNDER_FEE_BPS_MAX = 3_000;               // 30%: refuse anything greedier at boot

// The demo colony's customers (sim/revenue.ts). They are the only "outside world" in memory mode, so
// DEMO=1 allow-lists them as external payers; on a real chain the list is whatever the operator sets.
export const DEMO_CUSTOMER_WALLETS: readonly string[] = [
  'acme-labs', 'northbridge-co', 'tinyshop', 'harbor-media', 'quiet-capital', 'fenwick-studio',
  'blue-tarp', 'oakline-devs', 'paper-route', 'seventh-street', 'lowlight-games', 'ridgeway-analytics',
];

// Insecure but deterministic dev-only defaults so `pnpm demo` works with an empty .env. They are
// PUBLIC CONSTANTS — anyone with this repository has them — so core/preflight.ts refuses to boot with
// either of them once CHAIN_MODE=robinhood, where they would be protecting real keys and real sessions.
export const DEV_SESSION_SECRET = 'vantra-dev-session-secret-not-for-production!!';
export const DEV_KEY_ENCRYPTION_KEY = '0'.repeat(64);

// Where the web app and the API are reached from. The CSRF guard admits exactly these two origins and
// every link the API hands out is built on them, so core/preflight.ts refuses a production boot that
// still carries these development defaults.
export const PUBLIC_URL_DEFAULT = 'http://localhost:5173';
export const API_URL_DEFAULT = 'http://localhost:8787';

const bool = z.preprocess((v) => (typeof v === 'string' ? ['1', 'true', 'yes'].includes(v.toLowerCase()) : v), z.boolean());
const optional = (schema: z.ZodString) => z.preprocess((v) => (v === '' ? undefined : v), schema.optional());
const optionalNumber = <T extends z.ZodTypeAny>(schema: T) => z.preprocess((v) => (v === '' ? undefined : v), schema.optional());
const list = z.preprocess(
  (v) => (typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : v),
  z.array(z.string()),
);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  HOST: z.string().default('0.0.0.0'),
  PUBLIC_URL: z.string().url().default(PUBLIC_URL_DEFAULT),
  API_URL: z.string().url().default(API_URL_DEFAULT),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.string().default('postgres://localhost:5432/vantra'),
  SESSION_SECRET: optional(z.string().min(32)),
  KEY_ENCRYPTION_KEY: optional(z.string().regex(/^[0-9a-fA-F]{64}$/, 'must be 64 hex chars (openssl rand -hex 32)')),
  CHAIN_MODE: z.enum(['memory', 'robinhood']).default('memory'),
  RHC_NETWORK: z.enum(['mainnet', 'testnet']).default('testnet'),
  // Empty falls through to the default so a blank line in .env gets the readable "name it out loud"
  // refusal below rather than a bare zod "Invalid URL". The default is the keyless public mainnet
  // endpoint; CHAIN_MODE=robinhood refuses to inherit it, so nothing reaches mainnet by omission.
  RHC_RPC_URL: z.preprocess((v) => (v === '' ? undefined : v), z.string().url().default('https://rpc.mainnet.chain.robinhood.com')),
  USDC_ADDRESS: optional(z.string()),
  TREASURY_WALLET_SECRET: optional(z.string()),
  FOUNDER_FEE_WALLET: optional(z.string()),
  FOUNDER_FEE_BPS: z.coerce.number().int().min(0).max(FOUNDER_FEE_BPS_MAX).default(FOUNDER_FEE_BPS_DEFAULT),
  PROTOCOL_FEE_WALLET: optional(z.string()),
  ESCROW_WALLET_SECRET: optional(z.string()),
  // Fallback ETH/USD, used in memory mode and whenever the live spot call is unreachable. Deliberately
  // low: a stale price that under-values an ETH deposit credits too little, never too much.
  ETH_PRICE_USD: z.coerce.number().positive().default(3000),
  ACCEPT_ETH_DEPOSITS: bool.default(true),
  // LI.FI aggregates the swap routes agents trade through (li.quest). The endpoint is keyless; a key
  // only raises the rate limit, so this is optional everywhere.
  LIFI_API_KEY: optional(z.string()),
  // Autonomous trading (all limits enforced in tools/trade.ts; the model is never trusted with them).
  TRADE_ENABLED: bool.default(false),
  TRADE_ALLOWED_MINTS: list.default([]),                 // ERC-20 addresses an agent may buy; empty = nothing tradeable
  TRADE_MAX_POSITION_USD: z.coerce.number().positive().default(5),
  TRADE_MAX_DAILY_LOSS_USD: z.coerce.number().positive().default(5),
  TRADE_MIN_RESERVE_USD: z.coerce.number().min(0).default(2),
  TRADE_SLIPPAGE_BPS: z.coerce.number().int().min(1).max(2000).default(150),
  ALLOW_MAINNET: bool.default(false),
  LLM_PROVIDER: z.enum(['router', 'mock', 'x402']).default('mock'),
  ANTHROPIC_API_KEY: optional(z.string()),
  OPENAI_API_KEY: optional(z.string()),
  OPENROUTER_API_KEY: optional(z.string()),
  LLM_ALLOWED_MODELS: list.default([]),
  // x402 mode: each agent pays an OpenAI-compatible x402 LLM gateway per call from its own Robinhood
  // Chain wallet (USDC, HTTP 402). No provider API key is used. X402_MAX_PRICE_USD caps one payment.
  X402_GATEWAY_URL: optional(z.string().url()),
  X402_MAX_PRICE_USD: z.coerce.number().positive().default(0.5),
  SEARCH_PROVIDER: z.enum(['brave', 'tavily', 'none']).default('none'),
  BRAVE_API_KEY: optional(z.string()),
  TAVILY_API_KEY: optional(z.string()),
  // Sign in with Google (OAuth 2.0). Both required to enable the button; absent = feature off.
  GOOGLE_CLIENT_ID: optional(z.string()),
  GOOGLE_CLIENT_SECRET: optional(z.string()),
  // Agent token launches on Pons V2 (the launchpad on Robinhood Chain). Flag gates the feature; the tax
  // is the creator fee the agent earns on every trade of its own coin, fixed at launch and never rewired.
  TOKEN_LAUNCH_ENABLED: bool.default(false),
  PONS_CREATOR_TAX_BPS: z.coerce.number().int().min(0).max(PONS_CREATOR_TAX_BPS_MAX).default(PONS_CREATOR_TAX_BPS_MAX),
  // The flagship agent featured on the landing page (e.g. VANTRA). An explicit override: when it is
  // set it always wins. Left unset, the API features the longest-lived agent that is still alive
  // (GlobalStats.oldestAlive), and null only when nothing in the colony is breathing.
  MAIN_AGENT_ID: optional(z.string()),
  // docker: per-agent container. local: unisolated child_process, development only. none: no code
  // sandbox at all — every tool in SANDBOX_TOOLS is withheld from every agent (tools/registry.ts).
  SANDBOX_DRIVER: z.enum(['docker', 'local', 'none']).default('local'),
  SANDBOX_IMAGE: z.string().default('vantra-sandbox:latest'),
  SANDBOX_NETWORK: z.string().min(1).max(60).default(AGENT_NETWORK_DEFAULT),
  SANDBOX_EGRESS_FILTERED: bool.default(false),   // docker only: the host firewall rules are installed (see sandbox/egress.ts)
  DATA_DIR: z.string().default('./data'),
  SITES_BASE_URL: optional(z.string().url()),
  MIN_PURCHASE_USD: z.coerce.number().min(1).default(microToUsd(MIN_PURCHASE_MICRO)),
  MAX_PURCHASE_USD: z.coerce.number().min(1).default(microToUsd(MAX_PURCHASE_MICRO)),
  PURCHASE_TTL_HOURS: z.coerce.number().int().min(1).max(24 * 30).default(PURCHASE_TTL_HOURS),
  DEPOSIT_POLL_MS: optionalNumber(z.coerce.number().int().min(250).max(600_000)),
  HEARTBEAT_OVERRIDE_MIN: optionalNumber(z.coerce.number().int().min(1).max(MAX_HEARTBEAT_MIN)),
  RENT_PER_HOUR_USD: z.coerce.number().min(0).default(0.005),
  EXTERNAL_PAYER_WALLETS: list.default([]),
  MAX_CONCURRENT_STEPS: z.coerce.number().int().min(1).max(64).default(DEFAULT_MAX_CONCURRENT_STEPS),
  DEMO: bool.default(false),
  DEMO_SEED: z.coerce.number().int().default(42),
  DEMO_AGENTS: z.coerce.number().int().min(0).max(500).default(36),
  DEMO_DAYS: z.coerce.number().int().min(1).max(365).default(45),
  DEMO_TREASURY_USD: z.coerce.number().min(0).default(2000),
  // The launchpad (see economy/launch.ts and economy/ladder.ts). A launched agent is born dormant and
  // activates once its claimable creator fees reach LAUNCH_ACTIVATION_USD; the treasury then sends it
  // ACTIVATION_GAS_GWEI so it can sign its first claim. Above a runway floor of BURN_RUNWAY_FLOOR_DAYS
  // it spends any surplus of at least MIN_BURN_USD buying back and burning its own coin.
  LAUNCH_ACTIVATION_USD: z.coerce.number().positive().default(10),
  ACTIVATION_GAS_GWEI: z.coerce.number().int().positive().default(300_000),
  BURN_RUNWAY_FLOOR_DAYS: z.coerce.number().positive().default(30),
  MIN_BURN_USD: z.coerce.number().positive().default(5),
  // Operator kill switch for the buyback-and-burn leg. Off, a launched agent still claims and converts
  // its fees and climbs the ladder; the surplus simply stays in its treasury until this is turned on.
  BUYBACK_BURN_ENABLED: bool.default(true),
  MODEL_SWITCH_MIN_RUNWAY_DAYS: z.coerce.number().positive().default(7),
});

type Env = z.infer<typeof envSchema>;

export interface Config {
  env: Env['NODE_ENV'];
  isProduction: boolean;
  version: string;
  port: number;
  host: string;
  publicUrl: string;
  apiUrl: string;
  logLevel: Env['LOG_LEVEL'];
  databaseUrl: string;
  sessionSecret: string;
  keyEncryptionKey: string;         // 64 hex chars; never log
  chain: {
    mode: Env['CHAIN_MODE'];
    cluster: Env['RHC_NETWORK'];          // the field keeps its name: every consumer prints it as the network
    rpcUrl: string;
    usdcMint: string;                     // ERC-20 address of the settlement stablecoin, EIP-55
    treasuryWalletSecret: string | null;  // 0x-hex private key or path to a json byte array; never log
    founderFeeWallet: string | null;      // address only: takes FOUNDER_FEE_BPS of every purchase
    protocolFeeWallet: string | null;
    escrowWalletSecret: string | null;    // never log
    ethPriceUsd: number;
    acceptEthDeposits: boolean;
    lifiApiKey: string | null;            // optional; raises the li.quest rate limit
  };
  trading: {
    enabled: boolean;
    allowedMints: string[];              // ERC-20 addresses agents may trade into (USDC is always the quote leg)
    maxPositionMicro: number;            // cap on one position's cost basis
    maxDailyLossMicro: number;           // realized loss over 24h that halts trading
    minReserveMicro: number;             // liquid USDC an agent must keep; a trade may never dip below it
    slippageBps: number;
  };
  llm: {
    provider: Env['LLM_PROVIDER'];
    anthropicApiKey: string | null;
    openaiApiKey: string | null;
    openrouterApiKey: string | null;
    allowedModels: string[];        // empty = whole catalog
    x402: { gatewayUrl: string; maxPriceMicro: number } | null;
  };
  search: { provider: Env['SEARCH_PROVIDER']; braveApiKey: string | null; tavilyApiKey: string | null };
  auth: { google: { clientId: string; clientSecret: string } | null };
  token: { launchEnabled: boolean; creatorTaxBps: number };   // Pons creator tax, fixed into the launch
  mainAgentId: string | null;         // flagship agent featured on the landing page
  sandbox: { driver: Env['SANDBOX_DRIVER']; image: string; network: string; egressFiltered: boolean };
  dataDir: string;                  // absolute
  sitesBaseUrl: string;
  economy: {
    minPurchaseMicro: number; maxPurchaseMicro: number; founderFeeBps: number; purchaseTtlHours: number;
    rentPerHourMicro: number; maxConcurrentSteps: number;
    // Wallets the operator has verified as genuine outside customers (a merchant of record, a
    // settlement wallet). Everything else must prove itself: see runtime/deposits.ts.
    externalPayers: string[];
    heartbeatOverrideMin: number | null;   // DEV ONLY: forces every new agent's heartbeat
    depositPollMs: number;
  };
  launch: {
    activationMicro: number;          // claimable fees that wake a dormant launched agent (> 0)
    activationGasGwei: number;        // ETH the treasury sends a launched agent at activation
    burnEnabled: boolean;             // false = surplus is kept, never bought back and burned
    burnFloorDays: number;            // runway kept back before any buyback-and-burn
    minBurnMicro: number;             // smallest surplus worth a buyback
    modelSwitchMinRunwayDays: number; // a model is affordable when it leaves at least this much runway
  };
  demo: { enabled: boolean; seed: number; agents: number; days: number; treasuryUsd: number };
  warnings: string[];               // dev fallbacks in use; logged once at boot
}

const require = createRequire(import.meta.url);
const pkgVersion = (): string => (require('../package.json') as { version: string }).version;

export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new ConfigError(`Invalid environment:\n${lines.join('\n')}`);
  }
  const e = parsed.data;
  const isProduction = e.NODE_ENV === 'production';
  const warnings: string[] = [];

  const sessionSecret = e.SESSION_SECRET ?? devFallback('SESSION_SECRET', DEV_SESSION_SECRET, isProduction, warnings);
  const keyEncryptionKey = e.KEY_ENCRYPTION_KEY ?? devFallback('KEY_ENCRYPTION_KEY', DEV_KEY_ENCRYPTION_KEY, isProduction, warnings);

  if (e.SANDBOX_DRIVER === 'local' && isProduction) {
    throw new ConfigError(
      'SANDBOX_DRIVER=local is not isolated and is refused when NODE_ENV=production; use docker, or none to run '
      + 'with no agent code execution at all',
    );
  }
  // `bash` must not be able to reach what fetch_url refuses (cloud metadata, RFC1918, the host
  // gateway). Docker cannot express that, so production has to confirm the host rules are in place.
  if (e.SANDBOX_DRIVER === 'docker' && isProduction && !e.SANDBOX_EGRESS_FILTERED) {
    throw new ConfigError(
      'SANDBOX_EGRESS_FILTERED=1 is required in production: install the egress rules for the agent network '
      + '(see docs/OPERATIONS.md and apps/api/src/sandbox/egress.ts) before agents can run bash',
    );
  }
  if (e.CHAIN_MODE === 'robinhood') {
    const required = [
      ['TREASURY_WALLET_SECRET', e.TREASURY_WALLET_SECRET],
      ['ESCROW_WALLET_SECRET', e.ESCROW_WALLET_SECRET],
      ['PROTOCOL_FEE_WALLET', e.PROTOCOL_FEE_WALLET],
      ['FOUNDER_FEE_WALLET', e.FOUNDER_FEE_WALLET],
    ] as const;
    for (const [k, v] of required) {
      if (!v) throw new ConfigError(`${k} is required when CHAIN_MODE=robinhood`);
    }
    // The schema default is the public mainnet endpoint. Inheriting it while asking for a real chain is
    // how a testnet deployment ends up quietly spending on mainnet, so it has to be stated out loud.
    if (!source['RHC_RPC_URL']) {
      throw new ConfigError(
        'RHC_RPC_URL is required when CHAIN_MODE=robinhood: name the endpoint explicitly rather than inheriting '
        + (e.RHC_NETWORK === 'mainnet'
          ? 'the default. Free public: https://rpc.mainnet.chain.robinhood.com (rate limited, no SLA); for '
            + 'anything real use your own provider endpoint.'
          : 'the mainnet default. Robinhood Chain testnet has no keyless endpoint — use your Alchemy URL, '
            + 'https://robinhood-testnet.g.alchemy.com/v2/<KEY>.'),
      );
    }
    // Only mainnet has a canonical settlement stablecoin. On testnet the operator bridges his own, so
    // inheriting the mainnet address would read every deposit as zero against a contract that is not there.
    if (e.RHC_NETWORK === 'testnet' && !e.USDC_ADDRESS) {
      throw new ConfigError(
        `USDC_ADDRESS is required when RHC_NETWORK=testnet: the built-in default is mainnet USDC (${USDC_ADDRESSES.usdc}), `
        + 'which does not exist on testnet. Bridge test USDC and name the address it lands at.',
      );
    }
  }
  // Real money moves on mainnet: the operator has to say so out loud.
  if (e.RHC_NETWORK === 'mainnet' && !e.ALLOW_MAINNET) {
    throw new ConfigError(
      'RHC_NETWORK=mainnet moves real money: set ALLOW_MAINNET=1 to confirm you meant mainnet, '
      + 'or use RHC_NETWORK=testnet',
    );
  }
  if (e.HEARTBEAT_OVERRIDE_MIN !== undefined && isProduction) {
    throw new ConfigError('HEARTBEAT_OVERRIDE_MIN is a development-only override and is refused when NODE_ENV=production');
  }
  if (e.LLM_PROVIDER === 'router' && !e.ANTHROPIC_API_KEY && !e.OPENAI_API_KEY && !e.OPENROUTER_API_KEY) {
    throw new ConfigError('LLM_PROVIDER=router needs at least one of ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY');
  }
  if (e.LLM_PROVIDER === 'x402' && !e.X402_GATEWAY_URL) {
    throw new ConfigError('LLM_PROVIDER=x402 needs X402_GATEWAY_URL: the OpenAI-compatible x402 LLM gateway each agent pays per call with USDC');
  }
  if (e.SEARCH_PROVIDER === 'brave' && !e.BRAVE_API_KEY) throw new ConfigError('SEARCH_PROVIDER=brave needs BRAVE_API_KEY');
  if (e.SEARCH_PROVIDER === 'tavily' && !e.TAVILY_API_KEY) throw new ConfigError('SEARCH_PROVIDER=tavily needs TAVILY_API_KEY');
  if (e.DEMO && (e.CHAIN_MODE !== 'memory' || e.LLM_PROVIDER !== 'mock')) {
    throw new ConfigError('DEMO=1 requires CHAIN_MODE=memory and LLM_PROVIDER=mock');
  }
  const minPurchaseMicro = usd(e.MIN_PURCHASE_USD);
  const maxPurchaseMicro = usd(e.MAX_PURCHASE_USD);
  if (maxPurchaseMicro < minPurchaseMicro) {
    throw new ConfigError(`MAX_PURCHASE_USD (${e.MAX_PURCHASE_USD}) must be at least MIN_PURCHASE_USD (${e.MIN_PURCHASE_USD})`);
  }
  // Positive in dollars can still round to zero micro-dollars; a zero threshold would activate every
  // launch before it earned anything, and a zero burn minimum would burn dust every cycle.
  const activationMicro = usd(e.LAUNCH_ACTIVATION_USD);
  if (activationMicro <= 0) throw new ConfigError(`LAUNCH_ACTIVATION_USD (${e.LAUNCH_ACTIVATION_USD}) must be at least $0.000001`);
  const minBurnMicro = usd(e.MIN_BURN_USD);
  if (minBurnMicro <= 0) throw new ConfigError(`MIN_BURN_USD (${e.MIN_BURN_USD}) must be at least $0.000001`);

  return {
    env: e.NODE_ENV,
    isProduction,
    version: pkgVersion(),
    port: e.PORT,
    host: e.HOST,
    publicUrl: stripSlash(e.PUBLIC_URL),
    apiUrl: stripSlash(e.API_URL),
    logLevel: e.LOG_LEVEL,
    databaseUrl: e.DATABASE_URL,
    sessionSecret,
    keyEncryptionKey,
    chain: {
      mode: e.CHAIN_MODE,
      cluster: e.RHC_NETWORK,
      rpcUrl: e.RHC_RPC_URL,
      usdcMint: e.USDC_ADDRESS ?? USDC_ADDRESSES.usdc,
      treasuryWalletSecret: e.TREASURY_WALLET_SECRET ?? null,
      founderFeeWallet: e.FOUNDER_FEE_WALLET ?? null,
      protocolFeeWallet: e.PROTOCOL_FEE_WALLET ?? null,
      escrowWalletSecret: e.ESCROW_WALLET_SECRET ?? null,
      ethPriceUsd: e.ETH_PRICE_USD,
      acceptEthDeposits: e.ACCEPT_ETH_DEPOSITS,
      lifiApiKey: e.LIFI_API_KEY ?? null,
    },
    trading: {
      enabled: e.TRADE_ENABLED,
      allowedMints: e.TRADE_ALLOWED_MINTS,
      maxPositionMicro: usd(e.TRADE_MAX_POSITION_USD),
      maxDailyLossMicro: usd(e.TRADE_MAX_DAILY_LOSS_USD),
      minReserveMicro: usd(e.TRADE_MIN_RESERVE_USD),
      slippageBps: e.TRADE_SLIPPAGE_BPS,
    },
    llm: {
      provider: e.LLM_PROVIDER,
      anthropicApiKey: e.ANTHROPIC_API_KEY ?? null,
      openaiApiKey: e.OPENAI_API_KEY ?? null,
      openrouterApiKey: e.OPENROUTER_API_KEY ?? null,
      allowedModels: e.LLM_ALLOWED_MODELS,
      x402: e.LLM_PROVIDER === 'x402' && e.X402_GATEWAY_URL
        ? { gatewayUrl: stripSlash(e.X402_GATEWAY_URL), maxPriceMicro: usd(e.X402_MAX_PRICE_USD) }
        : null,
    },
    search: { provider: e.SEARCH_PROVIDER, braveApiKey: e.BRAVE_API_KEY ?? null, tavilyApiKey: e.TAVILY_API_KEY ?? null },
    auth: {
      google: e.GOOGLE_CLIENT_ID && e.GOOGLE_CLIENT_SECRET
        ? { clientId: e.GOOGLE_CLIENT_ID, clientSecret: e.GOOGLE_CLIENT_SECRET }
        : null,
    },
    token: { launchEnabled: e.TOKEN_LAUNCH_ENABLED, creatorTaxBps: e.PONS_CREATOR_TAX_BPS },
    mainAgentId: e.MAIN_AGENT_ID ?? null,
    sandbox: {
      driver: e.SANDBOX_DRIVER, image: e.SANDBOX_IMAGE, network: e.SANDBOX_NETWORK,
      egressFiltered: e.SANDBOX_EGRESS_FILTERED,
    },
    dataDir: path.resolve(REPO_ROOT, e.DATA_DIR),
    sitesBaseUrl: stripSlash(e.SITES_BASE_URL ?? `${stripSlash(e.API_URL)}/sites`),
    economy: {
      minPurchaseMicro,
      maxPurchaseMicro,
      founderFeeBps: e.FOUNDER_FEE_BPS,
      purchaseTtlHours: e.PURCHASE_TTL_HOURS,
      rentPerHourMicro: usd(e.RENT_PER_HOUR_USD),
      maxConcurrentSteps: e.MAX_CONCURRENT_STEPS,
      // The demo colony's synthetic customers are the outside world in memory mode, so they are
      // allow-listed there and nowhere else.
      externalPayers: [...new Set(e.DEMO ? [...DEMO_CUSTOMER_WALLETS, ...e.EXTERNAL_PAYER_WALLETS] : e.EXTERNAL_PAYER_WALLETS)],
      heartbeatOverrideMin: e.HEARTBEAT_OVERRIDE_MIN ?? null,
      depositPollMs: e.DEPOSIT_POLL_MS ?? DEPOSIT_POLL_MS_DEFAULT[e.CHAIN_MODE],
    },
    launch: {
      activationMicro,
      activationGasGwei: e.ACTIVATION_GAS_GWEI,
      burnEnabled: e.BUYBACK_BURN_ENABLED,
      burnFloorDays: e.BURN_RUNWAY_FLOOR_DAYS,
      minBurnMicro,
      modelSwitchMinRunwayDays: e.MODEL_SWITCH_MIN_RUNWAY_DAYS,
    },
    demo: { enabled: e.DEMO, seed: e.DEMO_SEED, agents: e.DEMO_AGENTS, days: e.DEMO_DAYS, treasuryUsd: e.DEMO_TREASURY_USD },
    warnings,
  };
}

function devFallback(name: string, fallback: string, isProduction: boolean, warnings: string[]): string {
  if (isProduction) throw new ConfigError(`${name} is required when NODE_ENV=production`);
  warnings.push(`${name} not set: using an insecure development default`);
  return fallback;
}

const stripSlash = (u: string): string => u.replace(/\/+$/, '');

// Secret-free snapshot for the boot log.
export function describeConfig(c: Config): Record<string, unknown> {
  return {
    env: c.env, version: c.version, port: c.port, publicUrl: c.publicUrl, apiUrl: c.apiUrl,
    chain: {
      mode: c.chain.mode, cluster: c.chain.cluster, usdcMint: c.chain.usdcMint,
      founderFeeWallet: c.chain.founderFeeWallet, acceptEthDeposits: c.chain.acceptEthDeposits,
      lifiKey: c.chain.lifiApiKey !== null,
    },
    token: { launchEnabled: c.token.launchEnabled, creatorTaxBps: c.token.creatorTaxBps },
    llm: { provider: c.llm.provider, allowedModels: c.llm.allowedModels, keys: { anthropic: !!c.llm.anthropicApiKey, openai: !!c.llm.openaiApiKey, openrouter: !!c.llm.openrouterApiKey } },
    search: c.search.provider, sandbox: c.sandbox.driver, dataDir: c.dataDir, sitesBaseUrl: c.sitesBaseUrl,
    economy: { ...c.economy, founderFeeBps: c.economy.founderFeeBps }, launch: c.launch, demo: c.demo,
  };
}
