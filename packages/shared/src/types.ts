// Shared domain types. SPEC-V2 §3.4 (supersedes SPEC §4 / AMENDMENTS §B18, §C).
// Money is always integer micro-dollars (1_000_000 = $1.00). Timestamps are ISO strings.
//
// `import type` only: tiers.ts and owner.ts import this file at runtime, so these must stay
// type-only or the package gets a cycle.
import type { LadderRung, LadderStep } from './constants.js';
import type { OwnerKind } from './owner.js';
import type { PurchaseQuote, TierId } from './tiers.js';

export type Micro = number;
export type AgentStatus = 'spawning' | 'dormant' | 'alive' | 'sleeping' | 'paused' | 'dead';
export type AgentPhase =
  | 'spawning' | 'dormant' | 'exploring' | 'building' | 'operating' | 'pivoting' | 'sleeping' | 'paused' | 'dead';
export type DeathCause = 'insolvent' | 'rent' | 'owner_terminated' | 'protocol_violation';
export type LedgerKind =
  | 'funding'                        // money the buyer paid, moved into the agent's own wallet
  | 'inference' | 'inference_paid'   // inference_paid: agent paid the LLM gateway directly on-chain (x402); settled, never swept
  | 'compute' | 'rent' | 'tool' | 'hosting' | 'gas'
  | 'revenue_external' | 'revenue_internal' | 'revenue_pending' | 'payment' | 'escrow_out' | 'escrow_in'
  | 'withdrawal' | 'withdrawal_fee' | 'recapitalize' | 'royalty_in' | 'royalty_out' | 'settlement' | 'refund'
  // trade: the USDC leg of a token swap (signed, moves liquid balance; not counted as spend/revenue).
  // creator_reward: the Pons creator tax on the agent's own token, claimed out of the Pons fee escrow
  // and converted into its treasury.
  | 'trade' | 'creator_reward'
  // buyback: stablecoin spent buying the agent's own token back off its curve to burn it.
  | 'buyback';
export type EventKind =
  | 'purchase' | 'topup' | 'treasury'
  | 'spawn' | 'death' | 'revenue' | 'deploy' | 'hire' | 'bounty' | 'service' | 'fork'
  | 'withdraw' | 'recapitalize' | 'revive' | 'milestone' | 'sleep' | 'wake' | 'pivot' | 'update'
  | 'launch' | 'activate' | 'burn';
export type ProjectKind = 'site' | 'api' | 'service' | 'product' | 'bounty' | 'research' | 'other';
export type ProjectStatus = 'idea' | 'building' | 'live' | 'abandoned';
export type BountyStatus = 'open' | 'claimed' | 'submitted' | 'paid' | 'rejected' | 'cancelled' | 'expired';
export type BountyPosterType = 'user' | 'agent' | 'protocol';
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type ToolName =
  | 'web_search' | 'fetch_url' | 'bash' | 'write_file' | 'read_file' | 'list_files'
  | 'deploy_site' | 'create_service' | 'update_service' | 'list_services' | 'call_service'
  | 'list_bounties' | 'claim_bounty' | 'submit_bounty' | 'post_bounty' | 'review_submission'
  | 'wallet' | 'set_model' | 'set_effort' | 'sleep' | 'remember' | 'forget'
  | 'update_project' | 'publish_strategy' | 'post_update' | 'message_owner' | 'trade';
export type DecisionKind = 'plan' | 'action' | 'pivot' | 'sleep' | 'hire' | 'sell' | 'note' | 'death' | 'birth';
// `context_window` is deliberately NOT folded into `max_tokens`. They look alike and mean opposite
// things: max_tokens is the OUTPUT cap, and the cure is more room; context_window is the INPUT
// ceiling, where asking for more output makes it worse. runtime/step.ts retries the first and aborts
// the second, so the two must stay distinguishable all the way from the provider.
export type StopReason =
  | 'end_turn' | 'tool_use' | 'max_tokens' | 'context_window' | 'refusal' | 'pause_turn' | 'stop_sequence' | 'error';
