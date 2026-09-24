// One heartbeat (SPEC §8.5) with AMENDMENTS B10–B14: rent and deposits first, the death ordering,
// budgeted completions, the tool loop (all results in ONE user message), pause_turn / max_tokens /
// refusal handling, a closing completion that always runs from the reserve, then scheduling.
import { eq, sql } from 'drizzle-orm';
import {
  CLOSING_MAX_TOKENS, LAST_WORDS_MAX_TOKENS, LLM_MAX_TOKENS_DEFAULT,
  MAX_TOOL_ROUNDS_PER_STEP, STEP_TIMEOUT_MS, fmtUsd,
  type Micro, type ModelInfo, type StepStatus, type StopReason,
} from '@vantra/shared';
import type { Deps, LlmContent, LlmMessage, LlmResponse } from '../core/interfaces.js';
import { agents, steps, type AgentRow, type StepRow } from '../db/schema.js';
import { activeDeploymentCount, emitAgent } from '../economy/agents.js';
import { addDecision, addEvent } from '../economy/events.js';
import { post } from '../economy/ledger.js';
import { launchedLaunchOf } from '../economy/ladder.js';
import { liveSteps } from '../economy/live.js';
import { toStepPublic } from '../economy/steps.js';
import { withTx } from '../economy/tx.js';
import { errorMessage } from '../lib/errors.js';
import { appendReminder, buildContext, userTurn } from './context.js';
import { scanDeposits, type Deposit } from './deposits.js';
import { goBroke, type BrokeCause } from './death.js';
import { carriedTokens, preflight, stepCapOf, tokensOf, usageCost } from './metering.js';
import { SUMMARY_MAX_CHARS, promptInputsFor, systemPrompt } from './prompts.js';
import { chargeRent, fixedCostPerHeartbeat, ratesOf } from './rent.js';
import { runTools } from './toolRound.js';

export const ERROR_RETRY_MS = 15 * 60_000;
const ROUND_CAP_REMINDER = 'Round cap reached; finish with a summary of what you did and what is next.';

export interface StepOutcome { ran: boolean; stepId: number | null; status: StepStatus | 'none'; costMicro: Micro }

export async function runStep(deps: Deps, input: AgentRow): Promise<StepOutcome> {
  // Only an awake agent thinks. The scheduler never claims anything else, but a dormant agent in
  // particular must never be stepped: a step bills rent and inference it has no money for.
  switch (input.status) {
    case 'alive': case 'sleeping': break;
    case 'dormant': case 'paused': case 'spawning': case 'dead':
      return { ran: false, stepId: null, status: 'none', costMicro: 0 };
  }
  const startedAt = deps.clock.now();
  let agent = (await chargeRent(deps, input, startedAt)).agent;
  const scan = await scanDeposits(deps, agent);
  agent = scan.agent;

  if (agent.status === 'sleeping') {
    if (agent.sleepUntil && agent.sleepUntil > startedAt) {
      await reschedule(deps, agent, agent.sleepUntil, 'sleeping');
      return { ran: false, stepId: null, status: 'none', costMicro: 0 };
    }
    agent = await wake(deps, agent, startedAt);
  }

  const rates = ratesOf(deps);
  const sites = await activeDeploymentCount(deps.db, agent.id);
  const cheapest = deps.llm.cheapest();
  const minStepMicro = deps.llm.estimateMicro(cheapest, 6000, 1000) + fixedCostPerHeartbeat(agent, sites, rates);

  if (agent.treasuryMicro <= 0) {
    await goBroke(deps, agent, 'rent', { memo: `Rent took the treasury to ${fmtUsd(agent.treasuryMicro)}` });
    return { ran: false, stepId: null, status: 'none', costMicro: 0 };
  }
  const lastWords = agent.treasuryMicro < 3 * minStepMicro;
  const model = lastWords ? cheapest : resolveModel(deps, agent);
  if (!lastWords && model.id !== agent.model) {
    await withTx(deps.db, (tx) => addDecision(deps, tx, {
      agentId: agent.id, kind: 'pivot',
      text: `Downgraded model to ${model.id}: cannot afford ${agent.model} with ${fmtUsd(agent.treasuryMicro)}`,
      meta: { from: agent.model, to: model.id },
    }));
  }

  const step = await openStep(deps, agent, model.id, startedAt);
  try {
    return await drive(deps, agent, step, { model, lastWords, deposits: scan.deposits, minStepMicro });
  } catch (e) {
    deps.log.error({ err: e, agentId: agent.id, stepId: step.id }, 'step failed');
    await closeStep(deps, agent, step, {
      status: 'error', error: errorMessage(e), summary: '', stopReason: null, rounds: 0, toolCalls: 0,
      costMicro: 0, usage: emptyUsage(), transcript: null, retryMs: ERROR_RETRY_MS, sleepUsed: false, dieWith: null,
    });
    return { ran: true, stepId: step.id, status: 'error', costMicro: 0 };
  }
}

