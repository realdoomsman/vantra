// SANDBOX_DRIVER=docker: one container per agent (`rw-<agentId>`) on the image from SANDBOX_IMAGE. SPEC §8.17.
// The image is never pulled or built here: build it once with `docker build -t vantra-sandbox:latest docker/sandbox`.
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { Readable, pipeline } from 'node:stream';
import { promisify } from 'node:util';
import Docker from 'dockerode';
import type { SandboxDriver, SandboxExecResult, SandboxFile } from '../core/interfaces.js';
import type { Logger } from '../lib/log.js';
import {
  MAX_EXPORT_FILES, OUTPUT_CAP_BYTES, OutputCollector, SandboxLimitError, SandboxPathError, WORK_DIR, assertAgentId,
  normalizeRelPath, shellQuote, truncationNote,
} from './common.js';
import { AGENT_NETWORK_DEFAULT, bridgeName, metadataExtraHosts, networkCreateOptions } from './egress.js';
import { packTar, readTar, type TarInput } from './tar.js';

export interface DockerSandboxOptions { image: string; log: Logger; network?: string; docker?: Docker }

export const MEMORY_BYTES = 512 * 1024 * 1024;
export const NANO_CPUS = 500_000_000;            // --cpus 0.5
export const PIDS_LIMIT = 256;
export const SANDBOX_UID = 1000;
export const SANDBOX_USER = `${SANDBOX_UID}:${SANDBOX_UID}`;
const TMPFS_OPTS = 'rw,nosuid,size=256m';
const HOST_KILL_GRACE_MS = 3_000;               // in-container `timeout` fires first; `docker kill` is the fallback
// Shell convention: "found but could not be invoked". Distinct from 128 (what the daemon reports) so
// the caller can tell a wedged container from a command that ran and returned 128 itself.
export const EXEC_START_FAILED_EXIT = 126;
const TIMEOUT_SLACK_MS = 50;                    // scheduling jitter around the in-container deadline
const EXEC_EXIT_POLLS = 40;
const EXEC_EXIT_POLL_MS = 50;
const FS_OP_TIMEOUT_MS = 15_000;
const streamPipeline = promisify(pipeline);

export const containerName = (agentId: string): string => `rw-${agentId}`;
export const volumeName = (agentId: string): string => `rw-vol-${agentId}`;

export function containerCreateOptions(agentId: string, image: string, network: string = AGENT_NETWORK_DEFAULT): Docker.ContainerCreateOptions {
  return {
    name: containerName(agentId),
    Image: image,
    Cmd: ['sleep', 'infinity'],
    User: SANDBOX_USER,
    WorkingDir: WORK_DIR,
    Env: ['HOME=/tmp', 'NPM_CONFIG_CACHE=/tmp/.npm', 'PIP_NO_CACHE_DIR=1'],
    Labels: { 'vantra.agent': agentId },
    HostConfig: {
      Memory: MEMORY_BYTES,
      MemorySwap: MEMORY_BYTES,                 // no swap beyond the memory limit
      NanoCpus: NANO_CPUS,
      PidsLimit: PIDS_LIMIT,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges'],
      ReadonlyRootfs: true,
      // docker-init (tini) as pid 1 instead of `sleep infinity`, for two measured reasons:
      //   1. Reaping. An exec whose child outlives it — `npm run dev &`, or just `(sleep 1 &)` — reparents
      //      that child to pid 1. `sleep` never calls wait(), so every one becomes a permanent zombie:
      //      measured 40 commands => 40 zombies that never clear. PidsLimit is 256, so a long-lived agent
      //      wedges its own container for good, and every later exec fails with a runc "Cannot fork" error.
      //   2. Signals. The kernel applies no default action to pid 1, so `sleep infinity` ignores SIGTERM and
      //      every `docker stop` burned the full grace period: measured 5117ms, versus 112ms with tini.
      //      Agents are stopped and started constantly for the sleep/pause rent discount.
      Init: true,
      Tmpfs: { '/tmp': TMPFS_OPTS },
      Mounts: [{ Type: 'volume', Source: volumeName(agentId), Target: WORK_DIR }],
      // Agents need egress, but NOT the default bridge: that is shared with whatever else the host
      // runs and routes straight to the gateway. sandbox/egress.ts owns this boundary.
      NetworkMode: network,
      ExtraHosts: metadataExtraHosts(),
      RestartPolicy: { Name: 'no' },
      LogConfig: { Type: 'none', Config: {} },
    },
  };
}

