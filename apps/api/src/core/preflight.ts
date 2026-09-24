// Boot preflight: the server refuses to start in any configuration where the operator would think
// he is running for real and is not.
//
// `config.ts` parses the environment and refuses what is internally contradictory. This file refuses
// what is *externally* contradictory — a key that is set but will never be used, a real chain behind
// scripted agents, a docker driver with no daemon, an RPC that is not the network it claims to be.
// Nothing here reads a flag and believes it: the docker and chain checks actually call out.
//
// Every problem carries a remedy naming the exact variable to change. `assertReady` throws one error
// listing all of them at once, so a misconfigured .env is fixed in one pass rather than five boots.
import { SANDBOX_STRATEGIES, SANDBOX_TOOLS, TIERS, resolveTierModel, type ModelInfo } from '@vantra/shared';
import type { Config } from '../config.js';
import { API_URL_DEFAULT, DEV_KEY_ENCRYPTION_KEY, DEV_SESSION_SECRET, PUBLIC_URL_DEFAULT } from '../config.js';
import { ConfigError, errorMessage } from '../lib/errors.js';
import type { Logger } from '../lib/log.js';

/**
 * Robinhood Chain ids, and the single source of truth for them: chain/evm.ts builds its viem chain
 * definitions from this table, so the endpoint the boot proves and the endpoint the app talks to can
 * never be two different networks. This is how the boot knows RHC_RPC_URL points where you think it does.
 */
export const CHAIN_IDS: Record<string, number> = {
  mainnet: 4663,
  testnet: 46630,
};

export const PREFLIGHT_TIMEOUT_MS = { docker: 20_000, rpc: 20_000 } as const;

export interface PreflightProblem {
  /** Stable id so a test can name the rule it is asserting. */
  id: string;
  /** What is wrong, in the operator's terms. */
  problem: string;
  /** The exact change that fixes it. */
  remedy: string;
}

export interface PreflightResult { problems: PreflightProblem[]; warnings: string[] }

/** Injectable probes so preflight is testable without a daemon or a chain. */
export interface PreflightProbes {
  /** Resolves when the Docker daemon answers; rejects otherwise. */
  dockerPing?: () => Promise<void>;
  /** Resolves when the sandbox image exists locally; rejects otherwise. */
  dockerImage?: (image: string) => Promise<void>;
  /** The chain id and head block behind RHC_RPC_URL — `eth_chainId` and `eth_blockNumber`. */
  chainHead?: (rpcUrl: string) => Promise<{ chainId: number; blockNumber: number }>;
  /** Treasury ETH in gwei. Warning-only: an unfunded treasury cannot pay a single fee. */
  treasuryGwei?: () => Promise<number>;
}

/** Below this the treasury cannot pay gas stipends for the agents it funds. */
export const MIN_TREASURY_GWEI = 50_000_000;   // 0.05 ETH

// ---------------------------------------------------------------------------
// Static contradictions — no network, so these are also what the tests assert
// ---------------------------------------------------------------------------

/**
 * Configurations that are internally consistent but mean the opposite of what the operator intends.
 * DEMO=1 is the one explicit opt-in to the whole simulated stack, so it is exempt from the
 * "you set a key but it is not being used" family: `pnpm demo` must work with a full .env.
 */
