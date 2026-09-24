// Registers the hosting plugin on a bare Fastify instance with fake dependencies (no db, no docker).
import Fastify, { type FastifyInstance } from 'fastify';
import { loadConfig } from '../../../src/config.js';
import { createBus } from '../../../src/core/bus.js';
import type { ChainAdapter, Deps, LaunchpadPort, LlmRouter, SandboxDriver, ToolRegistry } from '../../../src/core/interfaces.js';
import type { Db } from '../../../src/db/client.js';
import { registerHosting, type HostingOptions } from '../../../src/hosting/index.js';
import { systemClock } from '../../../src/lib/clock.js';
import { silentLogger } from '../../../src/lib/log.js';
import { createFakeChain, createFakeSandbox } from './fakes.js';

// Hosting talks to the database only through the stores it builds; any other access is a bug.
const forbiddenDb = new Proxy({}, {
  get: (_t, prop) => { throw new Error(`deps.db.${String(prop)} accessed directly by hosting`); },
}) as unknown as Db;
// Hosting has no reason to touch the Pons launchpad either.
const forbiddenLaunchpad = new Proxy({}, {
  get: (_t, prop) => { throw new Error(`deps.launchpad.${String(prop)} accessed by hosting`); },
}) as unknown as LaunchpadPort;

export interface HostingDepsOptions { dataDir: string; sandbox?: SandboxDriver; chain?: ChainAdapter; db?: Db; env?: NodeJS.ProcessEnv }

export function makeHostingDeps(opts: HostingDepsOptions): Deps {
  const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', DATA_DIR: opts.dataDir, ...opts.env });
  return {
    config,
    db: opts.db ?? forbiddenDb,
    clock: systemClock,
    chain: opts.chain ?? createFakeChain(),
    launchpad: forbiddenLaunchpad,
    sandbox: opts.sandbox ?? createFakeSandbox(),
    search: { name: 'none', search: async () => [] },
    llm: { mode: 'mock' } as unknown as LlmRouter,
    bus: createBus(silentLogger),
    log: silentLogger,
    tools: {} as ToolRegistry,
  };
}

export async function buildHostingApp(opts: HostingDepsOptions & { hosting?: HostingOptions }): Promise<{ app: FastifyInstance; deps: Deps }> {
  const deps = makeHostingDeps(opts);
  const app = Fastify({ logger: false });
  await registerHosting(app, deps, opts.hosting ?? {});
  await app.ready();
  return { app, deps };
}
