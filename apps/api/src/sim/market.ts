// Protocol-posted bounties for the demo colony (SPEC §8.18). VANTRA escrows the reward like any
// other poster; the simulator also plays the operator who reviews what agents submit, because
// `posterType: 'protocol'` has no human reviewer behind it.
import { and, eq } from 'drizzle-orm';
import { fmtUsd, usd, type Rng } from '@vantra/shared';
import type { CoreDeps } from '../core/interfaces.js';
import { agents, bounties, type BountyRow } from '../db/schema.js';
import { addEvent } from '../economy/events.js';
import { withTx } from '../economy/tx.js';
import { transferFromEscrow, wallets } from '../economy/wallets.js';
import { newBountyId } from '../lib/ids.js';
import { faucetTo } from './revenue.js';

const PROTOCOL_POSTER_ID = 'protocol';
const FINAL_OPEN_BOUNTIES = 6;                 // left open on the board when the demo hands over to real time
const APPROVE_CHANCE = 0.75;

interface BountySpec { title: string; description: string; rewardUsd: number }

const SPECS: readonly BountySpec[] = [
  { title: 'Write a one-page explainer for new agents', description: 'Explain, in under 400 words, how an agent on VANTRA pays rent, earns revenue and dies. Plain language, no hype, no token talk. Deliver the finished text in the submission.', rewardUsd: 0.75 },
  { title: 'Benchmark three agent services and publish the numbers', description: 'Call three live services from the market, record latency and output quality for each, and submit a comparison table a buyer could act on.', rewardUsd: 1.25 },
  { title: 'Ship a status page for your own endpoints', description: 'Deploy a static page that lists every endpoint you sell, its price and whether it answered on the last check. Submit the URL.', rewardUsd: 1 },
  { title: 'Document a strategy that paid for itself', description: 'Describe a strategy you actually ran, with the real numbers: what it cost, what it earned, and when it broke even. No projections.', rewardUsd: 1.5 },
  { title: 'Build a JSON validator other agents can call', description: 'Publish a service that takes {"text": "..."} and returns a structured verdict. It must answer in under a second and never crash on malformed input.', rewardUsd: 0.9 },
  { title: 'Find and report a broken agent site', description: 'Fetch the sites deployed by this colony, list any that 404 or render empty, and submit the findings with URLs.', rewardUsd: 0.5 },
  { title: 'Write the shortest useful onboarding checklist', description: 'Ten lines or fewer that a newly spawned agent could follow in its first three heartbeats. Ruthless about what earns money first.', rewardUsd: 0.6 },
  { title: 'Price research: what do buyers pay per call?', description: 'Survey the services on the market, group them by what they do, and submit the price range for each group with the evidence.', rewardUsd: 1.1 },
  { title: 'Publish a post-mortem of a dead strategy', description: 'Pick something you tried that did not work, explain why it failed and what the cheaper test would have been.', rewardUsd: 0.8 },
  { title: 'Make one page that sells one thing', description: 'Deploy a landing page with a single offer, a single price and a single call to action. Submit the URL and the reasoning.', rewardUsd: 1.2 },
];

// Posts one bounty from VANTRA, escrowing the reward first exactly like a user poster does.
export async function postProtocolBounty(deps: CoreDeps, spec: BountySpec, deadlineHours: number): Promise<BountyRow> {
  const rewardMicro = usd(spec.rewardUsd);
  const now = deps.clock.now();
  const id = newBountyId();
  const sig = await faucetTo(deps, wallets(deps).escrow.pubkey, rewardMicro, 'vantra-protocol-treasury');
  return withTx(deps.db, async (tx) => {
    const [row] = await tx.insert(bounties).values({
      id, posterType: 'protocol', posterId: PROTOCOL_POSTER_ID, title: spec.title, description: spec.description,
      rewardMicro, status: 'open', createdAt: now, deadlineAt: new Date(now.getTime() + deadlineHours * 3_600_000),
      escrowTx: sig,
    }).returning();
    await addEvent(deps, tx, {
      kind: 'bounty', amountMicro: rewardMicro, ts: now,
      text: `VANTRA posted a bounty: "${spec.title}" for ${fmtUsd(rewardMicro)}`,
      meta: { bountyId: id, posterType: 'protocol' },
    });
    return row!;
  });
}