export function configContradictions(config: Config): PreflightProblem[] {
  const out: PreflightProblem[] = [];
  const demo = config.demo.enabled;

  // 1. Keys bought and pasted in, then never used, because the mode switch was missed. This is the
  //    single most likely way to think you are running real models when every agent is a script.
  if (!demo && config.llm.provider === 'mock') {
    const set = ([
      ['ANTHROPIC_API_KEY', config.llm.anthropicApiKey],
      ['OPENAI_API_KEY', config.llm.openaiApiKey],
      ['OPENROUTER_API_KEY', config.llm.openrouterApiKey],
    ] as const).filter(([, v]) => v !== null).map(([k]) => k);
    if (set.length > 0) {
      out.push({
        id: 'llm.key-set-but-mock',
        problem: `${set.join(', ')} ${set.length === 1 ? 'is' : 'are'} set, but LLM_PROVIDER=mock — every agent would `
          + 'think with a canned script and the key would never be called',
        remedy: 'Set LLM_PROVIDER=router in .env to use the key, or remove the key if you meant to stay on the mock. '
          + '`pnpm demo` forces the mock deliberately and is exempt from this check.',
      });
    }
  }

  // 2. Same mistake, the money half: wallets configured, chain still simulated.
  if (!demo && config.chain.mode === 'memory') {
    const set = ([
      ['TREASURY_WALLET_SECRET', config.chain.treasuryWalletSecret],
      ['ESCROW_WALLET_SECRET', config.chain.escrowWalletSecret],
      ['FOUNDER_FEE_WALLET', config.chain.founderFeeWallet],
      ['PROTOCOL_FEE_WALLET', config.chain.protocolFeeWallet],
    ] as const).filter(([, v]) => v !== null).map(([k]) => k);
    if (set.length > 0) {
      out.push({
        id: 'chain.wallets-set-but-memory',
        problem: `${set.join(', ')} ${set.length === 1 ? 'is' : 'are'} set, but CHAIN_MODE=memory — deposit addresses `
          + 'are fake, no USDC moves and no founder fee is ever paid',
        remedy: 'Set CHAIN_MODE=robinhood in .env to use those wallets, or clear them if you meant to stay in the '
          + 'simulator. `pnpm demo` forces the simulator deliberately and is exempt from this check.',
      });
    }
  }

  // 3. And the search half.
  if (!demo && config.search.provider === 'none') {
    const set = ([
      ['BRAVE_API_KEY', config.search.braveApiKey],
      ['TAVILY_API_KEY', config.search.tavilyApiKey],
    ] as const).filter(([, v]) => v !== null).map(([k]) => k);
    if (set.length > 0) {
      out.push({
        id: 'search.key-set-but-none',
        problem: `${set.join(', ')} ${set.length === 1 ? 'is' : 'are'} set, but SEARCH_PROVIDER=none — the web_search `
          + 'tool returns nothing and agents cannot look anything up',
        remedy: `Set SEARCH_PROVIDER=${config.search.braveApiKey ? 'brave' : 'tavily'} in .env, or remove the key.`,
      });
    }
  }

  // 4. Real wallets encrypted with a key that is printed in this repository. Every agent secret and
  //    every deposit key in the database would be readable by anyone who has the source.
  if (config.chain.mode === 'robinhood') {
    if (config.keyEncryptionKey === DEV_KEY_ENCRYPTION_KEY) {
      out.push({
        id: 'secrets.dev-kek-on-real-chain',
        problem: 'KEY_ENCRYPTION_KEY is the development default, which is a public constant in this repository, '
          + 'but CHAIN_MODE=robinhood stores real agent and deposit keys encrypted with it',
        remedy: 'Put a real key in .env BEFORE any wallet is stored — it cannot be changed afterwards without '
          + 'losing every stored secret:  openssl rand -hex 32',
      });
    }
    if (config.sessionSecret === DEV_SESSION_SECRET) {
      out.push({
        id: 'secrets.dev-session-on-real-chain',
        problem: 'SESSION_SECRET is the development default, which is a public constant in this repository, but '
          + 'CHAIN_MODE=robinhood means those sessions own real money',
        remedy: 'Put a real secret in .env:  openssl rand -base64 48',
      });
    }
  }

  // 5. Unisolated bash next to real money. `local` runs agent commands as the API user on this host.
  if (config.chain.mode === 'robinhood' && config.sandbox.driver === 'local') {
    out.push({
      id: 'sandbox.local-on-real-chain',
      problem: 'SANDBOX_DRIVER=local runs agent bash directly on this machine as the API user — no container, no '
        + 'memory limit, no network boundary — and CHAIN_MODE=robinhood means those agents hold real keys',
      remedy: 'Set SANDBOX_DRIVER=docker in .env and build the image once:  docker build -t '
        + `${config.sandbox.image} docker/sandbox`,
    });
  }

  // 6. Real money, scripted minds. The purchases would be real and the agents would be theatre.
  if (config.chain.cluster === 'mainnet' && config.chain.mode === 'robinhood' && config.llm.provider === 'mock') {
    out.push({
      id: 'llm.mock-on-mainnet',
      problem: 'RHC_NETWORK=mainnet takes real money for agents that would run on the mock provider',
      remedy: 'Set LLM_PROVIDER=router and add at least one provider key before selling anything on mainnet.',
    });
  }

  // 6b. x402 pays the gateway with USDC from each agent's own wallet, so a provider key would never be
  //     used, and simulated wallets have nothing to pay with.
  if (!demo && config.llm.provider === 'x402') {
    const set = ([
      ['ANTHROPIC_API_KEY', config.llm.anthropicApiKey],
      ['OPENAI_API_KEY', config.llm.openaiApiKey],
      ['OPENROUTER_API_KEY', config.llm.openrouterApiKey],
    ] as const).filter(([, v]) => v !== null).map(([k]) => k);
    if (set.length > 0) {
      out.push({
        id: 'llm.key-set-but-x402',
        problem: `${set.join(', ')} ${set.length === 1 ? 'is' : 'are'} set, but LLM_PROVIDER=x402 pays the gateway `
          + 'per call with USDC and never sends a provider key',
        remedy: 'Remove the unused key, or set LLM_PROVIDER=router to call the provider with it instead.',
      });
    }
    if (config.chain.mode !== 'robinhood') {
      out.push({
        id: 'llm.x402-without-chain',
        problem: "LLM_PROVIDER=x402 pays for inference from each agent's own Robinhood Chain wallet, but "
          + 'CHAIN_MODE=memory means those wallets are simulated and no USDC can move',
        remedy: 'Set CHAIN_MODE=robinhood and fund the agents to use x402, or LLM_PROVIDER=router/mock otherwise.',
      });
    }
  }

  // 7. An RPC URL that names a different network than RHC_NETWORK. The eth_chainId probe below proves
  //    this properly, but the URL alone catches the copy-paste before a single packet leaves.
  if (config.chain.mode === 'robinhood') {
    const named = networkNamedInUrl(config.chain.rpcUrl);
    if (named !== null && named !== config.chain.cluster) {
      out.push({
        id: 'chain.rpc-url-network-mismatch',
        problem: `RHC_NETWORK=${config.chain.cluster} but RHC_RPC_URL names ${named} (${config.chain.rpcUrl})`,
        remedy: `Set RHC_NETWORK=${named}, or point RHC_RPC_URL at a ${config.chain.cluster} endpoint. `
          + 'Getting this wrong sends real purchases to a chain nobody is watching.',
      });
    }
  }

  // 8. The seeded demo colony on a production deploy: 36 invented agents and a faucetted treasury,
  //    presented to real visitors as the real thing.
  if (demo && config.isProduction) {
    out.push({
      id: 'demo.on-production',
      problem: 'DEMO=1 seeds an invented colony with a faucetted treasury, and NODE_ENV=production means real '
        + 'visitors would be shown it as real',
      remedy: 'Remove DEMO=1 from the production environment. `pnpm demo` is for showing the product locally.',
    });
  }

  // 9. A production deploy still addressed as the development default. The CSRF guard admits only
  //    PUBLIC_URL and API_URL as origins, so every browser POST from the real domain would be refused,
  //    and every link the API hands out (profiles, hosted sites, the Google callback) would be localhost.
  if (config.isProduction) {
    const unset = ([
      ['PUBLIC_URL', config.publicUrl, PUBLIC_URL_DEFAULT],
      ['API_URL', config.apiUrl, API_URL_DEFAULT],
    ] as const).filter(([, value, fallback]) => value === fallback).map(([name]) => name);
    if (unset.length > 0) {
      out.push({
        id: 'http.default-urls-on-production',
        problem: `${unset.join(' and ')} ${unset.length === 1 ? 'is' : 'are'} still the development default, but `
          + 'NODE_ENV=production: the CSRF guard would reject every sign-in and purchase from the real domain',
        remedy: 'Set PUBLIC_URL and API_URL to the public https origin, e.g. PUBLIC_URL=https://vantra.fun '
          + 'API_URL=https://vantra.fun when the API serves the web app itself.',
      });
    }
  }

  return out;
}

