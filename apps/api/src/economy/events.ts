// Feed events and decisions: persisted rows + bus broadcast after commit.
import { and, desc, eq, lt, notExists, sql } from 'drizzle-orm';
import type { Decision, DecisionKind, EventKind, FeedEvent, Micro } from '@vantra/shared';
import type { CoreDeps } from '../core/interfaces.js';
import type { DbLike } from '../db/client.js';
import { agents, decisions, events, type DecisionRow, type EventRow } from '../db/schema.js';
import { afterCommit } from './tx.js';

type Deps = Pick<CoreDeps, 'clock' | 'bus'>;

export interface EventInput { kind: EventKind; agentId?: string | null; agentName?: string | null; text: string; amountMicro?: Micro | null; meta?: Record<string, unknown>; ts?: Date }
export interface DecisionInput { agentId: string; stepId?: number | null; kind: DecisionKind; text: string; meta?: Record<string, unknown>; ts?: Date }

export async function addEvent(deps: Deps, db: DbLike, e: EventInput): Promise<FeedEvent> {
  const [row] = await db.insert(events).values({
    ts: e.ts ?? deps.clock.now(), kind: e.kind, agentId: e.agentId ?? null, agentName: e.agentName ?? null,
    text: e.text, amountMicro: e.amountMicro ?? null, meta: e.meta ?? {},
  }).returning();
  const pub = toFeedEvent(row!);
  afterCommit(db, () => deps.bus.emit({ type: 'event', event: pub }));
  return pub;
}

export async function addDecision(deps: Deps, db: DbLike, d: DecisionInput): Promise<Decision> {
  const [row] = await db.insert(decisions).values({
    agentId: d.agentId, stepId: d.stepId ?? null, ts: d.ts ?? deps.clock.now(), kind: d.kind, text: d.text, meta: d.meta ?? {},
  }).returning();
  const pub = toDecision(row!);
  afterCommit(db, () => deps.bus.emit({ type: 'decision', decision: pub }));
  return pub;
}

export function toFeedEvent(r: EventRow): FeedEvent {
  return { id: r.id, ts: r.ts.toISOString(), kind: r.kind, agentId: r.agentId, agentName: r.agentName, text: r.text, amountMicro: r.amountMicro, meta: r.meta };
}

export function toDecision(r: DecisionRow): Decision {
  return { id: r.id, agentId: r.agentId, stepId: r.stepId, ts: r.ts.toISOString(), kind: r.kind, text: r.text, meta: r.meta };
}

/** The public feed. An event of a hidden agent is only served on that agent's own page (`q.agentId`). */
export async function listEvents(db: DbLike, q: { limit: number; before?: number; agentId?: string }): Promise<FeedEvent[]> {
  const conds = [];
  if (q.before) conds.push(lt(events.id, q.before));
  if (q.agentId) conds.push(eq(events.agentId, q.agentId));
  else conds.push(notExists(db.select({ one: sql`1` }).from(agents).where(and(eq(agents.id, events.agentId), eq(agents.hidden, true)))));
  const rows = await db.select().from(events).where(and(...conds)).orderBy(desc(events.id)).limit(q.limit);
  return rows.map(toFeedEvent);
}

export async function listDecisions(db: DbLike, agentId: string, limit: number): Promise<Decision[]> {
  const rows = await db.select().from(decisions).where(eq(decisions.agentId, agentId)).orderBy(desc(decisions.id)).limit(limit);
  return rows.map(toDecision);
}

export const shortWallet = (w: string): string => (w.length > 12 ? `${w.slice(0, 4)}…${w.slice(-4)}` : w);