interface DriveOptions { model: ModelInfo; lastWords: boolean; deposits: Deposit[]; minStepMicro: Micro }

async function drive(deps: Deps, start: AgentRow, step: StepRow, opts: DriveOptions): Promise<StepOutcome> {
  const { model, minStepMicro } = opts;
  let agent = start;
  const controller = new AbortController();
  const deadline = Date.now() + STEP_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), STEP_TIMEOUT_MS);

  const system = systemPrompt(promptInputsFor(deps, agent, await launchedLaunchOf(deps.db, agent.id)));
  const toolDefs = deps.tools.defs(agent.enabledTools);
  const context = await buildContext(deps, agent, { deposits: opts.deposits, aboutToDie: opts.lastWords, modelId: model.id });
  const transcript: LlmMessage[] = [userTurn(context.text)];

  const usage = emptyUsage();
  let rounds = 0;
  let toolCalls = 0;
  let costMicro = 0;
  let status: StepStatus = 'ok';
  let stopReason: StopReason | null = null;
  let error: string | null = null;
  let closing = opts.lastWords;
  let dieWith: BrokeCause | null = opts.lastWords ? 'insolvent' : null;
  let sleepUsed = false;
  let maxTokensRetried = false;
  let carried = tokensOf(system.length + JSON.stringify(toolDefs).length + context.text.length);
  let desiredMaxTokens = opts.lastWords ? LAST_WORDS_MAX_TOKENS : LLM_MAX_TOKENS_DEFAULT;

  try {
    for (;;) {
      const budget = preflight({
        model, ctxTokens: carried, desiredMaxTokens, treasuryMicro: agent.treasuryMicro, minStepMicro,
        stepCostMicro: costMicro, rounds, closing,
      });
      if (budget.action === 'close') {
        closing = true;
        desiredMaxTokens = CLOSING_MAX_TOKENS;
        appendReminder(transcript, `Budget reached (${budget.reason}); finish with a summary now.`);
        continue;
      }
      if (budget.action === 'die') {
        if (rounds === 0) {
          status = 'aborted';
          error = `insufficient budget: ${budget.reason}`;
          dieWith = 'insolvent';
        }
        break;
      }

      liveSteps.round(agent.id, rounds + 1);
      let res: LlmResponse;
      try {
        res = await deps.llm.complete({
          model: model.id, system, messages: transcript, tools: toolDefs, maxTokens: budget.maxTokens,
          effort: agent.effort, toolChoice: closing ? 'none' : 'auto', signal: controller.signal,
          remainingMs: Math.max(0, deadline - Date.now()), agentId: agent.id,
        });
      } catch (e) {
        if (controller.signal.aborted) {
          status = 'aborted';
          error = 'timeout';
        } else {
          status = 'error';
          error = errorMessage(e);
        }
        break;
      }

      const spent = usageCost(model, res.usage);
      if (spent > 0) {
        const paid = res.payment;   // x402: the agent already paid the gateway on-chain this round
        agent = (await post(deps, deps.db, paid
          ? {
              agentId: agent.id, kind: 'inference_paid', amountMicro: -spent,
              memo: `${model.id} step ${step.n} round ${rounds + 1} (x402)`,
              txSig: paid.txSig, counterparty: paid.payTo,
              meta: { model: model.id, round: rounds + 1, stepId: step.id, network: paid.network, ...res.usage },
            }
          : {
              agentId: agent.id, kind: 'inference', amountMicro: -spent,
              memo: `${model.id} step ${step.n} round ${rounds + 1}`,
              meta: { model: model.id, round: rounds + 1, stepId: step.id, ...res.usage },
            })).agent;
      }
      costMicro += spent;
      addUsage(usage, res.usage);
      stopReason = res.stopReason;

      if (res.stopReason === 'refusal') {
        transcript.push({ role: 'assistant', content: res.content });
        status = 'refused';
        error = res.stopDetails?.category ?? 'refusal';
        await withTx(deps.db, (tx) => addDecision(deps, tx, {
          agentId: agent.id, stepId: step.id, kind: 'note',
          text: `Model refused: ${res.stopDetails?.explanation ?? error}`, meta: { category: error },
        }));
        break;
      }
      if (res.stopReason === 'error') {
        status = 'error';
        error = res.stopDetails?.explanation ?? 'provider error';
        break;
      }
      // The conversation no longer fits the model's INPUT window. Retrying at 2x maxTokens — what
      // the max_tokens branch below does — sends the same oversized prompt and asks for a longer
      // reply, so it buys a second guaranteed failure at full price. Stop and let the next step
      // start from a compacted context.
      if (res.stopReason === 'context_window') {
        status = 'aborted';
        error = 'context_window: the conversation no longer fits this model';
        transcript.push({ role: 'assistant', content: res.content });
        break;
      }
      if (res.stopReason === 'max_tokens') {
        const partialToolUse = res.content.some((c) => c.type === 'tool_use');
        if (partialToolUse) {
          // The tool call is truncated and unusable: drop the turn and retry once with more room (B11).
          const retryTokens = Math.min(budget.maxTokens * 2, LLM_MAX_TOKENS_DEFAULT);
          const affordable = preflight({
            model, ctxTokens: carried, desiredMaxTokens: retryTokens, treasuryMicro: agent.treasuryMicro, minStepMicro,
            stepCostMicro: costMicro, rounds, closing,
          });
          if (!maxTokensRetried && affordable.action === 'run') {
            maxTokensRetried = true;
            desiredMaxTokens = retryTokens;
            continue;
          }
          status = 'aborted';
          error = 'max_tokens';
          break;
        }
        transcript.push({ role: 'assistant', content: res.content });
        break;
      }
      if (res.stopReason === 'pause_turn') {
        transcript.push({ role: 'assistant', content: res.content });     // continue with no user message (B11)
        carried = carriedTokens(res.usage, 0);
        rounds += 1;
        if (rounds >= MAX_TOOL_ROUNDS_PER_STEP) {
          appendReminder(transcript, ROUND_CAP_REMINDER);
          closing = true;
          desiredMaxTokens = CLOSING_MAX_TOKENS;
        }
        continue;
      }

      transcript.push({ role: 'assistant', content: res.content });
      const calls = res.content.filter((c): c is Extract<LlmContent, { type: 'tool_use' }> => c.type === 'tool_use');
      if (closing || res.stopReason !== 'tool_use' || calls.length === 0) break;

      const round = await runTools(deps, agent, step, rounds + 1, calls, { controller, deadline });
      agent = round.agent;
      toolCalls += calls.length;
      costMicro += round.costMicro;
      sleepUsed ||= round.sleepUsed;
      transcript.push({ role: 'user', content: round.blocks });
      carried = carriedTokens(res.usage, round.chars);
      rounds += 1;

      // The cap is relative to the treasury (§7.2), so it is re-read against the balance the rounds
      // have already spent down — a step that keeps burning tightens its own ceiling.
      if (agent.treasuryMicro < 0 || costMicro > stepCapOf(agent.treasuryMicro, minStepMicro)) {
        status = 'aborted';
        error = agent.treasuryMicro < 0 ? 'insolvent' : 'budget';
        await withTx(deps.db, (tx) => addDecision(deps, tx, {
          agentId: agent.id, stepId: step.id, kind: 'note',
          text: `Step aborted: budget (${fmtUsd(costMicro)} spent this step)`, meta: { costMicro },
        }));
        closing = true;                                   // the closing completion still runs from the reserve (B10)
        desiredMaxTokens = CLOSING_MAX_TOKENS;
        continue;
      }
      if (rounds >= MAX_TOOL_ROUNDS_PER_STEP) {
        appendReminder(transcript, ROUND_CAP_REMINDER);
        closing = true;
        desiredMaxTokens = CLOSING_MAX_TOKENS;
      }
    }
  } finally {
    clearTimeout(timer);
  }

  const fresh = await reload(deps, agent);
  if (fresh.treasuryMicro < 0 && dieWith === null) dieWith = 'insolvent';
  const summary = lastText(transcript);
  await closeStep(deps, fresh, step, {
    status, error, summary, stopReason, rounds, toolCalls, costMicro, usage, transcript,
    retryMs: status === 'error' ? ERROR_RETRY_MS : null, sleepUsed, dieWith,
  });
  return { ran: true, stepId: step.id, status, costMicro };
}


