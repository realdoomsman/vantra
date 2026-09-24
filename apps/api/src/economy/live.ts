// In-process view of steps currently running: feeds AgentPublic.stepping / currentRound (C20) and,
// since SPEC-V2 §7.5, the control board's THINKING NOW panel — the tool calls of the step in flight,
// so a board opened mid-step is not blank until the step ends.
import type { LiveToolCall } from '@vantra/shared';

export const LIVE_TOOLS_MAX = 32;

export interface LiveStep { stepId: number; startedAt: Date; round: number; tools: LiveToolCall[] }

const live = new Map<string, LiveStep>();

export const liveSteps = {
  start(agentId: string, stepId: number, startedAt: Date): void {
    live.set(agentId, { stepId, startedAt, round: 0, tools: [] });
  },
  round(agentId: string, round: number): void {
    const s = live.get(agentId);
    if (s) s.round = round;
  },
  // Oldest first, capped: a runaway tool loop must not grow this map without bound.
  tool(agentId: string, call: LiveToolCall): void {
    const s = live.get(agentId);
    if (!s) return;
    s.tools.push(call);
    if (s.tools.length > LIVE_TOOLS_MAX) s.tools.splice(0, s.tools.length - LIVE_TOOLS_MAX);
  },
  end(agentId: string): void {
    live.delete(agentId);
  },
  get(agentId: string): LiveStep | null {
    return live.get(agentId) ?? null;
  },
};
