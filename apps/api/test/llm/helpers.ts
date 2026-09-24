// Fixtures shared by the llm tests. Nothing here touches the network.
import { loadConfig, type Config } from '../../src/config.js';
import type { LlmMessage, LlmRequest, LlmToolDef } from '../../src/core/interfaces.js';

export function testConfig(env: Record<string, string> = {}): Config {
  return loadConfig({ NODE_ENV: 'test', ...env } as NodeJS.ProcessEnv);
}

// Deliberately unsorted, with an optional property, an enum, a nested object and an array so the
// sorting and strict-schema transforms are exercised.
export const TOOL_DEFS: LlmToolDef[] = [
  {
    name: 'write_file',
    description: 'Write a UTF-8 file inside /work. Call before deploy_site.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'bash',
    description: 'Run a shell command in the sandbox.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        timeoutSec: { type: 'number', default: 30, maximum: 120 },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },
  {
    name: 'update_project',
    description: 'Create or update one of your projects.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        name: { type: 'string' },
        kind: { type: 'string', enum: ['site', 'api', 'service', 'product', 'bounty', 'research', 'other'] },
        status: { type: 'string', enum: ['idea', 'building', 'live', 'abandoned'] },
        url: { type: 'string' },
        description: { type: 'string' },
        tags: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' } }, required: ['label'], additionalProperties: false } },
      },
      required: ['name', 'kind', 'status', 'description'],
      additionalProperties: false,
    },
  },
  {
    name: 'deploy_site',
    description: 'Publish a static directory as your public site.',
    inputSchema: {
      type: 'object',
      properties: { dir: { type: 'string' }, slug: { type: 'string' } },
      required: [],
      additionalProperties: false,
    },
  },
];

export const STATUS_TEXT = (over: Record<string, unknown> = {}): string =>
  `STATUS\n${JSON.stringify({
    stepN: 12,
    model: 'mock-strong',
    treasuryMicro: 8_400_000,
    runwayDays: 18.4,
    burnPerDayMicro: 460_000,
    aboutToDie: false,
    projects: [],
    services: [],
    siteUrl: null,
    openBounties: 3,
    memory: ['keep the offer to one sentence'],
    ownerMessages: [],
    walletPubkey: 'DemoWa11et1111111111111111111111111111111111',
    unsettledMicro: 0,
    ...over,
  }, null, 2)}\n\nDirective from your owner: "Earn more than you spend."\n\nDecide and act.`;

export function userTurn(text: string): LlmMessage {
  return { role: 'user', content: [{ type: 'text', text }] };
}

export function makeRequest(over: Partial<LlmRequest> = {}): LlmRequest {
  return {
    model: 'mock-strong',
    system: 'You are TESTER, an autonomous economic agent on VANTRA.',
    messages: [userTurn(STATUS_TEXT())],
    tools: TOOL_DEFS,
    maxTokens: 16_000,
    effort: 'medium',
    agentId: 'ag_testagent0',
    ...over,
  };
}