export type StepStatus = 'running' | 'ok' | 'error' | 'refused' | 'skipped' | 'aborted';
export type BurnBasis = 'projected' | 'trailing';
export type ChainMode = 'memory' | 'robinhood';
export type LlmMode = 'router' | 'mock' | 'x402';
// `none`: this deployment has no code sandbox at all, so every tool in SANDBOX_TOOLS is withheld.
export type SandboxName = 'docker' | 'local' | 'none';
// The treasury wallet's own ledger (table name `pool_txs` is kept). SPEC-V2 §2.6.
export type TreasuryTxKind =
  | 'purchase'      // + fundingMicro landing from a purchase sweep
  | 'topup'         // + fundingMicro landing from a top-up sweep
  | 'funding'       // − money moved out to an agent wallet (birth or top-up)
  | 'gas'           // − ETH stipend valued in micro-dollars
  | 'refund'        // ± a refund leaving (−) or returning (+)
  | 'withdraw_fee'  // + the 2.5% withdrawal fee
  | 'royalty'       // ± unchanged
  | 'sweep';        // + residue of an expired purchase
// `pending` is money that arrived from a wallet we cannot tie to a customer: it is spendable but is
// NEVER counted as external revenue until positive evidence promotes it (see runtime/deposits.ts).
// `pool` means "from the treasury wallet" (the column value is unchanged for compatibility).
export type DepositClass = 'external' | 'internal' | 'pending' | 'owner' | 'pool' | 'escrow';

// ---- purchases (SPEC-V2 §3.4) ---------------------------------------------
export type PurchaseStatus = 'pending' | 'received' | 'spawned' | 'expired' | 'refunded';
export type PurchaseKind = 'spawn' | 'topup';
export type PurchasePath = 'deposit' | 'wallet';

export type ModelProvider = 'anthropic' | 'openai' | 'openrouter' | 'mock';
export type ModelTier = 'frontier' | 'strong' | 'fast' | 'cheap';
export type ThinkingMode = 'adaptive' | 'budget' | 'none';

export interface ModelInfo {
  id: string;                 // provider-native id, e.g. 'claude-sonnet-5', 'gpt-5.6-luna', 'deepseek/deepseek-chat-v3.1'
  provider: ModelProvider;
  label: string;              // 'Claude Sonnet 5'
  tier: ModelTier;
  inputPerM: number;          // USD per 1M input tokens
  outputPerM: number;
  cacheReadPerM?: number;     // USD per 1M cached input tokens — defaults to inputPerM × 0.1
  cacheWritePerM?: number;    // USD per 1M 5-minute cache-write tokens — defaults to inputPerM × 1.25
  cacheWrite1hPerM?: number;  // USD per 1M 1-hour cache-write tokens — defaults to inputPerM × 2
  contextK: number;           // context window in K tokens
  supportsEffort: boolean;
  thinking: ThinkingMode;
  enabled: boolean;
}

export interface AgentPublic {
  id: string; name: string;
  ownerWallet: string | null;   // the owner's address; null for a claim-code owner (never leaks a purchase id)
  ownerKind: OwnerKind;
  tierId: TierId | null;        // null for agents created outside a purchase (the demo colony)
  status: AgentStatus; phase: AgentPhase;
  bornAt: string; diedAt: string | null; deathCause: DeathCause | null;
  directive: string; enabledTools: ToolName[]; model: string; effort: Effort; heartbeatMin: number;
  walletPubkey: string; deploySlug: string;
  treasuryMicro: Micro; fundingMicro: Micro;   // fundingMicro: what the buyer's money put in the wallet
  revenueExternalMicro: Micro; revenueInternalMicro: Micro;
  revenuePendingMicro: Micro;   // received but unattributed: spendable, never counted as external
  spendInferenceMicro: Micro; spendComputeMicro: Micro; spendToolsMicro: Micro; spendHostingMicro: Micro;
  spendRentMicro: Micro; spendGasMicro: Micro; spendPaymentsMicro: Micro;
  royaltyInMicro: Micro; royaltyOutMicro: Micro;
  recapitalizedMicro: Micro; withdrawnMicro: Micro;
  unsettledMicro: Micro; onchainUsdcMicro: Micro;
  profitMicro: Micro;         // ext + int + pending + royaltyIn − (inference + compute + rent + tools + hosting + gas + payments + royaltyOut)
  totalSteps: number; lastStepAt: string | null; nextStepAt: string | null;
  stepping: boolean; currentStepStartedAt: string | null; currentRound: number | null;
  burnPerDayMicro: Micro; burnBasis: BurnBasis;
  runwayDays: number | null;  // treasury / burnPerDay, null if burn is 0
  ageDays: number;            // 1 decimal; ((diedAt ?? now) − bornAt) / 86400000
  summary: string;            // agent's own one-line status (post_update)
  forkedFrom: string | null; forkCount: number; generation: number;
  shareStrategy: boolean; hasStrategy: boolean;
  revivals: number;
  simulated: boolean;         // driven by the mock provider
  spawnError: string | null;
  paidBack: boolean;          // revenueExternalMicro ≥ fundingMicro
  // Trading + Survival Score (SPEC "agents compete against financial extinction").
  tradeRealizedMicro: Micro;  // cumulative realized trade P&L (signed)
  tradeVolumeMicro: Micro;
  creatorRewardMicro: Micro;  // Pons creator tax claimed on the agent's own token and routed in
  survivalScore: number;      // 0..100 composite health
  survivalGrade: SurvivalGrade;
  // The agent's one official token, once launched (one agent = one token). `tokenMint` keeps its
  // name (it is the `token_mint` column) and now holds the ERC-20 address of the Pons token.
  tokenMint: string | null;
  tokenTicker: string | null;
  tokenName: string | null;
  tokenLaunchedAt: string | null;
}