// CPU time from a `docker stats` delta (nanoseconds → ms); wall-clock × 0.5 when stats are unavailable.
export function cpuMsFromStats(beforeNs: number | null, afterNs: number | null, elapsedMs: number): number {
  if (beforeNs !== null && afterNs !== null && afterNs >= beforeNs) return Math.round((afterNs - beforeNs) / 1e6);
  return Math.round(elapsedMs * 0.5);
}

// Parses `find -printf '%y\t%s\t%f\n'` output into SandboxFile rows (relative to /work).
export function parseFindOutput(base: string, stdout: string): SandboxFile[] {
  const rows: SandboxFile[] = [];
  for (const line of stdout.split('\n')) {
    if (!line) continue;
    const [type, size, ...nameParts] = line.split('\t');
    const name = nameParts.join('\t');
    if (!type || !name) continue;
    rows.push({ path: base ? `${base}/${name}` : name, bytes: type === 'f' ? Number(size) || 0 : 0, dir: type === 'd' });
  }
  return rows.sort((a, b) => a.path.localeCompare(b.path));
}

// Tar entries for putArchive: every parent directory first (owned by the sandbox user) then the file.
export function fileArchiveEntries(rel: string, content: Buffer): TarInput[] {
  const segments = rel.split('/');
  const entries: TarInput[] = [];
  for (let i = 1; i < segments.length; i++) {
    entries.push({ name: segments.slice(0, i).join('/'), type: 'dir', uid: SANDBOX_UID, gid: SANDBOX_UID });
  }
  entries.push({ name: rel, type: 'file', content, uid: SANDBOX_UID, gid: SANDBOX_UID });
  return entries;
}

export function createDockerSandbox(opts: DockerSandboxOptions): SandboxDriver {
  return new DockerSandbox(opts.docker ?? new Docker(), opts.image, opts.log, opts.network ?? AGENT_NETWORK_DEFAULT);
}

