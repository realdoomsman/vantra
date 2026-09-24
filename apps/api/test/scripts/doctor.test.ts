// `pnpm run doctor` — the parts that can be asserted without a key, a cluster or a daemon.
// The network-touching checks are proved by running the command itself (docs/STATUS-V2.md);
// what is pinned here is the logic that decides PASS/FAIL, the remedy for every failure mode,
// the schema comparison against the drizzle migrations, and the PASS branch of the LLM probe
// (driven through the real check function with a provider whose answer is known).
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LlmProvider, LlmResponse } from '../../src/core/interfaces.js';
import { loadConfig, type Config } from '../../src/config.js';
import {
  BUY_LINES, CHAIN_IDS, brainChecks, fmtEth, fmtExactUsd, latestSnapshot, llmRemedy, msg,
  parsePubkey, render, renderCheck, schemaDrift, searchChecks, verdictOf, type Check, type Section,
} from '../../src/scripts/doctor.js';

const check = (over: Partial<Check> = {}): Check => ({
  id: 'x', title: 'X', status: 'pass', detail: 'd', required: true, ...over,
});

const configWith = (env: Record<string, string>): Config => loadConfig({
  NODE_ENV: 'development',
  DATABASE_URL: 'postgres://localhost:5432/vantra',
  ...env,
} as NodeJS.ProcessEnv);

describe('verdictOf', () => {
  const sections = (checks: Check[]): Section[] => [{ name: 's', checks }];

  it('is ready only when every required check passed', () => {
    const v = verdictOf(sections([check(), check({ id: 'y', status: 'warn', required: false })]), { cluster: 'testnet', allowMainnet: false });
    expect(v.ready).toBe(true);
    expect(v.blockers).toHaveLength(0);
  });

  it('a failed required check blocks, and keeps its order', () => {
    const v = verdictOf(sections([
      check({ id: 'a' }),
      check({ id: 'b', status: 'fail', detail: 'broken' }),
      check({ id: 'c', status: 'skip' }),
    ]), { cluster: 'testnet', allowMainnet: false });
    expect(v.ready).toBe(false);
    expect(v.blockers.map((c) => c.id)).toEqual(['b', 'c']);
  });

  it('a failed OPTIONAL check does not block but is surfaced', () => {
    const v = verdictOf(sections([check(), check({ id: 'o', status: 'fail', required: false })]), { cluster: 'testnet', allowMainnet: false });
    expect(v.ready).toBe(true);
    expect(v.warnings.map((c) => c.id)).toEqual(['o']);
  });

  it('READY FOR REAL MONEY needs mainnet AND ALLOW_MAINNET on top of a clean run', () => {
    const clean = sections([check()]);
    expect(verdictOf(clean, { cluster: 'testnet', allowMainnet: true }).realMoney).toBe(false);
    expect(verdictOf(clean, { cluster: 'mainnet', allowMainnet: false }).realMoney).toBe(false);
    expect(verdictOf(clean, { cluster: 'mainnet', allowMainnet: true }).realMoney).toBe(true);
  });

  it('never claims real money while anything required is unproven', () => {
    const dirty = sections([check({ status: 'fail' })]);
    expect(verdictOf(dirty, { cluster: 'mainnet', allowMainnet: true }).realMoney).toBe(false);
  });

  it('counts every status', () => {
    const v = verdictOf(sections([
      check(), check({ id: '2' }), check({ id: '3', status: 'fail' }),
      check({ id: '4', status: 'warn', required: false }), check({ id: '5', status: 'skip', required: false }),
    ]), { cluster: 'testnet', allowMainnet: false });
    expect(v.counts).toEqual({ pass: 2, fail: 1, warn: 1, skip: 1 });
  });
});

