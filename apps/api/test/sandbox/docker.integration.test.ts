// SANDBOX_DRIVER=docker against a REAL daemon (SPEC §8.17).
//
// docker.test.ts drives the same code against a dockerode double; this file drives it against an actual
// container, because a fake daemon cannot tell you that `sh -lc` parses, that `find -printf` exists in the
// image, that the tmpfs is writable by uid 1000, or that cgroup limits were really applied.
//
// Skipped when Docker is unreachable or the sandbox image is missing; runs whenever both are present.
// Force-skip with VANTRA_DOCKER_IT=0.
import { mkdtemp, readFile as readHostFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Docker from 'dockerode';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SandboxDriver } from '../../src/core/interfaces.js';
import { silentLogger } from '../../src/lib/log.js';
import { OUTPUT_CAP_BYTES, SandboxLimitError, SandboxPathError } from '../../src/sandbox/common.js';
import {
  MEMORY_BYTES, NANO_CPUS, PIDS_LIMIT, SANDBOX_USER, containerName, createDockerSandbox, volumeName,
} from '../../src/sandbox/docker.js';
import { BLOCKED_METADATA_HOSTS, bridgeName, networkCreateOptions } from '../../src/sandbox/egress.js';

const IMAGE = process.env['SANDBOX_IMAGE'] ?? 'vantra-sandbox:latest';
// Never touch the network a live deployment uses. The name must also differ from `vantra-agents` within
// its first 12 characters, or both truncate to the bridge `br-vantra-agent` and the daemon returns 403.
const NETWORK = 'rw-it-net';
const AGENT = `it${Math.random().toString(36).slice(2, 10)}`;

const docker = new Docker();

// Docker reachable AND the image built. Both are required; a missing image is reported loudly rather than
// silently skipped, so nobody mistakes "skipped" for "passed".
async function probe(): Promise<{ ok: boolean; why: string }> {
  if (process.env['VANTRA_DOCKER_IT'] === '0') return { ok: false, why: 'VANTRA_DOCKER_IT=0' };
  try {
    await docker.ping();
  } catch (e) {
    return { ok: false, why: `docker daemon unreachable (${(e as Error).message})` };
  }
  try {
    await docker.getImage(IMAGE).inspect();
  } catch {
    const why = `image "${IMAGE}" missing; build it with: docker build -t ${IMAGE} docker/sandbox`;
    console.warn(`[docker integration] SKIPPED: ${why}`);
    return { ok: false, why };
  }
  return { ok: true, why: '' };
}

const { ok: dockerReady, why: skipReason } = await probe();
if (!dockerReady) console.warn(`[docker integration] skipped: ${skipReason}`);

let sandbox: SandboxDriver;

// Reads one cgroup/proc value from inside the container. Proves the limit landed in the kernel, not just
// in the create request we sent.
async function containerRead(agentId: string, file: string): Promise<string> {
  const res = await sandbox.exec(agentId, `cat ${file} 2>/dev/null || echo ABSENT`, { timeoutMs: 10_000 });
  return res.stdout.trim();
}

async function cleanup(agentId: string): Promise<void> {
  await docker.getContainer(containerName(agentId)).remove({ force: true }).catch(() => undefined);
  await docker.getVolume(volumeName(agentId)).remove({ force: true }).catch(() => undefined);
}

