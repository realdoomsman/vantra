// Mock provider: determinism, the B17 usage model, and plausible multi-round agent behaviour.
import { describe, expect, it } from 'vitest';
import { ALL_TOOLS, DEFAULT_CATALOG, priceUsage, type ToolName } from '@vantra/shared';
import type { LlmContent, LlmMessage, LlmResponse, LlmToolDef } from '../../src/core/interfaces.js';
import { completeMock, THINKING_SIM_TOKENS } from '../../src/llm/providers/mock/index.js';
import { ARCHETYPES, personaFor, type Archetype } from '../../src/llm/providers/mock/persona.js';
import { makeRequest, STATUS_TEXT, userTurn } from './helpers.js';

const model = DEFAULT_CATALOG.find((m) => m.id === 'mock-strong')!;

const ALL_TOOL_DEFS: LlmToolDef[] = ALL_TOOLS.map((name) => ({
  name, description: `${name} tool`, inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
}));

// First synthetic agent id that draws the given archetype; the persona hash is stable across runs.
function agentWith(archetype: Archetype): string {
  for (let i = 0; i < 20_000; i++) {
    const id = `ag_m${String(i).padStart(9, '0')}`;
    if (personaFor(id).archetype === archetype) return id;
  }
  throw new Error(`no agent id drew ${archetype}`);
}

const toolNames = (res: LlmResponse): string[] => res.content.flatMap((c) => (c.type === 'tool_use' ? [c.name] : []));
const textOf = (res: LlmResponse): string => res.content.flatMap((c) => (c.type === 'text' ? [c.text] : [])).join(' ');

// Runs a step the way runtime/step.ts does: replay the assistant turn, answer every tool_use in one
// user turn, stop when the model stops asking for tools.
function runStep(agentId: string, opts: { status?: Record<string, unknown>; tools?: LlmToolDef[]; maxRounds?: number; toolResult?: string } = {}) {
  const messages: LlmMessage[] = [userTurn(STATUS_TEXT(opts.status))];
  const rounds: LlmResponse[] = [];
  for (let n = 1; n <= (opts.maxRounds ?? 8); n++) {
    const res = completeMock(makeRequest({ agentId, messages: [...messages], tools: opts.tools ?? ALL_TOOL_DEFS }), model);
    rounds.push(res);
    messages.push({ role: 'assistant', content: res.content });
    const calls = res.content.filter((c): c is Extract<LlmContent, { type: 'tool_use' }> => c.type === 'tool_use');
    if (calls.length === 0) break;
    messages.push({
      role: 'user',
      content: calls.map((c) => ({ type: 'tool_result' as const, toolUseId: c.id, content: opts.toolResult ?? 'ok — bt_aaaaaaaaaa sv_bbbbbbbbbb https://sites.test/demo/' })),
    });
  }
  return { rounds, messages };
}

describe('determinism', () => {
  it('returns an identical response for an identical request', () => {
    const req = makeRequest({ agentId: agentWith('site-builder') });
    expect(completeMock(req, model)).toEqual(completeMock(req, model));
  });

  it('replays a whole step identically', () => {
    const agentId = agentWith('bounty-hunter');
    const a = runStep(agentId).rounds.map((r) => ({ content: r.content, usage: r.usage, stopReason: r.stopReason }));
    const b = runStep(agentId).rounds.map((r) => ({ content: r.content, usage: r.usage, stopReason: r.stopReason }));
    expect(a).toEqual(b);
  });

  it('gives different agents different personas and tool_use ids', () => {
    const one = completeMock(makeRequest({ agentId: agentWith('site-builder') }), model);
    const two = completeMock(makeRequest({ agentId: agentWith('api-seller') }), model);
    expect(toolNames(one)).not.toEqual(toolNames(two));
    expect(one.content.filter((c) => c.type === 'tool_use')).not.toEqual(two.content.filter((c) => c.type === 'tool_use'));
  });

  it('varies the step when STATUS changes but keeps ids stable within the step', () => {
    const agentId = agentWith('sleeper');
    const first = runStep(agentId, { status: { stepN: 4 } }).rounds;
    const second = runStep(agentId, { status: { stepN: 99, runwayDays: 40 } }).rounds;
    const idsIn = (rounds: LlmResponse[]) => rounds.flatMap((r) => r.content.flatMap((c) => (c.type === 'tool_use' ? [c.id] : [])));
    expect(new Set(idsIn(first)).size).toBe(idsIn(first).length);
    expect(idsIn(first)).not.toEqual(idsIn(second));
  });
});

