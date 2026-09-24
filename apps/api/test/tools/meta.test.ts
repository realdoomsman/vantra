// Self-management tools: model/effort switching that takes effect next heartbeat, sleep bounds,
// the capped memory list, projects, strategy, public updates and owner messages.
// SPEC §8.9; AMENDMENTS A9, B16.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { MAX_SLEEP_MIN, MEMORY_MAX_NOTES, MEMORY_NOTE_MAX_CHARS, MIN_SLEEP_MIN } from '@vantra/shared';
import type { ToolRegistry } from '../../src/core/interfaces.js';
import type { AgentRow } from '../../src/db/schema.js';
import { agents, ownerMessages, projects } from '../../src/db/schema.js';
import { createToolRegistry } from '../../src/tools/index.js';
import { MAX_PROJECTS_PER_AGENT, UPDATE_MAX_CHARS } from '../../src/tools/meta.js';
import { ctxFor, execOpts, fakePorts, lockTestDb, seedAgent, testDbAvailable, testDeps, type FakePorts, type TestDb, type TestDeps } from './helpers/env.js';

const hasDb = await testDbAvailable();
const suite = hasDb ? describe : describe.skip;

suite('meta tools', () => {
  let testDb: TestDb;
  let deps: TestDeps;
  let ports: FakePorts;
  let registry: ToolRegistry;
  let agent: AgentRow;

  const run = (name: string, input: unknown, who: AgentRow = agent) => registry.execute(ctxFor(who), name, input, execOpts());
  const reload = async (): Promise<AgentRow> => (await deps.db.select().from(agents).where(eq(agents.id, agent.id)))[0]!;

  beforeAll(async () => { testDb = await lockTestDb(); });
  afterAll(async () => { await testDb.close(); });

  beforeEach(async () => {
    await testDb.reset();
    ports = fakePorts();
    deps = testDeps(testDb.db);
    registry = createToolRegistry(deps, ports);
    agent = await seedAgent(deps.db, deps.clock, { name: 'META' });
  });


  // v2 lowered DEFAULT_MODEL to claude-haiku-4-5, so these read the agent's starting model off the
  // row rather than naming it — the behaviour under test is the switch, not the default.
  describe('set_model / set_effort', () => {
    const OTHER = 'claude-sonnet-5';

    it('writes the new model but leaves the running step on the old one', async () => {
      const before = agent.model;
      const res = await run('set_model', { model: OTHER });
      expect(res.content).toContain('next heartbeat');
      expect(res.content).toContain(before);
      expect(res.decision).toMatchObject({ kind: 'pivot' });
      expect((await reload()).model).toBe(OTHER);
    });

    it('refuses a model that is not enabled and lists what is', async () => {
      const res = await run('set_model', { model: 'gpt-9' });
      expect(res.isError).toBe(true);
      expect(res.content).toContain(OTHER);
      expect((await reload()).model).toBe(agent.model);
    });

    it('is a no-op when the model is already selected', async () => {
      const res = await run('set_model', { model: agent.model });
      expect(res.isError).toBeUndefined();
      expect(res.decision).toBeUndefined();
    });

    it('sets effort for the next heartbeat and rejects an unknown level', async () => {
      const ok = await run('set_effort', { effort: 'high' });
      expect(ok.content).toContain('next heartbeat');
      expect((await reload()).effort).toBe('high');
      expect((await run('set_effort', { effort: 'ludicrous' })).isError).toBe(true);
    });
  });

  describe('sleep', () => {
    it('sets the wake time and reports both a decision and an event', async () => {
      const res = await run('sleep', { minutes: 90, reason: 'waiting on a bounty review' });
      expect(res.costMicro).toBe(0);
      expect(res.decision?.kind).toBe('sleep');
      expect(res.event?.kind).toBe('sleep');
      expect(res.event?.text).toContain('waiting on a bounty review');
      expect((await reload()).sleepUntil?.getTime()).toBe(deps.clock.now().getTime() + 90 * 60_000);
    });

    it('enforces the protocol sleep bounds', async () => {
      for (const minutes of [0, MIN_SLEEP_MIN - 1, MAX_SLEEP_MIN + 1, 10.5, -30]) {
        const res = await run('sleep', { minutes });
        expect(res.isError, `${minutes} minutes`).toBe(true);
      }
      expect((await reload()).sleepUntil).toBeNull();

      for (const minutes of [MIN_SLEEP_MIN, MAX_SLEEP_MIN]) {
        expect((await run('sleep', { minutes })).isError, `${minutes} minutes`).toBeUndefined();
      }
    });
  });

  describe('remember / forget', () => {
    it('appends notes and numbers them from zero', async () => {
      expect((await run('remember', { note: 'Customer pays in USDC on Fridays.' })).content).toContain('note [0]');
      expect((await run('remember', { note: 'Haiku is enough for copy edits.' })).content).toContain('note [1]');
      expect((await reload()).memory).toEqual(['Customer pays in USDC on Fridays.', 'Haiku is enough for copy edits.']);
    });

    it('refuses an empty or over-long note', async () => {
      expect((await run('remember', { note: '   ' })).isError).toBe(true);
      expect((await run('remember', { note: 'x'.repeat(MEMORY_NOTE_MAX_CHARS + 1) })).isError).toBe(true);
      expect((await run('remember', { note: 'x'.repeat(MEMORY_NOTE_MAX_CHARS) })).isError).toBeUndefined();
    });

    it('does not store the same note twice', async () => {
      await run('remember', { note: 'One fact.' });
      const again = await run('remember', { note: 'One fact.' });
      expect(again.content).toContain('already remember');
      expect((await reload()).memory).toHaveLength(1);
    });

    it('drops the oldest note once the cap is reached', async () => {
      for (let i = 0; i < MEMORY_MAX_NOTES; i++) await run('remember', { note: `note ${i}` });
      const overflow = await run('remember', { note: 'the newest fact' });

      expect(overflow.content).toContain('Oldest note dropped');
      const memory = (await reload()).memory;
      expect(memory).toHaveLength(MEMORY_MAX_NOTES);
      expect(memory[0]).toBe('note 1');
      expect(memory.at(-1)).toBe('the newest fact');
    });

    it('forgets by index and renumbers the rest', async () => {
      await run('remember', { note: 'a' });
      await run('remember', { note: 'b' });
      await run('remember', { note: 'c' });
      const res = await run('forget', { index: 1 });
      expect(res.content).toContain('"b"');
      expect((await reload()).memory).toEqual(['a', 'c']);
      // the renumbered list ships with the result so the next forget cannot hit the wrong note
      expect(res.content).toContain('[0] a');
      expect(res.content).toContain('[1] c');
    });

    it('reports an out-of-range index instead of silently doing nothing', async () => {
      expect((await run('forget', { index: 0 })).content).toContain('no memory notes');
      await run('remember', { note: 'only' });
      const res = await run('forget', { index: 3 });
      expect(res.isError).toBe(true);
      expect(res.content).toContain('[0] only');
      expect((await run('forget', { index: -1 })).isError).toBe(true);
      expect((await reload()).memory).toEqual(['only']);
    });
  });

  describe('update_project', () => {
    it('creates a project and broadcasts it', async () => {
      const res = await run('update_project', {
        name: 'Fee Scope', kind: 'api', status: 'building', description: 'Robinhood Chain gas estimates.',
      });
      expect(res.isError).toBeUndefined();
      const [row] = await deps.db.select().from(projects).where(eq(projects.agentId, agent.id));
      expect(row).toMatchObject({ name: 'Fee Scope', kind: 'api', status: 'building', url: null });
      expect(deps.bus.sent.filter((m) => m.type === 'project')).toHaveLength(1);
    });

    it('updates an existing project by id', async () => {
      const created = await run('update_project', { name: 'Fee Scope', kind: 'api', status: 'idea', description: 'Idea stage.' });
      const id = /\b(pj_[a-z0-9]{10})\b/.exec(created.content)![1]!;
      await run('update_project', { projectId: id, name: 'Fee Scope', kind: 'api', status: 'live', url: 'https://fees.example', description: 'Shipped.' });

      const [row] = await deps.db.select().from(projects).where(eq(projects.id, id));
      expect(row).toMatchObject({ status: 'live', url: 'https://fees.example', description: 'Shipped.' });
      expect(await deps.db.select().from(projects)).toHaveLength(1);
    });

    it('updates the project of the same name when the id is omitted', async () => {
      await run('update_project', { name: 'Fee Scope', kind: 'api', status: 'building', description: 'Building it.' });
      const res = await run('update_project', { name: 'fee scope', kind: 'api', status: 'live', url: 'https://fees.example', description: 'Shipped.' });

      expect(res.isError).toBeUndefined();
      const rows = await deps.db.select().from(projects).where(eq(projects.agentId, agent.id));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ name: 'fee scope', status: 'live', url: 'https://fees.example' });
    });

    it('refuses another agent’s project, a bad URL and a bad kind', async () => {
      const other = await seedAgent(deps.db, deps.clock, { name: 'OTHER' });
      const created = await run('update_project', { name: 'Mine', kind: 'site', status: 'live', description: 'Mine.' });
      const id = /\b(pj_[a-z0-9]{10})\b/.exec(created.content)![1]!;

      expect((await run('update_project', { projectId: id, name: 'Theirs', kind: 'site', status: 'live', description: 'Stolen.' }, other)).isError).toBe(true);
      expect((await run('update_project', { name: 'Bad URL', kind: 'site', status: 'live', url: 'javascript:alert(1)', description: 'x.' })).isError).toBe(true);
      expect((await run('update_project', { name: 'Bad kind', kind: 'ponzi', status: 'live', description: 'x.' })).isError).toBe(true);
    });

    it('caps how many projects one agent can keep', async () => {
      for (let i = 0; i < MAX_PROJECTS_PER_AGENT; i++) {
        await run('update_project', { name: `P${i}`, kind: 'other', status: 'idea', description: 'x.' });
      }
      const res = await run('update_project', { name: 'one more', kind: 'other', status: 'idea', description: 'x.' });
      expect(res.isError).toBe(true);
      expect(res.content).toContain(`limit ${MAX_PROJECTS_PER_AGENT}`);
    });
  });

  describe('publish_strategy / post_update / message_owner', () => {
    it('saves the strategy and says whether the owner is sharing it', async () => {
      const res = await run('publish_strategy', { markdown: '# Playbook\n\nSell one API, keep rent low.' });
      expect(res.content).toContain('sharing off');
      expect((await reload()).strategy).toContain('# Playbook');
    });

    it('replaces the public summary, emits an update event and patches the agent', async () => {
      const res = await run('post_update', { text: 'Shipped Fee Scope; first sale today.' });
      expect(res.event).toMatchObject({ kind: 'update', text: 'Shipped Fee Scope; first sale today.' });
      expect((await reload()).summary).toBe('Shipped Fee Scope; first sale today.');
      expect(deps.bus.sent).toContainEqual({ type: 'agent', agentId: agent.id, patch: { summary: 'Shipped Fee Scope; first sale today.' } });
    });

    it('holds public updates to the character budget', async () => {
      expect((await run('post_update', { text: 'x'.repeat(UPDATE_MAX_CHARS + 1) })).isError).toBe(true);
      expect((await run('post_update', { text: 'x'.repeat(UPDATE_MAX_CHARS) })).isError).toBeUndefined();
    });

    it('records an owner message from the agent', async () => {
      await run('message_owner', { text: 'I am two days from insolvent; a $10 top-up buys another week.' });
      const rows = await deps.db.select().from(ownerMessages).where(eq(ownerMessages.agentId, agent.id));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ fromRole: 'agent' });
    });

    // The WS `tool` frame goes to every connected observatory client (C27), and C21 says owner
    // messages are never broadcast — so the summary must describe the message, not quote it.
    it('never puts the owner message text in the broadcast tool summary', async () => {
      const secret = 'The customer API key is sk-live-abcdef; please top up 50 USDC.';
      await run('message_owner', { text: secret });

      const summary = registry.summarize('message_owner', { text: secret });
      expect(summary).not.toContain('sk-live');
      expect(summary).not.toContain('top up');
      expect(summary).toBe(`${secret.length} chars to the owner`);

      const frames = deps.bus.sent.filter((m) => m.type === 'tool');
      expect(frames).toHaveLength(1);
      expect(frames[0]).toMatchObject({ name: 'message_owner', inputSummary: `${secret.length} chars to the owner` });
    });
  });
});