interface CloseInput {
  status: StepStatus;
  error: string | null;
  summary: string;
  stopReason: StopReason | null;
  rounds: number;
  toolCalls: number;
  costMicro: Micro;
  usage: Usage;
  transcript: LlmMessage[] | null;
  retryMs: number | null;
  sleepUsed: boolean;
  dieWith: BrokeCause | null;    // a launchpad agent goes dormant instead (runtime/death.ts goBroke)
}

// Persists the step, bills the rent that accrued while it ran, schedules the next heartbeat and,
// when the books say so, kills the agent (B10, B13, B14).
async function closeStep(deps: Deps, input: AgentRow, step: StepRow, c: CloseInput): Promise<void> {
  const finishedAt = deps.clock.now();
  const agent = (await chargeRent(deps, input, finishedAt)).agent;   // billed before any status transition (B13)

  const [row] = await deps.db.update(steps).set({
    finishedAt, status: c.status, summary: c.summary, error: c.error, stopReason: c.stopReason,
    rounds: c.rounds, toolCalls: c.toolCalls, costMicro: c.costMicro,
    inputTokens: c.usage.inputTokens, outputTokens: c.usage.outputTokens,
    cacheReadTokens: c.usage.cacheReadTokens, cacheWriteTokens: c.usage.cacheWriteTokens,
    transcript: c.transcript,
  }).where(eq(steps.id, step.id)).returning();

  const counted = c.status !== 'error';   // a provider failure is not a heartbeat the agent took
  await deps.db.update(agents).set({
    currentStepId: null,
    ...(counted ? { totalSteps: sql`${agents.totalSteps} + 1` } : {}),
    lastStepAt: finishedAt,
    updatedAt: finishedAt,
  }).where(eq(agents.id, agent.id));
  liveSteps.end(agent.id);

  if (c.summary) {
    await withTx(deps.db, (tx) => addDecision(deps, tx, {
      agentId: agent.id, stepId: step.id, kind: c.sleepUsed ? 'sleep' : 'action', ts: finishedAt,
      text: c.summary, meta: { stepN: step.n, costMicro: c.costMicro },
    }));
  }
  if (row) deps.bus.emit({ type: 'step', step: toStepPublic(row) });

  // The rent billed above lands AFTER `dieWith` was decided, so the books are re-read here: B13's
  // death order is `treasury <= 0 → die('rent')` first, then a pending insolvency. Without this an
  // agent whose last rent post took it to zero is rescheduled alive with nothing left, and stays
  // listed (and sellable to) until its next heartbeat.
  const latest = await reload(deps, agent);
  const cause: BrokeCause | null = latest.treasuryMicro <= 0 ? 'rent' : c.dieWith;
  if (cause) {
    const memo = cause === 'rent' && c.dieWith === null
      ? `Rent took the treasury to ${fmtUsd(latest.treasuryMicro)}`
      : c.error ? `Died during step ${step.n}: ${c.error}` : undefined;
    await goBroke(deps, latest, cause, { stepId: step.id, ...(memo === undefined ? {} : { memo }) });
    return;
  }
  const sleepUntil = latest.sleepUntil;
  const next = c.retryMs !== null
    ? new Date(finishedAt.getTime() + c.retryMs)
    : sleepUntil && sleepUntil > finishedAt
      ? sleepUntil
      : new Date(finishedAt.getTime() + latest.heartbeatMin * 60_000);
  await reschedule(deps, latest, next, sleepUntil && sleepUntil > finishedAt ? 'sleeping' : 'alive');
}

