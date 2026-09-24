// A dockerode double good enough for the container-per-agent driver: containers, volumes, execs and
// the tar archive endpoints. It uses a real dockerode modem for demuxStream so the framing is not faked.
import { Duplex, Readable } from 'node:stream';
import Docker from 'dockerode';
import { packTar, type TarInput } from '../../../src/sandbox/tar.js';

export interface FakeExecRecord { cmd: string[]; user?: string; stdin: string }
export interface FakeExecAnswer {
  stdout?: string; stderr?: string; exitCode?: number; cpuNs?: number; hang?: boolean;
  /**
   * `exec.inspect().Pid`. The real daemon reports 0 when the process NEVER STARTED and writes runc's
   * own error to the output stream (verified against Docker 29.4.0: a missing binary gives
   * `{exitCode:127, pid:0, out:'OCI runtime exec failed: …'}` while a shell that runs and cannot find
   * the command gives `{exitCode:127, pid:86824}`). Defaults to a plausible live pid.
   */
  pid?: number;
}

export interface FakeContainerState {
  name: string;
  running: boolean;
  removed: boolean;
  killed: number;
  stopped: number;
  cpuNs: number | null;              // null makes stats() fail, forcing the wall-clock fallback
  putArchives: { path: string; tar: Buffer }[];
  archives: Map<string, TarInput[]>; // path → entries returned by getArchive
  execs: FakeExecRecord[];
  respond: (cmd: string[], stdin: string) => FakeExecAnswer;
}

export interface FakeDocker {
  docker: Docker;
  containers: Map<string, FakeContainerState>;
  volumes: Map<string, { removed: boolean; removeErrors: number }>;
  networks: Docker.NetworkCreateOptions[];
  created: Docker.ContainerCreateOptions[];
  createContainerError: (() => Error) | null;
  container(agentId: string): FakeContainerState;
}

export const httpError = (statusCode: number, message: string): Error => Object.assign(new Error(message), { statusCode });

export function createFakeDocker(): FakeDocker {
  const containers = new Map<string, FakeContainerState>();
  const volumes = new Map<string, { removed: boolean; removeErrors: number }>();
  const networks: Docker.NetworkCreateOptions[] = [];
  const created: Docker.ContainerCreateOptions[] = [];
  const fake: FakeDocker = {
    docker: null as unknown as Docker,
    containers, volumes, networks, created,
    createContainerError: null,
    container: (agentId) => {
      const state = containers.get(`rw-${agentId}`);
      if (!state) throw new Error(`no fake container for ${agentId}`);
      return state;
    },
  };

  const getContainer = (name: string) => {
    const state = (): FakeContainerState => {
      const s = containers.get(name);
      if (!s || s.removed) throw httpError(404, `no such container: ${name}`);
      return s;
    };
    return {
      async inspect() { return { State: { Running: state().running } } as Docker.ContainerInspectInfo; },
      async start() { const s = state(); if (s.running) throw httpError(304, 'already started'); s.running = true; },
      async stop() { const s = state(); s.stopped += 1; if (!s.running) throw httpError(304, 'already stopped'); s.running = false; },
      async kill() { const s = state(); s.killed += 1; s.running = false; },
      async remove() { state().removed = true; },
      async stats() {
        const s = state();
        if (s.cpuNs === null) throw new Error('stats unavailable');
        return { cpu_stats: { cpu_usage: { total_usage: s.cpuNs } } };
      },
      async putArchive(tar: Buffer, opts: { path: string }) { state().putArchives.push({ path: opts.path, tar }); },
      async getArchive(opts: { path: string }) {
        const entries = state().archives.get(opts.path);
        if (!entries) throw httpError(404, `no such path: ${opts.path}`);
        return Readable.from([packTar(entries)]);
      },
      async exec(opts: { Cmd: string[]; User?: string }) {
        const s = state();
        const record: FakeExecRecord = { cmd: opts.Cmd, user: opts.User, stdin: '' };
        s.execs.push(record);
        let exitCode = 0;
        let pid = 4242;
        // Resolved on first read, by which time the driver has written stdin.
        const produce = (): Buffer | null => {
          const answer = s.respond(opts.Cmd, record.stdin);
          if (answer.cpuNs !== undefined) s.cpuNs = answer.cpuNs;
          exitCode = answer.exitCode ?? 0;
          pid = answer.pid ?? 4242;
          return answer.hang ? null : frames(answer.stdout ?? '', answer.stderr ?? '');
        };
        return {
          async start() { return new FakeExecStream(produce, record); },
          async inspect() { return { Running: false, ExitCode: exitCode, Pid: pid } as Docker.ExecInspectInfo; },
        };
      },
    };
  };

  fake.docker = {
    modem: new Docker().modem,
    getContainer: (name: string) => getContainer(name) as unknown as Docker.Container,
    async createContainer(opts: Docker.ContainerCreateOptions) {
      if (fake.createContainerError) throw fake.createContainerError();
      const name = opts.name!;
      if (containers.has(name) && !containers.get(name)!.removed) throw httpError(409, 'name already in use');
      created.push(opts);
      containers.set(name, {
        name, running: false, removed: false, killed: 0, stopped: 0, cpuNs: 0,
        putArchives: [], archives: new Map(), execs: [], respond: () => ({}),
      });
      return getContainer(name) as unknown as Docker.Container;
    },
    async createNetwork(opts: Docker.NetworkCreateOptions) {
      if (networks.some((n) => n.Name === opts.Name)) throw httpError(409, 'network already exists');
      networks.push(opts);
    },
    async createVolume(opts: { Name: string }) { volumes.set(opts.Name, { removed: false, removeErrors: 0 }); },
    getVolume: (name: string) => ({
      async remove() {
        const v = volumes.get(name);
        if (!v || v.removed) throw httpError(404, 'no such volume');
        if (v.removeErrors > 0) { v.removeErrors -= 1; throw httpError(409, 'volume is in use'); }
        v.removed = true;
      },
    }),
  } as unknown as Docker;

  return fake;
}

// Docker multiplexes exec output: 8-byte header (stream type, 3 zero bytes, BE length) then the payload.
function frames(stdout: string, stderr: string): Buffer {
  const parts: Buffer[] = [];
  for (const [type, text] of [[1, stdout], [2, stderr]] as const) {
    if (!text) continue;
    const payload = Buffer.from(text, 'utf8');
    const header = Buffer.alloc(8);
    header.writeUInt8(type, 0);
    header.writeUInt32BE(payload.length, 4);
    parts.push(header, payload);
  }
  return Buffer.concat(parts);
}

class FakeExecStream extends Duplex {
  private pushed = false;

  constructor(private readonly produce: () => Buffer | null, private readonly record: FakeExecRecord) {
    super();
  }

  override _read(): void {
    if (this.pushed) return;
    this.pushed = true;
    const payload = this.produce();
    if (payload === null) return;          // hangs until the driver kills the container
    if (payload.length > 0) this.push(payload);
    this.push(null);
  }

  override _write(chunk: Buffer, _enc: BufferEncoding, cb: (e?: Error | null) => void): void {
    this.record.stdin += chunk.toString('utf8');
    cb();
  }
}