describe.skipIf(!dockerReady)('docker sandbox against a real daemon', () => {
  beforeAll(async () => {
    sandbox = createDockerSandbox({ image: IMAGE, log: silentLogger, network: NETWORK });
    await cleanup(AGENT);
    await sandbox.ensure(AGENT);
  }, 120_000);

  afterAll(async () => {
    await cleanup(AGENT);
    await cleanup(`${AGENT}b`);
    await docker.getNetwork(NETWORK).remove().catch(() => undefined);
  }, 60_000);

  describe('ensure', () => {
    it('creates a running container and its volume, and is idempotent', async () => {
      const info = await docker.getContainer(containerName(AGENT)).inspect();
      expect(info.State.Running).toBe(true);
      expect(info.Config.Image).toBe(IMAGE);
      const volumes = await docker.listVolumes({ filters: { name: [volumeName(AGENT)] } });
      expect(volumes.Volumes.map((v) => v.Name)).toContain(volumeName(AGENT));

      await sandbox.ensure(AGENT);                    // second call must not recreate anything
      const again = await docker.getContainer(containerName(AGENT)).inspect();
      expect(again.Id).toBe(info.Id);
      expect(again.State.Running).toBe(true);
    });

    it('rejects an unsafe agent id before talking to the daemon', async () => {
      await expect(sandbox.ensure('../evil')).rejects.toBeInstanceOf(SandboxPathError);
    });

    // The driver never pulls or builds. A missing image has to say what to run, against the real 404.
    it('explains how to build a missing image instead of pulling it', async () => {
      const missing = createDockerSandbox({ image: 'vantra-sandbox:definitely-absent', log: silentLogger, network: NETWORK });
      const victim = `${AGENT}m`;
      try {
        await expect(missing.ensure(victim)).rejects.toThrow(/docker build -t vantra-sandbox:definitely-absent docker\/sandbox/);
        await expect(docker.getImage('vantra-sandbox:definitely-absent').inspect()).rejects.toThrow();
      } finally {
        await cleanup(victim);
      }
    }, 60_000);

    // Linux caps an interface name at 15 characters, so two network names that agree on their first 12
    // truncate to one bridge and the daemon answers 403, not 409. Its message never mentions the setting
    // to change, so the driver adds that.
    it('explains a bridge-name collision rather than surfacing the raw 403', async () => {
      const first = 'rw-it-collide-a';                  // both are 15 chars and agree on their first 12,
      const second = 'rw-it-collide-b';                 // so both truncate to br-rw-it-collid
      expect(bridgeName(first)).toBe(bridgeName(second));
      expect(bridgeName(first)).not.toBe(bridgeName(NETWORK));
      const colliding = createDockerSandbox({ image: IMAGE, log: silentLogger, network: second });
      const victim = `${AGENT}c`;
      try {
        await docker.createNetwork(networkCreateOptions(first));
        await expect(colliding.ensure(victim)).rejects.toThrow(/SANDBOX_NETWORK that differs within its first 12 characters/);
      } finally {
        await cleanup(victim);
        await docker.getNetwork(first).remove().catch(() => undefined);
        await docker.getNetwork(second).remove().catch(() => undefined);
      }
    }, 60_000);
  });

  // The flags we send are only half the claim; these assert what the kernel actually enforced.
  describe('security posture, as enforced inside the container', () => {
    it('sends every hardening flag and the daemon keeps them', async () => {
      const host = (await docker.getContainer(containerName(AGENT)).inspect()).HostConfig;
      expect(host.Memory).toBe(MEMORY_BYTES);
      expect(host.MemorySwap).toBe(MEMORY_BYTES);
      expect(host.NanoCpus).toBe(NANO_CPUS);
      expect(host.PidsLimit).toBe(PIDS_LIMIT);
      expect(host.CapDrop).toEqual(['ALL']);
      expect(host.SecurityOpt).toEqual(['no-new-privileges']);
      expect(host.ReadonlyRootfs).toBe(true);
      expect(host.NetworkMode).toBe(NETWORK);
      expect(host.Init).toBe(true);
    });

    // Without an init, pid 1 is `sleep infinity`, which never calls wait(). Measured before the fix:
    // 40 backgrounding commands left 40 permanent zombies, and PidsLimit is 256 — so an ordinary
    // long-lived agent wedged its own container for good. Pid 1 must be a reaper.
    it('reaps orphaned processes instead of leaking zombies toward the pid limit', async () => {
      const count = `n=0; for p in /proc/[0-9]*; do [ "$(awk '{print $3}' $p/stat 2>/dev/null)" = "Z" ] && n=$((n+1)); done; echo $n`;
      expect((await sandbox.exec(AGENT, 'cat /proc/1/comm', { timeoutMs: 10_000 })).stdout.trim()).not.toBe('sleep');
      for (let i = 0; i < 12; i++) await sandbox.exec(AGENT, '(sleep 0.2 &) ; echo spawned', { timeoutMs: 10_000 });
      await new Promise((r) => setTimeout(r, 2_500));
      expect(Number((await sandbox.exec(AGENT, count, { timeoutMs: 10_000 })).stdout.trim())).toBe(0);
    }, 90_000);

    it('runs as uid 1000 in /work', async () => {
      const res = await sandbox.exec(AGENT, 'id -u; id -g; pwd', { timeoutMs: 10_000 });
      expect(res.exitCode).toBe(0);
      expect(res.stdout.trim().split('\n')).toEqual(['1000', '1000', '/work']);
      expect(SANDBOX_USER).toBe('1000:1000');
    });

    it('has a read-only root filesystem but a writable /tmp and /work', async () => {
      const ro = await sandbox.exec(AGENT, 'touch /rootfile', { timeoutMs: 10_000 });
      expect(ro.exitCode).not.toBe(0);
      expect(ro.stderr).toMatch(/[Rr]ead-only file system/);

      const rw = await sandbox.exec(AGENT, 'touch /tmp/t && touch /work/w && echo BOTH_OK', { timeoutMs: 10_000 });
      expect(rw.exitCode).toBe(0);
      expect(rw.stdout.trim()).toBe('BOTH_OK');
    });

    it('drops every capability', async () => {
      const caps = await sandbox.exec(AGENT, "grep -E '^Cap(Eff|Prm|Bnd)' /proc/self/status", { timeoutMs: 10_000 });
      expect(caps.exitCode).toBe(0);
      for (const line of caps.stdout.trim().split('\n')) {
        expect(line).toMatch(/:\s*0000000000000000$/);
      }
    });

    it('sets no-new-privileges in the kernel', async () => {
      expect(await containerRead(AGENT, '/proc/self/status | grep NoNewPrivs')).toMatch(/NoNewPrivs:\s*1/);
    });

    it('applies the memory and pid limits to the cgroup', async () => {
      expect(await containerRead(AGENT, '/sys/fs/cgroup/memory.max')).toBe(String(MEMORY_BYTES));
      expect(await containerRead(AGENT, '/sys/fs/cgroup/pids.max')).toBe(String(PIDS_LIMIT));
      // cpu.max is "<quota> <period>"; NanoCpus 5e8 == 0.5 cpu == quota/period 0.5.
      const [quota, period] = (await containerRead(AGENT, '/sys/fs/cgroup/cpu.max')).split(/\s+/);
      expect(Number(quota) / Number(period)).toBeCloseTo(NANO_CPUS / 1e9, 5);
    });

    // Runs in a throwaway container: exhausting the pid cgroup wedges every later exec in the same
    // container (the daemon cannot fork the exec process and returns 128 with an OCI error), which is
    // exactly the containment we want but would poison the rest of this file.
    it('contains a fork bomb at the pid limit instead of taking the host down', async () => {
      const victim = `${AGENT}p`;
      try {
        await sandbox.ensure(victim);
        const res = await sandbox.exec(victim, ':(){ :|:& };: 2>/dev/null; echo SURVIVED', { timeoutMs: 8_000 });
        // The container is wedged or the shell refused to fork; either way the exec returned and the
        // daemon is still healthy, which is the property under test.
        expect(typeof res.exitCode).toBe('number');
        expect(await docker.ping()).toBeTruthy();
        const limit = await docker.getContainer(containerName(victim)).inspect();
        expect(limit.HostConfig.PidsLimit).toBe(PIDS_LIMIT);
      } finally {
        await cleanup(victim);
      }
    }, 90_000);
  });

  describe('exec', () => {
    it('returns stdout, stderr and a zero exit code, demuxed', async () => {
      const res = await sandbox.exec(AGENT, 'echo to-out; echo to-err 1>&2', { timeoutMs: 10_000 });
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toBe('to-out\n');
      expect(res.stderr).toBe('to-err\n');
      expect(res.timedOut).toBe(false);
    });

    // The no-false-positive half of the Pid-0 rule, against the real daemon. A command the shell
    // cannot find produces exit 127 from a process that DID run, and must pass through untouched —
    // only a 127 with Pid 0 (the daemon's own OCI error, measured separately) is rewritten.
    it('lets a real 127 from the shell through instead of calling the container wedged', async () => {
      const res = await sandbox.exec(AGENT, 'definitely-not-a-command', { timeoutMs: 10_000 });
      expect(res.exitCode).toBe(127);
      expect(res.stderr).toContain('not found');
      expect(res.stderr).not.toContain('wedged');
      expect(res.stdout).toBe('');
    });

    it('reports a non-zero exit code', async () => {
      const res = await sandbox.exec(AGENT, 'echo nope 1>&2; exit 42', { timeoutMs: 10_000 });
      expect(res.exitCode).toBe(42);
      expect(res.stderr).toBe('nope\n');
      expect(res.timedOut).toBe(false);
    });

    it('feeds stdin to the command', async () => {
      const res = await sandbox.exec(AGENT, 'cat', { timeoutMs: 10_000, stdin: 'hello from stdin' });
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toBe('hello from stdin');
    });

    it('kills a command that outlives its timeout and flags timedOut', async () => {
      const started = Date.now();
      const res = await sandbox.exec(AGENT, 'sleep 60', { timeoutMs: 2_000 });
      const elapsed = Date.now() - started;
      expect(res.timedOut).toBe(true);
      expect([124, 137]).toContain(res.exitCode);
      expect(elapsed).toBeLessThan(10_000);           // the in-container `timeout` fired, not the host killer
      // The container survives an ordinary timeout: the next command still runs.
      expect((await sandbox.exec(AGENT, 'echo alive', { timeoutMs: 10_000 })).stdout.trim()).toBe('alive');
    }, 40_000);

    it('does not flag a fast non-timeout failure as a timeout', async () => {
      const res = await sandbox.exec(AGENT, 'exit 137', { timeoutMs: 10_000 });
      expect(res.exitCode).toBe(137);
      expect(res.timedOut).toBe(false);               // 137 away from the deadline is the command's own code
    });

    it('caps a flood of stdout at the output limit', async () => {
      const res = await sandbox.exec(AGENT, "tr '\\0' 'a' < /dev/zero | head -c 3000000", { timeoutMs: 20_000 });
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain('output truncated');
      expect(res.stdout.length).toBeLessThan(OUTPUT_CAP_BYTES + 4_096);
      expect(res.stdout.length).toBeGreaterThan(OUTPUT_CAP_BYTES - 4_096);
    }, 40_000);

    it('returns output under the cap untruncated', async () => {
      const res = await sandbox.exec(AGENT, "tr '\\0' 'b' < /dev/zero | head -c 200000", { timeoutMs: 20_000 });
      expect(res.stdout).not.toContain('output truncated');
      expect(res.stdout.length).toBe(200_000);
    }, 30_000);

    // Characterising a trap, not asserting it is ideal: a backgrounded child inherits the exec's stdout,
    // so the attached stream stays open until the in-container `timeout` fires, and the call costs the
    // FULL timeout even though the shell exited instantly. The child is then killed with it. Agents that
    // run `npm run dev &` pay their whole step budget for it — worth knowing before changing this loop.
    it('pays the full timeout for a command that leaves a background child, then kills it', async () => {
      const started = Date.now();
      const res = await sandbox.exec(AGENT, 'sleep 30 & echo started', { timeoutMs: 2_000 });
      const elapsed = Date.now() - started;
      expect(res.stdout).toBe('started\n');
      expect(res.exitCode).toBe(0);                   // the shell itself succeeded
      expect(elapsed).toBeGreaterThanOrEqual(1_900);  // but we waited out the deadline
      expect(elapsed).toBeLessThan(6_000);            // and the host killer never had to step in
      expect((await docker.getContainer(containerName(AGENT)).inspect()).State.Running).toBe(true);
    }, 40_000);

    it('accounts real cpu time rather than reporting zero', async () => {
      const idle = await sandbox.exec(AGENT, 'true', { timeoutMs: 10_000 });
      const busy = await sandbox.exec(AGENT, "awk 'BEGIN{x=0;for(i=0;i<6000000;i++)x+=i;print x}'", { timeoutMs: 20_000 });
      expect(busy.exitCode).toBe(0);
      expect(busy.cpuMs).toBeGreaterThan(100);        // a real burn, not a wall-clock guess of ~0
      expect(busy.cpuMs).toBeGreaterThan(idle.cpuMs);
      expect(busy.cpuMs).toBeLessThan(120_000);       // and not a nonsense magnitude
    }, 60_000);
  });

  describe('writeFile / readFile / listFiles', () => {
    it('round-trips a nested utf-8 file through the tar codec', async () => {
      const body = 'héllo — sandbox ✅\nline two\n';
      await sandbox.writeFile(AGENT, 'site/css/app.css', body);
      expect(await sandbox.readFile(AGENT, 'site/css/app.css', 10_000)).toBe(body);
      // and the container agrees it is a real file owned by the agent
      const res = await sandbox.exec(AGENT, "stat -c '%U %s' site/css/app.css", { timeoutMs: 10_000 });
      expect(res.stdout.trim()).toBe(`agent ${Buffer.byteLength(body)}`);
    });

    it('overwrites an existing file', async () => {
      await sandbox.writeFile(AGENT, 'notes.md', 'first');
      await sandbox.writeFile(AGENT, 'notes.md', 'second');
      expect(await sandbox.readFile(AGENT, 'notes.md', 100)).toBe('second');
    });

    it('writes a file large enough to span many tar blocks', async () => {
      const big = 'x'.repeat(300_000);
      await sandbox.writeFile(AGENT, 'big.txt', big);
      expect(await sandbox.readFile(AGENT, 'big.txt', 400_000)).toBe(big);
    }, 30_000);

    it('truncates readFile at maxBytes and says so', async () => {
      await sandbox.writeFile(AGENT, 'trunc.txt', 'abcdefghij');
      const clipped = await sandbox.readFile(AGENT, 'trunc.txt', 4);
      expect(clipped.startsWith('abcd')).toBe(true);
      expect(clipped).toContain('truncated 6 bytes');
    });

    it('rejects a missing file and a directory', async () => {
      await expect(sandbox.readFile(AGENT, 'no/such/file.txt', 100)).rejects.toBeInstanceOf(SandboxPathError);
      await expect(sandbox.readFile(AGENT, 'site', 100)).rejects.toBeInstanceOf(SandboxPathError);
    });

    it('rejects paths that escape /work', async () => {
      await expect(sandbox.writeFile(AGENT, '../escape.txt', 'x')).rejects.toBeInstanceOf(SandboxPathError);
      await expect(sandbox.readFile(AGENT, '/etc/passwd', 100)).rejects.toBeInstanceOf(SandboxPathError);
    });

    it('lists a directory with real sizes and dir flags', async () => {
      await sandbox.writeFile(AGENT, 'listing/a.txt', '12345');
      await sandbox.writeFile(AGENT, 'listing/sub/b.txt', 'xy');
      const rows = await sandbox.listFiles(AGENT, 'listing');
      expect(rows).toEqual([
        { path: 'listing/a.txt', bytes: 5, dir: false },
        { path: 'listing/sub', bytes: 0, dir: true },
      ]);
    });

    it('lists the /work root', async () => {
      const rows = await sandbox.listFiles(AGENT, '');
      expect(rows.map((r) => r.path)).toContain('listing');
      expect(rows.map((r) => r.path)).toContain('notes.md');
    });

    it('fails a listing of a path that does not exist', async () => {
      await expect(sandbox.listFiles(AGENT, 'nowhere')).rejects.toBeInstanceOf(SandboxPathError);
    });
  });

  describe('exportDir', () => {
    let dest: string;
    beforeAll(async () => { dest = await mkdtemp(path.join(tmpdir(), 'rw-export-it-')); });
    afterAll(async () => { await rm(dest, { recursive: true, force: true }); });

    it('exports a real tree to the host with byte and file counts', async () => {
      await sandbox.writeFile(AGENT, 'pub/index.html', '<h1>hi</h1>');
      await sandbox.writeFile(AGENT, 'pub/css/app.css', 'body{}');
      const out = path.join(dest, 'tree');
      const totals = await sandbox.exportDir(AGENT, 'pub', out, 1_000_000);
      expect(totals).toEqual({ bytes: 17, files: 2 });
      expect(await readHostFile(path.join(out, 'index.html'), 'utf8')).toBe('<h1>hi</h1>');
      expect(await readHostFile(path.join(out, 'css/app.css'), 'utf8')).toBe('body{}');
    }, 30_000);

    it('enforces the byte cap', async () => {
      await sandbox.writeFile(AGENT, 'heavy/big.bin', 'z'.repeat(50_000));
      await expect(sandbox.exportDir(AGENT, 'heavy', path.join(dest, 'capped'), 1_000))
        .rejects.toBeInstanceOf(SandboxLimitError);
    }, 30_000);
  });

  // stop/start are the rent discount for sleeping agents: the volume must survive.
  describe('stop / start', () => {
    // Agents are stopped and started constantly for the rent discount, so a slow stop is a real cost.
    // Pid 1 ignores SIGTERM unless it handles it: with `sleep infinity` this took the full 5s grace every
    // time (measured 5117ms); with docker-init forwarding the signal it is ~0.1s.
    it('stops promptly rather than burning the whole kill grace', async () => {
      await sandbox.ensure(AGENT);
      const started = Date.now();
      await sandbox.stop(AGENT);
      expect(Date.now() - started).toBeLessThan(3_000);
      await sandbox.start(AGENT);
    }, 60_000);

    it('stops the container, restarts it, and keeps /work intact', async () => {
      await sandbox.writeFile(AGENT, 'persist.txt', 'survives');
      await sandbox.stop(AGENT);
      expect((await docker.getContainer(containerName(AGENT)).inspect()).State.Running).toBe(false);

      await sandbox.stop(AGENT);                      // idempotent on an already-stopped container
      await sandbox.start(AGENT);
      expect((await docker.getContainer(containerName(AGENT)).inspect()).State.Running).toBe(true);
      expect(await sandbox.readFile(AGENT, 'persist.txt', 100)).toBe('survives');
    }, 60_000);

    it('exec restarts a stopped container by itself', async () => {
      await sandbox.stop(AGENT);
      const res = await sandbox.exec(AGENT, 'echo woken', { timeoutMs: 15_000 });
      expect(res.exitCode).toBe(0);
      expect(res.stdout.trim()).toBe('woken');
    }, 60_000);

    it('stop is a no-op for an agent with no container', async () => {
      await expect(sandbox.stop('itghost0001')).resolves.toBeUndefined();
    });
  });

  describe('egress boundary', () => {
    it('puts every metadata hostname in /etc/hosts pointing at the container loopback', async () => {
      const hosts = await sandbox.exec(AGENT, 'cat /etc/hosts', { timeoutMs: 10_000 });
      expect(hosts.exitCode).toBe(0);
      for (const name of BLOCKED_METADATA_HOSTS) expect(hosts.stdout).toContain(`127.0.0.1\t${name}`);
    }, 30_000);

    it('resolves every metadata hostname to loopback over IPv4', async () => {
      const cmd = BLOCKED_METADATA_HOSTS.map((h) => `getent ahostsv4 ${h} | head -1`).join('; ');
      const res = await sandbox.exec(AGENT, cmd, { timeoutMs: 15_000 });
      const lines = res.stdout.trim().split('\n').filter(Boolean);
      expect(lines).toHaveLength(BLOCKED_METADATA_HOSTS.length);
      for (const line of lines) expect(line.split(/\s+/)[0]).toBe('127.0.0.1');
    }, 30_000);

    // The property that actually matters. On a developer machine the API listens on the host, and without
    // ExtraHosts the container reaches it by name — verified by removing the flag. Whatever a runtime's
    // embedded DNS decides to answer for these names, none of them may be reachable from the sandbox.
    it('cannot reach anything through the metadata hostnames', async () => {
      const cmd = BLOCKED_METADATA_HOSTS
        .map((h) => `curl -s -m 4 -o /dev/null http://${h}:8787/ && echo "REACHED ${h}"`)
        .join('; ');
      const res = await sandbox.exec(AGENT, `${cmd}; echo SWEEP_DONE`, { timeoutMs: 45_000 });
      expect(res.stdout).toContain('SWEEP_DONE');
      expect(res.stdout).not.toContain('REACHED');
    }, 60_000);

    it('is not on the default bridge', async () => {
      const nets = (await docker.getContainer(containerName(AGENT)).inspect()).NetworkSettings.Networks;
      expect(Object.keys(nets)).toEqual([NETWORK]);
      expect(Object.keys(nets)).not.toContain('bridge');
    });

    it('still has outbound internet, which agents need', async () => {
      const res = await sandbox.exec(AGENT, "curl -s -m 15 -o /dev/null -w '%{http_code}' https://rpc.mainnet.chain.robinhood.com", { timeoutMs: 25_000 });
      expect(res.stdout.trim()).toBe('200');
    }, 45_000);
  });

  describe('destroy', () => {
    it('removes the container and its volume', async () => {
      const victim = `${AGENT}b`;
      await sandbox.ensure(victim);
      await sandbox.writeFile(victim, 'gone.txt', 'x');
      await sandbox.destroy(victim);

      await expect(docker.getContainer(containerName(victim)).inspect()).rejects.toThrow();
      const volumes = await docker.listVolumes({ filters: { name: [volumeName(victim)] } });
      expect((volumes.Volumes ?? []).map((v) => v.Name)).not.toContain(volumeName(victim));
    }, 60_000);

    it('is a no-op for an agent that never existed', async () => {
      await expect(sandbox.destroy('itghost0002')).resolves.toBeUndefined();
    }, 30_000);
  });
});
