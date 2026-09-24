// Builds the HTTP app on fake dependencies: fake Services, fake Payments, in-memory auth store,
// no hosting plugin, no db.
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { CLIENT_HEADER, CLIENT_HEADER_VALUE, DEFAULT_CATALOG, type ChainMode } from '@vantra/shared';
import { loadConfig } from '../../../src/config.js';
import { createBus } from '../../../src/core/bus.js';
import type { ChainAdapter, Deps, LaunchpadPort, LlmRouter, SandboxDriver, ToolRegistry } from '../../../src/core/interfaces.js';
import type { Db } from '../../../src/db/client.js';
import { systemClock } from '../../../src/lib/clock.js';
import { silentLogger } from '../../../src/lib/log.js';
import { createApp, type AppOptions } from '../../../src/http/server.js';
import { SESSION_COOKIE } from '../../../src/http/auth.js';
import { createFakePayments, type FakePayments } from './fakePayments.js';
import { createFakeServices, type FakeServices } from './fakeServices.js';
import { createMemoryAuthStore, type MemoryAuthStore } from './memoryAuthStore.js';

export const PUBLIC_URL = 'http://localhost:5173';

// The smallest env that loadConfig accepts for NODE_ENV=production (real secrets, isolated sandbox).
export const PROD_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: 'production',
  DEMO: '0',
  SANDBOX_DRIVER: 'docker',
  SANDBOX_EGRESS_FILTERED: '1',
  SESSION_SECRET: 'a-test-session-secret-of-sufficient-length',
  KEY_ENCRYPTION_KEY: 'a'.repeat(64),
};

export interface TestApp {
  app: FastifyInstance;
  deps: Deps;
  services: FakeServices;
  payments: FakePayments;
  store: MemoryAuthStore;
  // Signs in through POST /api/auth/demo and returns the Cookie header value. The "wallet" is an
  // owner id, so a `claim_pu_…` identity signs in exactly the same way.
  signIn(ownerId: string): Promise<string>;
  close(): Promise<void>;
}

export interface TestAppOptions extends Partial<AppOptions> {
  env?: NodeJS.ProcessEnv;
  chainMode?: ChainMode;    // 'robinhood' proves the memory-only routes are not mounted
}

// The http layer must never touch the db directly except through the auth store; this makes any stray access loud.
const forbiddenDb = new Proxy({}, {
  get: (_target, prop) => { throw new Error(`deps.db.${String(prop)} accessed by the http layer`); },
}) as unknown as Db;
// Launch routes reach the chain only through the (fake) Services; a direct launchpad call is a bug.
const forbiddenLaunchpad = new Proxy({}, {
  get: (_target, prop) => { throw new Error(`deps.launchpad.${String(prop)} accessed by the http layer`); },
}) as unknown as LaunchpadPort;

export interface FakeDepsOptions {
  services?: FakeServices;
  payments?: FakePayments;
  chainMode?: ChainMode;
}

export function makeDeps(env: NodeJS.ProcessEnv = {}, opts: FakeDepsOptions = {}): Deps {
  const services = opts.services ?? createFakeServices();
  const payments = opts.payments ?? createFakePayments();
  const mode: ChainMode = opts.chainMode ?? 'memory';
  const config = loadConfig({ NODE_ENV: 'test', DEMO: '1', LOG_LEVEL: 'silent', PUBLIC_URL, ...env });
  const chain = { mode, cluster: mode === 'memory' ? 'memory' : 'testnet', usdcMint: 'USDC' } as unknown as ChainAdapter;
  const sandbox = { name: 'local' } as unknown as SandboxDriver;
  const llm = { mode: 'mock', models: () => DEFAULT_CATALOG.filter((m) => m.provider === 'mock') } as unknown as LlmRouter;
  const deps: Deps = {
    config, db: forbiddenDb, clock: systemClock, chain, launchpad: forbiddenLaunchpad, sandbox, llm, log: silentLogger,
    search: { name: 'none', search: async () => [] },
    bus: createBus(silentLogger),
    tools: {} as ToolRegistry,
  };
  deps.services = services;
  deps.payments = payments;
  return deps;
}

export async function buildTestApp(opts: TestAppOptions = {}): Promise<TestApp> {
  const { env, chainMode, ...appOpts } = opts;
  const services = createFakeServices();
  const payments = createFakePayments();
  const deps = makeDeps(env, { services, payments, chainMode });
  const store = createMemoryAuthStore();
  const app = await createApp(deps, { hosting: null, authStore: store, ...appOpts });
  await app.ready();
  return {
    app, deps, services, payments, store,
    async signIn(ownerId) {
      const res = await app.inject(web({ method: 'POST', url: '/api/auth/demo', payload: { wallet: ownerId } }));
      if (res.statusCode !== 200) throw new Error(`demo sign-in failed: ${res.body}`);
      return cookieHeader(res);
    },
    close: () => app.close(),
  };
}

// Adds the CSRF header the web client sends on every mutating call.
export function web(opts: InjectOptions): InjectOptions {
  return { ...opts, headers: { [CLIENT_HEADER]: CLIENT_HEADER_VALUE, ...(opts.headers ?? {}) } };
}

// The raw Set-Cookie value for rw_session, exactly as a browser would echo it back.
export function cookieHeader(res: LightMyRequestResponse): string {
  const setCookie = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
  const line = setCookie.find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  if (!line) throw new Error('no session cookie in response');
  return line.split(';')[0]!;
}

export const json = <T = unknown>(res: LightMyRequestResponse): T => JSON.parse(res.body) as T;
