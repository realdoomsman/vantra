// Scripted doubles for the three collaborators the economy and the runtime talk to: the LLM router,
// the tool registry and the sandbox. The chain is the real in-memory adapter.
import { DEFAULT_CATALOG, estimateMicro, priceUsage, type ModelInfo } from '@vantra/shared';
import type {
  LlmRequest, LlmResponse, LlmRouter, LlmToolDef, SandboxDriver, SandboxExecResult, SandboxFile, ToolContext,
  ToolExecOpts, ToolRegistry, ToolResult,
} from '../../../src/core/interfaces.js';

// ---- LLM -------------------------------------------------------------------
export type Reply = Partial<LlmResponse> | ((req: LlmRequest) => Partial<LlmResponse> | Promise<Partial<LlmResponse>>);

export interface FakeLlm extends LlmRouter { requests: LlmRequest[] }

const MOCK_MODELS: ModelInfo[] = DEFAULT_CATALOG.filter((m) => m.provider === 'mock');

export function fakeLlm(opts: { replies?: Reply[]; models?: ModelInfo[]; mode?: 'router' | 'mock' } = {}): FakeLlm {
  const models = opts.models ?? MOCK_MODELS;
  const replies: Reply[] = [...(opts.replies ?? [])];
  const requests: LlmRequest[] = [];

  return {
    mode: opts.mode ?? 'mock',
    requests,
    models: () => models,
    resolve(id) {
      const found = models.find((m) => m.id === id);
      if (!found) throw new Error(`unknown model ${id}`);
      return found;
    },
    cheapest: () => [...models].sort((a, b) => estimateMicro(a, 3000, 600) - estimateMicro(b, 3000, 600))[0]!,
    estimateMicro: (model, inTok, outTok) => estimateMicro(model, inTok, outTok),
    refreshPricing: async () => undefined,
    async complete(req) {
      // Snapshot the messages: the step loop keeps mutating the same array between rounds.
      requests.push({ ...req, messages: structuredClone(req.messages) });
      const next = replies.shift() ?? textReply('(default reply)');
      const partial = typeof next === 'function' ? await next(req) : next;
      const model = models.find((m) => m.id === req.model) ?? models[0]!;
      const content = partial.content ?? [{ type: 'text', text: 'ok' }];
      const usage = partial.usage ?? defaultUsage(model, req, content);
      return {
        content, usage, model: req.model,
        stopReason: partial.stopReason ?? (content.some((c) => c.type === 'tool_use') ? 'tool_use' : 'end_turn'),
        ...(partial.stopDetails ? { stopDetails: partial.stopDetails } : {}),
        ...(partial.payment ? { payment: partial.payment } : {}),
      };
    },
  };
}

function defaultUsage(model: ModelInfo, req: LlmRequest, content: LlmResponse['content']) {
  const inputTokens = Math.ceil((req.system.length + JSON.stringify(req.messages).length) / 4);
  const outputTokens = Math.ceil(JSON.stringify(content).length / 4);
  const usage = { inputTokens, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0, costMicro: 0 };
  return { ...usage, costMicro: priceUsage(model, usage) };
}

export const textReply = (text: string, extra: Partial<LlmResponse> = {}): Reply => ({
  content: [{ type: 'text', text }], stopReason: 'end_turn', ...extra,
});

export const toolReply = (name: string, input: unknown, opts: { id?: string; text?: string } = {}): Reply => ({
  content: [
    ...(opts.text ? [{ type: 'text' as const, text: opts.text }] : []),
    { type: 'tool_use' as const, id: opts.id ?? `tu_${name}`, name, input },
  ],
  stopReason: 'tool_use',
});

export const fixedUsage = (costMicro: number, tokens = 100) => ({
  inputTokens: tokens, outputTokens: tokens, cacheReadTokens: 0, cacheWriteTokens: 0, costMicro,
});

// ---- Tools -----------------------------------------------------------------
export type ToolHandler = ToolResult | ((input: unknown, ctx: ToolContext, opts: ToolExecOpts) => ToolResult | Promise<ToolResult>);
export interface FakeToolSpec { run: ToolHandler; parallelSafe?: boolean }

export interface FakeTools extends ToolRegistry {
  calls: { name: string; input: unknown; round: number }[];
}

export function fakeTools(specs: Record<string, FakeToolSpec | ToolHandler> = {}): FakeTools {
  const calls: { name: string; input: unknown; round: number }[] = [];
  const spec = (name: string): FakeToolSpec | undefined => {
    const entry = specs[name];
    if (entry === undefined) return undefined;
    return typeof entry === 'object' && 'run' in entry ? entry : { run: entry as ToolHandler };
  };
  return {
    calls,
    defs: (enabled): LlmToolDef[] => enabled.map((name) => ({
      name, description: `fake ${name}`,
      inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    })),
    parallelSafe: (name) => spec(name)?.parallelSafe === true,
    summarize: (name, input) => `${name} ${JSON.stringify(input) ?? ''}`.slice(0, 160),
    async execute(ctx, name, input, opts) {
      calls.push({ name, input, round: ctx.round });
      const found = spec(name);
      if (!found) return { content: `Unknown tool "${name}".`, costMicro: 0, isError: true };
      return typeof found.run === 'function' ? found.run(input, ctx, opts) : found.run;
    },
  };
}

export const toolOk = (content: string, extra: Partial<ToolResult> = {}): ToolResult => ({ content, costMicro: 0, ...extra });

// ---- Sandbox ---------------------------------------------------------------
export interface FakeSandbox extends SandboxDriver {
  files: Map<string, Map<string, string>>;
  stopped: Set<string>;
  destroyed: Set<string>;
  exec_: { agentId: string; command: string }[];
  nextExec: SandboxExecResult | null;
}

export function fakeSandbox(): FakeSandbox {
  const files = new Map<string, Map<string, string>>();
  const stopped = new Set<string>();
  const destroyed = new Set<string>();
  const exec_: { agentId: string; command: string }[] = [];
  const of = (agentId: string): Map<string, string> => {
    const existing = files.get(agentId) ?? new Map<string, string>();
    files.set(agentId, existing);
    return existing;
  };

  const driver: FakeSandbox = {
    name: 'local', files, stopped, destroyed, exec_, nextExec: null,
    async ensure(agentId) { of(agentId); stopped.delete(agentId); },
    async exec(agentId, command) {
      exec_.push({ agentId, command });
      return driver.nextExec ?? { stdout: '', stderr: '', exitCode: 0, cpuMs: 10, timedOut: false };
    },
    async writeFile(agentId, path, content) { of(agentId).set(path, content); },
    async readFile(agentId, path, maxBytes) {
      const content = of(agentId).get(path);
      if (content === undefined) throw new Error(`no such file ${path}`);
      return content.slice(0, maxBytes);
    },
    async listFiles(agentId, path): Promise<SandboxFile[]> {
      const prefix = path === '.' || path === '' ? '' : `${path}/`;
      return [...of(agentId).entries()]
        .filter(([p]) => p.startsWith(prefix))
        .map(([p, content]) => ({ path: p, bytes: content.length, dir: false }));
    },
    async exportDir() { return { bytes: 0, files: 0 }; },
    async destroy(agentId) { destroyed.add(agentId); files.delete(agentId); },
    async stop(agentId) { stopped.add(agentId); },
    async start(agentId) { stopped.delete(agentId); },
  };
  return driver;
}

