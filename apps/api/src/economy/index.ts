// Services: everything the HTTP layer and the tools call into. Ledger writes stay in ledger.ts,
// which is the only writer of the agent money columns (SPEC §7, §8.4, §8.11; AMENDMENTS §C;
// SPEC-V2 §6.2, §7). Every `ownerId` is an owner id: a base58 pubkey, or `claim_pu_…`.
import type { Deps, Services } from '../core/interfaces.js';
import { custodialWallet, withdrawCustodial } from './custodial.js';
import { loadDetail } from './agents.js';
import { launchAgentToken } from './token.js';
import { loadImage, uploadImage } from './images.js';
import {
  agentLaunch, confirmLaunch, launchDetail, listLaunches, prepareLaunch, setLaunchModel, simulateFees, simulateLaunch,
} from './launch.js';
import { listEvents } from './events.js';
import { listLedger } from './ledger.js';
import { callService, listBounties, listServices, postBounty, reviewBounty } from './market.js';
import { creditTopUp, messageAgent, pause, recapitalize, setHeartbeat, setPayoutWallet, setShareStrategy, terminate } from './owner.js';
import { isOwnerOf, loadAgent } from './repo.js';
import { revive } from './revive.js';
import { spawn } from './spawn.js';
import { graveyard, leaderboard, listAgents, me, series, stats } from './stats.js';
import { listSteps, liveState, stepTranscript } from './steps.js';
import { treasuryService } from './treasury.js';
import { withdraw } from './withdraw.js';

export function createServices(deps: Deps): Services {
  const treasury = treasuryService(deps);
  return {
    spawn: (input) => spawn(deps, input),
    isOwner: (agentId, ownerId) => isOwnerOf(deps.db, agentId, ownerId),
    withdraw: (agentId, ownerId, amountMicro, payoutWallet) => withdraw(deps, agentId, ownerId, amountMicro, payoutWallet),
    revive: (agentId, ownerId) => revive(deps, agentId, ownerId),
    recapitalize: (agentId, ownerId, txSig) => recapitalize(deps, agentId, ownerId, txSig),
    creditTopUp: (agentId, purchaseId, amountMicro) => creditTopUp(deps, agentId, purchaseId, amountMicro),
    pause: (agentId, ownerId, paused) => pause(deps, agentId, ownerId, paused),
    terminate: (agentId, ownerId) => terminate(deps, agentId, ownerId),
    setShareStrategy: (agentId, ownerId, share) => setShareStrategy(deps, agentId, ownerId, share),
    setHeartbeat: (agentId, ownerId, heartbeatMin) => setHeartbeat(deps, agentId, ownerId, heartbeatMin),
    messageAgent: (agentId, ownerId, text) => messageAgent(deps, agentId, ownerId, text),
    postBounty: (input) => postBounty(deps, input),
    reviewBounty: (bountyId, posterWallet, approve, feedback) => reviewBounty(deps, bountyId, posterWallet, approve, feedback),
    callService: (serviceId, buyer, input) => callService(deps, serviceId, buyer, input),
    async getAgent(id, viewerOwnerId) {
      const row = await loadAgent(deps.db, id);
      return row ? loadDetail(deps, row, viewerOwnerId ?? null) : null;
    },
    listAgents: (q) => listAgents(deps, q),
    leaderboard: (by, limit) => leaderboard(deps, by, limit),
    graveyard: (limit, sort) => graveyard(deps, limit, sort),
    stats: () => stats(deps),
    series: (days) => series(deps, days),
    events: (q) => listEvents(deps.db, q),
    ledger: (agentId, q) => listLedger(deps.db, agentId, q),
    steps: (agentId, limit) => listSteps(deps.db, agentId, limit),
    agentLive: (agentId) => liveState(deps.db, agentId),
    stepTranscript: (agentId, stepId, viewerOwnerId) => stepTranscript(deps.db, agentId, stepId, viewerOwnerId),
    bounties: (status) => listBounties(deps, status),
    services: () => listServices(deps),
    treasury: () => treasury.current(),
    treasuryTxs: (q) => treasury.listTxs(q),
    me: (ownerId) => me(deps, ownerId),
    setPayoutWallet: (ownerId, wallet) => setPayoutWallet(deps, ownerId, wallet),
    custodialWallet: (ownerId) => custodialWallet(deps, ownerId),
    withdrawCustodial: (ownerId, to, amountMicro) => withdrawCustodial(deps, ownerId, to, amountMicro),
    launchToken: (agentId, ownerId, ticker) => launchAgentToken(deps, agentId, ownerId, ticker),
    prepareLaunch: (devId, req) => prepareLaunch(deps, devId, req),
    confirmLaunch: (launchId, devId, txSig) => confirmLaunch(deps, launchId, devId, txSig),
    simulateLaunch: (launchId, devId) => simulateLaunch(deps, launchId, devId),
    simulateLaunchFees: (launchId, amountUsd) => simulateFees(deps, launchId, amountUsd),
    setLaunchModel: (launchId, devId, model) => setLaunchModel(deps, launchId, devId, model),
    listLaunches: (q) => listLaunches(deps, q),
    launchDetail: (launchId) => launchDetail(deps, launchId),
    agentLaunch: (agentId) => agentLaunch(deps, agentId),
    uploadImage: (ownerId, bytes) => uploadImage(deps, ownerId, bytes),
    image: (id) => loadImage(deps, id),
  };
}

export { paymentsPort, escrowPort, hostingLedgerHook, hostingRefund } from './ports.js';
export { treasuryService } from './treasury.js';