// An owner who paused the agent while the step was running wins over the step's own schedule.
async function reschedule(deps: Deps, agent: AgentRow, next: Date, status: 'alive' | 'sleeping'): Promise<AgentRow> {
  const now = deps.clock.now();
  const resting = agent.pausedByOwner ? 'paused' : status;
  const [row] = await deps.db.update(agents)
    .set({ nextStepAt: agent.pausedByOwner ? null : next, status: resting, currentStepId: null, updatedAt: now })
    .where(eq(agents.id, agent.id)).returning();
  const updated = row ?? agent;
  if (resting !== 'alive' && agent.status === 'alive') {
    await deps.sandbox.stop(agent.id).catch((e: unknown) => deps.log.warn({ err: e, agentId: agent.id }, 'sandbox stop failed'));
  }
  await emitAgent(deps, deps.db, updated);
  return updated;
}

async function wake(deps: Deps, agent: AgentRow, now: Date): Promise<AgentRow> {
  const [row] = await deps.db.update(agents).set({ status: 'alive', sleepUntil: null, lastRentAt: now, updatedAt: now })
    .where(eq(agents.id, agent.id)).returning();
  const awake = row ?? agent;
  await deps.sandbox.start(agent.id).catch((e: unknown) => deps.log.warn({ err: e, agentId: agent.id }, 'sandbox start failed'));
  await withTx(deps.db, (tx) => addEvent(deps, tx, {
    kind: 'wake', agentId: agent.id, agentName: agent.name, text: `${agent.name} woke up`, ts: now,
  }));
  return awake;
}

