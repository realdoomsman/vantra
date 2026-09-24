// The bounty state machine end to end against a real Postgres schema: escrow on posting, one live
// claim per agent, the 48h claim window, resubmit-once, and the escrow payout on approval. SPEC §8.9.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { ToolRegistry } from '../../src/core/interfaces.js';
import type { AgentRow } from '../../src/db/schema.js';
import { bounties } from '../../src/db/schema.js';
import { BOUNTY_CLAIM_WINDOW_MS, createToolRegistry } from '../../src/tools/index.js';
import { ctxFor, execOpts, fakePorts, lockTestDb, seedAgent, testDbAvailable, testDeps, type FakePorts, type TestDb, type TestDeps } from './helpers/env.js';

const hasDb = await testDbAvailable();
const suite = hasDb ? describe : describe.skip;

suite('bounty tools', () => {
  let testDb: TestDb;
  let deps: TestDeps;
  let ports: FakePorts;
  let registry: ToolRegistry;
  let poster: AgentRow;
  let worker: AgentRow;

  const run = (agent: AgentRow, name: string, input: unknown) => registry.execute(ctxFor(agent), name, input, execOpts());
  const row = async (id: string) => (await deps.db.select().from(bounties).where(eq(bounties.id, id)).limit(1))[0]!;
  const idOf = (content: string) => /\b(bt_[a-z0-9]{10})\b/.exec(content)?.[1] ?? '';

  async function postOpenBounty(rewardUsd = 2, deadlineHours = 72): Promise<string> {
    const res = await run(poster, 'post_bounty', {
      title: 'Write launch copy', description: 'Three paragraphs of landing page copy for a JSON API.',
      rewardUsd, deadlineHours,
    });
    expect(res.isError).toBeUndefined();
    return idOf(res.content);
  }

  beforeAll(async () => { testDb = await lockTestDb(); });
  afterAll(async () => { await testDb.close(); });

  beforeEach(async () => {
    await testDb.reset();
    ports = fakePorts();
    deps = testDeps(testDb.db);
    registry = createToolRegistry(deps, ports);
    poster = await seedAgent(deps.db, deps.clock, { name: 'POSTER', treasuryMicro: 20_000_000 });
    worker = await seedAgent(deps.db, deps.clock, { name: 'WORKER', treasuryMicro: 5_000_000 });
  });


  describe('post_bounty', () => {
    it('escrows the reward and opens the bounty', async () => {
      const res = await run(poster, 'post_bounty', {
        title: 'Summarise Robinhood Chain fee docs', description: 'One page of notes with the current priority fee model.',
        rewardUsd: 1.5, deadlineHours: 24,
      });

      expect(res.costMicro).toBe(1_500_000);
      expect(res.ledgerKind).toBe('escrow_out');
      expect(ports.payments.transfers).toEqual([
        { agentId: poster.id, to: 'ESCROW_WALLET', amountMicro: 1_500_000, memo: expect.stringContaining('bounty escrow') },
      ]);

      const saved = await row(idOf(res.content));
      expect(saved.status).toBe('open');
      expect(saved.posterType).toBe('agent');
      expect(saved.posterId).toBe(poster.id);
      expect(saved.rewardMicro).toBe(1_500_000);
      expect(saved.escrowTx).toBe('sig_pay_1');
      expect(saved.deadlineAt.getTime()).toBe(deps.clock.now().getTime() + 24 * 3_600_000);
      expect(res.event).toMatchObject({ kind: 'bounty', amountMicro: 1_500_000 });
    });

    it('refuses a reward the treasury cannot cover and moves no money', async () => {
      const res = await run(worker, 'post_bounty', {
        title: 'Expensive job', description: 'Something far beyond what this agent can afford to escrow.',
        rewardUsd: 50, deadlineHours: 24,
      });
      expect(res.isError).toBe(true);
      expect(res.costMicro).toBe(0);
      expect(ports.payments.transfers).toHaveLength(0);
      expect(await deps.db.select().from(bounties)).toHaveLength(0);
    });

    it('rejects a reward below the floor and a deadline out of range', async () => {
      const cheap = await run(poster, 'post_bounty', { title: 'Tiny job', description: 'A very small job description here.', rewardUsd: 0.01, deadlineHours: 24 });
      const long = await run(poster, 'post_bounty', { title: 'Long job', description: 'A very long job description here.', rewardUsd: 1, deadlineHours: 400 });
      expect(cheap.isError).toBe(true);
      expect(long.isError).toBe(true);
    });
  });

  describe('claim_bounty', () => {
    it('reserves the bounty and emits a hire event naming both agents', async () => {
      const id = await postOpenBounty();
      const res = await run(worker, 'claim_bounty', { bountyId: id });

      expect(res.isError).toBeUndefined();
      expect(res.event?.kind).toBe('hire');
      expect(res.event?.text).toContain('POSTER hired WORKER');
      const saved = await row(id);
      expect(saved.status).toBe('claimed');
      expect(saved.claimerAgentId).toBe(worker.id);
      expect(saved.claimedAt?.getTime()).toBe(deps.clock.now().getTime());
    });

    it('allows only one live claim per agent', async () => {
      const first = await postOpenBounty();
      const second = await postOpenBounty();
      await run(worker, 'claim_bounty', { bountyId: first });
      const res = await run(worker, 'claim_bounty', { bountyId: second });

      expect(res.isError).toBe(true);
      expect(res.content).toContain('already hold a claim');
      expect((await row(second)).status).toBe('open');
    });

    it('refuses a bounty that is already claimed, past its deadline, or the agent’s own', async () => {
      const taken = await postOpenBounty();
      await run(worker, 'claim_bounty', { bountyId: taken });
      const other = await seedAgent(deps.db, deps.clock, { name: 'RIVAL' });
      expect((await run(other, 'claim_bounty', { bountyId: taken })).content).toContain('is claimed');

      const own = await postOpenBounty();
      expect((await run(poster, 'claim_bounty', { bountyId: own })).content).toContain('your own bounty');

      const expiring = await postOpenBounty(1, 1);
      deps.clock.advance(2 * 3_600_000);
      expect((await run(other, 'claim_bounty', { bountyId: expiring })).content).toContain('closed at');
    });

    it('reports a missing bounty rather than throwing', async () => {
      const res = await run(worker, 'claim_bounty', { bountyId: 'bt_doesnotex1' });
      expect(res.isError).toBe(true);
      expect(res.content).toContain('No bounty');
    });
  });

  describe('submit_bounty', () => {
    it('moves a claimed bounty to submitted', async () => {
      const id = await postOpenBounty();
      await run(worker, 'claim_bounty', { bountyId: id });
      const res = await run(worker, 'submit_bounty', { bountyId: id, submission: 'Here is the copy: ...' });

      expect(res.isError).toBeUndefined();
      const saved = await row(id);
      expect(saved.status).toBe('submitted');
      expect(saved.submission).toBe('Here is the copy: ...');
    });

    it('refuses an agent that did not claim it', async () => {
      const id = await postOpenBounty();
      await run(worker, 'claim_bounty', { bountyId: id });
      const other = await seedAgent(deps.db, deps.clock, { name: 'RIVAL' });
      const res = await run(other, 'submit_bounty', { bountyId: id, submission: 'mine now' });
      expect(res.isError).toBe(true);
      expect(res.content).toContain('have not claimed');
    });

    it('refuses once the 48h claim window has passed, even with a later poster deadline', async () => {
      const id = await postOpenBounty(2, 336);
      await run(worker, 'claim_bounty', { bountyId: id });
      deps.clock.advance(BOUNTY_CLAIM_WINDOW_MS + 60_000);
      const res = await run(worker, 'submit_bounty', { bountyId: id, submission: 'late' });
      expect(res.isError).toBe(true);
      expect(res.content).toContain('lapsed');
      expect((await row(id)).status).toBe('claimed');
    });

    it('refuses once the poster deadline has passed, even inside the 48h window', async () => {
      const id = await postOpenBounty(2, 2);
      await run(worker, 'claim_bounty', { bountyId: id });
      deps.clock.advance(3 * 3_600_000);
      expect((await run(worker, 'submit_bounty', { bountyId: id, submission: 'late' })).isError).toBe(true);
    });
  });

  describe('review_submission', () => {
    async function submitted(rewardUsd = 2): Promise<string> {
      const id = await postOpenBounty(rewardUsd);
      await run(worker, 'claim_bounty', { bountyId: id });
      await run(worker, 'submit_bounty', { bountyId: id, submission: 'the work' });
      return id;
    }

    it('pays the claimer out of escrow on approval', async () => {
      const id = await submitted(2);
      const res = await run(poster, 'review_submission', { bountyId: id, approve: true, feedback: 'Good work.' });

      expect(res.isError).toBeUndefined();
      expect(res.costMicro).toBe(0);                                   // the reward left the treasury at post_bounty
      expect(ports.escrow.payouts).toEqual([{ to: worker.walletPubkey, amountMicro: 2_000_000, memo: expect.stringContaining(id) }]);
      const saved = await row(id);
      expect(saved.status).toBe('paid');
      expect(saved.paidAt).not.toBeNull();
      expect(res.event).toMatchObject({ kind: 'bounty', amountMicro: 2_000_000 });
      expect(res.decision?.kind).toBe('hire');
    });

    it('lets the claimer resubmit after the first rejection', async () => {
      const id = await submitted();
      const rejected = await run(poster, 'review_submission', { bountyId: id, approve: false, feedback: 'Needs the pricing section.' });
      expect(rejected.isError).toBeUndefined();

      const afterReject = await row(id);
      expect(afterReject.status).toBe('rejected');
      expect(afterReject.rejections).toBe(1);
      expect(afterReject.claimerAgentId).toBe(worker.id);
      expect(afterReject.feedback).toBe('Needs the pricing section.');

      const resubmit = await run(worker, 'submit_bounty', { bountyId: id, submission: 'v2 with pricing' });
      expect(resubmit.isError).toBeUndefined();
      expect((await row(id)).status).toBe('submitted');
    });

    it('releases the bounty back to the board on the second rejection', async () => {
      const id = await submitted();
      await run(poster, 'review_submission', { bountyId: id, approve: false, feedback: 'v1 no' });
      await run(worker, 'submit_bounty', { bountyId: id, submission: 'v2' });
      const res = await run(poster, 'review_submission', { bountyId: id, approve: false, feedback: 'v2 no' });

      expect(res.content).toContain('open again');
      const saved = await row(id);
      expect(saved.status).toBe('open');
      expect(saved.claimerAgentId).toBeNull();
      expect(saved.submission).toBeNull();
      expect(saved.claimedAt).toBeNull();
      expect(saved.rejections).toBe(2);
      expect(ports.escrow.payouts).toHaveLength(0);

      // the released bounty frees the worker's claim slot and can be taken again
      const other = await seedAgent(deps.db, deps.clock, { name: 'RIVAL' });
      expect((await run(other, 'claim_bounty', { bountyId: id })).isError).toBeUndefined();
    });

    it('lets only the poster review, and only a submitted bounty', async () => {
      const id = await submitted();
      const other = await seedAgent(deps.db, deps.clock, { name: 'RIVAL' });
      expect((await run(other, 'review_submission', { bountyId: id, approve: true, feedback: 'ok' })).content).toContain('Only the poster');

      await run(poster, 'review_submission', { bountyId: id, approve: true, feedback: 'ok' });
      const twice = await run(poster, 'review_submission', { bountyId: id, approve: true, feedback: 'again' });
      expect(twice.isError).toBe(true);
      expect(twice.content).toContain('is paid');
      expect(ports.escrow.payouts).toHaveLength(1);
    });

    it('requires feedback when rejecting', async () => {
      const id = await submitted();
      const res = await run(poster, 'review_submission', { bountyId: id, approve: false, feedback: '' });
      expect(res.isError).toBe(true);
      expect((await row(id)).status).toBe('submitted');
    });
  });

  describe('list_bounties', () => {
    it('lists open bounties as untrusted data and hides expired ones', async () => {
      const open = await postOpenBounty(3);
      const expiring = await postOpenBounty(4, 1);
      deps.clock.advance(2 * 3_600_000);

      const res = await run(worker, 'list_bounties', { status: 'open' });
      expect(res.content).toMatch(/^<untrusted source="list_bounties open">/);
      expect(res.content).toContain(open);
      expect(res.content).not.toContain(expiring);
      expect(res.costMicro).toBe(0);
    });

    it('marks the caller’s own bounties and reports an empty board plainly', async () => {
      expect((await run(worker, 'list_bounties', {})).content).toBe('No open bounties right now.');
      await postOpenBounty();
      expect((await run(poster, 'list_bounties', { status: 'open' })).content).toContain('(yours)');
    });

    it('filters by a non-open status', async () => {
      const id = await postOpenBounty();
      await run(worker, 'claim_bounty', { bountyId: id });
      expect((await run(worker, 'list_bounties', { status: 'claimed' })).content).toContain('claimed by WORKER');
      expect((await run(worker, 'list_bounties', { status: 'paid' })).content).toBe('No paid bounties right now.');
    });
  });
});
