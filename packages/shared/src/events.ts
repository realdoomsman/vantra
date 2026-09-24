// WebSocket server→client messages. SPEC-V2 §3.5 (was SPEC §8.16 + AMENDMENTS C27).
// Broadcast-only and public: purchases are private to their buyer and are NEVER broadcast — the
// pending page polls instead. Every control-board region (§9.7) is driven by one of these.
import type { AgentPublic, Decision, Effort, FeedEvent, GlobalStats, LedgerEntry, Micro, Project, StepPublic, ToolName, TreasuryPublic } from './types.js';

export type WsMsg =
  | { type: 'hello'; stats: GlobalStats }
  | { type: 'event'; event: FeedEvent }
  | { type: 'agent'; agentId: string; patch: Partial<AgentPublic> }   // patches include phase and stepping
  | { type: 'step_start'; agentId: string; stepId: number; n: number; model: string; effort: Effort }
  | { type: 'step'; step: StepPublic }                                 // at start (status 'running') and at end
  | { type: 'tool'; agentId: string; stepId: number; round: number; name: ToolName; inputSummary: string; costMicro: Micro; ok: boolean; ms: number }
  | { type: 'decision'; decision: Decision }
  | { type: 'ledger'; entry: LedgerEntry }
  | { type: 'project'; project: Project }
  | { type: 'stats'; stats: GlobalStats }
  | { type: 'treasury'; treasury: TreasuryPublic };

export type WsMsgType = WsMsg['type'];
export type WsMsgOf<T extends WsMsgType> = Extract<WsMsg, { type: T }>;

export const WS_PING_INTERVAL_MS = 25_000;