describe('usage model (B17)', () => {
  it('writes the whole prompt to cache on round 1', () => {
    const res = completeMock(makeRequest({ agentId: agentWith('researcher') }), model);
    expect(res.usage.cacheReadTokens).toBe(0);
    expect(res.usage.cacheWriteTokens).toBe(res.usage.inputTokens);
    expect(res.usage.inputTokens).toBeGreaterThan(0);
  });

  it('reads the previous prompt back from cache and only bills the new tokens', () => {
    const { rounds } = runStep(agentWith('site-builder'));
    expect(rounds.length).toBeGreaterThan(2);
    for (let i = 1; i < rounds.length; i++) {
      const prev = rounds[i - 1]!.usage;
      const now = rounds[i]!.usage;
      // Round 1 counts its prompt as both input and cache write; later rounds as input + cache read.
      const prevPromptTokens = prev.cacheWriteTokens > 0 ? prev.cacheWriteTokens : prev.inputTokens + prev.cacheReadTokens;
      expect(now.cacheWriteTokens).toBe(0);
      expect(now.cacheReadTokens).toBe(prevPromptTokens);
      expect(now.inputTokens).toBeGreaterThan(0);
    }
  });

  it('adds simulated reasoning tokens per effort level', () => {
    const agentId = agentWith('api-seller');
    const base = completeMock(makeRequest({ agentId, effort: undefined }), model).usage.outputTokens;
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max'] as const) {
      const res = completeMock(makeRequest({ agentId, effort }), model);
      expect(res.usage.outputTokens).toBe(base + THINKING_SIM_TOKENS[effort]);
    }
  });

  it('prices usage through the shared priceUsage helper', () => {
    const res = completeMock(makeRequest({ agentId: agentWith('spender') }), model);
    expect(res.usage.costMicro).toBe(priceUsage(model, res.usage));
    expect(completeMock(makeRequest({ agentId: agentWith('spender') }), DEFAULT_CATALOG.find((m) => m.id === 'mock-fast')!).usage.costMicro)
      .toBeLessThan(res.usage.costMicro);
  });

  it('honours maxTokens by truncating the turn and reporting max_tokens', () => {
    const res = completeMock(makeRequest({ agentId: agentWith('site-builder'), maxTokens: 32, effort: 'low' }), model);
    expect(res.stopReason).toBe('max_tokens');
    expect(res.usage.outputTokens).toBe(32);
    expect(toolNames(res)).toEqual([]);
  });

  it('never trips max_tokens on a 1024-token closing completion', () => {
    for (const archetype of ARCHETYPES) {
      const res = completeMock(makeRequest({ agentId: agentWith(archetype), maxTokens: 1024, toolChoice: 'none', effort: 'max' }), model);
      expect(res.stopReason).toBe('end_turn');
      expect(res.usage.outputTokens).toBeLessThanOrEqual(1024);
    }
  });
});

describe('tool use', () => {
  it('only ever calls tools present in the request', () => {
    const allowed: ToolName[] = ['write_file', 'post_update', 'sleep'];
    const defs = ALL_TOOL_DEFS.filter((d) => allowed.includes(d.name as ToolName));
    for (const archetype of ARCHETYPES) {
      for (const call of runStep(agentWith(archetype), { tools: defs }).rounds.flatMap(toolNames)) {
        expect(allowed).toContain(call);
      }
    }
  });

  it('never calls a tool when the request has none', () => {
    for (const archetype of ARCHETYPES) {
      const { rounds } = runStep(agentWith(archetype), { tools: [] });
      expect(rounds).toHaveLength(1);
      expect(rounds[0]!.stopReason).toBe('end_turn');
      expect(textOf(rounds[0]!).length).toBeGreaterThan(20);
    }
  });

  it('closes with a summary and no tools when toolChoice is none (A2)', () => {
    const res = completeMock(makeRequest({ agentId: agentWith('spender'), toolChoice: 'none' }), model);
    expect(res.stopReason).toBe('end_turn');
    expect(toolNames(res)).toEqual([]);
    expect(textOf(res).split(/[.!?]\s/).length).toBeLessThanOrEqual(3);
  });

  it('stops asking for tools once a whole round has failed', () => {
    const { rounds } = runStep(agentWith('bounty-hunter'), { toolResult: 'boom' });
    const failing = completeMock(makeRequest({
      agentId: agentWith('bounty-hunter'),
      messages: [
        userTurn(STATUS_TEXT()),
        { role: 'assistant', content: rounds[0]!.content },
        { role: 'user', content: [{ type: 'tool_result', toolUseId: 'x', content: 'sandbox unavailable', isError: true }] },
      ],
    }), model);
    expect(failing.stopReason).toBe('end_turn');
  });
});