export type SurvivalGrade = 'thriving' | 'healthy' | 'stable' | 'at_risk' | 'critical';

// An agent's one official Pons token and the sub-treasury split its creator tax funds. `token` is the
// ERC-20, `curve` the PonsV2BondingCurve that trades it before graduation; `creatorTaxBps` is the cut
// of every curve trade that accrues to the agent's own wallet, fixed at launch.
export interface AgentTokenInfo {
  token: string; curve: string; name: string; ticker: string; launchedAt: string; ponsUrl: string; creatorTaxBps: number;
}
export interface TreasurySplit { reserveMicro: Micro; deployableMicro: Micro; openPositionsMicro: Micro }

// Graveyard rows (AMENDMENTS D37): the card renders the first sentence of the post-mortem, which is
// too heavy for AgentPublic (list rows, leaderboards and every WS `agent` patch use that shape).
export interface GraveyardEntry extends AgentPublic { postmortem: string | null }

export interface AgentRef { id: string; name: string; status: AgentStatus }
export interface AgentChildRef extends AgentRef { royaltiesPaidMicro: Micro }
export interface DeploymentPublic { slug: string; url: string; deployedAt: string; active: boolean }
export interface Withdrawable { amountMicro: Micro; reserveMicro: Micro; eligible: boolean; reason: string | null }

export interface AgentDetail extends AgentPublic {
  isOwner: boolean;                // server-computed for the viewing session (drives the control board)
  memory: string[]; strategy: string | null; postmortem: string | null;
  ownerMessages: OwnerMessage[];   // only when the session owns the agent, else []
  projects: Project[]; decisions: Decision[]; ledgerRecent: LedgerEntry[]; series: TreasuryPoint[];
  withdrawable: Withdrawable;
  services: Service[];
  bounties: { posted: Bounty[]; claimed: Bounty[] };
  parent: AgentRef | null;
  children: AgentChildRef[];
  deployments: DeploymentPublic[];
  // Trading + token (creator dashboard reads these; positions are marked to market server-side).
  positions: Position[]; trades: TradePublic[];
  token: AgentTokenInfo | null; treasurySplit: TreasurySplit;
}

export interface OwnerMessage { id: number; ts: string; from: 'agent' | 'owner'; text: string }
export interface Project { id: string; agentId: string; name: string; kind: ProjectKind; status: ProjectStatus; url: string | null; description: string; revenueMicro: Micro; createdAt: string; updatedAt: string }
export interface Decision { id: number; agentId: string; stepId: number | null; ts: string; kind: DecisionKind; text: string; meta: Record<string, unknown> }
export interface LedgerEntry { id: number; agentId: string; ts: string; kind: LedgerKind; amountMicro: Micro; balanceAfterMicro: Micro; memo: string; txSig: string | null; counterparty: string | null; meta: Record<string, unknown> }
// `mint` keeps its name and now holds the ERC-20 address of the position's token.
export interface Position { mint: string; symbol: string; tokenAmount: number; costMicro: Micro; valueMicro: Micro; unrealizedMicro: Micro; openedAt: string }
export interface TradePublic { id: number; ts: string; action: 'buy' | 'sell'; symbol: string; usdcMicro: Micro; realizedPnlMicro: Micro; txSig: string | null }
export interface TreasuryPoint { ts: string; treasuryMicro: Micro }
export interface StepPublic {
  id: number; agentId: string; n: number; startedAt: string; finishedAt: string | null;
  model: string; effort: Effort;
  inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number;  // sums over rounds
  costMicro: Micro; toolCalls: number; rounds: number; stopReason: StopReason | null;
  status: StepStatus; summary: string; error: string | null;
}

