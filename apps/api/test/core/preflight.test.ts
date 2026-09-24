// The boot refusals. Every case here is a configuration that PARSES — config.ts is happy with all of
// them — but in which the operator would believe he is running for real and would not be. The point
// of the module under test is that none of these reach `listen()`.
import { describe, expect, it } from 'vitest';
import { DEFAULT_CATALOG, TIERS } from '@vantra/shared';
import { loadConfig, type Config } from '../../src/config.js';
import {
  CHAIN_IDS, MIN_TREASURY_GWEI, assertReady, configContradictions, configWarnings, livePreflight,
  networkNamedInUrl, renderProblems, tierSubstitutions,
} from '../../src/core/preflight.js';
import { silentLogger } from '../../src/lib/log.js';

const cfg = (env: Record<string, string> = {}): Config =>
  loadConfig({ NODE_ENV: 'development', ...env } as NodeJS.ProcessEnv);

// A parsing-valid robinhood config with real (non-default) secrets, so each test can break exactly one thing.
const CHAIN_BASE: Record<string, string> = {
  CHAIN_MODE: 'robinhood',
  RHC_NETWORK: 'testnet',
  RHC_RPC_URL: 'https://robinhood-testnet.g.alchemy.com/v2/key',
  USDC_ADDRESS: '0x1111111111111111111111111111111111111111',
  SESSION_SECRET: 'a-real-session-secret-long-enough-to-pass',
  KEY_ENCRYPTION_KEY: 'ab'.repeat(32),
  TREASURY_WALLET_SECRET: 't', ESCROW_WALLET_SECRET: 'e',
  PROTOCOL_FEE_WALLET: 'p', FOUNDER_FEE_WALLET: 'f',
  SANDBOX_DRIVER: 'docker',
};

/** The same, pointed at mainnet with the confirmation flag and a real brain, so only mainnet differs. */
const MAINNET_BASE: Record<string, string> = {
  ...CHAIN_BASE,
  RHC_NETWORK: 'mainnet',
  ALLOW_MAINNET: '1',
  RHC_RPC_URL: 'https://rpc.mainnet.chain.robinhood.com',
  USDC_ADDRESS: '',
};

const ids = (c: Config): string[] => configContradictions(c).map((p) => p.id);

/** The Error assertReady threw, or a failure if it resolved. */
async function rejection(run: Promise<unknown>): Promise<Error> {
  try {
    await run;
  } catch (e) {
    return e as Error;
  }
  throw new Error('expected assertReady to refuse, but it resolved');
}

describe('config.ts: CHAIN_MODE=robinhood refuses to inherit the mainnet RPC default', () => {
  it('requires RHC_RPC_URL to be named out loud', () => {
    const { RHC_RPC_URL: _omitted, ...withoutRpc } = CHAIN_BASE;
    expect(() => cfg(withoutRpc)).toThrow(/RHC_RPC_URL is required when CHAIN_MODE=robinhood/);
  });

  it('accepts it when it is stated', () => {
    expect(cfg(CHAIN_BASE).chain.rpcUrl).toBe('https://robinhood-testnet.g.alchemy.com/v2/key');
  });

  it('memory mode still gets the default, because nothing is read from it', () => {
    expect(cfg().chain.rpcUrl).toBe('https://rpc.mainnet.chain.robinhood.com');
  });
});

describe('preflight: a key you bought and are not using', () => {
  it('refuses LLM_PROVIDER=mock while a provider key is set, and names the key', () => {
    const problems = configContradictions(cfg({ ANTHROPIC_API_KEY: 'sk-ant-real' }));
    expect(problems.map((p) => p.id)).toContain('llm.key-set-but-mock');
    const p = problems.find((x) => x.id === 'llm.key-set-but-mock')!;
    expect(p.problem).toContain('ANTHROPIC_API_KEY');
    expect(p.problem).toContain('canned script');
    expect(p.remedy).toContain('LLM_PROVIDER=router');
  });

  it('names every key that is set, not just the first', () => {
    const p = configContradictions(cfg({ ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'b', OPENROUTER_API_KEY: 'c' }))
      .find((x) => x.id === 'llm.key-set-but-mock')!;
    for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY']) expect(p.problem).toContain(k);
  });

  it('refuses CHAIN_MODE=memory while wallets are configured', () => {
    const p = configContradictions(cfg({ TREASURY_WALLET_SECRET: 't', FOUNDER_FEE_WALLET: 'f' }))
      .find((x) => x.id === 'chain.wallets-set-but-memory')!;
    expect(p.problem).toContain('TREASURY_WALLET_SECRET');
    expect(p.problem).toContain('FOUNDER_FEE_WALLET');
    expect(p.remedy).toContain('CHAIN_MODE=robinhood');
  });

  it('refuses SEARCH_PROVIDER=none while a search key is set', () => {
    const p = configContradictions(cfg({ BRAVE_API_KEY: 'brave' })).find((x) => x.id === 'search.key-set-but-none')!;
    expect(p.problem).toContain('BRAVE_API_KEY');
    expect(p.remedy).toContain('SEARCH_PROVIDER=brave');
  });

  it('refuses x402 inference against simulated wallets, which have nothing to pay with', () => {
    const p = configContradictions(cfg({ LLM_PROVIDER: 'x402', X402_GATEWAY_URL: 'https://gw.example/v1' }))
      .find((x) => x.id === 'llm.x402-without-chain')!;
    expect(p.problem).toContain('CHAIN_MODE=memory');
    expect(p.remedy).toContain('CHAIN_MODE=robinhood');
  });

  it('DEMO=1 is the explicit opt-in and is exempt from all three: `pnpm demo` must work with a full .env', () => {
    const demo = cfg({
      DEMO: '1', ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'b',
      TREASURY_WALLET_SECRET: 't', FOUNDER_FEE_WALLET: 'f', BRAVE_API_KEY: 'brave',
    });
    expect(configContradictions(demo)).toEqual([]);
  });
});

