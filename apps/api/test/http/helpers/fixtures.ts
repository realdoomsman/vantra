import type {
  AgentDetail, AgentLiveState, AgentPublic, Bounty, GlobalStats, Me, PurchasePublic, Service,
  StepTranscript, TiersResponse, TreasuryPublic, TreasuryTx,
} from '@vantra/shared';
import {
  DEFAULT_CATALOG, FOUNDER_FEE_BPS_DEFAULT, MAX_PURCHASE_MICRO, MIN_PROJECTED_LIFE_DAYS,
  MIN_PURCHASE_MICRO, TIERS, claimOwnerId, estimateMicro, quoteFor, QUOTE_IN_TOKENS, QUOTE_OUT_TOKENS,
} from '@vantra/shared';

export const OWNER_A = 'demo-wallet-1';
export const OWNER_B = 'demo-wallet-2';
export const PURCHASE_ID = 'pu_aaaaaaaaaa';
export const CLAIM_OWNER = claimOwnerId(PURCHASE_ID);      // 'claim_pu_aaaaaaaaaa'
export const CLAIM_CODE = 'RW-ABCDE-FGHJK-MNPQR-STVWX';
export const PAYOUT_WALLET = '0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc';
export const AGENT_A = 'ag_aaaaaaaaaa';
export const AGENT_B = 'ag_bbbbbbbbbb';
export const CLAIM_AGENT = 'ag_cccccccccc';
export const DEAD_AGENT = 'ag_dddddddddd';
const ISO = '2026-09-01T00:00:00.000Z';

const MOCK_MODELS = DEFAULT_CATALOG.filter((m) => m.provider === 'mock');
const mockFast = MOCK_MODELS.find((m) => m.id === 'mock-fast')!;

export const sampleQuote = (amountMicro = MIN_PURCHASE_MICRO) =>
  quoteFor({ amountMicro, feeBps: FOUNDER_FEE_BPS_DEFAULT, model: mockFast });

export function makeAgent(overrides: Partial<AgentPublic> = {}): AgentPublic {
  return {
    id: AGENT_A, name: 'ALPHA', ownerWallet: OWNER_A, ownerKind: 'wallet', tierId: 'SPARK',
    status: 'alive', phase: 'exploring',
    bornAt: ISO, diedAt: null, deathCause: null,
    directive: 'Earn by selling a tiny API', enabledTools: ['bash', 'write_file'], model: 'mock-fast', effort: 'medium', heartbeatMin: 120,
    walletPubkey: 'AgentWallet1111111111111111111111111111111', deploySlug: 'alpha',
    treasuryMicro: 9_000_000, fundingMicro: 9_000_000, revenueExternalMicro: 0, revenueInternalMicro: 0, revenuePendingMicro: 0,
    spendInferenceMicro: 500_000, spendComputeMicro: 0, spendToolsMicro: 0, spendHostingMicro: 0,
    spendRentMicro: 500_000, spendGasMicro: 0, spendPaymentsMicro: 0, royaltyInMicro: 0, royaltyOutMicro: 0,
    recapitalizedMicro: 0, withdrawnMicro: 0, unsettledMicro: 0, onchainUsdcMicro: 9_000_000, profitMicro: -1_000_000,
    totalSteps: 3, lastStepAt: ISO, nextStepAt: ISO, stepping: false, currentStepStartedAt: null, currentRound: null,
    burnPerDayMicro: 130_800, burnBasis: 'projected', runwayDays: 68.8, ageDays: 0.5, summary: 'Building.',
    forkedFrom: null, forkCount: 0, generation: 1, shareStrategy: false, hasStrategy: false, revivals: 0,
    simulated: true, spawnError: null, paidBack: false,
    tradeRealizedMicro: 0, tradeVolumeMicro: 0, creatorRewardMicro: 0, survivalScore: 55, survivalGrade: 'stable',
    tokenMint: null, tokenTicker: null, tokenName: null, tokenLaunchedAt: null,
    ...overrides,
  };
}

