// One definition per tool drives both runtime validation (zod) and the canonical JSON schema sent to
// the model. The canonical schema is Anthropic-style (AMENDMENTS A7): additionalProperties:false,
// `required` lists only mandatory keys, and only keywords every strict-mode provider accepts
// (type / description / properties / required / additionalProperties / enum / items). Ranges and
// length limits live in descriptions and are enforced by zod at execute time.
import { z } from 'zod';
import type { ToolName } from '@vantra/shared';
import type { LlmToolDef, ToolContext, ToolExecOpts, ToolResult } from '../core/interfaces.js';

export type ToolParams = z.ZodObject<z.ZodRawShape, z.core.$strict>;

export interface ToolSpec<P extends ToolParams = ToolParams> {
  name: ToolName;
  description: string;                 // prescriptive: when to call it and what it costs
  params: P;
  parallelSafe: boolean;               // may run concurrently with other tool calls of the same round
  summarize(input: z.output<P>): string;   // ≤160 chars, never secrets (WS 'tool' inputSummary)
  run(ctx: ToolContext, input: z.output<P>, opts: ToolExecOpts): Promise<ToolResult>;
}

export const defineTool = <P extends ToolParams>(spec: ToolSpec<P>): ToolSpec => spec as unknown as ToolSpec;

// Keywords strict-mode providers reject (Anthropic strict tool use, OpenAI strict function calling).
const UNSUPPORTED_KEYWORDS = new Set([
  '$schema', 'default', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
  'minLength', 'maxLength', 'pattern', 'format', 'minItems', 'maxItems', 'uniqueItems',
]);

export function toInputSchema(params: ToolParams): Record<string, unknown> {
  const schema = sanitize(z.toJSONSchema(params, { io: 'input' })) as Record<string, unknown>;
  assertCanonical(schema);
  return schema;
}

// Drops keywords strict mode rejects and spells out the two keys zod omits when they are implicit:
// `required: []` when every property has a default, and `additionalProperties: false` on nested objects.
function sanitize(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(sanitize);
  if (!isPlainObject(node)) return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    if (!UNSUPPORTED_KEYWORDS.has(k)) out[k] = sanitize(v);
  }
  if (isPlainObject(out['properties'])) {
    out['type'] = 'object';
    if (!Array.isArray(out['required'])) out['required'] = [];
    out['additionalProperties'] = false;
  }
  return out;
}

// Boot-time guard: a tool whose schema drifted from the contract fails loudly here, not in a step.
function assertCanonical(schema: Record<string, unknown>): void {
  const properties = schema['properties'];
  if (schema['type'] !== 'object' || !isPlainObject(properties)) throw new Error('tool schema must be an object with properties');
  if (schema['additionalProperties'] !== false) throw new Error('tool schema must set additionalProperties:false');
  if (!Array.isArray(schema['required'])) throw new Error('tool schema must list required properties');
  for (const [key, prop] of Object.entries(properties)) {
    if (!isPlainObject(prop) || typeof prop['description'] !== 'string' || typeof prop['type'] !== 'string') {
      throw new Error(`tool property "${key}" needs a type and a description`);
    }
  }
}

export const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

// Providers in strict mode send `null` for omitted optional properties (A7); executors treat null as absent.
export function stripNulls(input: unknown): unknown {
  if (!isPlainObject(input)) return input;
  return Object.fromEntries(Object.entries(input).filter(([, v]) => v !== null));
}

export function toToolDef(spec: ToolSpec, inputSchema: Record<string, unknown>): LlmToolDef {
  return { name: spec.name, description: spec.description, inputSchema };
}
