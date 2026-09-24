// OpenAI strict-mode transform (AMENDMENTS A7): the registry keeps ONE canonical Anthropic-style
// schema; the OpenAI provider must turn it into a valid strict schema without changing meaning.
import { describe, expect, it } from 'vitest';
import { toStrictSchema } from '../../src/llm/schema.js';
import { TOOL_DEFS } from './helpers.js';

type Json = Record<string, unknown>;
const isJson = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

// Every rule OpenAI strict mode enforces on an object schema.
function assertStrict(node: Json, path = '$'): void {
  expect(node, `${path} must not carry a default`).not.toHaveProperty('default');
  if (isJson(node.properties) || node.type === 'object') {
    const properties = isJson(node.properties) ? node.properties : {};
    expect(node.type, `${path} type`).toBe('object');
    expect(node.additionalProperties, `${path} additionalProperties`).toBe(false);
    expect([...(node.required as string[])].sort(), `${path} required`).toEqual(Object.keys(properties).sort());
    for (const [key, child] of Object.entries(properties)) {
      if (isJson(child)) assertStrict(child, `${path}.${key}`);
    }
  }
  if (isJson(node.items)) assertStrict(node.items, `${path}[]`);
  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    const branches = node[key];
    if (Array.isArray(branches)) branches.forEach((b, i) => { if (isJson(b)) assertStrict(b, `${path}.${key}[${i}]`); });
  }
}

const nullableTypes = (node: unknown): string[] => {
  const type = isJson(node) ? node.type : undefined;
  return Array.isArray(type) ? (type as string[]) : typeof type === 'string' ? [type] : [];
};

describe('toStrictSchema', () => {
  it.each(TOOL_DEFS)('produces a valid strict schema for $name', (def) => {
    assertStrict(toStrictSchema(def.inputSchema));
  });

  it('keeps required properties untouched and makes optional ones nullable', () => {
    const strict = toStrictSchema(TOOL_DEFS.find((t) => t.name === 'update_project')!.inputSchema);
    const props = strict.properties as Record<string, Json>;
    expect(nullableTypes(props.name)).toEqual(['string']);
    expect(nullableTypes(props.projectId)).toEqual(['string', 'null']);
    expect(nullableTypes(props.url)).toEqual(['string', 'null']);
    expect(strict.required).toEqual(['projectId', 'name', 'kind', 'status', 'url', 'description', 'tags']);
  });

  it('adds null to the enum of an optional enum property so the value stays valid', () => {
    const strict = toStrictSchema({
      type: 'object',
      properties: { status: { type: 'string', enum: ['active', 'paused'] } },
      required: [],
      additionalProperties: false,
    });
    expect((strict.properties as Record<string, Json>).status).toEqual({ type: ['string', 'null'], enum: ['active', 'paused', null] });
  });

  it('strips defaults, which strict mode rejects', () => {
    const strict = toStrictSchema(TOOL_DEFS.find((t) => t.name === 'bash')!.inputSchema);
    const timeout = (strict.properties as Record<string, Json>).timeoutSec!;
    expect(timeout).not.toHaveProperty('default');
    expect(timeout.maximum).toBe(120);
  });

  it('closes nested objects reached through array items', () => {
    const strict = toStrictSchema(TOOL_DEFS.find((t) => t.name === 'update_project')!.inputSchema);
    const tags = (strict.properties as Record<string, Json>).tags as Json;
    const items = tags.items as Json;
    expect(items.additionalProperties).toBe(false);
    expect(items.required).toEqual(['label']);
  });

  it('does not mutate the canonical schema the registry holds', () => {
    const def = TOOL_DEFS.find((t) => t.name === 'deploy_site')!;
    const before = JSON.stringify(def.inputSchema);
    toStrictSchema(def.inputSchema);
    expect(JSON.stringify(def.inputSchema)).toBe(before);
  });

  it('adds a null branch to anyOf unions exactly once', () => {
    const once = toStrictSchema({
      type: 'object',
      properties: { value: { anyOf: [{ type: 'string' }, { type: 'number' }] } },
      required: [],
      additionalProperties: false,
    });
    const value = (once.properties as Record<string, Json>).value as Json;
    expect(value.anyOf).toEqual([{ type: 'string' }, { type: 'number' }, { type: 'null' }]);
    expect((toStrictSchema(once).properties as Record<string, Json>).value).toEqual(value);
  });
});