// A step row exists from the first moment so the UI can show "THINKING" (AMENDMENTS C20, C27).
async function openStep(deps: Deps, agent: AgentRow, modelId: string, startedAt: Date): Promise<StepRow> {
  const [row] = await deps.db.insert(steps).values({
    agentId: agent.id,
    n: sql<number>`(select coalesce(max(${steps.n}), 0) + 1 from ${steps} where ${steps.agentId} = ${agent.id})`,
    startedAt, model: modelId, effort: agent.effort, status: 'running',
  }).returning();
  const step = row!;
  await deps.db.update(agents).set({ currentStepId: step.id }).where(eq(agents.id, agent.id));
  liveSteps.start(agent.id, step.id, startedAt);
  deps.bus.emit({ type: 'step_start', agentId: agent.id, stepId: step.id, n: step.n, model: modelId, effort: agent.effort });
  deps.bus.emit({ type: 'step', step: toStepPublic(step) });
  await emitAgent(deps, deps.db, agent);
  return step;
}

function resolveModel(deps: Deps, agent: AgentRow) {
  const cheapest = deps.llm.cheapest();
  let model = cheapest;
  try {
    model = deps.llm.resolve(agent.model);
  } catch {
    return cheapest;
  }
  return deps.llm.estimateMicro(model, 6000, 1000) > agent.treasuryMicro ? cheapest : model;
}

async function reload(deps: Deps, agent: AgentRow): Promise<AgentRow> {
  const [row] = await deps.db.select().from(agents).where(eq(agents.id, agent.id));
  return row ?? agent;
}

interface Usage { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }
const emptyUsage = (): Usage => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });

function addUsage(total: Usage, u: Usage): void {
  total.inputTokens += u.inputTokens;
  total.outputTokens += u.outputTokens;
  total.cacheReadTokens += u.cacheReadTokens;
  total.cacheWriteTokens += u.cacheWriteTokens;
}

// The public summary is the model's own last words, trimmed (SPEC §8.5).
function lastText(transcript: LlmMessage[]): string {
  for (let i = transcript.length - 1; i >= 0; i--) {
    const message = transcript[i]!;
    if (message.role !== 'assistant') continue;
    const text = message.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
    if (text) return text.length > SUMMARY_MAX_CHARS ? `${text.slice(0, SUMMARY_MAX_CHARS - 1)}…` : text;
  }
  return '';
}
