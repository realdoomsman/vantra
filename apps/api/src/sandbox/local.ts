// SANDBOX_DRIVER=local: runs commands with child_process in DATA_DIR/sandboxes/<agentId>. SPEC §8.2, §8.17.
// NOT isolated — same user, same network, same filesystem as the API. Dev only; refuses in production.
import { spawn, type ChildProcess } from 'node:child_process';
import { constants as osConstants } from 'node:os';
import { copyFile, lstat, mkdir, open, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { SandboxDriver, SandboxExecResult, SandboxFile } from '../core/interfaces.js';
import type { Logger } from '../lib/log.js';
import {
  MAX_EXPORT_FILES, OUTPUT_CAP_BYTES, OutputCollector, SandboxLimitError, SandboxPathError, assertAgentId,
  normalizeRelPath, truncationNote,
} from './common.js';

export interface LocalSandboxOptions { dataDir: string; isProduction: boolean; log: Logger }

const CLOSE_GRACE_MS = 2_000;   // after exit, give orphaned stdio this long before force-closing

export function createLocalSandbox(opts: LocalSandboxOptions): SandboxDriver {
  if (opts.isProduction) throw new Error('SANDBOX_DRIVER=local is not isolated and refuses to run when NODE_ENV=production; use docker');
  const root = path.resolve(opts.dataDir, 'sandboxes');
  opts.log.warn(
    { root },
    '!!! SANDBOX_DRIVER=local: agent commands run UNISOLATED on this host as the API user (no container, no limits). Development only. !!!',
  );
  return new LocalSandbox(root, opts.log);
}

class LocalSandbox implements SandboxDriver {
  readonly name = 'local' as const;

  constructor(private readonly root: string, private readonly log: Logger) {}

  private dirOf(agentId: string): string {
    assertAgentId(agentId);
    return path.join(this.root, agentId);
  }

  private async ensureDir(agentId: string): Promise<string> {
    const dir = this.dirOf(agentId);
    await mkdir(dir, { recursive: true });
    return dir;
  }

  // Resolves an existing /work-relative path and proves (via realpath) that it stays inside the workdir,
  // so a symlink planted by `bash` cannot redirect a read or export outside the sandbox.
  private async resolveExisting(agentId: string, rel: string, allowRoot = false): Promise<string> {
    const dir = await this.ensureDir(agentId);
    const normalized = normalizeRelPath(rel, { allowRoot });
    const [realRoot, realTarget] = await Promise.all([realpath(dir), realpath(path.join(dir, normalized)).catch(() => null)]);
    if (realTarget === null) throw new SandboxPathError(`no such file or directory: ${normalized || '.'}`);
    assertInside(realRoot, realTarget, normalized);
    return realTarget;
  }

  async ensure(agentId: string): Promise<void> {
    await this.ensureDir(agentId);
  }

  async exec(agentId: string, command: string, opts: { timeoutMs: number; stdin?: string }): Promise<SandboxExecResult> {
    const cwd = await this.ensureDir(agentId);
    const started = Date.now();
    return new Promise<SandboxExecResult>((resolve) => {
      const child = spawn('sh', ['-lc', command], {
        cwd,
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: cwd, LANG: 'C.UTF-8', TERM: 'dumb' },
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,   // own process group so a timeout kills the whole tree
      });
      const out = new OutputCollector(OUTPUT_CAP_BYTES);
      const err = new OutputCollector(OUTPUT_CAP_BYTES);
      child.stdout.pipe(out);
      child.stderr.pipe(err);
      let timedOut = false;
      let done = false;
      const finish = (exitCode: number, stderrOverride?: string) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        const elapsed = Date.now() - started;
        resolve({ stdout: out.text(), stderr: stderrOverride ?? err.text(), exitCode, cpuMs: elapsed, timedOut });
      };
      const timer = setTimeout(() => {
        timedOut = true;
        killTree(child);
      }, opts.timeoutMs);
      child.stdin.on('error', () => { /* EPIPE when the command never reads stdin */ });
      child.stdin.end(opts.stdin ?? '');
      child.on('error', (e) => finish(127, e.message));
      child.on('exit', () => {
        setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); }, CLOSE_GRACE_MS).unref();
      });
      child.on('close', (code, signal) => finish(code ?? 128 + (signal ? osConstants.signals[signal] ?? 0 : 0)));
    });
  }

  async writeFile(agentId: string, rel: string, content: string): Promise<void> {
    const dir = await this.ensureDir(agentId);
    const normalized = normalizeRelPath(rel);
    const target = path.join(dir, normalized);
    await mkdir(path.dirname(target), { recursive: true });
    const [realRoot, realParent] = await Promise.all([realpath(dir), realpath(path.dirname(target))]);
    assertInside(realRoot, realParent, normalized);
    const existing = await lstat(target).catch(() => null);
    if (existing?.isSymbolicLink()) throw new SandboxPathError(`refusing to write through a symlink: ${normalized}`);
    await writeFile(target, content, 'utf8');
  }

  async readFile(agentId: string, rel: string, maxBytes: number): Promise<string> {
    const target = await this.resolveExisting(agentId, rel);
    const st = await stat(target);
    if (!st.isFile()) throw new SandboxPathError(`not a file: ${rel}`);
    const fh = await open(target, 'r');
    try {
      const buf = Buffer.alloc(Math.min(maxBytes, st.size));
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      return buf.subarray(0, bytesRead).toString('utf8') + truncationNote(st.size, bytesRead);
    } finally {
      await fh.close();
    }
  }

  async listFiles(agentId: string, rel: string): Promise<SandboxFile[]> {
    const target = await this.resolveExisting(agentId, rel, true);
    const st = await stat(target);
    if (!st.isDirectory()) throw new SandboxPathError(`not a directory: ${rel}`);
    const base = normalizeRelPath(rel, { allowRoot: true });
    const entries = await readdir(target, { withFileTypes: true });
    const files = await Promise.all(entries.map(async (e): Promise<SandboxFile> => {
      const s = await lstat(path.join(target, e.name));
      return { path: base ? `${base}/${e.name}` : e.name, bytes: s.isFile() ? s.size : 0, dir: s.isDirectory() };
    }));
    return files.sort((a, b) => a.path.localeCompare(b.path));
  }

  async exportDir(agentId: string, rel: string, destDir: string, maxBytes: number): Promise<{ bytes: number; files: number }> {
    const src = await this.resolveExisting(agentId, rel, true);
    const st = await stat(src);
    if (!st.isDirectory()) throw new SandboxPathError(`not a directory: ${rel}`);
    await mkdir(destDir, { recursive: true });
    const totals = { bytes: 0, files: 0 };
    await copyTree(src, destDir, maxBytes, totals);
    return totals;
  }

  async destroy(agentId: string): Promise<void> {
    await rm(this.dirOf(agentId), { recursive: true, force: true });
  }

  async stop(agentId: string): Promise<void> {
    this.log.debug({ agentId }, 'local sandbox: stop is a no-op');
  }

  async start(agentId: string): Promise<void> {
    await this.ensureDir(agentId);
  }
}

function assertInside(realRoot: string, realTarget: string, rel: string): void {
  if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) {
    throw new SandboxPathError(`path escapes the sandbox: ${rel}`);
  }
}

function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

// Copies regular files and directories only (symlinks and special files are skipped), enforcing caps as it goes.
async function copyTree(src: string, dst: string, maxBytes: number, totals: { bytes: number; files: number }): Promise<void> {
  const entries = (await readdir(src, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    const from = path.join(src, e.name);
    const to = path.join(dst, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) {
      await mkdir(to, { recursive: true });
      await copyTree(from, to, maxBytes, totals);
    } else if (e.isFile()) {
      const s = await stat(from);
      totals.bytes += s.size;
      totals.files += 1;
      if (totals.bytes > maxBytes) throw new SandboxLimitError(`directory exceeds ${maxBytes} bytes`);
      if (totals.files > MAX_EXPORT_FILES) throw new SandboxLimitError(`directory has more than ${MAX_EXPORT_FILES} files`);
      await copyFile(from, to);
    }
  }
}
