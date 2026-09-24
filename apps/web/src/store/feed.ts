import { create } from 'zustand';
import type { Decision, Effort, FeedEvent, LedgerEntry, Project, StepPublic } from '@vantra/shared';

export const GLOBAL_RING = 200;
export const AGENT_RING = 100;

/** One row of an agent's LIVE panel (D33). `id` is unique per item; `ts` is ISO. */
export type LiveItem =
  | { kind: 'event'; id: string; ts: string; event: FeedEvent }
  | { kind: 'step_start'; id: string; ts: string; stepId: number; n: number; model: string; effort: Effort }
  | { kind: 'step'; id: string; ts: string; step: StepPublic }
  | { kind: 'tool'; id: string; ts: string; stepId: number; round: number; name: string; inputSummary: string; costMicro: number; ok: boolean; ms: number }
  | { kind: 'decision'; id: string; ts: string; decision: Decision }
  | { kind: 'ledger'; id: string; ts: string; entry: LedgerEntry }
  | { kind: 'project'; id: string; ts: string; project: Project };

interface FeedState {
  /** Global feed, newest first, capped at GLOBAL_RING. */
  events: FeedEvent[];
  /** Per-agent live items, newest first, capped at AGENT_RING. */
  live: Record<string, LiveItem[]>;

  pushEvent: (event: FeedEvent) => void;
  seedEvents: (events: FeedEvent[]) => void;
  pushLive: (agentId: string, item: LiveItem) => void;
  seedLive: (agentId: string, events: FeedEvent[], steps: StepPublic[]) => void;
}

const byTsDesc = (a: { ts: string }, b: { ts: string }) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0);

function mergeRing<T extends { id: string | number; ts: string }>(cur: T[], add: T[], cap: number): T[] {
  const seen = new Map<string | number, T>();
  for (const x of add) seen.set(x.id, x);
  for (const x of cur) if (!seen.has(x.id)) seen.set(x.id, x);
  return [...seen.values()].sort(byTsDesc).slice(0, cap);
}

export const eventItem = (event: FeedEvent): LiveItem => ({ kind: 'event', id: `event:${event.id}`, ts: event.ts, event });
export const stepItem = (step: StepPublic): LiveItem => ({ kind: 'step', id: `step:${step.id}`, ts: step.finishedAt ?? step.startedAt, step });

export const useFeedStore = create<FeedState>()((set) => ({
  events: [],
  live: {},

  pushEvent: (event) =>
    set((s) => {
      const events = mergeRing(s.events, [event], GLOBAL_RING);
      const live = event.agentId ? { ...s.live, [event.agentId]: mergeRing(s.live[event.agentId] ?? [], [eventItem(event)], AGENT_RING) } : s.live;
      return { events, live };
    }),

  seedEvents: (events) => set((s) => ({ events: mergeRing(s.events, events, GLOBAL_RING) })),

  pushLive: (agentId, item) =>
    set((s) => ({ live: { ...s.live, [agentId]: mergeRing(s.live[agentId] ?? [], [item], AGENT_RING) } })),

  seedLive: (agentId, events, steps) =>
    set((s) => {
      const items = [...events.map(eventItem), ...steps.map(stepItem)];
      return { live: { ...s.live, [agentId]: mergeRing(s.live[agentId] ?? [], items, AGENT_RING) } };
    }),
}));

const EMPTY_LIVE: LiveItem[] = [];

export function useAgentLive(agentId: string | null | undefined): LiveItem[] {
  return useFeedStore((s) => (agentId ? (s.live[agentId] ?? EMPTY_LIVE) : EMPTY_LIVE));
}