describe('every failure names a remedy', () => {
  it('renderCheck prints the remedy under a fail and hides it on a pass', () => {
    const failed = renderCheck(check({ status: 'fail', remedy: 'do the thing' }), 10).join('\n');
    expect(failed).toContain('FAIL');
    expect(failed).toContain('do the thing');
    expect(renderCheck(check({ status: 'pass', remedy: 'ignored' }), 10).join('\n')).not.toContain('ignored');
  });

  it('the NOT READY block lists the blockers in order, numbered', () => {
    const sections: Section[] = [{ name: 's', checks: [
      check({ id: 'a', title: 'First', status: 'fail', detail: 'nope', remedy: 'fix first' }),
      check({ id: 'b', title: 'Second', status: 'skip', detail: 'absent', remedy: 'fix second' }),
    ] }];
    const out = render(sections, verdictOf(sections, { cluster: 'testnet', allowMainnet: false }), null);
    expect(out).toContain('NOT READY');
    expect(out).toMatch(/1\. First/);
    expect(out).toMatch(/2\. Second/);
    expect(out.indexOf('fix first')).toBeLessThan(out.indexOf('fix second'));
    expect(out).not.toContain('READY FOR REAL MONEY');
  });

  it('says READY FOR REAL MONEY only on a clean mainnet run', () => {
    const sections: Section[] = [{ name: 's', checks: [check()] }];
    const testnet = render(sections, verdictOf(sections, { cluster: 'testnet', allowMainnet: false }), null);
    expect(testnet).toContain('PRACTICE MONEY');
    expect(testnet).not.toMatch(/^ {2}READY FOR REAL MONEY {2}$/m);   // only as an instruction, never as the verdict
    const mainnet = render(sections, verdictOf(sections, { cluster: 'mainnet', allowMainnet: true }), null);
    expect(mainnet).toMatch(/^ {2}READY FOR REAL MONEY {2}$/m);
  });
});

describe('llmRemedy', () => {
  it('401 and 403 point at the key itself', () => {
    for (const status of [401, 403]) {
      expect(llmRemedy('anthropic', status, 'unauthorized', 'claude-haiku-4-5')).toContain('ANTHROPIC_API_KEY');
    }
  });

  it('404 names the model, not the key', () => {
    const r = llmRemedy('openai', 404, 'model not found', 'gpt-5-nano');
    expect(r).toContain('gpt-5-nano');
    expect(r).toContain('LLM_ALLOWED_MODELS');
  });

  it('an out-of-credit account is told to top up, not to re-paste the key', () => {
    const r = llmRemedy('anthropic', 400, 'Your credit balance is too low', 'claude-haiku-4-5');
    expect(r).toContain('out of money');
    expect(r).not.toContain('Re-copy');
  });

  it('429 says wait, 5xx says it is the provider', () => {
    expect(llmRemedy('openai', 429, 'rate limit', 'gpt-5-nano')).toContain('Wait');
    expect(llmRemedy('openai', 503, 'bad gateway', 'gpt-5-nano')).toContain('their outage');
  });

  it('a network failure blames the network', () => {
    expect(llmRemedy('openrouter', undefined, 'network error: fetch failed', 'x')).toContain('online');
  });
});

describe('parsePubkey', () => {
  it('accepts an address and returns it EIP-55 checksummed, whatever case it arrived in', () => {
    const checksummed = '0x80e0e24718dbFcad49ECAA6F1e6C89A190586cA8';
    expect(parsePubkey(checksummed)).toEqual({ pubkey: checksummed });
    expect(parsePubkey(checksummed.toLowerCase())).toEqual({ pubkey: checksummed });
  });

  it('rejects an empty value, a path, a private key and a truncated address', () => {
    expect(parsePubkey('  ')).toEqual({ error: 'empty' });
    expect(parsePubkey('/Users/me/wallet.json')).toHaveProperty('error');
    expect(parsePubkey('not a key')).toHaveProperty('error');
    expect(parsePubkey(`0x${'ab'.repeat(32)}`)).toHaveProperty('error');   // a 32-byte secret, not a 20-byte address
    expect(parsePubkey('0x80e0e24718dbFcad49ECAA6F1e6C89A190586c')).toHaveProperty('error');
  });
});