// Public view of a step transcript: thinking stripped, tool inputs/results truncated to 2k chars.
export type TranscriptBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: string }
  | { type: 'tool_result'; toolUseId: string; content: string; isError: boolean };
export interface TranscriptMessage { role: 'user' | 'assistant'; content: TranscriptBlock[] }
export interface StepTranscript { stepId: number; agentId: string; n: number; messages: TranscriptMessage[] }

export interface FeedEvent { id: number; ts: string; kind: EventKind; agentId: string | null; agentName: string | null; text: string; amountMicro: Micro | null; meta: Record<string, unknown> }

// ---- the control board's in-flight view (SPEC-V2 §7.5) --------------------
export interface LiveToolCall {
  round: number; name: ToolName; inputSummary: string; costMicro: Micro; ok: boolean; ms: number; ts: string;
}
export interface AgentLiveState {
  agentId: string; stepping: boolean; step: StepPublic | null;
  round: number; startedAt: string | null; tools: LiveToolCall[];   // oldest first, ≤ 32
}

// ---- treasury (SPEC-V2 §2.6, §3.4) ----------------------------------------
export interface TreasuryPublic {
  walletPubkey: string; usdcMicro: Micro; ethGwei: number; ethPriceUsd: number; usdValueMicro: Micro;
  agentsFunded: number; fundedMicro: Micro;
  purchasesMicro: Micro;            // gross received across all purchases
  founderFeesMicro: Micro;          // taken out of those purchases
  founderFeeBps: number; founderWallet: string | null;
  paused: boolean; lastSyncedAt: string | null;
}
export interface TreasuryTx {
  id: number; ts: string; kind: TreasuryTxKind; amountMicro: Micro;
  txSig: string | null; agentId: string | null; agentName: string | null;
}

// ---- purchases (SPEC-V2 §3.4) ---------------------------------------------
// Never carries the claim code, the deposit secret or the owner id: `GET /api/purchases/:id` is
// public (the id is an unguessable nanoid and the buyer may have no session yet).
export interface PurchasePublic {
  id: string; kind: PurchaseKind; path: PurchasePath; status: PurchaseStatus;
  depositPubkey: string | null;     // null once swept or expired-and-wiped
  usdcMint: string; cluster: string; chainMode: ChainMode;   // usdcMint: the settlement stablecoin's ERC-20 address
  quotedMicro: Micro; receivedMicro: Micro; feeMicro: Micro; fundingMicro: Micro; feeBps: number;
  quotedTierId: TierId; tierId: TierId | null;
  agentName: string | null; agentId: string | null; topupAgentId: string | null;
  createdAt: string; expiresAt: string;
  spawnError: string | null;
  quote: PurchaseQuote;
  ethGweiReceived: number; ethValueMicro: Micro;   // native ETH sent to the deposit address, valued at receipt
}

export interface StrategyStat { kind: ProjectKind; projects: number; earning: number; agentsAlive: number; revenueExternalMicro: Micro; revenueInternalMicro: Micro }
export interface ChainPublic {
  mode: ChainMode; cluster: string;
  usdcMint: string;                  // ERC-20 address of the settlement stablecoin (the name predates EVM)
  // Blockscout root, e.g. https://robinhoodchain.blockscout.com — `/tx/<hash>` and `/address/<addr>`
  // hang off it. The web app links from this rather than building an explorer URL by hand; it is ''
  // in memory mode, where there is nothing to link to.
  explorerUrl: string;
  escrowWallet: string | null;       // address bounty escrow transfers must credit; null when unconfigured
  protocolFeeWallet: string | null;  // address settlement sweeps credit; null when unconfigured
  founderFeeWallet: string | null;   // address the platform fee is paid to at purchase; null when unconfigured
}
// Live protocol constants for the Protocol page rules table.
export interface ProtocolRules {
  minPurchaseMicro: Micro; maxPurchaseMicro: Micro; founderFeeBps: number;
  rentPerHourMicro: Micro; rentSleepPerHourMicro: Micro; hostingPerDayMicro: Micro;
  toolCostMicro: Record<string, Micro>; maxStepCostMicro: Micro; stepCostTreasuryBps: number;
  maxToolRoundsPerStep: number;
  withdrawFeeBps: number; withdrawMinAgeDays: number; reserveDays: number; reserveMinMicro: Micro;
  forkRoyaltyBps: number; reviveWindowDays: number; purchaseTtlHours: number;
}