export function makeDetail(overrides: Partial<AgentDetail> = {}): AgentDetail {
  return {
    ...makeAgent(),
    isOwner: false,
    memory: [], strategy: null, postmortem: null, ownerMessages: [], projects: [], decisions: [], ledgerRecent: [], series: [],
    withdrawable: { amountMicro: 0, reserveMicro: MIN_PURCHASE_MICRO, eligible: false, reason: 'Agent is younger than 7 days' },
    services: [], bounties: { posted: [], claimed: [] }, parent: null, children: [], deployments: [],
    positions: [], trades: [], token: null,
    treasurySplit: { reserveMicro: 0, deployableMicro: 0, openPositionsMicro: 0 },
    ...overrides,
  };
}

export function makeTreasury(overrides: Partial<TreasuryPublic> = {}): TreasuryPublic {
  return {
    walletPubkey: 'Treasury1111', usdcMicro: 500_000_000, ethGwei: 0, ethPriceUsd: 150, usdValueMicro: 500_000_000,
    agentsFunded: 3, fundedMicro: 27_000_000, purchasesMicro: 30_000_000, founderFeesMicro: 3_000_000,
    founderFeeBps: FOUNDER_FEE_BPS_DEFAULT, founderWallet: 'Founder1111', paused: false, lastSyncedAt: ISO,
    ...overrides,
  };
}

export function makeTreasuryTx(overrides: Partial<TreasuryTx> = {}): TreasuryTx {
  return {
    id: 1, ts: ISO, kind: 'purchase', amountMicro: 9_000_000, txSig: 'sig-sweep', agentId: AGENT_A, agentName: 'ALPHA',
    ...overrides,
  };
}

export function makeStats(overrides: Partial<GlobalStats> = {}): GlobalStats {
  return {
    born: 3, alive: 2, dead: 1, sleeping: 0,
    revenueExternalMicro: 1_000_000, revenueInternalMicro: 0,
    spendInferenceMicro: 2_000_000, spendComputeMicro: 0, spendToolsMicro: 0, spendHostingMicro: 0, spendGasMicro: 0, spendRentMicro: 100_000, spendTotalMicro: 2_100_000,
    withdrawnMicro: 0, recapitalizedMicro: 0,
    longestLifeDays: 1, oldestAlive: { id: AGENT_A, name: 'ALPHA', ageDays: 0.5 }, topEarner: null, survivalRate30d: 1,
    strategies: [],
    agentsBought: 3, grossSalesMicro: 30_000_000, founderFeesMicro: 3_000_000,
    treasury: makeTreasury(),
    chain: { mode: 'memory', cluster: 'memory', usdcMint: 'USDC', explorerUrl: '', escrowWallet: 'Escrow1111', protocolFeeWallet: 'Fee1111', founderFeeWallet: 'Founder1111' },
    llm: { provider: 'mock', models: MOCK_MODELS },
    rules: {
      minPurchaseMicro: MIN_PURCHASE_MICRO, maxPurchaseMicro: MAX_PURCHASE_MICRO, founderFeeBps: FOUNDER_FEE_BPS_DEFAULT,
      rentPerHourMicro: 5_000, rentSleepPerHourMicro: 1_000, hostingPerDayMicro: 10_000,
      toolCostMicro: {}, maxStepCostMicro: 500_000, stepCostTreasuryBps: 200, maxToolRoundsPerStep: 8,
      withdrawFeeBps: 250, withdrawMinAgeDays: 7, reserveDays: 30, reserveMinMicro: MIN_PURCHASE_MICRO,
      forkRoyaltyBps: 500, reviveWindowDays: 30, purchaseTtlHours: 72,
    },
    demo: true,
    updatedAt: ISO,
    ...overrides,
  };
}

export function makeMe(ownerId: string, overrides: Partial<Me> = {}): Me {
  const isClaim = ownerId.startsWith('claim_');
  return {
    ownerId,
    ownerKind: isClaim ? 'claim' : 'wallet',
    wallet: isClaim ? null : ownerId,
    payoutWallet: null,
    custodialWallet: null,
    agents: [],
    purchases: [],
    ...overrides,
  };
}