describe('preflight: real money behind development defaults', () => {
  it('refuses the public development KEY_ENCRYPTION_KEY once the chain is real', () => {
    const { KEY_ENCRYPTION_KEY: _drop, ...noKek } = CHAIN_BASE;
    const p = configContradictions(cfg(noKek)).find((x) => x.id === 'secrets.dev-kek-on-real-chain')!;
    expect(p.problem).toContain('public constant');
    expect(p.remedy).toContain('openssl rand -hex 32');
  });

  it('refuses the public development SESSION_SECRET once the chain is real', () => {
    const { SESSION_SECRET: _drop, ...noSession } = CHAIN_BASE;
    expect(ids(cfg(noSession))).toContain('secrets.dev-session-on-real-chain');
  });

  it('allows both development defaults in the simulator, which is what `pnpm demo` runs on', () => {
    expect(configContradictions(cfg())).toEqual([]);
  });

  it('refuses unisolated bash next to real keys', () => {
    const p = configContradictions(cfg({ ...CHAIN_BASE, SANDBOX_DRIVER: 'local' }))
      .find((x) => x.id === 'sandbox.local-on-real-chain')!;
    expect(p.problem).toContain('no container');
    expect(p.remedy).toContain('SANDBOX_DRIVER=docker');
  });

  it('refuses scripted agents on mainnet, where the purchases are real', () => {
    const p = configContradictions(cfg(MAINNET_BASE)).find((x) => x.id === 'llm.mock-on-mainnet')!;
    expect(p.problem).toContain('RHC_NETWORK=mainnet');
    expect(p.remedy).toContain('LLM_PROVIDER=router');
  });

  it('refuses a seeded demo colony on a production deploy', () => {
    const prod = loadConfig({
      NODE_ENV: 'production', DEMO: '1', SANDBOX_DRIVER: 'docker', SANDBOX_EGRESS_FILTERED: '1',
      SESSION_SECRET: 'x'.repeat(40), KEY_ENCRYPTION_KEY: 'cd'.repeat(32),
    } as NodeJS.ProcessEnv);
    expect(ids(prod)).toContain('demo.on-production');
  });
});

describe('preflight: RHC_RPC_URL that is not the network it claims', () => {
  it('reads the network out of the hostname when it is there', () => {
    expect(networkNamedInUrl('https://rpc.mainnet.chain.robinhood.com')).toBe('mainnet');
    expect(networkNamedInUrl('https://robinhood-testnet.g.alchemy.com/v2/key')).toBe('testnet');
  });

  it('says nothing about a private endpoint that names no network', () => {
    expect(networkNamedInUrl('https://rpc.example.com/?api-key=abc')).toBeNull();
    expect(networkNamedInUrl('not-a-url')).toBeNull();
  });

  it('refuses mainnet pointed at a testnet URL before a single packet leaves', () => {
    const p = configContradictions(cfg({
      ...MAINNET_BASE, LLM_PROVIDER: 'router', ANTHROPIC_API_KEY: 'k',
      RHC_RPC_URL: 'https://robinhood-testnet.g.alchemy.com/v2/key',
    })).find((x) => x.id === 'chain.rpc-url-network-mismatch')!;
    expect(p.problem).toContain('RHC_NETWORK=mainnet');
    expect(p.problem).toContain('testnet');
  });

  it('says nothing when the URL and the network agree', () => {
    expect(ids(cfg(CHAIN_BASE))).not.toContain('chain.rpc-url-network-mismatch');
  });
});

