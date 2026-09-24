// SANDBOX_DRIVER=docker (SPEC §8.17). Docker is not installed on the build machine, so the driver is
// exercised against a dockerode double; only the daemon is faked, not the driver's logic.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SandboxDriver } from '../../src/core/interfaces.js';
import { silentLogger } from '../../src/lib/log.js';
import { SandboxLimitError, SandboxPathError } from '../../src/sandbox/common.js';
import {
  EXEC_START_FAILED_EXIT, MEMORY_BYTES, NANO_CPUS, PIDS_LIMIT, SANDBOX_USER, containerCreateOptions,
  containerName, cpuMsFromStats, createDockerSandbox, fileArchiveEntries, parseFindOutput, volumeName,
} from '../../src/sandbox/docker.js';
import { AGENT_NETWORK_DEFAULT, egressFirewallRules, networkCreateOptions } from '../../src/sandbox/egress.js';
import { readTar } from '../../src/sandbox/tar.js';
import { createFakeDocker, httpError, type FakeDocker } from './helpers/fakeDocker.js';

const AGENT = 'ag_docker01';
const IMAGE = 'vantra-sandbox:latest';
let fake: FakeDocker;
let sandbox: SandboxDriver;

beforeEach(() => {
  fake = createFakeDocker();
  sandbox = createDockerSandbox({ image: IMAGE, log: silentLogger, docker: fake.docker });
});

describe('containerCreateOptions', () => {
  it('applies every hardening flag from §8.17', () => {
    const opts = containerCreateOptions(AGENT, IMAGE);
    expect(opts.name).toBe(`rw-${AGENT}`);
    expect(opts.Image).toBe(IMAGE);
    expect(opts.User).toBe(SANDBOX_USER);
    expect(opts.WorkingDir).toBe('/work');
    const host = opts.HostConfig!;
    expect(host.Memory).toBe(MEMORY_BYTES);
    expect(host.MemorySwap).toBe(MEMORY_BYTES);
    expect(host.NanoCpus).toBe(NANO_CPUS);
    expect(host.PidsLimit).toBe(PIDS_LIMIT);
    expect(host.CapDrop).toEqual(['ALL']);
    expect(host.SecurityOpt).toEqual(['no-new-privileges']);
    expect(host.ReadonlyRootfs).toBe(true);
    // docker-init as pid 1: `sleep infinity` reaps nothing (40 backgrounding commands left 40 permanent
    // zombies against a 256 pid limit) and ignores SIGTERM (every stop burned the full 5s grace).
    expect(host.Init).toBe(true);
    expect(host.Tmpfs).toEqual({ '/tmp': expect.stringContaining('nosuid') as unknown as string });
    expect(host.Mounts).toEqual([{ Type: 'volume', Source: `rw-vol-${AGENT}`, Target: '/work' }]);
  });

  // Agents need egress, but not to the default bridge, to each other, or to a metadata service.
  it('puts the container on the dedicated agent network with the metadata hosts blackholed', () => {
    const host = containerCreateOptions(AGENT, IMAGE).HostConfig!;
    expect(host.NetworkMode).toBe(AGENT_NETWORK_DEFAULT);
    expect(host.NetworkMode).not.toBe('bridge');
    expect(host.ExtraHosts).toContain('metadata.google.internal:127.0.0.1');
    expect(host.ExtraHosts).toContain('host.docker.internal:127.0.0.1');

    const custom = containerCreateOptions(AGENT, IMAGE, 'other-net').HostConfig!;
    expect(custom.NetworkMode).toBe('other-net');
  });

  it('creates the agent network once, before the first container', async () => {
    await sandbox.ensure(AGENT);
    await sandbox.ensure('ag_docker02');
    expect(fake.networks.map((n) => n.Name)).toEqual([AGENT_NETWORK_DEFAULT]);
  });

  it('describes an agent network that isolates containers from each other', () => {
    const net = networkCreateOptions(AGENT_NETWORK_DEFAULT);
    expect(net.Name).toBe(AGENT_NETWORK_DEFAULT);
    expect(net.Driver).toBe('bridge');
    expect(net.Internal).toBe(false);                 // egress stays on; the host firewall narrows it
    expect(net.Options!['com.docker.network.bridge.enable_icc']).toBe('false');
    expect(egressFirewallRules(AGENT_NETWORK_DEFAULT).join('\n')).toContain('169.254.0.0/16');
  });
});