describe('schemaDrift', () => {
  const expected = new Map([['agents', new Set(['id', 'name'])], ['purchases', new Set(['id'])]]);

  it('reports nothing when the live database matches the migrations', () => {
    const actual = new Map([['agents', new Set(['id', 'name'])], ['purchases', new Set(['id'])]]);
    expect(schemaDrift(expected, actual)).toEqual({ missingTables: [], missingColumns: [], extraTables: [] });
  });

  it('names a table the migrations add and the database does not have', () => {
    const actual = new Map([['agents', new Set(['id', 'name'])]]);
    expect(schemaDrift(expected, actual).missingTables).toEqual(['purchases']);
  });

  it('names a missing column as table.column', () => {
    const actual = new Map([['agents', new Set(['id'])], ['purchases', new Set(['id'])]]);
    expect(schemaDrift(expected, actual).missingColumns).toEqual(['agents.name']);
  });

  it('reports an extra table without treating it as drift, and ignores drizzle bookkeeping', () => {
    const actual = new Map([
      ['agents', new Set(['id', 'name'])], ['purchases', new Set(['id'])],
      ['legacy', new Set(['id'])], ['__drizzle_migrations', new Set(['id'])],
    ]);
    const drift = schemaDrift(expected, actual);
    expect(drift.extraTables).toEqual(['legacy']);
    expect(drift.missingTables).toEqual([]);
  });
});

describe('latestSnapshot', () => {
  it('reads the newest snapshot, not the first', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'doctor-meta-'));
    writeFileSync(path.join(dir, '0000_snapshot.json'), JSON.stringify({ tables: { 'public.a': { name: 'a', columns: { id: { name: 'id' } } } } }));
    writeFileSync(path.join(dir, '0010_snapshot.json'), JSON.stringify({
      tables: { 'public.a': { name: 'a', columns: { id: { name: 'id' } } }, 'public.b': { name: 'b', columns: { id: { name: 'id' } } } },
    }));
    const snapshot = latestSnapshot(dir);
    expect(snapshot.tag).toBe('0010');
    expect([...snapshot.tables.keys()].sort()).toEqual(['a', 'b']);
  });

  it('reads this repository’s own migrations and finds the tables the app needs', () => {
    const snapshot = latestSnapshot(path.join(import.meta.dirname, '../../drizzle/meta'));
    expect(snapshot.tables.has('purchases')).toBe(true);
    expect(snapshot.tables.get('agents')?.has('funding_micro')).toBe(true);
  });
});

describe('formatting', () => {
  it('prints ETH at full gwei precision, no exponent, no trailing zeroes', () => {
    expect(fmtEth(0)).toBe('0 ETH');
    expect(fmtEth(5_000_000)).toBe('0.005 ETH');           // the gas stipend one agent is spawned with
    expect(fmtEth(1_500_000_000)).toBe('1.5 ETH');
    expect(fmtEth(100_000_000_000)).toBe('100 ETH');       // trailing zeroes must not eat the integer part
    expect(fmtEth(1)).toBe('0.000000001 ETH');             // a dust balance is not rounded away to "0 ETH"
  });

  it('prints a sub-cent completion cost in full rather than as $0.00', () => {
    expect(fmtExactUsd(0)).toBe('$0');
    expect(fmtExactUsd(0.000_012_5)).toBe('$0.0000125');
    expect(fmtExactUsd(0.5)).toBe('$0.5000');
    expect(fmtExactUsd(1e-10)).toBe('<$0.00000001');       // never "$0." and never "$0"
  });
});

describe('network identity', () => {
  it('knows the real chain ids, which is how the network is proved', () => {
    expect(CHAIN_IDS.mainnet).toBe(4663);
    expect(CHAIN_IDS.testnet).toBe(46630);
  });
});