describe('preflight: probes that actually call out', () => {
  const dockerCfg = cfg({ SANDBOX_DRIVER: 'docker', SANDBOX_IMAGE: 'vantra-sandbox:latest' });

  it('refuses SANDBOX_DRIVER=docker when the daemon does not answer', async () => {
    const { problems } = await livePreflight(dockerCfg, {
      dockerPing: async () => { throw new Error('connect ENOENT /var/run/docker.sock'); },
    });
    expect(problems.map((p) => p.id)).toEqual(['sandbox.daemon-unreachable']);
    expect(problems[0]!.problem).toContain('ENOENT');
    expect(problems[0]!.remedy).toContain('docker info');
  });

  it('refuses SANDBOX_DRIVER=docker when the image was never built, and prints the build command', async () => {
    const { problems } = await livePreflight(dockerCfg, {
      dockerPing: async () => undefined,
      dockerImage: async () => { throw new Error('no such image'); },
    });
    expect(problems.map((p) => p.id)).toEqual(['sandbox.image-missing']);
    expect(problems[0]!.remedy).toContain('docker build -t vantra-sandbox:latest docker/sandbox');
  });

  it('passes when the daemon answers and the image is there', async () => {
    const { problems } = await livePreflight(dockerCfg, {
      dockerPing: async () => undefined,
      dockerImage: async () => undefined,
    });
    expect(problems).toEqual([]);
  });

  it('does not probe Docker at all when the driver is local', async () => {
    let pinged = false;
    const { problems } = await livePreflight(cfg({ SANDBOX_DRIVER: 'local' }), {
      dockerPing: async () => { pinged = true; },
    });
    expect(pinged).toBe(false);
    expect(problems).toEqual([]);
  });

  it('refuses an RPC that answers with the wrong chain id, and names the network it really is', async () => {
    const { problems } = await livePreflight(cfg({ ...CHAIN_BASE, RHC_RPC_URL: 'https://rpc.example.com' }), {
      chainHead: async () => ({ chainId: CHAIN_IDS.mainnet!, blockNumber: 12_345 }),
    });
    expect(problems.map((p) => p.id)).toEqual(['chain.wrong-network']);
    expect(problems[0]!.problem).toContain('really is mainnet');
  });

  it('accepts an RPC whose chain id matches the configured network', async () => {
    const { problems } = await livePreflight(cfg(CHAIN_BASE), {
      chainHead: async () => ({ chainId: CHAIN_IDS.testnet!, blockNumber: 12_345 }),
    });
    expect(problems).toEqual([]);
  });

  // An endpoint can know its chain id and still be serving nothing: every balance read would be zero
  // and every purchase would look unpaid.
  it('refuses an RPC that knows its chain id but has no head block', async () => {
    const { problems } = await livePreflight(cfg(CHAIN_BASE), {
      chainHead: async () => ({ chainId: CHAIN_IDS.testnet!, blockNumber: 0 }),
    });
    expect(problems.map((p) => p.id)).toEqual(['chain.rpc-no-blocks']);
    expect(problems[0]!.problem).toContain('not serving chain state');
  });

  it('refuses an RPC that does not answer', async () => {
    const { problems } = await livePreflight(cfg(CHAIN_BASE), {
      chainHead: async () => { throw new Error('fetch failed'); },
    });
    expect(problems.map((p) => p.id)).toEqual(['chain.rpc-unreachable']);
    expect(problems[0]!.problem).toContain('fetch failed');
  });

  it('never probes the chain in memory mode', async () => {
    let read = false;
    const { problems } = await livePreflight(cfg(), {
      chainHead: async () => { read = true; return { chainId: 1, blockNumber: 1 }; },
    });
    expect(read).toBe(false);
    expect(problems).toEqual([]);
  });

  it('an unfunded treasury is a warning, not a refusal: it can be funded while the server runs', async () => {
    const { problems, warnings } = await livePreflight(cfg(CHAIN_BASE), {
      chainHead: async () => ({ chainId: CHAIN_IDS.testnet!, blockNumber: 12_345 }),
      treasuryGwei: async () => 0,
    });
    expect(problems).toEqual([]);
    expect(warnings.join(' ')).toContain('0.000000 ETH');
    expect(warnings.join(' ')).toContain('first purchase will fail');
  });

  it('a funded treasury says nothing', async () => {
    const { warnings } = await livePreflight(cfg(CHAIN_BASE), {
      chainHead: async () => ({ chainId: CHAIN_IDS.testnet!, blockNumber: 12_345 }),
      treasuryGwei: async () => MIN_TREASURY_GWEI,
    });
    expect(warnings).toEqual([]);
  });
});