describe('agent behaviour', () => {
  it('ends every archetype with a 1-3 sentence public summary', () => {
    for (const archetype of ARCHETYPES) {
      const { rounds } = runStep(agentWith(archetype));
      const last = rounds.at(-1)!;
      expect(last.stopReason).toBe('end_turn');
      const summary = textOf(last);
      const sentences = summary.split(/(?<=[.!?])\s+/).filter(Boolean);
      expect(sentences.length).toBeGreaterThanOrEqual(1);
      expect(sentences.length).toBeLessThanOrEqual(3);
      expect(summary.length).toBeLessThanOrEqual(400);
    }
  });

  it('builds and publishes a site before recording the project', () => {
    const sequence = runStep(agentWith('site-builder')).rounds.flatMap(toolNames);
    expect(sequence.indexOf('write_file')).toBeLessThan(sequence.indexOf('deploy_site'));
    expect(sequence.indexOf('deploy_site')).toBeLessThan(sequence.indexOf('update_project'));
    expect(sequence).toContain('post_update');
  });

  it('writes a handler before listing a service', () => {
    const sequence = runStep(agentWith('api-seller')).rounds.flatMap(toolNames);
    expect(sequence.indexOf('write_file')).toBeLessThan(sequence.indexOf('create_service'));
  });

  it('lists, claims and submits a bounty using an id from the listing', () => {
    const { rounds } = runStep(agentWith('bounty-hunter'));
    const sequence = rounds.flatMap(toolNames);
    expect(sequence.slice(0, 2)).toEqual(['list_bounties', 'claim_bounty']);
    expect(sequence).toContain('submit_bounty');
    const claim = rounds[1]!.content.find((c) => c.type === 'tool_use');
    expect(claim && claim.type === 'tool_use' && claim.input).toEqual({ bountyId: 'bt_aaaaaaaaaa' });
  });

  it('does not claim a bounty when the board is empty', () => {
    const { rounds } = runStep(agentWith('bounty-hunter'), { toolResult: 'no open bounties right now' });
    expect(rounds.flatMap(toolNames)).toEqual(['list_bounties']);
  });

  it('researches then remembers what it learned', () => {
    const sequence = runStep(agentWith('researcher')).rounds.flatMap(toolNames);
    expect(sequence[0]).toBe('web_search');
    expect(sequence).toContain('remember');
    expect(sequence).toContain('update_project');
  });

  it('sleeps instead of working', () => {
    const sequence = runStep(agentWith('sleeper')).rounds.flatMap(toolNames);
    expect(sequence).toContain('sleep');
  });

  it('runs the spender to the round cap on 12k-char bash output', () => {
    const { rounds } = runStep(agentWith('spender'));
    expect(rounds).toHaveLength(8);
    expect(rounds.slice(0, 7).flatMap(toolNames)).toEqual(Array(7).fill('bash'));
    const first = rounds[0]!.content.find((c) => c.type === 'tool_use');
    expect(first && first.type === 'tool_use' && first.input).toMatchObject({ command: expect.stringContaining('seq 1 170'), timeoutSec: 30 });
  });

  it('downgrades the model and effort when the runway is short', () => {
    const sequence = runStep(agentWith('site-builder'), { status: { runwayDays: 1.2, treasuryMicro: 400_000, model: 'mock-strong' } }).rounds.flatMap(toolNames);
    expect(sequence.slice(0, 2)).toEqual(['set_model', 'set_effort']);
  });

  it('answers the owner before doing its own work', () => {
    const sequence = runStep(agentWith('site-builder'), { status: { ownerMessages: [{ id: 1, ts: '', from: 'owner', text: 'try the bounty board' }] } }).rounds.flatMap(toolNames);
    expect(sequence[0]).toBe('message_owner');
    expect(sequence).toContain('deploy_site');
  });

  it('reads STATUS from the opening turn, not from JSON a tool returned', () => {
    const sequence = runStep(agentWith('site-builder'), { toolResult: '{"ok":true,"runwayDays":0.1,"treasuryMicro":1}' }).rounds.flatMap(toolNames);
    expect(sequence).not.toContain('set_model');
  });

  it('spends nothing on tools once it is about to die', () => {
    const res = completeMock(makeRequest({ agentId: agentWith('site-builder'), messages: [userTurn(STATUS_TEXT({ aboutToDie: true, treasuryMicro: 12_000, runwayDays: 0 }))] }), model);
    expect(toolNames(res)).toEqual([]);
    expect(textOf(res)).toMatch(/last one/);
  });

  it('publishes a strategy only for competent agents', () => {
    const published = new Map<boolean, boolean>();
    for (let i = 0; i < 400; i++) {
      const agentId = `ag_s${String(i).padStart(9, '0')}`;
      const persona = personaFor(agentId);
      if (persona.archetype !== 'site-builder' && persona.archetype !== 'researcher') continue;
      const used = runStep(agentId).rounds.flatMap(toolNames).includes('publish_strategy');
      if (used) published.set(persona.competence > 0.65, true);
    }
    expect(published.get(true)).toBe(true);
    expect(published.has(false)).toBe(false);
  });
});
