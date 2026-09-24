// SANDBOX_DRIVER=local driver: exec, timeouts, path confinement and exportDir caps (SPEC §8.17).
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SandboxDriver } from '../../src/core/interfaces.js';
import { silentLogger } from '../../src/lib/log.js';
import { SandboxLimitError, SandboxPathError } from '../../src/sandbox/common.js';
import { createLocalSandbox } from '../../src/sandbox/local.js';

const AGENT = 'ag_test01';
let dataDir: string;
let sandbox: SandboxDriver;
const workdir = () => path.join(dataDir, 'sandboxes', AGENT);

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'vantra-sbx-'));
  sandbox = createLocalSandbox({ dataDir, isProduction: false, log: silentLogger });
  await sandbox.ensure(AGENT);
});
afterEach(async () => { await rm(dataDir, { recursive: true, force: true }); });

describe('createLocalSandbox', () => {
  it('refuses to run in production', () => {
    expect(() => createLocalSandbox({ dataDir, isProduction: true, log: silentLogger })).toThrow(/NODE_ENV=production/);
  });

  it('rejects agent ids that are not safe path segments', async () => {
    await expect(sandbox.ensure('../escape')).rejects.toBeInstanceOf(SandboxPathError);
    await expect(sandbox.exec('a/b', 'true', { timeoutMs: 1_000 })).rejects.toBeInstanceOf(SandboxPathError);
  });
});

