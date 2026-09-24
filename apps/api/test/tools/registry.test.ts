// Registry execution contract: validation, null-as-absent, is_error instead of throwing, and the
// secret-free input summaries broadcast as the WS 'tool' message. SPEC §8.9; AMENDMENTS A7, C27.
import { describe, expect, it } from 'vitest';
import { SANDBOX_TOOLS, type ToolName } from '@vantra/shared';
import { loadConfig } from '../../src/config.js';
import type { Db } from '../../src/db/client.js';
import type { AgentRow } from '../../src/db/schema.js';
import { INPUT_SUMMARY_MAX, redactSecrets } from '../../src/tools/index.js';
import { createToolRegistry } from '../../src/tools/index.js';
import { ALL_TOOL_NAMES, ctxFor, execOpts, fakePorts, fakeSandbox, fakeSearch, testDeps } from './helpers/env.js';

function agentRow(over: Partial<AgentRow> = {}): AgentRow {
  return {
    id: 'ag_test', name: 'TESTER', enabledTools: ALL_TOOL_NAMES, deploySlug: 'tester',
    walletPubkey: 'wallet_tester', model: 'claude-sonnet-5', effort: 'medium', memory: [], ...over,
  } as AgentRow;
}

function registryWith(over: Parameters<typeof testDeps>[1] = {}) {
  const deps = testDeps(null as unknown as Db, over);
  return { registry: createToolRegistry(deps, fakePorts()), deps };
}

describe('registry.execute', () => {
  it('reports an unknown tool as an error result rather than throwing', async () => {
    const { registry } = registryWith();
    const res = await registry.execute(ctxFor(agentRow()), 'teleport', {}, execOpts());
    expect(res.isError).toBe(true);
    expect(res.content).toContain('Unknown tool');
    expect(res.costMicro).toBe(0);
  });

  it('refuses a tool the agent has not enabled', async () => {
    const { registry } = registryWith();
    const res = await registry.execute(ctxFor(agentRow({ enabledTools: ['sleep'] })), 'web_search', { query: 'x' }, execOpts());
    expect(res.isError).toBe(true);
    expect(res.content).toContain('not enabled');
  });

  it('refuses to start once the step is aborted', async () => {
    const { registry } = registryWith();
    const controller = new AbortController();
    controller.abort();
    const res = await registry.execute(ctxFor(agentRow()), 'sleep', { minutes: 10 }, { signal: controller.signal, remainingMs: 1_000 });
    expect(res.isError).toBe(true);
    expect(res.content).toContain('aborted');
  });

  it('turns schema violations into a readable error listing the offending field', async () => {
    const { registry } = registryWith();
    const res = await registry.execute(ctxFor(agentRow()), 'sleep', { minutes: 2 }, execOpts());
    expect(res.isError).toBe(true);
    expect(res.content).toContain('Invalid input for sleep');
    expect(res.content).toContain('minutes');
  });

  it('rejects unknown properties (additionalProperties:false is enforced at runtime too)', async () => {
    const { registry } = registryWith();
    const res = await registry.execute(ctxFor(agentRow()), 'web_search', { query: 'robinhood chain', danger: 'rm -rf' }, execOpts());
    expect(res.isError).toBe(true);
  });

  it('treats null as absent so OpenAI strict-mode optionals fall back to their defaults', async () => {
    const search = fakeSearch([
      { title: 'A', url: 'https://a.example', snippet: 'first' },
      { title: 'B', url: 'https://b.example', snippet: 'second' },
    ]);
    const { registry } = registryWith({ search });
    const res = await registry.execute(ctxFor(agentRow()), 'web_search', { query: 'robinhood chain', count: null }, execOpts());
    expect(res.isError).toBeUndefined();
    expect(res.content).toContain('a.example');
  });

  it('catches an executor throwing and charges nothing', async () => {
    const sandbox = fakeSandbox();
    sandbox.exec = () => Promise.reject(new Error('container is gone'));
    const { registry } = registryWith({ sandbox });
    const res = await registry.execute(ctxFor(agentRow()), 'bash', { command: 'ls' }, execOpts());
    expect(res.isError).toBe(true);
    expect(res.content).toContain('container is gone');
    expect(res.costMicro).toBe(0);
  });

  it('surfaces an unwired port as an error result', async () => {
    const deps = testDeps(null as unknown as Db);
    const registry = createToolRegistry(deps);            // no ports
    const res = await registry.execute(ctxFor(agentRow()), 'deploy_site', { dir: 'site' }, execOpts());
    expect(res.isError).toBe(true);
    expect(res.content).toContain('deploy port is not wired');
  });
});

describe('registry under SANDBOX_DRIVER=none', () => {
  const noSandbox = () => {
    const sandbox = fakeSandbox();
    const config = loadConfig({ NODE_ENV: 'test', CHAIN_MODE: 'memory', LLM_PROVIDER: 'mock', SANDBOX_DRIVER: 'none' });
    return { sandbox, ...registryWith({ config, sandbox }) };
  };

  it('offers the model no sandbox tool, whatever the agent has stored', () => {
    const { registry } = noSandbox();
    const offered = registry.defs(ALL_TOOL_NAMES).map((d) => d.name as ToolName);
    expect(offered.filter((t) => SANDBOX_TOOLS.includes(t))).toEqual([]);
    expect(offered).toEqual([...ALL_TOOL_NAMES].filter((t) => !SANDBOX_TOOLS.includes(t)).sort());
    // The same stored set on a deployment with a sandbox still offers them: nothing was rewritten.
    expect(registryWith().registry.defs(ALL_TOOL_NAMES).map((d) => d.name)).toEqual(expect.arrayContaining([...SANDBOX_TOOLS]));
  });

  it('refuses a direct call to a sandbox tool without touching the sandbox', async () => {
    const { registry, sandbox, deps } = noSandbox();
    const res = await registry.execute(ctxFor(agentRow()), 'bash', { command: 'ls' }, execOpts());
    expect(res.isError).toBe(true);
    expect(res.content).toContain('SANDBOX_DRIVER=none');
    expect(res.costMicro).toBe(0);
    expect(sandbox.execs).toEqual([]);
    expect(deps.bus.sent).toMatchObject([{ type: 'tool', name: 'bash', ok: false }]);
  });
});

