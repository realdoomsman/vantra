// Every registry schema must satisfy BOTH strict-mode dialects: the canonical Anthropic shape the
// registry emits, and the OpenAI-strict transform applied by the provider (AMENDMENTS A7).
import { describe, expect, it } from 'vitest';
import { ALL_TOOLS, type ToolName } from '@vantra/shared';
import { toStrictSchema } from '../../src/llm/schema.js';
import { createToolRegistry } from '../../src/tools/index.js';
import { ALL_TOOL_NAMES, fakePorts, testDeps } from './helpers/env.js';
import type { Db } from '../../src/db/client.js';

// Schemas are built at construction time and never touch the database.
const registry = createToolRegistry(testDeps(null as unknown as Db), fakePorts());
const defs = registry.defs(ALL_TOOL_NAMES);

type Json = Record<string, unknown>;
const isJson = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

// Keywords Anthropic strict tool use and OpenAI strict function calling both reject.
const FORBIDDEN_KEYWORDS = [
  '$schema', '$ref', '$defs', 'definitions', 'default', 'minimum', 'maximum', 'exclusiveMinimum',
  'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'pattern', 'format', 'minItems', 'maxItems',
  'uniqueItems', 'patternProperties', 'not', 'if', 'then', 'else',
];

function walk(node: unknown, visit: (n: Json, path: string) => void, path = '$'): void {
  if (Array.isArray(node)) {
    node.forEach((child, i) => walk(child, visit, `${path}[${i}]`));
    return;
  }
  if (!isJson(node)) return;
  visit(node, path);
  for (const [key, value] of Object.entries(node)) walk(value, visit, `${path}.${key}`);
}

describe('tool schemas', () => {
  it('exposes exactly the ToolName union, sorted by name', () => {
    expect(defs.map((d) => d.name)).toEqual([...ALL_TOOLS].sort((a, b) => a.localeCompare(b)));
  });

  it('returns only the enabled subset', () => {
    const enabled: ToolName[] = ['sleep', 'bash', 'wallet'];
    expect(registry.defs(enabled).map((d) => d.name)).toEqual(['bash', 'sleep', 'wallet']);
    expect(registry.defs([])).toEqual([]);
  });

  it('deduplicates and ignores unknown names', () => {
    expect(registry.defs(['sleep', 'sleep', 'nope' as ToolName]).map((d) => d.name)).toEqual(['sleep']);
  });

  for (const def of defs) {
    describe(def.name, () => {
      it('is a closed object with an explicit required list', () => {
        const schema = def.inputSchema;
        expect(schema['type']).toBe('object');
        expect(schema['additionalProperties']).toBe(false);
        expect(Array.isArray(schema['required'])).toBe(true);
        expect(isJson(schema['properties'])).toBe(true);
      });

      it('gives every property a scalar type and a description', () => {
        const properties = def.inputSchema['properties'] as Json;
        expect(Object.keys(properties).length).toBeGreaterThan(0);
        for (const [key, prop] of Object.entries(properties)) {
          expect(isJson(prop), `${key} must be an object`).toBe(true);
          const p = prop as Json;
          expect(typeof p['type'], `${key} needs a type`).toBe('string');
          expect(typeof p['description'], `${key} needs a description`).toBe('string');
          expect((p['description'] as string).length).toBeGreaterThan(9);
        }
      });

      it('lists required properties that actually exist', () => {
        const properties = Object.keys(def.inputSchema['properties'] as Json);
        for (const key of def.inputSchema['required'] as string[]) expect(properties).toContain(key);
      });

      it('uses no keyword a strict-mode provider rejects', () => {
        walk(def.inputSchema, (node, path) => {
          for (const keyword of FORBIDDEN_KEYWORDS) {
            expect(Object.hasOwn(node, keyword), `${path} must not use "${keyword}"`).toBe(false);
          }
        });
      });

      it('survives the OpenAI strict transform with every property required and nullable optionals', () => {
        const strict = toStrictSchema(def.inputSchema);
        const canonicalProps = Object.keys(def.inputSchema['properties'] as Json);
        const canonicalRequired = new Set(def.inputSchema['required'] as string[]);
        expect(strict['additionalProperties']).toBe(false);
        expect(strict['required']).toEqual(canonicalProps);

        const strictProps = strict['properties'] as Json;
        for (const key of canonicalProps) {
          const prop = strictProps[key] as Json;
          const type = prop['type'];
          if (canonicalRequired.has(key)) {
            expect(typeof type, `${key} stays a scalar type`).toBe('string');
          } else {
            expect(Array.isArray(type) && type.includes('null'), `${key} becomes nullable`).toBe(true);
          }
        }
        walk(strict, (node) => expect(Object.hasOwn(node, 'default')).toBe(false));
      });

      it('has a description that says when to call it', () => {
        expect(def.description.length).toBeGreaterThan(120);
        expect(def.description).toMatch(/\b(call it|call this|use it)\b/i);
      });

      it('states its cost', () => {
        expect(def.description).toMatch(/free\b|costs?\b|\$\d|price/i);
      });
    });
  }

  it('charges only the metered tools', () => {
    const paid = new Set<ToolName>(['web_search', 'fetch_url', 'bash', 'deploy_site', 'call_service', 'post_bounty']);
    for (const def of defs) {
      const saysFree = /\bfree\b/i.test(def.description);
      expect(saysFree, `${def.name} free-ness`).toBe(!paid.has(def.name as ToolName));
    }
  });

  it('marks read-only tools parallel-safe and mutating tools not', () => {
    const parallel = defs.filter((d) => registry.parallelSafe(d.name as ToolName)).map((d) => d.name);
    expect(parallel.sort()).toEqual(['fetch_url', 'list_bounties', 'list_files', 'list_services', 'read_file', 'wallet', 'web_search']);
  });
});
