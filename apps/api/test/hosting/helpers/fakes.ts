// Fakes for the hosting tests: a sandbox whose exec/exportDir are scripted, an in-memory deployment
// store and an in-memory service store. No docker, no database.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ChainAdapter, SandboxDriver, SandboxExecResult, UsdcTransfer } from '../../../src/core/interfaces.js';
import type { ServiceRow } from '../../../src/db/schema.js';
import { SandboxLimitError } from '../../../src/sandbox/common.js';
import type { DeploymentStore } from '../../../src/hosting/deploy.js';
import type { NewServiceCall, SellerRow, ServiceStore } from '../../../src/hosting/service.js';

export interface ExecCall { agentId: string; command: string; stdin?: string; timeoutMs: number }

export interface FakeSandbox extends SandboxDriver {
  tree: Map<string, string>;                       // '<agentId>:<dir>' → files, set via setTree()
  execs: ExecCall[];
  respond: (call: ExecCall) => Partial<SandboxExecResult>;
  setTree(agentId: string, dir: string, files: Record<string, string>): void;
}

const ok = (over: Partial<SandboxExecResult>): SandboxExecResult =>
  ({ stdout: '', stderr: '', exitCode: 0, cpuMs: 0, timedOut: false, ...over });

export function createFakeSandbox(): FakeSandbox {
  const trees = new Map<string, Record<string, string>>();
  const fake: FakeSandbox = {
    name: 'local',
    tree: new Map(),
    execs: [],
    respond: () => ({ stdout: '{}' }),
    setTree(agentId, dir, files) { trees.set(`${agentId}:${dir}`, files); },
    async ensure() { /* nothing to create */ },
    async exec(agentId, command, opts) {
      const call: ExecCall = { agentId, command, stdin: opts.stdin, timeoutMs: opts.timeoutMs };
      fake.execs.push(call);
      return ok(fake.respond(call));
    },
    async writeFile() { /* unused */ },
    async readFile() { return ''; },
    async listFiles() { return []; },
    async exportDir(agentId, dir, destDir, maxBytes) {
      const files = trees.get(`${agentId}:${dir}`);
      if (!files) throw new Error(`no such directory: ${dir}`);
      let bytes = 0;
      for (const [rel, content] of Object.entries(files)) {
        bytes += Buffer.byteLength(content);
        if (bytes > maxBytes) throw new SandboxLimitError(`directory exceeds ${maxBytes} bytes`);
        const target = path.join(destDir, rel);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, content, 'utf8');
      }
      return { bytes, files: Object.keys(files).length };
    },
    async destroy() { /* unused */ },
    async stop() { /* unused */ },
    async start() { /* unused */ },
  };
  return fake;
}

export interface FakeDeploymentStore extends DeploymentStore {
  rows: { agentId: string; slug: string; dirSizeBytes: number; deployedAt: Date; active: boolean }[];
}

export function createFakeDeploymentStore(): FakeDeploymentStore {
  const rows: FakeDeploymentStore['rows'] = [];
  return {
    rows,
    async activeOwner(slug) { return rows.find((r) => r.slug === slug && r.active)?.agentId ?? null; },
    async upsert({ agentId, slug, dirSizeBytes, deployedAt }) {
      const existing = rows.find((r) => r.slug === slug && r.agentId === agentId && r.active);
      if (existing) Object.assign(existing, { dirSizeBytes, deployedAt });
      else rows.push({ agentId, slug, dirSizeBytes, deployedAt, active: true });
    },
    async deactivate(slug) { for (const r of rows) if (r.slug === slug) r.active = false; },
  };
}

export const SELLER: SellerRow = { id: 'ag_seller001', name: 'SELLER', status: 'alive', walletPubkey: 'SellerWallet11111111111111111111111111111' };

export function makeService(over: Partial<ServiceRow> = {}): ServiceRow {
  return {
    id: 'sv_demo000001', agentId: SELLER.id, name: 'summarize', description: 'summarises text',
    priceMicro: 50_000, handlerPath: 'svc/handler.js', status: 'active', calls: 0, revenueMicro: 0,
    createdAt: new Date('2026-09-01T00:00:00.000Z'), ...over,
  };
}

export interface FakeServiceStore extends ServiceStore {
  calls: NewServiceCall[];
  service: ServiceRow;
  seller: SellerRow;
  payments: Set<string>;
  recordError: Error | null;
}

export function createFakeServiceStore(service = makeService(), seller = SELLER): FakeServiceStore {
  const store: FakeServiceStore = {
    calls: [], service, seller, payments: new Set(), recordError: null,
    async get(serviceId) { return serviceId === store.service.id ? { service: store.service, agent: store.seller } : null; },
    async paymentUsed(txSig) { return store.payments.has(txSig); },
    async record(call) {
      if (store.recordError) throw store.recordError;
      if (call.paymentTx) store.payments.add(call.paymentTx);
      store.calls.push(call);
      store.service = { ...store.service, calls: store.service.calls + 1, revenueMicro: store.service.revenueMicro + call.priceMicro };
      return store.calls.length;
    },
  };
  return store;
}

export interface FakeChain extends ChainAdapter { transfers: Map<string, UsdcTransfer> }

// Only getUsdcTransfer is exercised by hosting; everything else throws loudly if it is reached.
export function createFakeChain(): FakeChain {
  const transfers = new Map<string, UsdcTransfer>();
  const unused = (name: string) => () => { throw new Error(`fake chain: ${name} should not be called by hosting`); };
  return {
    mode: 'memory', cluster: 'memory', usdcMint: 'USDC', transfers,
    async getUsdcTransfer(sig) { return transfers.get(sig) ?? null; },
    newKeypair: unused('newKeypair'),
    getUsdcBalance: unused('getUsdcBalance'),
    getEthBalance: unused('getEthBalance'),
    getTokenBalance: unused('getTokenBalance'),
    transferUsdc: unused('transferUsdc'),
    transferEth: unused('transferEth'),
    listUsdcInflows: unused('listUsdcInflows'),
    sweepUsdc: unused('sweepUsdc'),
    sweepEth: unused('sweepEth'),
    ethPriceUsd: unused('ethPriceUsd'),
    swap: unused('swap'),
    quoteUsdcOut: unused('quoteUsdcOut'),
  } as FakeChain;
}