describe('cpuMsFromStats', () => {
  it('uses the nanosecond delta when both samples are present', () => {
    expect(cpuMsFromStats(1_000_000_000, 1_250_000_000, 800)).toBe(250);
  });
  it('falls back to wall-clock × 0.5 when stats are missing or go backwards', () => {
    expect(cpuMsFromStats(null, 5, 800)).toBe(400);
    expect(cpuMsFromStats(5, null, 800)).toBe(400);
    expect(cpuMsFromStats(10, 5, 800)).toBe(400);
  });
});

describe('parseFindOutput', () => {
  it('maps find rows to SandboxFile rows, sorted, with dirs at zero bytes', () => {
    const out = 'f\t12\tindex.html\nd\t4096\tcss\nf\t0\tempty.txt\n';
    expect(parseFindOutput('site', out)).toEqual([
      { path: 'site/css', bytes: 0, dir: true },
      { path: 'site/empty.txt', bytes: 0, dir: false },
      { path: 'site/index.html', bytes: 12, dir: false },
    ]);
    expect(parseFindOutput('', 'f\t3\ta.txt\n')).toEqual([{ path: 'a.txt', bytes: 3, dir: false }]);
  });
});

describe('fileArchiveEntries', () => {
  it('creates every parent directory before the file, owned by the sandbox user', () => {
    expect(fileArchiveEntries('site/css/app.css', Buffer.from('x'))).toEqual([
      { name: 'site', type: 'dir', uid: 1000, gid: 1000 },
      { name: 'site/css', type: 'dir', uid: 1000, gid: 1000 },
      { name: 'site/css/app.css', type: 'file', content: Buffer.from('x'), uid: 1000, gid: 1000 },
    ]);
  });
});

describe('ensure', () => {
  it('creates the volume and container once, then starts it', async () => {
    await sandbox.ensure(AGENT);
    expect(fake.volumes.has(volumeName(AGENT))).toBe(true);
    expect(fake.created).toHaveLength(1);
    expect(fake.container(AGENT).running).toBe(true);

    await sandbox.ensure(AGENT);                    // idempotent
    expect(fake.created).toHaveLength(1);
  });

  it('restarts a stopped container', async () => {
    await sandbox.ensure(AGENT);
    await sandbox.stop(AGENT);
    expect(fake.container(AGENT).running).toBe(false);
    await sandbox.start(AGENT);
    expect(fake.container(AGENT).running).toBe(true);
  });

  it('never pulls: a missing image explains how to build it', async () => {
    fake.createContainerError = () => httpError(404, 'no such image');
    await expect(sandbox.ensure(AGENT)).rejects.toThrow(/docker build -t vantra-sandbox:latest docker\/sandbox/);
  });

  it('rejects unsafe agent ids before touching the daemon', async () => {
    await expect(sandbox.ensure('../evil')).rejects.toBeInstanceOf(SandboxPathError);
    expect(fake.created).toHaveLength(0);
  });
});

// The daemon reports a failure to START the process by writing runc's own error to the OUTPUT stream
// and setting Pid 0. Measured against Docker 29.4.0 / OrbStack with a missing binary:
//   {"exitCode":127,"pid":0,"out":"OCI runtime exec failed: exec failed: unable to start container
//    process: exec: \"/no/such/binary\": stat /no/such/binary: no such file or directory"}
// while a shell that runs and cannot find the command reports {"exitCode":127,"pid":86824}. Pid is
// therefore the structural discriminator; nothing here matches on the daemon's wording.
describe('exec when the container never started the process', () => {
  it('does not hand the daemon\'s own error back to the agent as stdout', async () => {
    await sandbox.ensure(AGENT);
    const ociError = 'OCI runtime exec failed: unable to start container process: fork/exec: Cannot fork';
    fake.container(AGENT).respond = () => ({ stdout: ociError, exitCode: 128, pid: 0 });

    const res = await sandbox.exec(AGENT, 'echo alive', { timeoutMs: 5_000 });

    expect(res.stdout).toBe('');                          // never presented as the command's output
    expect(res.stderr).toContain('the container is wedged and needs recreating');
    expect(res.stderr).toContain('Cannot fork');          // the cause is kept, just not as stdout
    expect(res.exitCode).toBe(EXEC_START_FAILED_EXIT);    // distinct from the daemon's 128
    expect(res.timedOut).toBe(false);
  });

  it('leaves a real command that exits 127 completely alone', async () => {
    await sandbox.ensure(AGENT);
    // The shell ran (a live pid) and reported for itself. This is NOT infrastructure failure.
    fake.container(AGENT).respond = () => ({ stderr: 'sh: 1: nope: not found\n', exitCode: 127, pid: 86_824 });

    const res = await sandbox.exec(AGENT, 'nope', { timeoutMs: 5_000 });

    expect(res.exitCode).toBe(127);
    expect(res.stderr).toBe('sh: 1: nope: not found\n');
    expect(res.stderr).not.toContain('wedged');
  });

  it('leaves a real command that exits 128 alone too, when a process really ran', async () => {
    await sandbox.ensure(AGENT);
    fake.container(AGENT).respond = () => ({ stdout: 'mine\n', exitCode: 128, pid: 1_234 });
    const res = await sandbox.exec(AGENT, 'exit 128', { timeoutMs: 5_000 });
    expect(res).toMatchObject({ exitCode: 128, stdout: 'mine\n', stderr: '' });
  });
});