describe('the brains section', () => {
  const okResponse = (model: string): LlmResponse => ({
    content: [{ type: 'text', text: 'ok' }],
    stopReason: 'end_turn',
    usage: { inputTokens: 14, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0, costMicro: 1 },
    model,
  });

  const provider = (name: LlmProvider['name'], impl: LlmProvider['complete']): LlmProvider => ({ name, complete: impl });

  it('SKIPs a provider with no key and tells him where to buy it', async () => {
    const checks = await brainChecks(configWith({ LLM_PROVIDER: 'mock' }));
    const anthropic = checks.find((c) => c.id === 'llm.anthropic');
    expect(anthropic?.status).toBe('skip');
    expect(anthropic?.remedy).toBe(BUY_LINES.ANTHROPIC_API_KEY);
  });

  it('PASSes on a real answer and reports the model, the latency and the actual cost', async () => {
    const config = configWith({ LLM_PROVIDER: 'router', ANTHROPIC_API_KEY: 'sk-ant-test' });
    const checks = await brainChecks(config, {
      llmProviders: { anthropic: provider('anthropic', async (_req, model) => okResponse(model.id)) },
    });
    const anthropic = checks.find((c) => c.id === 'llm.anthropic');
    expect(anthropic?.status).toBe('pass');
    expect(anthropic?.detail).toContain('claude-haiku-4-5');      // the cheapest Anthropic model: the probe must not burn Opus
    expect(anthropic?.detail).toMatch(/answered in \d+ ms/);
    expect(anthropic?.detail).toContain('14 in / 3 out tokens');
    expect(anthropic?.detail).toContain('this call cost $0.000029');   // 14 × $1/M + 3 × $5/M, not rounded to $0.00
    expect(anthropic?.remedy).toBeUndefined();
    expect(typeof anthropic?.ms).toBe('number');

    // ...and the summary line only goes green because a provider actually answered.
    expect(checks.find((c) => c.id === 'llm.any')?.status).toBe('pass');
    expect(checks.find((c) => c.id === 'llm.mode')?.status).toBe('pass');
  });

  it('FAILs with the provider’s own message and a remedy when the call is rejected', async () => {
    const { LlmCallError } = await import('../../src/llm/errors.js');
    const config = configWith({ LLM_PROVIDER: 'router', OPENAI_API_KEY: 'sk-bad' });
    const checks = await brainChecks(config, {
      llmProviders: {
        openai: provider('openai', () => Promise.reject(new LlmCallError('openai', 'HTTP 401: Incorrect API key', { status: 401, retryable: false }))),
      },
    });
    const openai = checks.find((c) => c.id === 'llm.openai');
    expect(openai?.status).toBe('fail');
    expect(openai?.detail).toContain('Incorrect API key');
    expect(openai?.remedy).toContain('OPENAI_API_KEY');
    expect(checks.find((c) => c.id === 'llm.any')?.status).toBe('fail');
  });

  it('keys that work but LLM_PROVIDER=mock is a FAILURE, not a pass: that is the silent fallback', async () => {
    const config = configWith({ LLM_PROVIDER: 'mock', ANTHROPIC_API_KEY: 'sk-ant-test' });
    const checks = await brainChecks(config, {
      llmProviders: { anthropic: provider('anthropic', async (_req, model) => okResponse(model.id)) },
    });
    expect(checks.find((c) => c.id === 'llm.anthropic')?.status).toBe('pass');
    const mode = checks.find((c) => c.id === 'llm.mode');
    expect(mode?.status).toBe('fail');
    expect(mode?.remedy).toContain('LLM_PROVIDER=router');
  });

  it('warns when a tier would silently run a model other than the one it is sold with', async () => {
    const config = configWith({ LLM_PROVIDER: 'router', ANTHROPIC_API_KEY: 'sk-ant-test' });
    const checks = await brainChecks(config, {
      llmProviders: { anthropic: provider('anthropic', async (_req, model) => okResponse(model.id)) },
    });
    const tiers = checks.find((c) => c.id === 'llm.tiers');
    expect(tiers?.status).toBe('fail');                  // no OpenAI key, so SPARK cannot have gpt-5-nano
    expect(tiers?.detail).toContain('SPARK wants gpt-5-nano');
    expect(tiers?.required).toBe(false);                 // it substitutes; it does not stop the app working
  });

  it('a narrow LLM_ALLOWED_MODELS is called out as the cause, not a missing key', async () => {
    const answers = async (_req: unknown, model: { id: string }) => okResponse(model.id);
    const config = configWith({
      LLM_PROVIDER: 'router',
      ANTHROPIC_API_KEY: 'sk-ant-test', OPENAI_API_KEY: 'sk-oa-test', OPENROUTER_API_KEY: 'sk-or-test',
      LLM_ALLOWED_MODELS: 'gpt-5-nano,claude-haiku-4-5',
    });
    const checks = await brainChecks(config, {
      llmProviders: {
        anthropic: provider('anthropic', answers), openai: provider('openai', answers), openrouter: provider('openrouter', answers),
      },
    });
    const tiers = checks.find((c) => c.id === 'llm.tiers');
    expect(tiers?.status).toBe('fail');
    expect(tiers?.detail).toContain('OPERATOR wants claude-sonnet-5');
    expect(tiers?.detail).not.toContain('SCOUT wants');          // haiku is allowed, so SCOUT is fine
    expect(tiers?.remedy).toContain('LLM_ALLOWED_MODELS');
    expect(tiers?.remedy).not.toContain('Add the provider key');
  });

  it('every SKIP and FAIL in the section carries a remedy', async () => {
    const checks = await brainChecks(configWith({ LLM_PROVIDER: 'mock' }));
    for (const c of checks) {
      if (c.status === 'fail' || c.status === 'skip') expect(c.remedy, `${c.id} has no remedy`).toBeTruthy();
    }
  });
});

