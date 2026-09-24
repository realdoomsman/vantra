// In-memory Services: records every call, returns fixtures, and can be told to fail a method once.
// The fixture fields are mutable so a test can stage state (`services.transcript = null`) before a request.
//
// Ownership lives in its own `owners` map, deliberately NOT on the public payload: a claim-code
// owner's agent has `ownerWallet: null`, so a route that still compared the two would pass every
// check here for the wrong reason (SPEC-V2 §6.2).
import type {
  AgentDetail, AgentLiveState, AgentPublic, Bounty, GlobalStats, Me, Service, StepTranscript,
} from '@vantra/shared';
import type { Services } from '../../../src/core/interfaces.js';
import { notFound } from '../../../src/lib/errors.js';
import {
  AGENT_A, AGENT_B, CLAIM_AGENT, CLAIM_OWNER, DEAD_AGENT, OWNER_A, OWNER_B, PAYOUT_WALLET,
  makeBounty, makeDetail, makeLive, makeMe, makeRawTranscript, makeService, makeStats, makeTreasuryTx,
} from './fixtures.js';

export interface RecordedCall { method: keyof Services; args: unknown[] }

export interface FakeServices extends Services {
  calls: RecordedCall[];
  agents: Map<string, AgentDetail>;
  owners: Map<string, string>;          // agentId → owner id (a pubkey, or claim_pu_…)
  bountyList: Bounty[];
  serviceList: Service[];
  transcript: StepTranscript | null;
  statsValue: GlobalStats;
  liveValue: AgentLiveState;
  failOnce(method: keyof Services, err: Error): void;
  callsTo(method: keyof Services): RecordedCall[];
}

