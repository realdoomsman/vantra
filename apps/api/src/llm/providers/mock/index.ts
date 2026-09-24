// Mock LLM provider: zero-cost, deterministic, and good enough to drive the demo colony.
// Behaviour comes from the agent's persona (persona.ts) and the world state in STATUS (status.ts);
// the usage/cost model is AMENDMENTS B17. Given the same request it always returns the same
// response, and it only ever calls tools that are present in `req.tools`.
import { priceUsage, type Effort, type ModelInfo, type StopReason } from '@vantra/shared';
import type { LlmContent, LlmMessage, LlmProvider, LlmRequest, LlmResponse, LlmToolDef } from '../../../core/interfaces.js';
import { harvestIds, lastRoundFailed } from './harvest.js';
import { fnv1a, mixSeed, personaFor } from './persona.js';
import { planRound, summaryText, type MockCall, type PlanInput } from './plan.js';
import { readStatus } from './status.js';

// Simulated reasoning tokens per effort level (B17: low 200 … max 2500).
export const THINKING_SIM_TOKENS: Record<Effort, number> = { low: 200, medium: 700, high: 1200, xhigh: 1800, max: 2500 };

export const CHARS_PER_TOKEN = 4;

export function createMockProvider(): LlmProvider {
  return {
    name: 'mock',
    complete: (req, model) => Promise.resolve(completeMock(req, model)),
  };
}

export function completeMock(req: LlmRequest, model: ModelInfo): LlmResponse {
  const persona = personaFor(req.agentId);
  const userTexts = req.messages.filter((m) => m.role === 'user').map(textOf).filter((t) => t.length > 0);
  const status = readStatus([...userTexts].reverse());
  const round = req.messages.filter((m) => m.role === 'assistant').length + 1;
  const seed = mixSeed(persona.seed, fnv1a(userTexts[0] ?? req.system));

  const plan: PlanInput = {
    persona, status, round, seed,
    tools: new Set(req.tools.map((t) => t.name)),
    ids: harvestIds(req.messages),
  };
  const beat = req.toolChoice === 'none' || lastRoundFailed(req.messages) ? null : planRound(plan);
  const didWork = req.messages.some((m) => m.role === 'assistant' && m.content.some((c) => c.type === 'tool_use'));

  let text = beat?.text ?? summaryText(plan, didWork);
  let calls = beat?.calls ?? [];
  let stopReason: StopReason = calls.length > 0 ? 'tool_use' : 'end_turn';

  const thinkingTokens = simulatedThinking(req.effort, req.maxTokens);
  let outputTokens = tokens(responseChars(text, calls)) + thinkingTokens;
  if (outputTokens > req.maxTokens) {
    // Ran out of room mid-turn: the partial turn keeps only the text it could fit (A3/B11).
    calls = [];
    text = text.slice(0, Math.max(0, (req.maxTokens - thinkingTokens) * CHARS_PER_TOKEN));
    outputTokens = req.maxTokens;
    stopReason = 'max_tokens';
  }

  const content: LlmContent[] = [];
  if (text.length > 0) content.push({ type: 'text', text });
  calls.forEach((call, i) => content.push({ type: 'tool_use', id: toolUseId(seed, round, i), name: call.name, input: call.input }));

  const usage = { ...promptUsage(req), outputTokens };
  return {
    content,
    stopReason,
    usage: { ...usage, costMicro: priceUsage(model, usage) },
    model: model.id,
    raw: { provider: 'mock', archetype: persona.archetype, competence: persona.competence, niche: persona.niche.slug, round },
  };
}

// B17: round 1 writes the whole prompt into cache; later rounds read it back and pay only for
// what the new tool results added.
function promptUsage(req: LlmRequest): { inputTokens: number; cacheReadTokens: number; cacheWriteTokens: number } {
  const total = tokens(promptChars(req.system, req.tools, req.messages));
  const lastAssistant = req.messages.findLastIndex((m) => m.role === 'assistant');
  if (lastAssistant < 0) return { inputTokens: total, cacheReadTokens: 0, cacheWriteTokens: total };
  const cacheReadTokens = tokens(promptChars(req.system, req.tools, req.messages.slice(0, lastAssistant)));
  return { inputTokens: Math.max(0, total - cacheReadTokens), cacheReadTokens, cacheWriteTokens: 0 };
}

const tokens = (chars: number): number => Math.ceil(chars / CHARS_PER_TOKEN);

const promptChars = (system: string, tools: LlmToolDef[], messages: LlmMessage[]): number =>
  system.length + JSON.stringify(tools).length + JSON.stringify(messages).length;

const responseChars = (text: string, calls: readonly MockCall[]): number =>
  text.length + calls.reduce((sum, c) => sum + c.name.length + JSON.stringify(c.input).length, 0);

// Capped at half the output budget so short closing completions never trip the max_tokens path.
function simulatedThinking(effort: Effort | undefined, maxTokens: number): number {
  if (!effort) return 0;
  return Math.min(THINKING_SIM_TOKENS[effort], Math.floor(maxTokens / 2));
}

const toolUseId = (seed: number, round: number, index: number): string =>
  `toolu_mock_${seed.toString(36)}_${round}_${index}`;

// Text blocks only: STATUS is prose the runtime wrote, never a tool's output.
const textOf = (m: LlmMessage): string =>
  m.content.flatMap((c) => (c.type === 'text' ? [c.text] : [])).join('\n');
