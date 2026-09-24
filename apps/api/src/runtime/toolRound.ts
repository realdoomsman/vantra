// One round of tool calls (SPEC §8.5, AMENDMENTS C27): parallel-safe tools run together, every result
// is ledgered and broadcast, and all of them go back to the model in ONE user message.
import type { Deps, LlmContent, ToolResult } from '../core/interfaces.js';
import type { LiveToolCall, Micro, ToolName } from '@vantra/shared';
import type { AgentRow, StepRow } from '../db/schema.js';
import { addDecision, addEvent } from '../economy/events.js';
import { post } from '../economy/ledger.js';
import { liveSteps } from '../economy/live.js';
import { withTx } from '../economy/tx.js';

export const MIN_TOOL_MS = 2_000;                 // never hand a tool a deadline it cannot use

export type ToolCall = Extract<LlmContent, { type: 'tool_use' }>;

export interface ToolRound { blocks: LlmContent[]; chars: number; costMicro: Micro; agent: AgentRow; sleepUsed: boolean }

// All results of one round go back in ONE user message (SPEC §8.5); parallel-safe tools run together.
export async function runTools(
  deps: Deps,
  start: AgentRow,
  step: StepRow,
  round: number,
  calls: ToolCall[],
  opts: { controller: AbortController; deadline: number },
): Promise<ToolRound> {
  const ctx = { agent: start, stepId: step.id, round, log: deps.log.child({ agentId: start.id, stepId: step.id }) };
  const timed: { call: (typeof calls)[number]; result: ToolResult; ms: number }[] = new Array(calls.length);

  const execute = async (index: number): Promise<void> => {
    const call = calls[index]!;
    const at = Date.now();
    const remainingMs = Math.max(MIN_TOOL_MS, opts.deadline - at);
    const result = await deps.tools.execute(ctx, call.name, call.input, { signal: opts.controller.signal, remainingMs });
    timed[index] = { call, result, ms: Date.now() - at };
  };

  let index = 0;
  while (index < calls.length) {
    const batch: number[] = [];
    while (index < calls.length && isParallelSafe(deps, calls[index]!.name)) batch.push(index++);
    if (batch.length > 0) await Promise.all(batch.map(execute));
    else await execute(index++);
  }

  let agent = start;
  let costMicro = 0;
  let chars = 0;
  let sleepUsed = false;
  const blocks: LlmContent[] = [];
  for (const entry of timed) {
    const { call, result, ms } = entry;
    const ok = result.isError !== true;
    if (result.costMicro > 0) {
      agent = (await post(deps, deps.db, {
        agentId: agent.id, kind: result.ledgerKind ?? 'tool', amountMicro: -result.costMicro,
        memo: `${call.name}${ok ? '' : ' (failed)'}`, meta: { tool: call.name, stepId: step.id, round },
      })).agent;
      costMicro += result.costMicro;
    }
    if (result.event) {
      await withTx(deps.db, (tx) => addEvent(deps, tx, {
        kind: result.event!.kind, agentId: agent.id, agentName: agent.name, text: result.event!.text,
        amountMicro: result.event!.amountMicro ?? null, meta: result.event!.meta ?? {},
      }));
    }
    if (result.decision) {
      sleepUsed ||= result.decision.kind === 'sleep';
      await withTx(deps.db, (tx) => addDecision(deps, tx, {
        agentId: agent.id, stepId: step.id, kind: result.decision!.kind, text: result.decision!.text,
        meta: result.decision!.meta ?? {},
      }));
    }
    const live: LiveToolCall = {
      round, name: call.name as ToolName, inputSummary: summarize(deps, call.name, call.input),
      costMicro: result.costMicro, ok, ms, ts: deps.clock.now().toISOString(),
    };
    // Same payload on the wire and in the in-process buffer, so a control board opened mid-step sees
    // exactly what one opened at `step_start` saw (SPEC-V2 §7.5).
    liveSteps.tool(agent.id, live);
    deps.bus.emit({
      type: 'tool', agentId: agent.id, stepId: step.id, round, name: live.name,
      inputSummary: live.inputSummary, costMicro: result.costMicro, ok, ms,
    });
    blocks.push({ type: 'tool_result', toolUseId: call.id, content: result.content, isError: !ok });
    chars += result.content.length;
  }
  return { blocks, chars, costMicro, agent, sleepUsed };
}

const isParallelSafe = (deps: Deps, name: string): boolean => {
  try {
    return deps.tools.parallelSafe(name as ToolName);
  } catch {
    return false;
  }
};

const summarize = (deps: Deps, name: string, input: unknown): string => {
  try {
    return deps.tools.summarize(name as ToolName, input);
  } catch {
    return name;
  }
};
