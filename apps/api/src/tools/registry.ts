// ToolRegistry: canonical schemas, validated execution that never throws, cost accounting in the
// ToolResult, parallel-safety flags and secret-free input summaries. SPEC §8.9; AMENDMENTS A7, B12, C27.
import { isSandboxTool, toolsAvailable, type SandboxName, type ToolName } from '@vantra/shared';
import type { z } from 'zod';
import type { EventBus, LlmToolDef, ToolContext, ToolExecOpts, ToolRegistry, ToolResult } from '../core/interfaces.js';
import { errorMessage } from '../lib/errors.js';
import type { Logger } from '../lib/log.js';
import { fail } from './common.js';
import { stripNulls, toInputSchema, toToolDef, type ToolSpec } from './spec.js';

export const INPUT_SUMMARY_MAX = 160;

interface Entry { spec: ToolSpec; def: LlmToolDef }

// `sandbox` is the deployment's SANDBOX_DRIVER. Under `none` this is the one place SANDBOX_TOOLS are
// withheld: never offered to a model (`defs`) and refused if a call names one anyway (`execute`).
export function buildRegistry(specs: ToolSpec[], bus: EventBus, log: Logger, sandbox: SandboxName): ToolRegistry {
  const entries = new Map<ToolName, Entry>();
  for (const spec of specs) {
    if (entries.has(spec.name)) throw new Error(`duplicate tool ${spec.name}`);
    entries.set(spec.name, { spec, def: toToolDef(spec, toInputSchema(spec.params)) });
  }

  const registry: ToolRegistry = {
    defs(enabled) {
      return [...new Set(toolsAvailable(enabled, sandbox))]
        .map((name) => entries.get(name)?.def)
        .filter((d): d is LlmToolDef => d !== undefined)
        .sort((a, b) => a.name.localeCompare(b.name));
    },

    async execute(ctx: ToolContext, name: string, input: unknown, opts: ToolExecOpts): Promise<ToolResult> {
      const entry = entries.get(name as ToolName);
      if (!entry) return fail(`Unknown tool "${name}".`);
      const tool = entry.spec.name;
      const started = Date.now();
      // The WS 'tool' message (AMENDMENTS C27) is emitted here for every attempt, successful or not:
      // this is the only place that knows the real cost, the outcome and how long the call took.
      const broadcast = (result: ToolResult): ToolResult => {
        const ms = Date.now() - started;
        bus.emit({
          type: 'tool', agentId: ctx.agent.id, stepId: ctx.stepId, round: ctx.round, name: tool,
          inputSummary: registry.summarize(tool, input), costMicro: result.costMicro, ok: !result.isError, ms,
        });
        ctx.log.debug({ tool, ms, costMicro: result.costMicro, ok: !result.isError }, 'tool ran');
        return result;
      };

      if (sandbox === 'none' && isSandboxTool(tool)) {
        return broadcast(fail(
          `Tool "${name}" is not available on this deployment: it needs a code sandbox and this server runs without one `
          + '(SANDBOX_DRIVER=none). Nothing was run.',
        ));
      }
      if (!ctx.agent.enabledTools.includes(tool)) return broadcast(fail(`Tool "${name}" is not enabled for this agent.`));
      if (opts.signal.aborted) return broadcast(fail(`${name} was not run: the step was aborted.`));

      const parsed = entry.spec.params.safeParse(stripNulls(input));
      if (!parsed.success) return broadcast(fail(`Invalid input for ${name}: ${formatIssues(parsed.error)}`));

      try {
        return broadcast(await entry.spec.run(ctx, parsed.data, opts));
      } catch (e) {
        ctx.log.warn({ tool, err: e }, 'tool threw');
        return broadcast(fail(`${name} failed: ${errorMessage(e)}`));
      }
    },

    parallelSafe(name) {
      return entries.get(name)?.spec.parallelSafe ?? false;
    },

    summarize(name, input) {
      const entry = entries.get(name);
      const parsed = entry?.spec.params.safeParse(stripNulls(input));
      const raw = entry && parsed?.success ? entry.spec.summarize(parsed.data) : summarizeKeys(input);
      return truncateSummary(redactSecrets(raw));
    },
  };

  return registry;

  function summarizeKeys(input: unknown): string {
    if (typeof input !== 'object' || input === null) return '';
    const keys = Object.keys(input);
    log.debug({ keys }, 'summarize fell back to key names (input did not validate)');
    return keys.join(', ');
  }
}

function formatIssues(err: z.ZodError): string {
  return err.issues
    .map((i) => (i.path.length ? `${i.path.map(String).join('.')}: ${i.message}` : i.message))
    .join('; ');
}

const SECRET_PATTERNS: [RegExp, string][] = [
  [/\b(sk|rk|pk|xox[abp]|ghp|gho|github_pat)[-_][A-Za-z0-9_-]{8,}/g, '[redacted]'],              // vendor-prefixed API keys
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [redacted]'],                               // Authorization values
  [/\b([A-Za-z0-9_-]*(?:api[_-]?key|token|secret|password|passwd|private[_-]?key)[A-Za-z0-9_-]*)(\s*[=:]\s*)(["']?)[^\s"'&,;]{4,}\3/gi, '$1$2[redacted]'],
  [/\b[A-Fa-f0-9]{40,}\b/g, '[redacted]'],                                                        // long hex (keys, hashes)
  [/\b[1-9A-HJ-NP-Za-km-z]{64,}\b/g, '[redacted]'],                                               // base58 secret keys
];

// Input summaries are broadcast to every observatory client: scrub anything key-shaped.
export function redactSecrets(s: string): string {
  return SECRET_PATTERNS.reduce((out, [re, repl]) => out.replace(re, repl), s);
}

function truncateSummary(s: string): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length <= INPUT_SUMMARY_MAX ? oneLine : `${oneLine.slice(0, INPUT_SUMMARY_MAX - 1)}…`;
}