describe('preflight: tier model substitution is loud', () => {
  it('says nothing when every tier can run the model it is sold with', () => {
    const all = DEFAULT_CATALOG.map((m) => ({ ...m, enabled: true }));
    expect(tierSubstitutions(all)).toEqual([]);
  });

  it('names the tier, the model it is sold with and the model it will really run', () => {
    // Only the OpenRouter models enabled: nothing any tier is actually sold with.
    const openrouterOnly = DEFAULT_CATALOG.map((m) => ({ ...m, enabled: m.provider === 'openrouter' }));
    const lines = tierSubstitutions(openrouterOnly);
    expect(lines).toHaveLength(TIERS.length);
    for (const line of lines) expect(line).toMatch(/is sold with .* but will run /);
    expect(lines.join('\n')).toContain('PRIME is sold with claude-opus-5');
  });

  it('says so plainly when a tier has no model at all', () => {
    const none = DEFAULT_CATALOG.map((m) => ({ ...m, enabled: false }));
    expect(tierSubstitutions(none)[0]).toContain('NO model is available');
  });
});

describe('preflight: conditions the catalog cannot show', () => {
  it('warns that claude-fable-5-1 needs 30-day retention, which is a 400 on every call without it', () => {
    const w = configWarnings(cfg({ LLM_PROVIDER: 'router', ANTHROPIC_API_KEY: 'k', LLM_ALLOWED_MODELS: 'claude-fable-5-1' }));
    expect(w.join(' ')).toContain('30-day data retention');
    expect(w.join(' ')).toContain('400 invalid_request_error');
  });

  it('says nothing about a model that has no caveat', () => {
    expect(configWarnings(cfg({ LLM_PROVIDER: 'router', ANTHROPIC_API_KEY: 'k', LLM_ALLOWED_MODELS: 'claude-opus-5' })))
      .toEqual([]);
  });

  it('says the egress boundary is half-installed, including the ICC caveat', () => {
    const w = configWarnings(cfg({ SANDBOX_DRIVER: 'docker' })).join(' ');
    expect(w).toContain('SANDBOX_EGRESS_FILTERED=0');
    expect(w).toContain('enable_icc=false');
  });

  it('is quiet once the firewall is declared installed', () => {
    expect(configWarnings(cfg({ SANDBOX_DRIVER: 'docker', SANDBOX_EGRESS_FILTERED: '1' }))).toEqual([]);
  });
});

describe('assertReady', () => {
  it('throws one error listing every problem with its fix', async () => {
    const broken = cfg({ ANTHROPIC_API_KEY: 'a', TREASURY_WALLET_SECRET: 't', BRAVE_API_KEY: 'b' });
    await expect(assertReady({ config: broken, log: silentLogger })).rejects.toThrow(/VANTRA refuses to start\. 3 configuration problems/);
    const err = await rejection(assertReady({ config: broken, log: silentLogger }));
    expect(err.message).toContain('ANTHROPIC_API_KEY');
    expect(err.message).toContain('TREASURY_WALLET_SECRET');
    expect(err.message).toContain('BRAVE_API_KEY');
    expect(err.message.match(/FIX:/g)).toHaveLength(3);
    expect(err.message).toContain('pnpm ready');
  });

  it('combines the static rules with the live probes in one refusal', async () => {
    const err = await rejection(assertReady({
      config: cfg({ ...CHAIN_BASE, SANDBOX_DRIVER: 'local', ANTHROPIC_API_KEY: 'a' }),
      log: silentLogger,
      probes: { chainHead: async () => ({ chainId: CHAIN_IDS.mainnet!, blockNumber: 12_345 }) },
    }));
    expect(err.message).toContain('SANDBOX_DRIVER=local');    // static
    expect(err.message).toContain('really is mainnet');       // live
  });

  it('resolves for the zero-key demo stack, which is the whole point of `pnpm demo`', async () => {
    const demo = cfg({ DEMO: '1', CHAIN_MODE: 'memory', LLM_PROVIDER: 'mock', SANDBOX_DRIVER: 'local' });
    await expect(assertReady({ config: demo, log: silentLogger, models: DEFAULT_CATALOG })).resolves.toBeUndefined();
  });

  it('renders singular and plural correctly', () => {
    expect(renderProblems([{ id: 'a', problem: 'p', remedy: 'r' }])).toContain('1 configuration problem would');
    expect(renderProblems([{ id: 'a', problem: 'p', remedy: 'r' }, { id: 'b', problem: 'q', remedy: 's' }]))
      .toContain('2 configuration problems would');
  });
});