describe('exec', () => {
  it('runs sh -lc under an in-container timeout as uid 1000 and reports demuxed output', async () => {
    await sandbox.ensure(AGENT);
    fake.container(AGENT).respond = () => ({ stdout: 'hello\n', stderr: 'warn\n', exitCode: 2, cpuNs: 1_400_000 });
    const res = await sandbox.exec(AGENT, 'echo hello', { timeoutMs: 2_500 });
    expect(res).toMatchObject({ stdout: 'hello\n', stderr: 'warn\n', exitCode: 2, timedOut: false });
    expect(res.cpuMs).toBe(1);                       // 1.4ms of cpu since the pre-exec sample at 0ns
    const [record] = fake.container(AGENT).execs;
    expect(record!.cmd).toEqual(['timeout', '-s', 'KILL', '3', 'sh', '-lc', 'echo hello']);
    expect(record!.user).toBe(SANDBOX_USER);
  });

  it('feeds stdin to the handler', async () => {
    await sandbox.ensure(AGENT);
    fake.container(AGENT).respond = (_cmd, stdin) => ({ stdout: stdin.toUpperCase() });
    const res = await sandbox.exec(AGENT, 'cat', { timeoutMs: 1_000, stdin: 'ping' });
    expect(res.stdout).toBe('PING');
    expect(fake.container(AGENT).execs[0]!.stdin).toBe('ping');
  });

  it('flags the in-container timeout kill', async () => {
    await sandbox.ensure(AGENT);
    fake.container(AGENT).respond = () => ({ exitCode: 137, stderr: 'killed' });
    const res = await sandbox.exec(AGENT, 'sleep 99', { timeoutMs: 1 });
    expect(res.timedOut).toBe(true);
    expect(res.exitCode).toBe(137);
  });

  it('kills the container when the exec ignores the in-container timeout', async () => {
    await sandbox.ensure(AGENT);
    fake.container(AGENT).respond = () => ({ hang: true });
    const res = await sandbox.exec(AGENT, 'trap "" TERM; sleep 99', { timeoutMs: 20 });
    expect(res.timedOut).toBe(true);
    expect(res.exitCode).toBe(137);
    expect(fake.container(AGENT).killed).toBe(1);
  });

  it('falls back to wall-clock cpu when stats are unavailable', async () => {
    await sandbox.ensure(AGENT);
    fake.container(AGENT).cpuNs = null;
    fake.container(AGENT).respond = () => ({ stdout: 'ok' });
    expect((await sandbox.exec(AGENT, 'true', { timeoutMs: 1_000 })).cpuMs).toBeGreaterThanOrEqual(0);
  });
});

