// Step rows → public shapes. Thinking blocks are persisted in the transcript but never leave here
// (AMENDMENTS A1, C25).
import { and, desc, eq } from 'drizzle-orm';
import {
  TRANSCRIPT_PUBLIC_TRUNCATE_CHARS,
  type AgentLiveState, type StepPublic, type StepTranscript, type TranscriptBlock, type TranscriptMessage,
} from '@vantra/shared';
import type { LlmContent, LlmMessage, StepTranscriptView } from '../core/interfaces.js';
import type { DbLike } from '../db/client.js';
import { agents, steps, type StepRow } from '../db/schema.js';
import { redactOwnerPrivate } from '../lib/ownerPrivate.js';
import { truncate } from '../lib/untrusted.js';
import { liveSteps } from './live.js';

export function toStepPublic(r: StepRow): StepPublic {
  return {
    id: r.id, agentId: r.agentId, n: r.n,
    startedAt: r.startedAt.toISOString(), finishedAt: r.finishedAt?.toISOString() ?? null,
    model: r.model, effort: r.effort,
    inputTokens: r.inputTokens, outputTokens: r.outputTokens, cacheReadTokens: r.cacheReadTokens, cacheWriteTokens: r.cacheWriteTokens,
    costMicro: r.costMicro, toolCalls: r.toolCalls, rounds: r.rounds, stopReason: r.stopReason,
    status: r.status, summary: r.summary, error: r.error,
  };
}

export async function listSteps(db: DbLike, agentId: string, limit: number): Promise<StepPublic[]> {
  const rows = await db.select().from(steps).where(eq(steps.agentId, agentId)).orderBy(desc(steps.id)).limit(Math.min(Math.max(1, limit), 200));
  return rows.map(toStepPublic);
}

/**
 * What the control board needs to render THINKING NOW on first load (SPEC-V2 §7.5): the step in
 * flight and the tool calls it has already made. The WS `step_start` / `tool` / `step` messages carry
 * it from there. Public: the panel shows nothing a step row does not already expose.
 */
export async function liveState(db: DbLike, agentId: string): Promise<AgentLiveState> {
  const live = liveSteps.get(agentId);
  if (!live) return { agentId, stepping: false, step: null, round: 0, startedAt: null, tools: [] };
  const [row] = await db.select().from(steps).where(eq(steps.id, live.stepId)).limit(1);
  return {
    agentId,
    stepping: true,
    step: row && row.agentId === agentId ? toStepPublic(row) : null,
    round: live.round,
    startedAt: live.startedAt.toISOString(),
    tools: [...live.tools],
  };
}

// null once the transcript has been pruned (SPEC §7) or the step belongs to another agent.
// The endpoint is public, so unless the viewer IS the owner every owner-private section is redacted:
// the STATUS block replays the owner's last messages verbatim and `message_owner` carries the reply
// back (AMENDMENTS C21 — ownerMessages are returned only to the owner).
export async function stepTranscript(
  db: DbLike, agentId: string, stepId: number, viewerOwnerId?: string | null,
): Promise<StepTranscriptView | null> {
  const [row] = await db.select({ step: steps, ownerWallet: agents.ownerWallet })
    .from(steps).innerJoin(agents, eq(agents.id, steps.agentId))
    .where(and(eq(steps.id, stepId), eq(steps.agentId, agentId))).limit(1);
  const transcript = row?.step.transcript;
  if (!row || !transcript) return null;
  const ownerView = !!viewerOwnerId && viewerOwnerId === row.ownerWallet;
  const { step } = row;
  return {
    ownerView,
    transcript: { stepId: step.id, agentId: step.agentId, n: step.n, messages: transcript.map((m) => toPublicMessage(m, ownerView)) },
  };
}

const toPublicMessage = (m: LlmMessage, ownerView: boolean): TranscriptMessage => ({
  role: m.role,
  content: m.content.map((c) => toPublicBlock(c, ownerView)).filter((b): b is TranscriptBlock => b !== null),
});

function toPublicBlock(c: LlmContent, ownerView: boolean): TranscriptBlock | null {
  switch (c.type) {
    case 'text': return { type: 'text', text: ownerView ? c.text : redactOwnerPrivate(c.text) };
    case 'tool_use': return { type: 'tool_use', id: c.id, name: c.name, input: toolInput(c.name, c.input, ownerView) };
    case 'tool_result': return { type: 'tool_result', toolUseId: c.toolUseId, content: clip(c.content), isError: c.isError === true };
    default: return null;    // thinking / redacted_thinking never reach a public payload
  }
}

// message_owner is the private channel: its input is the message body itself.
export const OWNER_PRIVATE_TOOLS: ReadonlySet<string> = new Set(['message_owner']);

function toolInput(name: string, input: unknown, ownerView: boolean): string {
  if (!ownerView && OWNER_PRIVATE_TOOLS.has(name)) return '"[redacted: owner-private]"';
  return clip(JSON.stringify(input ?? null) ?? 'null');
}

const clip = (s: string): string => truncate(s, TRANSCRIPT_PUBLIC_TRUNCATE_CHARS);