export function makePurchase(overrides: Partial<PurchasePublic> = {}): PurchasePublic {
  const quote = sampleQuote();
  return {
    id: PURCHASE_ID, kind: 'spawn', path: 'deposit', status: 'pending',
    depositPubkey: 'Deposit11111111111111111111111111111111111',
    usdcMint: 'USDC', cluster: 'memory', chainMode: 'memory',
    quotedMicro: quote.amountMicro, receivedMicro: 0, feeMicro: quote.feeMicro, fundingMicro: quote.fundingMicro, feeBps: quote.feeBps,
    quotedTierId: quote.tierId, tierId: null,
    agentName: 'GAMMA', agentId: null, topupAgentId: null,
    createdAt: ISO, expiresAt: '2026-09-04T00:00:00.000Z',
    spawnError: null,
    quote,
    ethGweiReceived: 0, ethValueMicro: 0,
    ...overrides,
  };
}

export function makeTiers(): TiersResponse {
  return {
    tiers: TIERS.map((t) => ({
      ...t,
      modelId: t.modelId,
      modelLabel: t.id === 'SPARK' || t.id === 'SCOUT' ? 'Mock Fast' : 'Mock Strong',
      stepCostMicro: estimateMicro(mockFast, QUOTE_IN_TOKENS, QUOTE_OUT_TOKENS),
    })),
    feeBps: FOUNDER_FEE_BPS_DEFAULT,
    minMicro: MIN_PURCHASE_MICRO,
    maxMicro: MAX_PURCHASE_MICRO,
    minProjectedLifeDays: MIN_PROJECTED_LIFE_DAYS,
  };
}

export function makeLive(overrides: Partial<AgentLiveState> = {}): AgentLiveState {
  return {
    agentId: AGENT_A, stepping: true, step: null, round: 2, startedAt: ISO,
    tools: [{ round: 1, name: 'fetch_url', inputSummary: 'https://example.com', costMicro: 1_000, ok: true, ms: 120, ts: ISO }],
    ...overrides,
  };
}

export function makeBounty(overrides: Partial<Bounty> = {}): Bounty {
  return {
    id: 'bt_0000000001', posterType: 'user', posterId: OWNER_A, posterName: 'demo-w…1', title: 'Write a haiku', description: 'About runway',
    rewardMicro: 500_000, status: 'submitted', claimerAgentId: AGENT_B, claimerName: 'BRAVO', submission: 'haiku', feedback: null,
    createdAt: ISO, deadlineAt: ISO, paidAt: null,
    ...overrides,
  };
}

export function makeService(overrides: Partial<Service> = {}): Service {
  return {
    id: 'sv_0000000001', agentId: AGENT_B, agentName: 'BRAVO', agentWallet: 'AgentWallet2222222222222222222222222222222', name: 'summarize', description: 'Summarizes text', priceMicro: 10_000,
    endpointUrl: 'http://localhost:8787/svc/sv_0000000001', status: 'active', calls: 0, revenueMicro: 0, createdAt: ISO,
    ...overrides,
  };
}

// What a careless producer might hand over: thinking blocks and an oversized tool result.
export function makeRawTranscript(): StepTranscript {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'STATUS {}' }] },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'secret reasoning', signature: 'sig' },
        { type: 'redacted_thinking', data: 'blob' },
        { type: 'text', text: 'Running a command.' },
        { type: 'tool_use', id: 'tu_1', name: 'bash', input: JSON.stringify({ command: 'ls' }) },
      ],
    },
    { role: 'user', content: [{ type: 'tool_result', toolUseId: 'tu_1', content: 'x'.repeat(5_000), isError: false }] },
  ];
  return { stepId: 7, agentId: AGENT_A, n: 3, messages: messages as StepTranscript['messages'] };
}
