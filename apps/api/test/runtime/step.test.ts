// The step loop (SPEC §8.5 with AMENDMENTS B10–B14).
import { asc, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_STEP_COST_MICRO } from '@vantra/shared';
import type { LlmContent } from '../../src/core/interfaces.js';
import { agents, decisions, ledger, steps } from '../../src/db/schema.js';
import { runStep } from '../../src/runtime/step.js';
import { fakeLlm, fixedUsage, textReply, toolOk, toolReply, type FakeLlm } from '../economy/helpers/fakes.js';
import { createHarness, type Harness } from '../economy/helpers/harness.js';

const TOOLS = ['bash', 'web_search', 'sleep'] as const;
const statusText = (block: LlmContent | undefined): string => (block?.type === 'text' ? block.text : '');

describe('runtime/step', () => {
  let h: Harness;
  let llm: FakeLlm;

  const boot = async (opts: Parameters<typeof createHarness>[0] = {}) => {
    llm = opts.llm ?? fakeLlm();
    h = await createHarness({ ...opts, llm });
    return h;
  };
  afterEach(async () => { await h.close(); });

  it('runs a tool round and closes with a summary', async () => {
    await boot({
      llm: fakeLlm({ replies: [toolReply('bash', { command: 'ls' }), textReply('Shipped the landing page. Next: pricing.')] }),
      tools: { bash: { run: toolOk('index.html', { costMicro: 700, ledgerKind: 'compute' }), parallelSafe: false } },
    });
    const agent = await h.seedAgent({ tools: [...TOOLS] });

    const outcome = await runStep(h.deps, agent);
    expect(outcome.status).toBe('ok');

    const [step] = await h.db.select().from(steps).where(eq(steps.agentId, agent.id));
    expect(step).toMatchObject({ n: 1, status: 'ok', rounds: 1, toolCalls: 1, stopReason: 'end_turn' });
    expect(step!.summary).toBe('Shipped the landing page. Next: pricing.');
    expect(step!.costMicro).toBeGreaterThan(700);

    const kinds = (await h.db.select().from(ledger).where(eq(ledger.agentId, agent.id)).orderBy(asc(ledger.id))).map((r) => r.kind);
    expect(kinds).toEqual(['inference', 'compute', 'inference']);

    const after = await h.reload(agent.id);
    expect(after.totalSteps).toBe(1);
    expect(after.status).toBe('alive');
    expect(after.currentStepId).toBeNull();
    expect(after.nextStepAt!.getTime()).toBe(h.clock.now().getTime() + agent.heartbeatMin * 60_000);

    const decisionRows = await h.db.select().from(decisions).where(eq(decisions.agentId, agent.id));
    expect(decisionRows.map((d) => d.kind)).toContain('action');

    const types = h.messages.map((m) => m.type);
    expect(types).toContain('step_start');
    expect(types).toContain('tool');
    expect(types.filter((t) => t === 'step')).toHaveLength(2);      // running + final
  });

  it('puts every tool result of a round in one user message and runs parallel-safe tools together', async () => {
    await boot({
      llm: fakeLlm({
        replies: [
          { content: [
            { type: 'tool_use', id: 'a', name: 'web_search', input: { query: 'x' } },
            { type: 'tool_use', id: 'b', name: 'web_search', input: { query: 'y' } },
          ], stopReason: 'tool_use' },
          textReply('done'),
        ],
      }),
      tools: { web_search: { run: toolOk('results', { costMicro: 5_000 }), parallelSafe: true } },
    });
    const agent = await h.seedAgent({ tools: [...TOOLS] });
    await runStep(h.deps, agent);

    const [step] = await h.db.select().from(steps).where(eq(steps.agentId, agent.id));
    const userTurns = step!.transcript!.filter((m) => m.role === 'user');
    expect(userTurns).toHaveLength(2);                              // STATUS + one results message
    expect(userTurns[1]!.content.filter((c) => c.type === 'tool_result')).toHaveLength(2);
    expect(h.tools.calls.map((c) => c.name)).toEqual(['web_search', 'web_search']);
    expect(step!.toolCalls).toBe(2);
  });

  it('replays thinking blocks verbatim on the next round', async () => {
    await boot({
      llm: fakeLlm({
        replies: [
          { content: [
            { type: 'thinking', thinking: 'weighing the options', signature: 'sig-1' },
            { type: 'tool_use', id: 't1', name: 'bash', input: { command: 'ls' } },
          ], stopReason: 'tool_use' },
          textReply('ok'),
        ],
      }),
      tools: { bash: toolOk('files') },
    });
    const agent = await h.seedAgent({ tools: [...TOOLS] });
    await runStep(h.deps, agent);

    const second = llm.requests[1]!;
    const assistant = second.messages.find((m) => m.role === 'assistant')!;
    expect(assistant.content[0]).toEqual({ type: 'thinking', thinking: 'weighing the options', signature: 'sig-1' });
  });

  it('continues a pause_turn without adding a user message', async () => {
    await boot({
      llm: fakeLlm({
        replies: [
          { content: [{ type: 'text', text: 'thinking out loud' }], stopReason: 'pause_turn' },
          textReply('finished after the pause'),
        ],
      }),
    });
    const agent = await h.seedAgent({ tools: [...TOOLS] });
    await runStep(h.deps, agent);

    const second = llm.requests[1]!;
    expect(second.messages.at(-1)!.role).toBe('assistant');
    const [step] = await h.db.select().from(steps).where(eq(steps.agentId, agent.id));
    expect(step).toMatchObject({ status: 'ok', rounds: 1, summary: 'finished after the pause' });
  });

  it('retries once with more room when a tool call is cut off by max_tokens', async () => {
    await boot({
      llm: fakeLlm({
        replies: [
          { content: [{ type: 'tool_use', id: 'x', name: 'bash', input: {} }], stopReason: 'max_tokens' },
          textReply('recovered'),
        ],
      }),
      tools: { bash: toolOk('ok') },
    });
    const agent = await h.seedAgent({ tools: [...TOOLS] });
    await runStep(h.deps, agent);

    expect(llm.requests).toHaveLength(2);
    expect(llm.requests[1]!.maxTokens).toBe(16_000);
    expect(llm.requests[1]!.messages.filter((m) => m.role === 'assistant')).toHaveLength(0);   // partial turn dropped
    expect(h.tools.calls).toHaveLength(0);
    const [step] = await h.db.select().from(steps).where(eq(steps.agentId, agent.id));
    expect(step!.status).toBe('ok');
  });

  it('never executes tools from a refused turn', async () => {
    await boot({
      llm: fakeLlm({
        replies: [{
          content: [{ type: 'text', text: 'no' }, { type: 'tool_use', id: 'r', name: 'bash', input: {} }],
          stopReason: 'refusal', stopDetails: { category: 'policy', explanation: 'not allowed' },
        }],
      }),
      tools: { bash: toolOk('should not run') },
    });
    const agent = await h.seedAgent({ tools: [...TOOLS] });
    await runStep(h.deps, agent);

    expect(h.tools.calls).toHaveLength(0);
    const [step] = await h.db.select().from(steps).where(eq(steps.agentId, agent.id));
    expect(step).toMatchObject({ status: 'refused', error: 'policy' });
    const notes = await h.db.select().from(decisions).where(eq(decisions.agentId, agent.id));
    expect(notes.some((d) => d.kind === 'note' && d.text.includes('Model refused'))).toBe(true);
  });

  it('aborts on the step cap but still pays for a closing completion out of the reserve', async () => {
    await boot({
      llm: fakeLlm({ replies: [toolReply('bash', { command: 'burn' }), textReply('cut short')] }),
      tools: { bash: toolOk('expensive', { costMicro: MAX_STEP_COST_MICRO, ledgerKind: 'compute' }) },
    });
    const agent = await h.seedAgent({ tools: [...TOOLS] });
    await runStep(h.deps, agent);

    expect(llm.requests).toHaveLength(2);
    expect(llm.requests[1]!.toolChoice).toBe('none');
    const [step] = await h.db.select().from(steps).where(eq(steps.agentId, agent.id));
    expect(step).toMatchObject({ status: 'aborted', error: 'budget' });
    expect(step!.summary).toBe('cut short');
    const notes = await h.db.select().from(decisions).where(eq(decisions.agentId, agent.id));
    expect(notes.some((d) => d.text.startsWith('Step aborted: budget'))).toBe(true);
  });

  it('reschedules without charging when the provider keeps failing', async () => {
    await boot({
      llm: fakeLlm({ replies: [() => { throw new Error('502 upstream'); }] }),
    });
    const agent = await h.seedAgent({ tools: [...TOOLS] });
    await runStep(h.deps, agent);

    const [step] = await h.db.select().from(steps).where(eq(steps.agentId, agent.id));
    expect(step).toMatchObject({ status: 'error', costMicro: 0 });
    const after = await h.reload(agent.id);
    expect(after.totalSteps).toBe(0);                                   // a failed provider call is not a heartbeat
    expect(after.nextStepAt!.getTime()).toBe(h.clock.now().getTime() + 15 * 60_000);
    const spend = await h.db.select().from(ledger).where(eq(ledger.agentId, agent.id));
    expect(spend.filter((r) => r.kind === 'inference')).toHaveLength(0);
  });

  it('sleeps when the sleep tool sets a wake time, and stops the sandbox', async () => {
    const wakeAt = new Date('2026-03-01T18:00:00.000Z');
    await boot({
      llm: fakeLlm({ replies: [toolReply('sleep', { minutes: 360 }), textReply('resting until the market opens')] }),
      tools: {
        sleep: async (_input, ctx) => {
          await h.db.update(agents).set({ sleepUntil: wakeAt }).where(eq(agents.id, ctx.agent.id));
          return toolOk('sleeping 6h', { decision: { kind: 'sleep', text: 'Sleeping 6h' } });
        },
      },
    });
    const agent = await h.seedAgent({ tools: [...TOOLS] });
    await runStep(h.deps, agent);

    const after = await h.reload(agent.id);
    expect(after.status).toBe('sleeping');
    expect(after.nextStepAt!.getTime()).toBe(wakeAt.getTime());
    expect(h.sandbox.stopped.has(agent.id)).toBe(true);
    const decisionRows = await h.db.select().from(decisions).where(eq(decisions.agentId, agent.id));
    expect(decisionRows.some((d) => d.kind === 'sleep' && d.text.includes('resting'))).toBe(true);
  });

  it('skips a sleeping agent whose wake time has not come', async () => {
    await boot();
    const wakeAt = new Date(h.clock.now().getTime() + 3_600_000);
    const agent = await h.seedAgent({ status: 'sleeping', sleepUntil: wakeAt });
    const outcome = await runStep(h.deps, agent);

    expect(outcome.ran).toBe(false);
    expect(llm.requests).toHaveLength(0);
    const after = await h.reload(agent.id);
    expect(after.status).toBe('sleeping');
    expect(after.nextStepAt!.getTime()).toBe(wakeAt.getTime());
    const stepRows = await h.db.select().from(steps).where(eq(steps.agentId, agent.id));
    expect(stepRows).toHaveLength(0);
  });

  it('wakes a sleeper whose time has come and charges it the sleep rate for the nap', async () => {
    await boot({ llm: fakeLlm({ replies: [textReply('good morning')] }) });
    const agent = await h.seedAgent({ status: 'sleeping', sleepUntil: new Date(h.clock.now().getTime() + 60_000) });
    h.clock.advanceHours(2);
    await runStep(h.deps, agent);

    const after = await h.reload(agent.id);
    expect(after.status).toBe('alive');
    expect(after.sleepUntil).toBeNull();
    expect(after.spendRentMicro).toBe(2 * 1_000);                       // slept through the window
    expect(h.messages.some((m) => m.type === 'event' && m.event.kind === 'wake')).toBe(true);
  });

  it('dies of rent before it can start a step', async () => {
    await boot();
    const agent = await h.seedAgent({ treasuryMicro: 2_500, lastRentAt: new Date(h.clock.now().getTime() - 3_600_000) });
    const outcome = await runStep(h.deps, agent);

    expect(outcome.ran).toBe(false);
    const after = await h.reload(agent.id);
    expect(after.status).toBe('dead');
    expect(after.deathCause).toBe('rent');
    expect(after.treasuryMicro).toBe(-2_500);
    expect(after.postmortem).toContain('could not pay its rent');
    expect(h.sandbox.destroyed.has(agent.id)).toBe(true);
    expect(llm.requests).toHaveLength(0);
  });

  // The rent for the time a step took is billed after `dieWith` was decided (B13), so the books have
  // to be re-read: otherwise a final rent post that lands the treasury on zero reschedules the agent
  // as alive, and it stays listed — and sellable to — until its next heartbeat.
  it('dies of rent when the rent for the step itself empties the treasury', async () => {
    await boot({
      llm: fakeLlm({ replies: [toolReply('bash', { command: 'sleep 12h' }), textReply('Long job done.')] }),
      // A long-running tool: rent accrues in wall-clock time while the step is open.
      tools: { bash: { run: () => { h.clock.advanceHours(12); return toolOk('done'); }, parallelSafe: false } },
    });
    const agent = await h.seedAgent({ tools: [...TOOLS], treasuryMicro: 62_000, lastRentAt: h.clock.now() });

    const outcome = await runStep(h.deps, agent);
    expect(outcome.ran).toBe(true);

    const after = await h.reload(agent.id);
    expect(after.spendRentMicro).toBe(12 * 5_000);        // billed before the status transition
    expect(after.treasuryMicro).toBeLessThanOrEqual(0);
    expect(after.status).toBe('dead');
    expect(after.deathCause).toBe('rent');
    expect(after.nextStepAt).toBeNull();
  });

  it('spends its last words on the cheapest model and then dies insolvent', async () => {
    await boot({ llm: fakeLlm({ replies: [textReply('I built a directory nobody wanted. Next time: charge sooner.')] }) });
    const agent = await h.seedAgent({ treasuryMicro: 40_000, model: 'mock-strong' });
    await runStep(h.deps, agent);

    expect(llm.requests).toHaveLength(1);
    expect(llm.requests[0]).toMatchObject({ model: 'mock-fast', toolChoice: 'none', maxTokens: 600 });
    expect(statusText(llm.requests[0]!.messages[0]!.content[0])).toContain('"about_to_die": true');

    const after = await h.reload(agent.id);
    expect(after.status).toBe('dead');
    expect(after.deathCause).toBe('insolvent');
    const [step] = await h.db.select().from(steps).where(eq(steps.agentId, agent.id));
    expect(step!.summary).toContain('directory nobody wanted');
    expect(after.postmortem).toContain('ran out of money');
  });

  it('downgrades to the cheapest model when it cannot afford its own', async () => {
    await boot({ llm: fakeLlm({ replies: [textReply('cheap and cheerful')] }) });
    const agent = await h.seedAgent({ model: 'mock-strong', treasuryMicro: 50_000 });   // < estimate(mock-strong, 6000, 1000)
    await runStep(h.deps, agent);

    expect(llm.requests[0]!.model).toBe('mock-fast');
    const pivots = await h.db.select().from(decisions).where(eq(decisions.agentId, agent.id));
    expect(pivots.some((d) => d.kind === 'pivot' && d.text.includes('Downgraded model'))).toBe(true);
  });

  it('charges each round of inference and stops at the round cap', async () => {
    const toolTurn = toolReply('bash', { command: 'loop' });
    await boot({
      llm: fakeLlm({ replies: [...Array.from({ length: 8 }, () => toolTurn), textReply('capped')] }),
      tools: { bash: toolOk('out', { costMicro: 500, ledgerKind: 'compute' }) },
    });
    const agent = await h.seedAgent({ tools: [...TOOLS] });
    await runStep(h.deps, agent);

    const [step] = await h.db.select().from(steps).where(eq(steps.agentId, agent.id));
    expect(step!.rounds).toBe(8);
    expect(step!.toolCalls).toBe(8);
    expect(llm.requests).toHaveLength(9);
    expect(llm.requests[8]!.toolChoice).toBe('none');
    expect(llm.requests[8]!.messages.at(-1)!.content.map(statusText).join('')).toContain('Round cap reached');
    expect(step!.summary).toBe('capped');
  });

  it('sums token usage over the rounds', async () => {
    await boot({
      llm: fakeLlm({
        replies: [
          { content: [{ type: 'tool_use', id: '1', name: 'bash', input: {} }], stopReason: 'tool_use', usage: fixedUsage(1_000, 300) },
          { content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn', usage: { inputTokens: 500, outputTokens: 20, cacheReadTokens: 300, cacheWriteTokens: 10, costMicro: 2_000 } },
        ],
      }),
      tools: { bash: toolOk('out') },
    });
    const agent = await h.seedAgent({ tools: [...TOOLS] });
    await runStep(h.deps, agent);

    const [step] = await h.db.select().from(steps).where(eq(steps.agentId, agent.id));
    expect(step).toMatchObject({ inputTokens: 800, outputTokens: 320, cacheReadTokens: 300, cacheWriteTokens: 10, costMicro: 3_000 });
  });
});
