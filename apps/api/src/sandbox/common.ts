// Shared sandbox helpers: agent-id and /work-relative path validation, output capture caps.
import { Writable } from 'node:stream';

export const AGENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const OUTPUT_CAP_BYTES = 1024 * 1024;     // per stream; tools truncate further (SPEC §8.9)
export const MAX_EXPORT_FILES = 5_000;           // exportDir file-count guard next to the byte cap
export const WORK_DIR = '/work';

export class SandboxPathError extends Error {
  override readonly name = 'SandboxPathError';
}

export class SandboxLimitError extends Error {
  override readonly name = 'SandboxLimitError';
}

// SANDBOX_DRIVER=none: the tools that would reach a sandbox are withheld by the registry, so this is
// only ever thrown if something bypasses that — and then it must fail loudly, never return nothing.
export class SandboxUnavailableError extends Error {
  override readonly name = 'SandboxUnavailableError';
}

export function assertAgentId(agentId: string): void {
  if (!AGENT_ID_RE.test(agentId)) throw new SandboxPathError(`invalid agent id: ${JSON.stringify(agentId)}`);
}

// Normalises a path relative to /work: no absolute paths, no '~', no '..' segments, no NUL bytes.
// Returns '' for the root only when `allowRoot` is set.
export function normalizeRelPath(rel: string, opts: { allowRoot?: boolean } = {}): string {
  if (typeof rel !== 'string') throw new SandboxPathError('path must be a string');
  if (rel.includes('\0')) throw new SandboxPathError('path contains a NUL byte');
  const trimmed = rel.trim();
  if (trimmed.startsWith('/') || trimmed.startsWith('~')) throw new SandboxPathError(`path must be relative to ${WORK_DIR}: ${trimmed}`);
  const segments = trimmed.split('/').filter((s) => s !== '' && s !== '.');
  if (segments.includes('..')) throw new SandboxPathError(`path may not contain '..': ${trimmed}`);
  if (segments.length === 0) {
    if (opts.allowRoot) return '';
    throw new SandboxPathError(`path must name a file or directory inside ${WORK_DIR}`);
  }
  return segments.join('/');
}

// POSIX single-quote shell quoting: safe for any byte sequence, including newlines.
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// Collects a stream into memory up to `cap` bytes; anything beyond is dropped and flagged.
export class OutputCollector extends Writable {
  private readonly chunks: Buffer[] = [];
  private size = 0;
  truncated = false;

  constructor(private readonly cap: number) {
    super();
  }

  override _write(chunk: Buffer, _enc: BufferEncoding, cb: (error?: Error | null) => void): void {
    const room = this.cap - this.size;
    if (room <= 0) {
      this.truncated = true;
    } else {
      const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
      this.chunks.push(part);
      this.size += part.length;
      if (chunk.length > room) this.truncated = true;
    }
    cb();
  }

  text(): string {
    const body = Buffer.concat(this.chunks).toString('utf8');
    return this.truncated ? `${body}\n…[output truncated at ${this.cap} bytes]` : body;
  }
}

export function truncationNote(totalBytes: number, keptBytes: number): string {
  return totalBytes > keptBytes ? `\n…[truncated ${totalBytes - keptBytes} bytes]` : '';
}