describe('exec', () => {
  it('runs in the agent workdir and reports the exit code', async () => {
    const res = await sandbox.exec(AGENT, 'pwd && echo err >&2 && exit 3', { timeoutMs: 5_000 });
    expect(res.exitCode).toBe(3);
    expect(res.stdout.trim()).toBe(await realpathOf(workdir()));
    expect(res.stderr.trim()).toBe('err');
    expect(res.timedOut).toBe(false);
    expect(res.cpuMs).toBeGreaterThanOrEqual(0);
  });

  it('feeds stdin to the command', async () => {
    const res = await sandbox.exec(AGENT, 'cat', { timeoutMs: 5_000, stdin: '{"hello":"world"}' });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe('{"hello":"world"}');
  });

  it('does not hang when the command ignores stdin', async () => {
    const res = await sandbox.exec(AGENT, 'echo done', { timeoutMs: 5_000, stdin: 'x'.repeat(100_000) });
    expect(res.stdout.trim()).toBe('done');
  });

  it('kills the whole process tree on timeout', async () => {
    const started = Date.now();
    const res = await sandbox.exec(AGENT, 'sleep 30 & sleep 30; echo never', { timeoutMs: 300 });
    expect(res.timedOut).toBe(true);
    expect(res.stdout).not.toContain('never');
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('writes files that later execs and readFile can see', async () => {
    await sandbox.exec(AGENT, 'mkdir -p site && printf hello > site/index.html', { timeoutMs: 5_000 });
    expect(await sandbox.readFile(AGENT, 'site/index.html', 1_000)).toBe('hello');
  });
});

describe('path confinement', () => {
  it('rejects absolute paths, traversal and NUL bytes', async () => {
    for (const bad of ['/etc/passwd', '../outside.txt', 'a/../../b', '~/secrets', 'a\0b']) {
      await expect(sandbox.writeFile(AGENT, bad, 'x')).rejects.toBeInstanceOf(SandboxPathError);
      await expect(sandbox.readFile(AGENT, bad, 100)).rejects.toBeInstanceOf(SandboxPathError);
    }
  });

  it('refuses to read or write through a symlink that leaves the workdir', async () => {
    const outside = path.join(dataDir, 'outside.txt');
    await writeFile(outside, 'secret', 'utf8');
    await symlink(outside, path.join(workdir(), 'link.txt'));
    await expect(sandbox.readFile(AGENT, 'link.txt', 100)).rejects.toBeInstanceOf(SandboxPathError);
    await expect(sandbox.writeFile(AGENT, 'link.txt', 'pwned')).rejects.toBeInstanceOf(SandboxPathError);
    expect(await readFile(outside, 'utf8')).toBe('secret');
  });

  it('refuses a directory symlink used as a parent', async () => {
    await symlink(dataDir, path.join(workdir(), 'up'));
    await expect(sandbox.writeFile(AGENT, 'up/pwned.txt', 'x')).rejects.toBeInstanceOf(SandboxPathError);
  });
});

describe('readFile / listFiles', () => {
  it('truncates at maxBytes and says so', async () => {
    await sandbox.writeFile(AGENT, 'big.txt', 'abcdefghij');
    const out = await sandbox.readFile(AGENT, 'big.txt', 4);
    expect(out.startsWith('abcd')).toBe(true);
    expect(out).toContain('truncated 6 bytes');
  });

  it('lists the workdir root and nested directories', async () => {
    await sandbox.writeFile(AGENT, 'site/index.html', '<h1>hi</h1>');
    await sandbox.writeFile(AGENT, 'NOTES.md', 'plan');
    const root = await sandbox.listFiles(AGENT, '');
    expect(root.map((f) => f.path)).toEqual(['NOTES.md', 'site']);
    expect(root.find((f) => f.path === 'site')?.dir).toBe(true);
    expect(root.find((f) => f.path === 'NOTES.md')?.bytes).toBe(4);
    expect(await sandbox.listFiles(AGENT, 'site')).toEqual([{ path: 'site/index.html', bytes: 11, dir: false }]);
  });

  it('rejects listing a file and reading a directory', async () => {
    await sandbox.writeFile(AGENT, 'site/index.html', 'x');
    await expect(sandbox.listFiles(AGENT, 'site/index.html')).rejects.toBeInstanceOf(SandboxPathError);
    await expect(sandbox.readFile(AGENT, 'site', 100)).rejects.toBeInstanceOf(SandboxPathError);
    await expect(sandbox.readFile(AGENT, 'nope.txt', 100)).rejects.toBeInstanceOf(SandboxPathError);
  });
});

describe('exportDir', () => {
  it('copies a tree and reports bytes and file count', async () => {
    await sandbox.writeFile(AGENT, 'site/index.html', '12345');
    await sandbox.writeFile(AGENT, 'site/css/app.css', '123');
    const dest = path.join(dataDir, 'out');
    expect(await sandbox.exportDir(AGENT, 'site', dest, 1_000)).toEqual({ bytes: 8, files: 2 });
    expect(await readFile(path.join(dest, 'index.html'), 'utf8')).toBe('12345');
    expect(await readFile(path.join(dest, 'css/app.css'), 'utf8')).toBe('123');
  });

  it('enforces the byte cap', async () => {
    await sandbox.writeFile(AGENT, 'site/big.html', 'x'.repeat(2_000));
    await expect(sandbox.exportDir(AGENT, 'site', path.join(dataDir, 'out'), 1_000)).rejects.toBeInstanceOf(SandboxLimitError);
  });

  it('skips symlinks instead of following them out of the sandbox', async () => {
    await mkdir(path.join(workdir(), 'site'), { recursive: true });
    await writeFile(path.join(dataDir, 'outside.txt'), 'secret', 'utf8');
    await sandbox.writeFile(AGENT, 'site/index.html', 'ok');
    await symlink(path.join(dataDir, 'outside.txt'), path.join(workdir(), 'site', 'leak.txt'));
    const dest = path.join(dataDir, 'out');
    expect(await sandbox.exportDir(AGENT, 'site', dest, 1_000)).toEqual({ bytes: 2, files: 1 });
    await expect(readFile(path.join(dest, 'leak.txt'), 'utf8')).rejects.toThrow();
  });

  it('refuses a path outside the workdir', async () => {
    await expect(sandbox.exportDir(AGENT, '../..', path.join(dataDir, 'out'), 1_000)).rejects.toBeInstanceOf(SandboxPathError);
  });
});

describe('lifecycle', () => {
  it('destroy removes the workdir and ensure recreates it', async () => {
    await sandbox.writeFile(AGENT, 'a.txt', 'x');
    await sandbox.destroy(AGENT);
    await expect(sandbox.listFiles(AGENT, '')).resolves.toEqual([]);   // ensure() recreated an empty dir
    await sandbox.stop(AGENT);
    await sandbox.start(AGENT);
    expect(await sandbox.listFiles(AGENT, '')).toEqual([]);
  });
});

async function realpathOf(p: string): Promise<string> {
  const { realpath } = await import('node:fs/promises');
  return realpath(p);
}