/**
 * Models with a condition attached that is not visible in the catalog. Nothing here blocks a boot;
 * each one is a first-call 400 waiting to happen if the operator does not know about it.
 */
export const MODEL_CAVEATS: Record<string, string> = {
  'claude-fable-5-1': 'claude-fable-5-1 requires 30-day data retention on the Anthropic organisation. '
    + 'A zero-data-retention org gets a 400 invalid_request_error on EVERY call to it.',
};

/** Things worth saying out loud at boot that are not, by themselves, reasons to refuse. */
export function configWarnings(config: Config): string[] {
  const out: string[] = [];
  for (const id of config.llm.allowedModels) {
    const caveat = MODEL_CAVEATS[id.trim()];
    if (caveat) out.push(caveat);
  }
  if (config.sandbox.driver === 'docker' && !config.sandbox.egressFiltered) {
    out.push(
      'SANDBOX_EGRESS_FILTERED=0: the host firewall half of the egress boundary is not installed, so agent bash '
      + 'can reach private addresses the fetch_url tool refuses. Container-to-container isolation also depends on '
      + 'the runtime honouring enable_icc=false, which OrbStack on macOS does NOT — verify it on the Linux host.',
    );
  }
  // `none` is a legitimate production mode (nothing runs, so nothing escapes), but the operator reading
  // the log must know exactly what the agents cannot do on this deployment.
  if (config.sandbox.driver === 'none') {
    out.push(
      `SANDBOX_DRIVER=none: there is no code sandbox, so these tools are withheld from every agent: ${SANDBOX_TOOLS.join(', ')}. `
      + `The ${SANDBOX_STRATEGIES.join(' and ')} launch strategies are refused. Stored agent tools are unchanged: set `
      + 'SANDBOX_DRIVER=docker on a host with a Docker daemon and they come back on the next heartbeat.',
    );
  }
  return out;
}

