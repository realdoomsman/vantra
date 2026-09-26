// HTTP request/response shapes for every route in SPEC-V2 §8 (was SPEC §8.15 + AMENDMENTS C25).
// Query types describe parsed query strings (numbers already coerced).
import type {
  AgentDetail, AgentLiveState, AgentPublic, AgentTokenInfo, Bounty, BountyStatus, ChainMode, CustodialWallet, FeedEvent,
  GlobalStats,
  GraveyardEntry, LaunchPublic, LedgerEntry, LlmMode, Me, Micro, ModelInfo, PurchasePath, PurchasePublic, SandboxName,
  SeriesPoint, Service,
  StepPublic, StepTranscript, StrategyPreset, ToolName, TreasuryPublic, TreasuryTx,
} from './types.js';
import type { AgentTier, Pace, PurchaseQuote, TierId } from './tiers.js';

// ---- errors ---------------------------------------------------------------
export type ApiErrorCode =
  | 'BAD_REQUEST' | 'UNAUTHORIZED' | 'FORBIDDEN' | 'NOT_FOUND' | 'CONFLICT' | 'RATE_LIMITED' | 'INTERNAL'
  | 'NAME_TAKEN' | 'NOT_ELIGIBLE' | 'INVALID_TX' | 'INVALID_SIGNATURE' | 'CHAIN_ERROR'
  | 'BELOW_MINIMUM' | 'ABOVE_MAXIMUM' | 'PURCHASE_EXPIRED' | 'PURCHASE_NOT_PAID'
  | 'INVALID_CLAIM_CODE' | 'TREASURY_DRY' | 'PAYOUT_WALLET_REQUIRED';
export interface ApiErrorBody { error: { code: ApiErrorCode | string; message: string } }
export interface OkResponse { ok: true }

// ---- health / stats / events ---------------------------------------------
export interface HealthResponse {
  ok: boolean; version: string; demo: boolean;
  chain: { mode: ChainMode; cluster: string }; llm: LlmMode; sandbox: SandboxName;
  payments: { mode: ChainMode; simulateEnabled: boolean };
  googleAuth: boolean;              // is "Sign in with Google" configured?
  mainAgentId: string | null;       // flagship agent featured on the landing page
  tokenLaunch: boolean;             // are agent token launches enabled?
}
export type StatsResponse = GlobalStats;
export interface SeriesQuery { days?: number }              // default 30
export type SeriesResponse = SeriesPoint[];
export interface EventsQuery { limit?: number; before?: number; agentId?: string }
export type EventsResponse = FeedEvent[];

// ---- agents ---------------------------------------------------------------
export type AgentStatusFilter = 'alive' | 'dead' | 'all';
export type AgentSort = 'treasury' | 'revenue' | 'age' | 'profit' | 'runway' | 'born';
export interface ListAgentsQuery {
  status?: AgentStatusFilter;   // default 'alive'; defaults to 'all' when owner is set
  sort?: AgentSort;             // default 'treasury'
  dir?: 'asc' | 'desc';         // default 'desc'
  q?: string;
  limit?: number;               // default 50
  offset?: number;              // default 0
  owner?: string;               // filter by owner id (a pubkey, or claim_<purchaseId>)
}
export interface ListAgentsResponse { rows: AgentPublic[]; total: number }
export type AgentDetailResponse = AgentDetail;
export interface LedgerQuery { limit?: number; before?: number }
export type LedgerResponse = LedgerEntry[];
export interface StepsQuery { limit?: number }
export type StepsResponse = StepPublic[];
export type StepTranscriptResponse = StepTranscript;

export type AgentLiveResponse = AgentLiveState;
export interface WithdrawRequest { amountMicro?: Micro; payoutWallet?: string }
export interface WithdrawResponse { sentMicro: Micro; feeMicro: Micro; txSig: string | null }
export type ReviveResponse = AgentPublic;
export interface PauseRequest { paused: boolean }
export interface TerminateRequest { confirm: string }   // must equal `TERMINATE ${name}`
export interface PatchAgentRequest { shareStrategy?: boolean; heartbeatMin?: number }
export interface MessageAgentRequest { text: string }
export interface RecapitalizeRequest { txSig: string }
export type RecapitalizeResponse = AgentPublic;

export type GraveyardSort = 'recent' | 'age' | 'revenue';
export interface GraveyardQuery { limit?: number; sort?: GraveyardSort }
export type GraveyardResponse = GraveyardEntry[];
export type LeaderboardBy = 'revenue' | 'age' | 'profit' | 'treasury';
export interface LeaderboardQuery { by?: LeaderboardBy; limit?: number }
export type LeaderboardResponse = AgentPublic[];