describe('the search section', () => {
  const braveBody = { web: { results: [{ title: 'Robinhood Chain Bridge', url: 'https://bridge.example', description: 'Bridge USDC' }] } };
  const respond = (status: number, body: unknown) => () => Promise.resolve(
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
  );

  it('SKIPs with the place to get a key when neither key is set', async () => {
    const checks = await searchChecks(configWith({}));
    expect(checks.find((c) => c.id === 'search.key')?.status).toBe('skip');
    expect(checks.find((c) => c.id === 'search.key')?.remedy).toBe(BUY_LINES.BRAVE_API_KEY);
  });

  it('PASSes on a real result set and names the top hit', async () => {
    const config = configWith({ SEARCH_PROVIDER: 'brave', BRAVE_API_KEY: 'brave-test' });
    const checks = await searchChecks(config, { searchFetch: respond(200, braveBody) });
    const key = checks.find((c) => c.id === 'search.key');
    expect(key?.status).toBe('pass');
    expect(key?.detail).toContain('brave returned 1 results');
    expect(key?.detail).toContain('Robinhood Chain Bridge');
    expect(checks.find((c) => c.id === 'search.mode')?.status).toBe('pass');
  });

  it('a working key with SEARCH_PROVIDER=none is a warning: the key is never used', async () => {
    const config = configWith({ SEARCH_PROVIDER: 'none', BRAVE_API_KEY: 'brave-test' });
    const checks = await searchChecks(config, { searchFetch: respond(200, braveBody) });
    expect(checks.find((c) => c.id === 'search.key')?.status).toBe('pass');
    const mode = checks.find((c) => c.id === 'search.mode');
    expect(mode?.status).toBe('warn');
    expect(mode?.remedy).toContain('SEARCH_PROVIDER=brave');
  });

  it('a rejected key FAILs with the provider status and never blocks the verdict', async () => {
    const config = configWith({ SEARCH_PROVIDER: 'brave', BRAVE_API_KEY: 'bad' });
    const checks = await searchChecks(config, { searchFetch: respond(422, { error: 'SUBSCRIPTION_TOKEN_INVALID' }) });
    const key = checks.find((c) => c.id === 'search.key');
    expect(key?.status).toBe('fail');
    expect(key?.detail).toContain('422');
    expect(key?.required).toBe(false);
  });
});

describe('msg', () => {
  it('unwraps an AggregateError with an empty message rather than printing a blank FAIL line', () => {
    const inner = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:59999'), { code: 'ECONNREFUSED' });
    expect(msg(new AggregateError([inner]))).toContain('ECONNREFUSED');
  });

  it('falls back to the error code when there is no message at all', () => {
    expect(msg(Object.assign(new Error(''), { code: 'ENOENT' }))).toBe('ENOENT');
  });
});