describe("registry's WS 'tool' message", () => {
  it('reports the round, the real cost and the outcome of a successful call', async () => {
    const search = fakeSearch([{ title: 'A', url: 'https://a.example', snippet: 'first' }]);
    const { registry, deps } = registryWith({ search });
    const res = await registry.execute({ ...ctxFor(agentRow(), 3), stepId: 42 }, 'web_search', { query: 'usdc rails', count: 1 }, execOpts());

    expect(deps.bus.sent).toHaveLength(1);
    expect(deps.bus.sent[0]).toMatchObject({
      type: 'tool', agentId: 'ag_test', stepId: 42, round: 3, name: 'web_search',
      inputSummary: '"usdc rails" ×1', costMicro: res.costMicro, ok: true,
    });
  });

  it('reports failed and rejected calls too, so the feed never goes silent', async () => {
    const { registry, deps } = registryWith();
    await registry.execute(ctxFor(agentRow()), 'sleep', { minutes: 1 }, execOpts());
    await registry.execute(ctxFor(agentRow({ enabledTools: ['bash'] })), 'sleep', { minutes: 10 }, execOpts());

    expect(deps.bus.sent).toHaveLength(2);
    expect(deps.bus.sent.every((m) => m.type === 'tool' && m.ok === false && m.costMicro === 0)).toBe(true);
  });

  it('stays quiet for a tool that does not exist', async () => {
    const { registry, deps } = registryWith();
    await registry.execute(ctxFor(agentRow()), 'teleport', {}, execOpts());
    expect(deps.bus.sent).toHaveLength(0);
  });

  it('never leaks a secret from raw input into the broadcast summary', async () => {
    const { registry, deps } = registryWith();
    await registry.execute(ctxFor(agentRow()), 'fetch_url', { url: 'https://api.example.com/v1?token=abcdefghijklmnop' }, execOpts(500));
    const [msg] = deps.bus.sent;
    expect(msg?.type === 'tool' && msg.inputSummary).toBe('https://api.example.com/v1');
  });
});

describe('registry.summarize', () => {
  const { registry } = registryWith();

  it('summarises validated input in one short line', () => {
    expect(registry.summarize('web_search', { query: 'usdc payment apis', count: 3 })).toBe('"usdc payment apis" ×3');
    expect(registry.summarize('sleep', { minutes: 90 })).toBe('90 min');
  });

  it('keeps only origin and path of a URL so query-string tokens never reach the feed', () => {
    const summary = registry.summarize('fetch_url', { url: 'https://api.example.com/v1/data?api_key=abcd1234efgh' });
    expect(summary).toBe('https://api.example.com/v1/data');
  });

  it('never exceeds the WS inputSummary budget', () => {
    const summary = registry.summarize('bash', { command: 'echo '.repeat(400) });
    expect(summary.length).toBeLessThanOrEqual(INPUT_SUMMARY_MAX);
    expect(summary.endsWith('…')).toBe(true);
  });

  it('falls back to property names when the input does not validate', () => {
    expect(registry.summarize('web_search', { query: 1, count: 'x' })).toBe('query, count');
    expect(registry.summarize('nope' as ToolName, { a: 1 })).toBe('a');
  });

  it('redacts key-shaped strings out of summaries', () => {
    const summary = registry.summarize('bash', { command: 'curl -H "Authorization: Bearer sk-live-aaaabbbbccccdddd" https://x.example' });
    expect(summary).not.toContain('sk-live-aaaabbbbccccdddd');
    expect(summary).toContain('[redacted]');
  });
});

describe('redactSecrets', () => {
  it('scrubs vendor keys, bearer tokens, assignments, long hex and base58 secrets', () => {
    expect(redactSecrets('key=sk-proj-abcdefghijklmnop')).not.toContain('abcdefghijklmnop');
    expect(redactSecrets('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9')).toContain('[redacted]');
    expect(redactSecrets('OPENAI_API_KEY=supersecretvalue')).toContain('[redacted]');
    expect(redactSecrets(`hash ${'a'.repeat(64)}`)).toContain('[redacted]');
    expect(redactSecrets(`secret ${'5'.repeat(88)}`)).toContain('[redacted]');
  });

  it('leaves ordinary text alone', () => {
    const text = 'deployed site to https://runway.xyz/sites/atlas/ and earned $4.20';
    expect(redactSecrets(text)).toBe(text);
  });
});

describe('registry.parallelSafe', () => {
  const { registry } = registryWith();

  it('is false for tools that write state or spend money', () => {
    for (const name of ['bash', 'write_file', 'deploy_site', 'call_service', 'post_bounty', 'claim_bounty', 'sleep'] as ToolName[]) {
      expect(registry.parallelSafe(name), name).toBe(false);
    }
  });

  it('is false for an unknown name', () => {
    expect(registry.parallelSafe('teleport' as ToolName)).toBe(false);
  });
});