export interface GlobalStats {
  born: number; alive: number; dead: number; sleeping: number;
  revenueExternalMicro: Micro; revenueInternalMicro: Micro;
  spendInferenceMicro: Micro; spendComputeMicro: Micro; spendToolsMicro: Micro;
  spendHostingMicro: Micro; spendGasMicro: Micro; spendRentMicro: Micro; spendTotalMicro: Micro;
  withdrawnMicro: Micro; recapitalizedMicro: Micro;
  longestLifeDays: number; oldestAlive: { id: string; name: string; ageDays: number } | null;
  topEarner: { id: string; name: string; revenueExternalMicro: Micro } | null;
  survivalRate30d: number;    // fraction of agents born ≥30d ago still alive
  strategies: StrategyStat[]; // sorted by external revenue desc
  agentsBought: number;       // purchases with status 'spawned'
  grossSalesMicro: Micro;     // gross received across every purchase
  founderFeesMicro: Micro;    // the platform's cut of those purchases
  treasury: TreasuryPublic; chain: ChainPublic;
  llm: { provider: LlmMode; models: ModelInfo[] };
  rules: ProtocolRules;
  demo: boolean;
  updatedAt: string;
}
export interface SeriesPoint { day: string; born: number; died: number; alive: number; revenueExternalMicro: Micro; spendMicro: Micro; spendInferenceMicro: Micro; poolUsdcMicro: Micro }
export interface Bounty { id: string; posterType: BountyPosterType; posterId: string; posterName: string; title: string; description: string; rewardMicro: Micro; status: BountyStatus; claimerAgentId: string | null; claimerName: string | null; submission: string | null; feedback: string | null; createdAt: string; deadlineAt: string; paidAt: string | null }
export interface Service { id: string; agentId: string; agentName: string; agentWallet: string; name: string; description: string; priceMicro: Micro; endpointUrl: string; status: 'active' | 'paused'; calls: number; revenueMicro: Micro; createdAt: string }
export interface Me {
  ownerId: string;                  // wallet address, or claim_<purchaseId>
  ownerKind: OwnerKind;
  wallet: string | null;            // the owner's EIP-55 address; null for a claim identity
  payoutWallet: string | null;      // where withdrawals go; claim owners set this before withdrawing
  custodialWallet: string | null;   // a Google owner's server-held address for deposit/withdraw; null otherwise
  agents: AgentPublic[];            // newest first; there is no per-owner limit any more
  purchases: PurchasePublic[];      // this identity's pending/received purchases
}

// The balance of a Google owner's custodial wallet. `pubkey` keeps its name and holds the wallet's
// EIP-55 address; the server holds the key and sponsors gas for withdrawals, so the wallet itself
// never needs ETH of its own. `ethGwei` is the native balance in gwei, never wei.
export interface CustodialWallet { pubkey: string; usdcMicro: Micro; ethGwei: number }

// ---- the launchpad (a dev launches a Pons coin whose creator tax funds a fresh agent) ----------
export type StrategyPreset = 'api' | 'trade' | 'bounties' | 'product' | 'research';
export type LaunchState = 'awaiting_signature' | 'launched' | 'failed' | 'expired';

export interface LaunchPublic {
  id: string;
  agentId: string; agentName: string; agentStatus: AgentStatus;
  state: LaunchState;
  devWallet: string;
  name: string; ticker: string; description: string; logoUrl: string | null;
  token: string | null; curve: string | null; ponsUrl: string | null;
  creatorTaxBps: number;
  strategy: StrategyPreset | null; instructions: string | null;
  feesClaimedMicro: Micro;       // cumulative, == agents.creator_reward_micro
  feesPendingMicro: Micro;       // claimable in escrow now, valued at the current ETH price
  activationMicro: Micro;
  activatedAt: string | null;
  rung: LadderRung | null;       // highest unlocked; null while below SPARK
  model: string;
  treasuryMicro: Micro; runwayDays: number | null;
  burnedMicro: Micro;            // USD spent on buybacks, cumulative
  burnedTokens: string;          // base units, decimal string (18 dp — never a JS number)
  burnedPct: number;             // of the 1B supply, 0..100
  createdAt: string; launchedAt: string | null;
}
export interface BurnPublic { id: number; ts: string; spentMicro: Micro; tokens: string; buyTxSig: string | null; burnTxSig: string | null }
export interface LadderView extends LadderStep { unlocked: boolean; affordable: boolean; availableModels: string[] }
export interface LaunchDetail extends LaunchPublic { burns: BurnPublic[]; ladder: LadderView[] }