describe('writeFile / readFile / listFiles', () => {
  it('uploads a tar with parent directories to /work', async () => {
    await sandbox.ensure(AGENT);
    await sandbox.writeFile(AGENT, 'site/index.html', '<h1>hi</h1>');
    const [upload] = fake.container(AGENT).putArchives;
    expect(upload!.path).toBe('/work');
    const names: string[] = [];
    let body = '';
    for await (const { entry, body: read } of readTar(streamOf(upload!.tar))) {
      names.push(entry.name);
      for await (const chunk of read()) body += chunk.toString('utf8');
    }
    expect(names).toEqual(['site/', 'site/index.html']);
    expect(body).toBe('<h1>hi</h1>');
  });

  it('rejects paths that escape /work before any daemon call', async () => {
    await expect(sandbox.writeFile(AGENT, '../escape', 'x')).rejects.toBeInstanceOf(SandboxPathError);
    await expect(sandbox.readFile(AGENT, '/etc/passwd', 10)).rejects.toBeInstanceOf(SandboxPathError);
  });

  it('reads a file out of the archive stream and truncates at maxBytes', async () => {
    await sandbox.ensure(AGENT);
    fake.container(AGENT).archives.set('/work/notes.md', [{ name: 'notes.md', type: 'file', content: Buffer.from('abcdefghij') }]);
    expect(await sandbox.readFile(AGENT, 'notes.md', 100)).toBe('abcdefghij');
    const clipped = await sandbox.readFile(AGENT, 'notes.md', 4);
    expect(clipped.startsWith('abcd')).toBe(true);
    expect(clipped).toContain('truncated 6 bytes');
  });

  it('maps a missing path to a path error', async () => {
    await sandbox.ensure(AGENT);
    await expect(sandbox.readFile(AGENT, 'nope.md', 10)).rejects.toBeInstanceOf(SandboxPathError);
  });

  it('lists a directory through find', async () => {
    await sandbox.ensure(AGENT);
    fake.container(AGENT).respond = (cmd) => ({ stdout: cmd.join(' ').includes("cd '/work/site'") ? 'f\t5\tindex.html\n' : '', exitCode: 0 });
    expect(await sandbox.listFiles(AGENT, 'site')).toEqual([{ path: 'site/index.html', bytes: 5, dir: false }]);
  });
});

describe('exportDir', () => {
  let dest: string;
  beforeEach(async () => { dest = await mkdtemp(path.join(tmpdir(), 'vantra-export-')); });
  afterEach(async () => { await rm(dest, { recursive: true, force: true }); });

  it('unpacks the archive, dropping the top-level component docker adds', async () => {
    await sandbox.ensure(AGENT);
    fake.container(AGENT).archives.set('/work/site', [
      { name: 'site', type: 'dir' },
      { name: 'site/index.html', type: 'file', content: Buffer.from('12345') },
      { name: 'site/css', type: 'dir' },
      { name: 'site/css/app.css', type: 'file', content: Buffer.from('abc') },
    ]);
    expect(await sandbox.exportDir(AGENT, 'site', dest, 1_000)).toEqual({ bytes: 8, files: 2 });
    expect(await readFile(path.join(dest, 'index.html'), 'utf8')).toBe('12345');
    expect(await readFile(path.join(dest, 'css/app.css'), 'utf8')).toBe('abc');
  });

  it('never writes an entry whose name escapes the destination', async () => {
    await sandbox.ensure(AGENT);
    fake.container(AGENT).archives.set('/work/site', [
      { name: 'site/../../etc/pwned', type: 'file', content: Buffer.from('x') },
      { name: 'site/ok.txt', type: 'file', content: Buffer.from('y') },
    ]);
    expect(await sandbox.exportDir(AGENT, 'site', dest, 1_000)).toEqual({ bytes: 1, files: 1 });
    expect(await readFile(path.join(dest, 'ok.txt'), 'utf8')).toBe('y');
  });

  it('enforces the byte cap', async () => {
    await sandbox.ensure(AGENT);
    fake.container(AGENT).archives.set('/work/site', [{ name: 'site/big.bin', type: 'file', content: Buffer.alloc(2_000, 1) }]);
    await expect(sandbox.exportDir(AGENT, 'site', dest, 1_000)).rejects.toBeInstanceOf(SandboxLimitError);
  });
});

describe('destroy', () => {
  it('removes the container and retries the volume while it is still attached', async () => {
    await sandbox.ensure(AGENT);
    fake.volumes.get(volumeName(AGENT))!.removeErrors = 2;
    await sandbox.destroy(AGENT);
    expect(fake.containers.get(containerName(AGENT))!.removed).toBe(true);
    expect(fake.volumes.get(volumeName(AGENT))!.removed).toBe(true);
  });

  it('is a no-op for an agent that never had a container', async () => {
    await expect(sandbox.destroy('ag_ghost0001')).resolves.toBeUndefined();
  });
});

async function* streamOf(buf: Buffer): AsyncGenerator<Uint8Array> {
  yield buf;
}
