// Cross-check: every tool input the mock provider emits must satisfy the real registry's canonical
// schema. Building the registry only reads config/log — no tool is executed, so nothing touches the
// database, the chain or the sandbox.
import { describe, expect, it } from 'vitest';
import { ALL_TOOLS, DEFAULT_CATALOG, type ToolName } from '@vantra/shared';
import type { CoreDeps, LlmContent, LlmMessage, LlmToolDef } from '../../src/core/interfaces.js';
import { silentLogger } from '../../src/lib/log.js';
import { completeMock } from '../../src/llm/providers/mock/index.js';
import { ARCHETYPES, personaFor, type Archetype } from '../../src/llm/providers/mock/persona.js';
import { createToolRegistry } from '../../src/tools/index.js';
import { makeRequest, STATUS_TEXT, testConfig, userTurn } from './helpers.js';

const config = testConfig();
const unavailable = (name: string) => new Proxy({}, { get: () => { throw new Error(`${name} must not be used while building tool defs`); } });
const deps = {
  config, log: silentLogger,
  db: unavailable('db'), clock: { now: () => new Date(0) },
  chain: { mode: config.chain.mode, cluster: config.chain.cluster, usdcMint: config.chain.usdcMint },
  sandbox: { name: 'local' }, search: { name: 'none' }, llm: { mode: 'mock' }, bus: { emit: () => {} },
} as unknown as CoreDeps;

const defs = createToolRegistry(deps).defs([...ALL_TOOLS]);
const schemaFor = new Map(defs.map((d: LlmToolDef) => [d.name, d.inputSchema]));
const model = DEFAULT_CATALOG.find((m) => m.id === 'mock-strong')!;

function agentWith(archetype: Archetype): string {
  for (let i = 0; i < 20_000; i++) {
    const id = `ag_v${String(i).padStart(9, '0')}`;
    if (personaFor(id).archetype === archetype) return id;
  }
  throw new Error(`no agent id drew ${archetype}`);
}

// The canonical schema only uses type / enum / items / required / additionalProperties (tools/spec.ts).
function violations(schema: Record<string, unknown>, value: unknown, path = '$'): string[] {
  const out: string[] = [];
  const type = schema['type'];
  if (type === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return [`${path}: expected object`];
    const properties = (schema['properties'] ?? {}) as Record<string, Record<string, unknown>>;
    for (const key of (schema['required'] ?? []) as string[]) {
      if (!(key in (value as object))) out.push(`${path}.${key}: required but missing`);
    }
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      const child = properties[key];
      if (!child) out.push(`${path}.${key}: not in the schema`);
      else out.push(...violations(child, v, `${path}.${key}`));
    }
    return out;
  }
  const enumValues = schema['enum'];
  if (Array.isArray(enumValues) && !enumValues.includes(value)) out.push(`${path}: ${JSON.stringify(value)} not in ${JSON.stringify(enumValues)}`);
  if (type === 'string' && typeof value !== 'string') out.push(`${path}: expected string, got ${typeof value}`);
  if (type === 'number' && typeof value !== 'number') out.push(`${path}: expected number, got ${typeof value}`);
  if (type === 'integer' && !Number.isInteger(value)) out.push(`${path}: expected integer`);
  if (type === 'boolean' && typeof value !== 'boolean') out.push(`${path}: expected boolean`);
  if (type === 'array') {
    if (!Array.isArray(value)) out.push(`${path}: expected array`);
    else if (schema['items']) value.forEach((v, i) => out.push(...violations(schema['items'] as Record<string, unknown>, v, `${path}[${i}]`)));
  }
  return out;
}

// Every tool call the mock makes for one agent, over a full step with results fed back.
function callsFor(agentId: string, status: Record<string, unknown> = {}): { name: ToolName; input: unknown }[] {
  const tools: LlmToolDef[] = defs;
  const messages: LlmMessage[] = [userTurn(STATUS_TEXT(status))];
  const made: { name: ToolName; input: unknown }[] = [];
  for (let round = 1; round <= 8; round++) {
    const res = completeMock(makeRequest({ agentId, messages: [...messages], tools }), model);
    const uses = res.content.filter((c): c is Extract<LlmContent, { type: 'tool_use' }> => c.type === 'tool_use');
    made.push(...uses.map((u) => ({ name: u.name as ToolName, input: u.input })));
    messages.push({ role: 'assistant', content: res.content });
    if (uses.length === 0) break;
    messages.push({
      role: 'user',
      content: uses.map((u) => ({ type: 'tool_result' as const, toolUseId: u.id, content: 'ok — bt_aaaaaaaaaa sv_bbbbbbbbbb pj_cccccccccc https://sites.test/demo/' })),
    });
  }
  return made;
}

describe('mock tool inputs match the registry schemas', () => {
  it('builds every registry def without touching runtime dependencies', () => {
    expect(defs.map((d) => d.name).sort()).toEqual([...ALL_TOOLS].sort());
  });

  it.each(ARCHETYPES)('%s emits only valid tool inputs', (archetype) => {
    const agentId = agentWith(archetype);
    const calls = [
      ...callsFor(agentId),
      ...callsFor(agentId, { runwayDays: 0.8, treasuryMicro: 300_000, memory: Array(40).fill('note'), ownerMessages: [{ text: 'hi' }] }),
      ...callsFor(agentId, { services: [{ id: 'sv_dddddddddd', name: 'x' }], siteUrl: 'https://sites.test/demo/', projects: [{ name: 'p', status: 'live' }] }),
    ];
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      const schema = schemaFor.get(call.name);
      expect(schema, `${call.name} is not a registry tool`).toBeDefined();
      expect(violations(schema!, call.input), `${call.name} ${JSON.stringify(call.input).slice(0, 200)}`).toEqual([]);
    }
  });

  it('covers a broad slice of the tool surface across the colony', () => {
    const used = new Set<string>();
    for (let i = 0; i < 300; i++) {
      for (const call of callsFor(`ag_w${String(i).padStart(9, '0')}`)) used.add(call.name);
    }
    for (const name of ['write_file', 'deploy_site', 'create_service', 'list_bounties', 'claim_bounty', 'submit_bounty', 'web_search', 'remember', 'sleep', 'post_update', 'update_project', 'bash']) {
      expect(used, `expected the colony to use ${name}`).toContain(name);
    }
  });
});