export function createFakeServices(): FakeServices {
  const failures = new Map<keyof Services, Error>();
  const agents = new Map<string, AgentDetail>([
    [AGENT_A, makeDetail({ id: AGENT_A, name: 'ALPHA', ownerWallet: OWNER_A, ownerKind: 'wallet' })],
    [AGENT_B, makeDetail({ id: AGENT_B, name: 'BRAVO', ownerWallet: OWNER_B, ownerKind: 'wallet', walletPubkey: 'AgentWallet2222222222222222222222222222222', deploySlug: 'bravo' })],
    // Bought with a claim code: the public payload has no owner on it at all.
    [CLAIM_AGENT, makeDetail({ id: CLAIM_AGENT, name: 'CHARLIE', ownerWallet: null, ownerKind: 'claim', tierId: 'SCOUT', walletPubkey: 'AgentWallet3333333333333333333333333333333', deploySlug: 'charlie' })],
    [DEAD_AGENT, makeDetail({ id: DEAD_AGENT, name: 'DELTA', ownerWallet: OWNER_B, ownerKind: 'wallet', status: 'dead', phase: 'dead', deathCause: 'insolvent', diedAt: '2026-09-02T00:00:00.000Z', postmortem: 'Ran out of money. Spent it all on inference.' })],
  ]);
  const owners = new Map<string, string>([
    [AGENT_A, OWNER_A], [AGENT_B, OWNER_B], [CLAIM_AGENT, CLAIM_OWNER], [DEAD_AGENT, OWNER_B],
  ]);

  const fake = {
    calls: [] as RecordedCall[],
    agents,
    owners,
    bountyList: [makeBounty()],
    serviceList: [makeService()],
    transcript: makeRawTranscript() as StepTranscript | null,
    statsValue: makeStats(),
    liveValue: makeLive(),
    failOnce: (method: keyof Services, err: Error) => { failures.set(method, err); },
    callsTo: (method: keyof Services) => fake.calls.filter((c) => c.method === method),
  } as FakeServices;

  const detail = (id: string): AgentDetail => {
    const agent = agents.get(id);
    if (!agent) throw new Error(`fake: unknown agent ${id}`);
    return agent;
  };
  const owned = (id: string): AgentPublic => publicOf(detail(id));

  const impl: Services = {
    async spawn(input) {
      const agent = makeDetail({
        id: 'ag_spawned000', name: input.name, ownerWallet: input.ownerKind === 'claim' ? null : input.ownerWallet,
        ownerKind: input.ownerKind, tierId: input.tierId, directive: input.directive, enabledTools: input.tools,
        model: input.model, effort: input.effort, heartbeatMin: input.heartbeatMin,
        fundingMicro: input.fundingMicro, forkedFrom: input.forkOf ?? null, status: 'spawning', phase: 'spawning',
      });
      agents.set(agent.id, agent);
      owners.set(agent.id, input.ownerWallet);
      return publicOf(agent);
    },
    async isOwner(agentId, ownerId) { return owners.get(agentId) === ownerId; },
    async withdraw() { return { sentMicro: 1_000_000, feeMicro: 25_000, txSig: 'sig-withdraw' }; },
    async revive(id) { return owned(id); },
    async recapitalize(id) { return owned(id); },
    async creditTopUp(id) { return owned(id); },
    async pause(id, _owner, paused) { return { ...owned(id), status: paused ? 'paused' : 'alive' }; },
    async terminate(id) { return { ...owned(id), status: 'dead', deathCause: 'owner_terminated' }; },
    async setShareStrategy(id, _owner, share) { return { ...owned(id), shareStrategy: share }; },
    async setHeartbeat(id, _owner, heartbeatMin) { return { ...owned(id), heartbeatMin }; },
    async messageAgent() { /* recorded only */ },
    async postBounty(input) { return makeBounty({ id: 'bt_posted00000', posterId: input.posterWallet, title: input.title, description: input.description, rewardMicro: input.rewardMicro, status: 'open', claimerAgentId: null, claimerName: null, submission: null }); },
    async reviewBounty(id, _wallet, approve, feedback) { return makeBounty({ id, status: approve ? 'paid' : 'rejected', feedback }); },
    async callService() { return { output: { ok: true }, status: 'ok' }; },
    async getAgent(id, viewerId) {
      const agent = agents.get(id);
      return agent ? { ...agent, isOwner: !!viewerId && owners.get(id) === viewerId } : null;
    },
    async listAgents() { return { rows: [...agents.values()].map(publicOf), total: agents.size }; },
    async leaderboard() { return [...agents.values()].map(publicOf); },
    async graveyard() { return [...agents.values()].filter((a) => a.status === 'dead').map((a) => ({ ...publicOf(a), postmortem: a.postmortem })); },
    async stats() { return fake.statsValue; },
    async series() { return []; },
    async events() { return []; },
    async ledger() { return []; },
    async steps() { return []; },
    async agentLive(agentId) { return { ...fake.liveValue, agentId }; },
    async stepTranscript(_agentId, _stepId, viewerId) {
      return fake.transcript === null ? null : { transcript: fake.transcript, ownerView: viewerId === OWNER_A };
    },
    async bounties(status) { return status ? fake.bountyList.filter((b) => b.status === status) : fake.bountyList; },
    async services() { return fake.serviceList; },
    async treasury() { return fake.statsValue.treasury; },
    async treasuryTxs() { return [makeTreasuryTx()]; },
    async me(ownerId) {
      return makeMe(ownerId, {
        agents: [...agents.entries()].filter(([id]) => owners.get(id) === ownerId).map(([, a]) => publicOf(a)),
      });
    },
    async setPayoutWallet(ownerId, wallet) { return makeMe(ownerId, { payoutWallet: wallet || PAYOUT_WALLET }); },
    async custodialWallet() { return { pubkey: 'CustodiaLWa11etPubkey1111111111111111111111', usdcMicro: 5_000_000, ethGwei: 0 }; },
    async withdrawCustodial(_ownerId, _to, amountMicro) { return { sentMicro: amountMicro ?? 1_000_000, txSig: 'sig-custodial-withdraw' }; },
    async launchToken(_agentId, _ownerId, ticker) {
      const token = '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984';
      return {
        token, curve: '0x06e3f4759795a26c96EC89209a6A567c25b272d7', name: 'TOK', ticker: ticker ?? 'TOK',
        launchedAt: '2026-09-01T00:00:00.000Z', ponsUrl: `https://www.ponsfamily.com/token/${token}`, creatorTaxBps: 1000,
      };
    },
    // The fixture world has no launches: every launch lookup misses exactly as it would on an empty table.
    async prepareLaunch() { throw notFound('Launch'); },
    async confirmLaunch() { throw notFound('Launch'); },
    async simulateLaunch() { throw notFound('Launch'); },
    async simulateLaunchFees() { throw notFound('Launch'); },
    async setLaunchModel() { throw notFound('Launch'); },
    async listLaunches() { return { rows: [], total: 0 }; },
    async launchDetail() { return null; },
    async agentLaunch() { return null; },
  };

  for (const method of Object.keys(impl) as (keyof Services)[]) {
    const original = impl[method] as (...args: unknown[]) => Promise<unknown>;
    (fake as unknown as Record<string, unknown>)[method] = async (...args: unknown[]) => {
      fake.calls.push({ method, args });
      const err = failures.get(method);
      if (err) {
        failures.delete(method);
        throw err;
      }
      return original.apply(impl, args);
    };
  }
  return fake;
}

// Detail-only fields must not ride along on an AgentPublic, or a test could pass on data a route leaked.
function publicOf(a: AgentDetail): AgentPublic {
  const {
    isOwner, memory, strategy, postmortem, ownerMessages, projects, decisions, ledgerRecent, series,
    withdrawable, services, bounties, parent, children, deployments, ...pub
  } = a;
  return pub;
}