/**
 * The host in RHC_RPC_URL names a network, or null when it names none (a private provider URL).
 * Testnet is checked first: `robinhood-testnet.g.alchemy.com` also contains no "mainnet", but a host
 * like `rpc.mainnet-testnet.example` must read as testnet rather than as the network it is proxying.
 */
export function networkNamedInUrl(rpcUrl: string): string | null {
  let host: string;
  try {
    host = new URL(rpcUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (host.includes('testnet')) return 'testnet';
  if (host.includes('mainnet')) return 'mainnet';
  return null;
}

// ---------------------------------------------------------------------------
// Live probes — these actually call out
// ---------------------------------------------------------------------------

export async function livePreflight(config: Config, probes: PreflightProbes): Promise<PreflightResult> {
  const problems: PreflightProblem[] = [];
  const warnings: string[] = [];

  if (config.sandbox.driver === 'docker') {
    const ping = probes.dockerPing;
    if (ping) {
      try {
        await withTimeout('Docker daemon', PREFLIGHT_TIMEOUT_MS.docker, ping);
        const image = probes.dockerImage;
        if (image) {
          try {
            await withTimeout('Docker image', PREFLIGHT_TIMEOUT_MS.docker, () => image(config.sandbox.image));
          } catch (e) {
            problems.push({
              id: 'sandbox.image-missing',
              problem: `SANDBOX_DRIVER=docker but the image "${config.sandbox.image}" is not on this machine `
                + `(${errorMessage(e)}) — every agent's first bash call would fail`,
              remedy: `Build it once:  docker build -t ${config.sandbox.image} docker/sandbox`,
            });
          }
        }
      } catch (e) {
        problems.push({
          id: 'sandbox.daemon-unreachable',
          problem: `SANDBOX_DRIVER=docker but the Docker daemon did not answer (${errorMessage(e)})`,
          remedy: 'Start Docker (OrbStack or Docker Desktop) and check `docker info`. On a host that cannot run Docker, '
            + 'set SANDBOX_DRIVER=none to run with no agent code execution; SANDBOX_DRIVER=local is for an unisolated '
            + 'development run only.',
        });
      }
    }
  }

  if (config.chain.mode === 'robinhood' && probes.chainHead) {
    const read = probes.chainHead;
    try {
      const head = await withTimeout('Robinhood Chain RPC', PREFLIGHT_TIMEOUT_MS.rpc, () => read(config.chain.rpcUrl));
      const expected = CHAIN_IDS[config.chain.cluster];
      if (expected !== undefined && head.chainId !== expected) {
        const actual = Object.entries(CHAIN_IDS).find(([, id]) => id === head.chainId)?.[0]
          ?? `an unknown chain (id ${head.chainId})`;
        problems.push({
          id: 'chain.wrong-network',
          problem: `RHC_NETWORK=${config.chain.cluster} (chain id ${expected}) but RHC_RPC_URL really is ${actual}`,
          remedy: 'Either set RHC_NETWORK to match the endpoint, or point RHC_RPC_URL at a '
            + `${config.chain.cluster} endpoint. USDC lives at a different address on each network, so this `
            + 'mismatch makes every deposit unreadable.',
        });
      } else if (head.blockNumber <= 0) {
        // An endpoint that answers eth_chainId but serves no block is a proxy in front of nothing:
        // every balance read would come back zero and every purchase would look unpaid.
        problems.push({
          id: 'chain.rpc-no-blocks',
          problem: `RHC_RPC_URL (${config.chain.rpcUrl}) reports chain id ${head.chainId} but its head block is `
            + `${head.blockNumber} — it is not serving chain state`,
          remedy: 'Point RHC_RPC_URL at a synced endpoint. The public mainnet node is '
            + 'https://rpc.mainnet.chain.robinhood.com; a provider URL that is still syncing answers exactly like this.',
        });
      }
    } catch (e) {
      problems.push({
        id: 'chain.rpc-unreachable',
        problem: `CHAIN_MODE=robinhood but RHC_RPC_URL (${config.chain.rpcUrl}) did not answer: ${errorMessage(e)}`,
        remedy: 'Check this machine is online. https://rpc.mainnet.chain.robinhood.com is free but rate limited '
          + 'and carries no SLA; for anything real put your own provider endpoint in RHC_RPC_URL.',
      });
    }
  }

  if (config.chain.mode === 'robinhood' && probes.treasuryGwei) {
    const read = probes.treasuryGwei;
    try {
      const gwei = await withTimeout('Treasury balance', PREFLIGHT_TIMEOUT_MS.rpc, read);
      if (gwei < MIN_TREASURY_GWEI) {
        warnings.push(
          `treasury holds ${(gwei / 1e9).toFixed(6)} ETH, below the ${(MIN_TREASURY_GWEI / 1e9).toFixed(2)} ETH `
          + 'needed to pay gas stipends: the first purchase will fail until it is funded',
        );
      }
    } catch (e) {
      warnings.push(`could not read the treasury ETH balance: ${errorMessage(e)}`);
    }
  }

  return { problems, warnings };
}

// ---------------------------------------------------------------------------
// Non-blocking honesty warnings
// ---------------------------------------------------------------------------

/**
 * SPEC-V2 §2.3 lets a tier substitute a model when the one it is sold with is unavailable. That is
 * deliberate and the substitute is shown on /api/tiers, but it must never be quiet in the log: a
 * PRIME buyer paying for claude-opus-5 and getting a cheap open model is the thing to notice.
 */
export function tierSubstitutions(models: readonly ModelInfo[]): string[] {
  const out: string[] = [];
  for (const tier of TIERS) {
    const resolved = resolveTierModel(tier, models);
    if (resolved === null) {
      out.push(`tier ${tier.id} is sold with ${tier.modelId} and NO model is available to run it`);
    } else if (resolved.id !== tier.modelId) {
      out.push(`tier ${tier.id} is sold with ${tier.modelId} but will run ${resolved.id} — buyers are shown the substitute on /api/tiers`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface AssertReadyInput {
  config: Config;
  log: Logger;
  probes?: PreflightProbes;
  /** The router's enabled catalog, for the tier-substitution warning. */
  models?: readonly ModelInfo[];
}

/** Throws one error naming every problem, or logs the warnings and returns. */
export async function assertReady(input: AssertReadyInput): Promise<void> {
  const { config, log } = input;
  const problems = configContradictions(config);
  const live = await livePreflight(config, input.probes ?? {});
  problems.push(...live.problems);

  const warnings = [...configWarnings(config), ...live.warnings];
  if (input.models) warnings.push(...tierSubstitutions(input.models));
  if (config.llm.provider === 'mock') {
    warnings.push('LLM_PROVIDER=mock: every agent thinks with a canned script, not a real model');
  }
  if (config.chain.mode === 'memory') {
    warnings.push('CHAIN_MODE=memory: deposit addresses are simulated and no USDC moves');
  }
  for (const w of warnings) log.warn({ preflight: true }, w);

  if (problems.length === 0) {
    log.info({ checks: describeChecks(config) }, 'preflight passed');
    return;
  }
  throw new ConfigError(renderProblems(problems));
}

export function renderProblems(problems: readonly PreflightProblem[]): string {
  const body = problems
    .map((p, i) => `  ${i + 1}. ${p.problem}\n     FIX: ${p.remedy}`)
    .join('\n\n');
  return `VANTRA refuses to start. ${problems.length} configuration `
    + `${problems.length === 1 ? 'problem' : 'problems'} would make it look like it was running for real when it is not:\n\n`
    + `${body}\n\nRun \`pnpm ready\` for the full report.`;
}

function describeChecks(config: Config): Record<string, string> {
  return {
    chain: config.chain.mode === 'robinhood'
      ? `robinhood:${config.chain.cluster} (reachable, chain id ${CHAIN_IDS[config.chain.cluster] ?? '?'} verified)`
      : 'memory (simulated)',
    llm: config.llm.provider === 'router' ? 'router (real provider keys)'
      : config.llm.provider === 'x402' ? `x402 (agents pay ${config.llm.x402?.gatewayUrl ?? 'the gateway'} in USDC)`
      : 'mock (scripted)',
    sandbox: config.sandbox.driver === 'docker' ? 'docker (daemon up, image present)'
      : config.sandbox.driver === 'local' ? 'local (unisolated)'
      : 'none (no code sandbox; sandbox tools withheld)',
    demo: config.demo.enabled ? 'DEMO=1 (seeded colony, simulated everything)' : 'off',
  };
}

async function withTimeout<T>(label: string, ms: number, run: () => Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      run(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not answer within ${Math.round(ms / 1000)}s`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