interface DockerError { statusCode?: number; message?: string }
const statusOf = (e: unknown): number | undefined => (e as DockerError | null)?.statusCode;
const ignoreStatus = async (p: Promise<unknown>, ...codes: number[]): Promise<void> => {
  try {
    await p;
  } catch (e) {
    if (!codes.includes(statusOf(e) ?? -1)) throw e;
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class DockerSandbox implements SandboxDriver {
  readonly name = 'docker' as const;
  private network: Promise<void> | null = null;

  constructor(
    private readonly docker: Docker,
    private readonly image: string,
    private readonly log: Logger,
    private readonly networkName: string,
  ) {}

  // Created once per process; 409 means another worker won the race, which is the outcome we wanted.
  private ensureNetwork(): Promise<void> {
    this.network ??= (async () => {
      try {
        await this.docker.createNetwork(networkCreateOptions(this.networkName));
        this.log.info({ network: this.networkName }, 'agent network created');
      } catch (e) {
        const status = statusOf(e);
        if (status === 409) return;             // another worker won the race, which is the outcome we wanted
        this.network = null;                    // let the next container creation try again
        // 403 here is almost always the bridge-name collision: Linux caps an interface at 15 characters,
        // so two SANDBOX_NETWORK values sharing their first 12 truncate to one bridge. Say so, because the
        // daemon's own message ("networks have same bridge name") does not mention the setting to change.
        if (status === 403) {
          throw new Error(
            `cannot create agent network "${this.networkName}" (bridge ${bridgeName(this.networkName)}): ` +
            `${(e as DockerError).message ?? 'conflict'}. Another network already owns that bridge; ` +
            'pick a SANDBOX_NETWORK that differs within its first 12 characters.',
            { cause: e },
          );
        }
        throw e;
      }
    })();
    return this.network;
  }

  private container(agentId: string): Docker.Container {
    assertAgentId(agentId);
    return this.docker.getContainer(containerName(agentId));
  }

  private async inspect(agentId: string): Promise<Docker.ContainerInspectInfo | null> {
    try {
      return await this.container(agentId).inspect();
    } catch (e) {
      if (statusOf(e) === 404) return null;
      throw e;
    }
  }

  // Creates the volume + container when missing and starts the container when stopped.
  private async ensureRunning(agentId: string): Promise<Docker.Container> {
    let info = await this.inspect(agentId);
    if (!info) {
      await this.ensureNetwork();
      await ignoreStatus(this.docker.createVolume({ Name: volumeName(agentId), Labels: { 'vantra.agent': agentId } }), 409);
      try {
        await this.docker.createContainer(containerCreateOptions(agentId, this.image, this.networkName));
      } catch (e) {
        if (statusOf(e) === 404) {
          throw new Error(`sandbox image "${this.image}" not found; build it with: docker build -t ${this.image} docker/sandbox`);
        }
        if (statusOf(e) !== 409) throw e;   // 409: created concurrently by another step
      }
      info = await this.inspect(agentId);
      this.log.info({ agentId }, 'sandbox container created');
    }
    const container = this.container(agentId);
    if (!info?.State.Running) await ignoreStatus(container.start(), 304);
    return container;
  }

  private async cpuNs(container: Docker.Container): Promise<number | null> {
    try {
      const stats = await container.stats({ stream: false, 'one-shot': true });
      const total = stats?.cpu_stats?.cpu_usage?.total_usage;
      return typeof total === 'number' ? total : null;
    } catch {
      return null;
    }
  }

  // `pid` is what says whether the process ever existed. Docker reports a failure to START one — an
  // exhausted pid cgroup after a fork bomb, a missing interpreter in the image — as exit 128 with the
  // runc error written to the OUTPUT stream and Pid 0. See exec() for why that distinction matters.
  private async waitExit(exec: Docker.Exec): Promise<{ exitCode: number; pid: number }> {
    for (let i = 0; i < EXEC_EXIT_POLLS; i++) {
      const info = await exec.inspect();
      if (!info.Running) return { exitCode: info.ExitCode ?? -1, pid: info.Pid ?? -1 };
      await sleep(EXEC_EXIT_POLL_MS);
    }
    return { exitCode: -1, pid: -1 };
  }

  async ensure(agentId: string): Promise<void> {
    await this.ensureRunning(agentId);
  }

  async exec(agentId: string, command: string, opts: { timeoutMs: number; stdin?: string }): Promise<SandboxExecResult> {
    const container = await this.ensureRunning(agentId);
    const attachStdin = opts.stdin !== undefined;
    const seconds = Math.max(1, Math.ceil(opts.timeoutMs / 1000));
    const exec = await container.exec({
      Cmd: ['timeout', '-s', 'KILL', String(seconds), 'sh', '-lc', command],
      AttachStdin: attachStdin, AttachStdout: true, AttachStderr: true, Tty: false,
      WorkingDir: WORK_DIR, User: SANDBOX_USER,
    });
    const cpuBefore = await this.cpuNs(container);
    const started = Date.now();
    const stream = await exec.start({ hijack: true, stdin: attachStdin });
    const out = new OutputCollector(OUTPUT_CAP_BYTES);
    const err = new OutputCollector(OUTPUT_CAP_BYTES);
    this.docker.modem.demuxStream(stream, out, err);

    let hostKilled = false;
    const killer = setTimeout(() => {
      hostKilled = true;
      this.log.warn({ agentId }, 'exec ignored in-container timeout; killing container');
      stream.destroy();
      container.kill().catch(() => { /* already gone */ });
    }, opts.timeoutMs + HOST_KILL_GRACE_MS);
    if (attachStdin) {
      stream.write(opts.stdin);
      stream.end();
    }
    await new Promise<void>((resolve) => {
      stream.once('end', resolve);
      stream.once('close', resolve);
      stream.once('error', () => resolve());
    });
    clearTimeout(killer);

    const elapsed = Date.now() - started;
    const finished = hostKilled ? { exitCode: 137, pid: -1 } : await this.waitExit(exec);
    const cpuAfter = hostKilled ? null : await this.cpuNs(container);
    let { exitCode } = finished;
    let stdout = out.text();
    let stderr = err.text();

    // Pid 0 means the daemon never started a process, so nothing on that stream can be the command's
    // output — it is runc's own error text ("Cannot fork", "procReady not received") delivered on
    // stdout. Handing that back as stdout is the worst kind of quiet failure: the agent reads an
    // infrastructure message as the result of its own program and acts on it. This is a structural
    // check on the exec record, not a match against the daemon's wording.
    if (finished.pid === 0) {
      const detail = (stderr || stdout).trim() || `the container refused to start the process (exit ${exitCode})`;
      this.log.error({ agentId, exitCode, detail }, 'sandbox exec never started: the container is wedged');
      stdout = '';
      stderr = `sandbox could not start this command — the container is wedged and needs recreating: ${detail}`;
      exitCode = EXEC_START_FAILED_EXIT;
    }

    // `timeout` exits 124/137 when it fires; the same codes near the deadline mean the command was killed,
    // away from it they are the command's own exit (an OOM kill, say) and must not be reported as a timeout.
    const timedOut = hostKilled || ((exitCode === 137 || exitCode === 124) && elapsed + TIMEOUT_SLACK_MS >= opts.timeoutMs);
    return { stdout, stderr, exitCode, cpuMs: cpuMsFromStats(cpuBefore, cpuAfter, elapsed), timedOut };
  }

  async writeFile(agentId: string, rel: string, content: string): Promise<void> {
    const normalized = normalizeRelPath(rel);
    const container = await this.ensureRunning(agentId);
    await container.putArchive(packTar(fileArchiveEntries(normalized, Buffer.from(content, 'utf8'))), { path: WORK_DIR });
  }

  async readFile(agentId: string, rel: string, maxBytes: number): Promise<string> {
    const normalized = normalizeRelPath(rel);
    const container = await this.ensureRunning(agentId);
    const stream = await this.getArchive(container, normalized);
    for await (const { entry, body } of readTar(stream)) {
      if (entry.type === 'dir') throw new SandboxPathError(`not a file: ${normalized}`);
      if (entry.type !== 'file') continue;
      const parts: Buffer[] = [];
      let kept = 0;
      for await (const chunk of body()) {
        const room = maxBytes - kept;
        if (room <= 0) break;
        const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
        parts.push(part);
        kept += part.length;
      }
      return Buffer.concat(parts).toString('utf8') + truncationNote(entry.size, kept);
    }
    throw new SandboxPathError(`no such file: ${normalized}`);
  }

  async listFiles(agentId: string, rel: string): Promise<SandboxFile[]> {
    const normalized = normalizeRelPath(rel, { allowRoot: true });
    const dir = normalized ? `${WORK_DIR}/${normalized}` : WORK_DIR;
    const cmd = `cd ${shellQuote(dir)} && find . -mindepth 1 -maxdepth 1 -printf '%y\\t%s\\t%f\\n'`;
    const res = await this.exec(agentId, cmd, { timeoutMs: FS_OP_TIMEOUT_MS });
    if (res.exitCode !== 0) throw new SandboxPathError(res.stderr.trim() || `cannot list ${normalized || '.'}`);
    return parseFindOutput(normalized, res.stdout);
  }

  async exportDir(agentId: string, rel: string, destDir: string, maxBytes: number): Promise<{ bytes: number; files: number }> {
    const normalized = normalizeRelPath(rel, { allowRoot: true });
    const container = await this.ensureRunning(agentId);
    const stream = await this.getArchive(container, normalized);
    await mkdir(destDir, { recursive: true });
    const totals = { bytes: 0, files: 0 };
    for await (const { entry, body } of readTar(stream)) {
      // getArchive of /work/site yields entries as `site/...`; drop that top-level component.
      const inner = entry.name.split('/').slice(1).join('/');
      if (inner === '') continue;
      let safe: string;
      try {
        safe = normalizeRelPath(inner);
      } catch {
        continue;                                   // hostile entry name; never write it
      }
      const target = path.join(destDir, safe);
      if (entry.type === 'dir') {
        await mkdir(target, { recursive: true });
      } else if (entry.type === 'file') {
        totals.bytes += entry.size;
        totals.files += 1;
        if (totals.bytes > maxBytes) throw new SandboxLimitError(`directory exceeds ${maxBytes} bytes`);
        if (totals.files > MAX_EXPORT_FILES) throw new SandboxLimitError(`directory has more than ${MAX_EXPORT_FILES} files`);
        await mkdir(path.dirname(target), { recursive: true });
        await streamPipeline(Readable.from(body()), createWriteStream(target));
      }
    }
    return totals;
  }

  async destroy(agentId: string): Promise<void> {
    await ignoreStatus(this.container(agentId).remove({ force: true }), 404);
    const volume = this.docker.getVolume(volumeName(agentId));
    for (let attempt = 0; ; attempt++) {
      try {
        await volume.remove();
        return;
      } catch (e) {
        const status = statusOf(e);
        if (status === 404) return;
        if (status !== 409 || attempt >= 5) throw e;   // 409: still attached while the container is being removed
        await sleep(200 * (attempt + 1));
      }
    }
  }

  async stop(agentId: string): Promise<void> {
    await ignoreStatus(this.container(agentId).stop({ t: 5 }), 304, 404);
  }

  async start(agentId: string): Promise<void> {
    await this.ensureRunning(agentId);
  }

  private async getArchive(container: Docker.Container, normalized: string): Promise<Readable> {
    try {
      return (await container.getArchive({ path: normalized ? `${WORK_DIR}/${normalized}` : WORK_DIR })) as unknown as Readable;
    } catch (e) {
      if (statusOf(e) === 404) throw new SandboxPathError(`no such file or directory: ${normalized || '.'}`);
      throw e;
    }
  }
}