// One bounty every few ticks while the colony fast-forwards, so the board is never empty.
export function protocolBountyAt(index: number): BountySpec {
  return SPECS[index % SPECS.length]!;
}

// The board the demo leaves behind: FINAL_OPEN_BOUNTIES fresh jobs with week-long deadlines.
export async function postFinalBoard(deps: CoreDeps, rng: Rng): Promise<void> {
  for (let i = 0; i < FINAL_OPEN_BOUNTIES; i++) {
    await postProtocolBounty(deps, SPECS[(i * 3 + 1) % SPECS.length]!, rng.int(72, 336));
  }
}

// The operator pass: approve most submissions, reject the rest with usable feedback.
export async function reviewProtocolSubmissions(deps: CoreDeps, rng: Rng): Promise<number> {
  const rows = await deps.db.select().from(bounties)
    .where(and(eq(bounties.posterType, 'protocol'), eq(bounties.status, 'submitted'))).limit(20);
  let reviewed = 0;
  for (const row of rows) {
    if (!row.claimerAgentId) continue;
    reviewed += await reviewOne(deps, row, row.claimerAgentId, rng.chance(APPROVE_CHANCE)) ? 1 : 0;
  }
  return reviewed;
}

async function reviewOne(deps: CoreDeps, row: BountyRow, claimerId: string, approve: boolean): Promise<boolean> {
  const [claimer] = await deps.db.select({ name: agents.name, wallet: agents.walletPubkey })
    .from(agents).where(eq(agents.id, claimerId)).limit(1);
  if (!claimer) return false;
  const now = deps.clock.now();

  if (!approve) {
    const rejections = row.rejections + 1;
    const released = rejections >= 2;
    await deps.db.update(bounties).set({
      status: released ? 'open' : 'rejected', rejections,
      feedback: 'Close, but the submission does not show the result itself — include the finished work, not a description of it.',
      ...(released ? { claimerAgentId: null, claimedAt: null, submission: null } : {}),
    }).where(eq(bounties.id, row.id));
    await withTx(deps.db, (tx) => addEvent(deps, tx, {
      kind: 'bounty', agentId: claimerId, agentName: claimer.name, amountMicro: row.rewardMicro, ts: now,
      text: released
        ? `"${row.title}" is open again after a second rejection`
        : `${claimer.name}'s submission for "${row.title}" was rejected by VANTRA`,
      meta: { bountyId: row.id, posterType: 'protocol', rejections },
    }));
    return true;
  }

  // Marked paid before the transfer: a crash leaves an unpaid bounty an operator can settle, never a double payment.
  await deps.db.update(bounties).set({ status: 'paid', paidAt: now, feedback: 'Accepted — this is exactly what was asked for.' })
    .where(eq(bounties.id, row.id));
  let sig: string;
  try {
    sig = await transferFromEscrow(deps, claimer.wallet, row.rewardMicro, `bounty ${row.id}`);
  } catch (e) {
    await deps.db.update(bounties).set({ status: 'submitted', paidAt: null }).where(eq(bounties.id, row.id));
    deps.log.error({ err: e, bountyId: row.id }, 'protocol bounty payout failed');
    return false;
  }
  await withTx(deps.db, (tx) => addEvent(deps, tx, {
    kind: 'bounty', agentId: claimerId, agentName: claimer.name, amountMicro: row.rewardMicro, ts: now,
    text: `${claimer.name} was paid ${fmtUsd(row.rewardMicro)} by VANTRA for "${row.title}"`,
    meta: { bountyId: row.id, posterType: 'protocol', txSig: sig },
  }));
  return true;
}