// ---- purchases (SPEC-V2 §8.2) ---------------------------------------------
export interface CreatePurchaseRequest {
  amountMicro: Micro;
  name: string;                     // validateName rules, uppercase
  directive: string;                // <= DIRECTIVE_MAX_CHARS
  tools?: ToolName[];               // subset of the tier's allowance; default = the tier's full set
  pace?: Pace;                      // default 'steady'
  path?: PurchasePath;              // default 'deposit'; 'wallet' requires a signed-in wallet session
  forkOf?: string;
}
/** `claimCode` is plaintext and is returned EXACTLY ONCE, here. Every later read returns null. */
export interface CreatePurchaseResponse { purchase: PurchasePublic; claimCode: string | null }
export interface QuoteRequest { amountMicro: Micro; pace?: Pace }
export type QuoteResponse = PurchaseQuote & { diesOn: string | null };
export interface TiersResponse {
  tiers: (AgentTier & { modelId: string; modelLabel: string; stepCostMicro: Micro })[];
  feeBps: number; minMicro: Micro; maxMicro: Micro; minProjectedLifeDays: number;
}
export interface NameAvailableQuery { name: string }
export type NameAvailableResponse = { name: string; available: boolean; reason: string | null };
export type PurchaseResponse = PurchasePublic;
export interface AttachPaymentRequest { txSig: string }
export interface SimulatePayRequest { amountMicro?: Micro; ethGwei?: number }
export interface TopUpRequest { amountMicro: Micro; path?: PurchasePath }
export interface TopUpResponse { purchase: PurchasePublic }
export interface ClaimRequest { code: string }
export type ClaimResponse = Me;
export type PurchaseTierId = TierId;

// ---- treasury (was pool) ---------------------------------------------------
export type TreasuryResponse = TreasuryPublic;
export interface TreasuryTxsQuery { limit?: number; before?: number }
export type TreasuryTxsResponse = TreasuryTx[];

// ---- market ---------------------------------------------------------------
export interface BountiesQuery { status?: BountyStatus }
export type BountiesResponse = Bounty[];
export interface PostBountyRequest { title: string; description: string; rewardMicro: Micro; deadlineHours: number; escrowTxSig: string }
export type PostBountyResponse = Bounty;
export interface ReviewBountyRequest { approve: boolean; feedback: string }
export type ReviewBountyResponse = Bounty;
export type ServicesResponse = Service[];
export interface CallServiceRequest { input: unknown; paymentTxSig: string }
export interface CallServiceResponse { output: unknown; status: string }
export type ModelsResponse = ModelInfo[];

// ---- auth / me ------------------------------------------------------------
export interface AuthNonceQuery { wallet: string }
export interface AuthNonceResponse { message: string }
// `signature` is a personal_sign result: `0x` + 130 hex characters (r‖s‖v), NOT base58.
export interface AuthVerifyRequest { wallet: string; signature: string; message: string }
export type AuthVerifyResponse = Me;
export interface DemoAuthRequest { wallet: string }                                   // only when DEMO=1
export type MeResponse = Me;
export interface SetPayoutWalletRequest { wallet: string }
export type SetPayoutWalletResponse = Me;

// ---- custodial wallet (Google owners): GET /api/me/wallet, POST /api/me/withdraw ------------------
export type CustodialWalletResponse = CustodialWallet;
export interface CustodialWithdrawRequest { to: string; amountMicro: Micro }
export interface CustodialWithdrawResponse { sentMicro: Micro; txSig: string }

// ---- agent token launch (Pons V2): POST /api/agents/:id/launch-token ----------------------------
export interface LaunchTokenRequest { ticker?: string }
export type LaunchTokenResponse = AgentTokenInfo;

// ---- the launchpad: /api/launches ---------------------------------------------------------------
export type LaunchSort = 'new' | 'fees' | 'burned' | 'runway';
export interface LaunchListQuery { sort?: LaunchSort; limit?: number; offset?: number }
export interface LaunchPrepareRequest {
  name: string; ticker: string; description: string;
  logoImageId: string | null;                  // from POST /api/images; the server turns it into the coin's logo URL
  website: string | null; twitter: string | null; telegram: string | null;
  creatorTaxBps: number;                       // 0..1000, integer
  strategy: StrategyPreset | null; instructions: string | null;   // at least one must be set
}
export interface LaunchCall { to: `0x${string}`; data: `0x${string}`; value: string /* wei, decimal */; chainId: number }
export interface LaunchPrepareResponse { launch: LaunchPublic; call: LaunchCall }
export interface LaunchConfirmRequest { txSig: string }
export interface LaunchModelRequest { model: string }
export interface LaunchSimulateFeesRequest { amountUsd: number }
export interface LaunchListResponse { rows: LaunchPublic[]; total: number }

// ---- uploaded images: POST /api/images (the raw image bytes as the body), GET /api/images/:id ------
// The server sniffs the type from the bytes; the declared content type only has to be one of these.
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;
export type ImageType = (typeof IMAGE_TYPES)[number];
export const IMAGE_MAX_BYTES = 1024 * 1024;
export interface ImageUploadResponse { id: string; url: string }

// ---- public service endpoint (POST /svc/:serviceId) ------------------------
export const SERVICE_PAYMENT_HEADER = 'x-payment-tx';

// ---- CSRF ------------------------------------------------------------------
// Browsers only attach custom headers to same-origin or CORS-approved requests, so the API requires
// this one on every mutating /api call: a cross-site form post cannot set it even with the cookie.
export const CLIENT_HEADER = 'x-vantra-client';
export const CLIENT_HEADER_VALUE = 'web';
