// Postgres schema (drizzle). SPEC-V2 §4 (was SPEC §7 + AMENDMENTS C20/B18/C22).
// Table and column names are contract. Money columns are bigint micro-dollars read as JS numbers.
// The `pool` / `pool_txs` table names are KEPT while their meaning is now the TREASURY: the wallet
// that receives the net of every purchase and funds each agent out of it.
import { sql } from 'drizzle-orm';
import {
  bigint, bigserial, boolean, customType, date, index, integer, jsonb, numeric, pgTable, serial, text, timestamp,
  uniqueIndex,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import type {
  AgentStatus, BountyPosterType, BountyStatus, DeathCause, DecisionKind, DepositClass, Effort, EventKind, ImageType,
  LaunchState, LedgerKind, OwnerKind, Pace, ProjectKind, ProjectStatus, PurchaseKind, PurchasePath, PurchaseStatus,
  StepStatus, StopReason, StrategyPreset, TierId, ToolName, TreasuryTxKind,
} from '@vantra/shared';
import type { LlmMessage } from '../core/interfaces.js';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });
const micro = (name: string) => bigint(name, { mode: 'number' }).notNull().default(0);
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const tsNow = (name: string) => ts(name).notNull().defaultNow();
const meta = (name: string) => jsonb(name).$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`);

// `wallet` is the OWNER ID: an EIP-55 address for the wallet path, or `claim_pu_…` for the
// claim-code path. It keeps its name because it is the join key for sessions and every owner check.
export const users = pgTable('users', {
  wallet: text('wallet').primaryKey(),
  createdAt: tsNow('created_at'),
  lastLoginAt: tsNow('last_login_at'),
  displayName: text('display_name'),
  kind: text('kind').$type<OwnerKind>().notNull().default('wallet'),
  payoutWallet: text('payout_wallet'),           // an address a claim owner can withdraw to
  purchaseId: text('purchase_id'),               // for kind='claim', the purchase that minted it
  custodialPubkey: text('custodial_pubkey'),     // for kind='google', a server-held wallet (key in user_keys)
});

export const sessions = pgTable('sessions', {
  token: text('token').primaryKey(),
  wallet: text('wallet').notNull().references(() => users.wallet),
  createdAt: tsNow('created_at'),
  expiresAt: ts('expires_at').notNull(),
}, (t) => [index('sessions_wallet_idx').on(t.wallet)]);

export const authNonces = pgTable('auth_nonces', {
  wallet: text('wallet').primaryKey(),
  nonce: text('nonce').notNull(),
  expiresAt: ts('expires_at').notNull(),
});

export const agents = pgTable('agents', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  // An OWNER ID (see `users.wallet`). Stays NOT NULL: it is the FK and the owner-check join key.
  // `AgentPublic.ownerWallet` is nulled for claim owners so a purchase id never leaks publicly.
  ownerWallet: text('owner_wallet').notNull().references(() => users.wallet),
  ownerKind: text('owner_kind').$type<OwnerKind>().notNull().default('wallet'),
  tier: text('tier').$type<TierId>(),                 // null for demo/legacy agents
  purchaseId: text('purchase_id'),                    // provenance; no FK (purchases references agents)
  status: text('status').$type<AgentStatus>().notNull().default('spawning'),
  bornAt: tsNow('born_at'),
  diedAt: ts('died_at'),
  deathCause: text('death_cause').$type<DeathCause>(),
  directive: text('directive').notNull(),
  enabledTools: jsonb('enabled_tools').$type<ToolName[]>().notNull().default(sql`'[]'::jsonb`),
  model: text('model').notNull(),
  effort: text('effort').$type<Effort>().notNull().default('medium'),
  heartbeatMin: integer('heartbeat_min').notNull().default(60),
  walletPubkey: text('wallet_pubkey').notNull(),
  deploySlug: text('deploy_slug').notNull(),
  containerId: text('container_id'),
  treasuryMicro: micro('treasury_micro'),
  fundingMicro: micro('funding_micro'),               // what the buyer's money put into the wallet
  revenueExternalMicro: micro('revenue_external_micro'),
  revenueInternalMicro: micro('revenue_internal_micro'),
  revenuePendingMicro: micro('revenue_pending_micro'),   // inflows with no evidence of an outside customer

  spendInferenceMicro: micro('spend_inference_micro'),
  spendComputeMicro: micro('spend_compute_micro'),
  spendToolsMicro: micro('spend_tools_micro'),
  spendHostingMicro: micro('spend_hosting_micro'),
  spendRentMicro: micro('spend_rent_micro'),
  spendGasMicro: micro('spend_gas_micro'),
  spendPaymentsMicro: micro('spend_payments_micro'),
  royaltyInMicro: micro('royalty_in_micro'),
  royaltyOutMicro: micro('royalty_out_micro'),
  recapitalizedMicro: micro('recapitalized_micro'),
  withdrawnMicro: micro('withdrawn_micro'),
  onchainUsdcMicro: micro('onchain_usdc_micro'),
  onchainCheckedAt: ts('onchain_checked_at'),
  totalSteps: integer('total_steps').notNull().default(0),
  lastStepAt: ts('last_step_at'),
  nextStepAt: ts('next_step_at'),
  sleepUntil: ts('sleep_until'),
  lastRentAt: tsNow('last_rent_at'),
  lastSettledAt: ts('last_settled_at'),
  unsettledMicro: micro('unsettled_micro'),
  // Trading (tools/trade.ts): realized P&L booked to treasury and lifetime traded volume, for stats.
  tradeRealizedMicro: micro('trade_realized_micro'),   // cumulative realized trade P&L (signed)
  tradeVolumeMicro: micro('trade_volume_micro'),
  creatorRewardMicro: micro('creator_reward_micro'),   // Pons creator tax routed into this agent
  // The agent's one official Pons token (set once — one agent = one token). Null until launched.
  // `token_mint` keeps its name and now holds the ERC-20 address; `token_curve` is the bonding curve
  // that token trades on, which is the ONLY way to trade it until it graduates to the AMM.
  tokenMint: text('token_mint'),
  tokenCurve: text('token_curve'),
  tokenCreatorTaxBps: integer('token_creator_tax_bps'),   // the tax fixed at launch, in bps
  tokenTicker: text('token_ticker'),
  tokenName: text('token_name'),
  tokenLaunchedAt: ts('token_launched_at'),
  currentStepId: bigint('current_step_id', { mode: 'number' }),
  memory: jsonb('memory').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  strategy: text('strategy'),
  shareStrategy: boolean('share_strategy').notNull().default(false),
  summary: text('summary').notNull().default(''),
  postmortem: text('postmortem'),
  forkedFrom: text('forked_from').references((): AnyPgColumn => agents.id, { onDelete: 'set null' }),
  generation: integer('generation').notNull().default(1),
  revivals: integer('revivals').notNull().default(0),
  pausedByOwner: boolean('paused_by_owner').notNull().default(false),
  spawnError: text('spawn_error'),
  spawnAttempts: integer('spawn_attempts').notNull().default(0),
  lastDepositSig: text('last_deposit_sig'),
  createdAt: tsNow('created_at'),
  updatedAt: tsNow('updated_at'),
}, (t) => [
  uniqueIndex('agents_name_uq').on(t.name),
  uniqueIndex('agents_wallet_pubkey_uq').on(t.walletPubkey),
  uniqueIndex('agents_deploy_slug_uq').on(t.deploySlug),
  // SPEC-V2 §4.2: `agents_one_live_per_owner_uq` is DROPPED. You own as many agents as you pay for.
  index('agents_owner_idx').on(t.ownerWallet),
  index('agents_purchase_idx').on(t.purchaseId),
  index('agents_status_next_step_idx').on(t.status, t.nextStepAt),
  index('agents_forked_from_idx').on(t.forkedFrom),
]);

// PURCHASES (SPEC-V2 §4.1). One row per attempt to buy (or top up) an agent. It owns a one-time
// deposit keypair whose secret is encrypted at rest and NULLED the moment the sweep settles, and a
// claim code that exists here only as an HMAC. Nothing in this table is ever logged in plaintext.
export const purchases = pgTable('purchases', {
  id: text('id').primaryKey(),                                     // 'pu_' + 10 chars
  kind: text('kind').$type<PurchaseKind>().notNull().default('spawn'),
  path: text('path').$type<PurchasePath>().notNull().default('deposit'),
  status: text('status').$type<PurchaseStatus>().notNull().default('pending'),
  createdAt: tsNow('created_at'),
  expiresAt: ts('expires_at').notNull(),
  lastPolledAt: ts('last_polled_at'),

  depositPubkey: text('deposit_pubkey').notNull(),
  depositSecretEnc: bytea('deposit_secret_enc'),                   // AES-256-GCM; NULLED after a successful sweep
  depositIv: bytea('deposit_iv'),
  depositTag: bytea('deposit_tag'),

  claimCodeHash: text('claim_code_hash'),                          // HMAC-SHA256; null on the wallet path
  ownerWallet: text('owner_wallet'),                               // set on the wallet path
  ownerId: text('owner_id'),                                       // resolved owner id, set at fulfilment

  quotedMicro: bigint('quoted_micro', { mode: 'number' }).notNull(),
  amountMicro: micro('amount_micro'),                              // gross actually received (usdc + eth value)
  usdcMicro: micro('usdc_micro'),
  ethGwei: bigint('eth_gwei', { mode: 'number' }).notNull().default(0),
  ethValueMicro: micro('eth_value_micro'),
  ethPriceUsd: numeric('eth_price_usd', { precision: 14, scale: 4, mode: 'number' }).notNull().default(0),
  feeBps: integer('fee_bps').notNull(),
  feeMicro: micro('fee_micro'),
  fundingMicro: micro('funding_micro'),

  quotedTier: text('quoted_tier').$type<TierId>().notNull(),       // TierId at checkout
  tier: text('tier').$type<TierId>(),                              // TierId derived from what arrived
  pace: text('pace').$type<Pace>().notNull().default('steady'),
  heartbeatMin: integer('heartbeat_min'),                          // resolved at fulfilment
  model: text('model'),
  effort: text('effort').$type<Effort>(),
  agentName: text('agent_name'),                                   // null for kind='topup'
  directive: text('directive'),
  tools: jsonb('tools').$type<ToolName[]>(),
  forkOf: text('fork_of').references(() => agents.id, { onDelete: 'set null' }),
  topupAgentId: text('topup_agent_id').references(() => agents.id, { onDelete: 'cascade' }),
  agentId: text('agent_id').references(() => agents.id, { onDelete: 'set null' }),

  sweepSig: text('sweep_sig'),
  fundingSig: text('funding_sig'),
  refundTo: text('refund_to'),                                     // the first sender seen at the deposit address
  refundSig: text('refund_sig'),
  spawnError: text('spawn_error'),
  spawnAttempts: integer('spawn_attempts').notNull().default(0),
  meta: meta('meta'),
}, (t) => [
  uniqueIndex('purchases_deposit_pubkey_uq').on(t.depositPubkey),
  uniqueIndex('purchases_claim_code_uq').on(t.claimCodeHash),
  // Reserves the agent name from checkout to spawn. A race that slips past it is handled by
  // `dedupeName` at spawn (§7.1): a buyer's money must never fail to produce an agent.
  uniqueIndex('purchases_name_reserved_uq').on(t.agentName).where(sql`status in ('pending','received')`),
  index('purchases_status_idx').on(t.status, t.expiresAt),
  index('purchases_owner_idx').on(t.ownerId, t.id),
  index('purchases_agent_idx').on(t.agentId),
]);

export const agentKeys = pgTable('agent_keys', {
  agentId: text('agent_id').primaryKey().references(() => agents.id, { onDelete: 'cascade' }),
  pubkey: text('pubkey').notNull(),
  secretEnc: bytea('secret_enc').notNull(),
  iv: bytea('iv').notNull(),
  tag: bytea('tag').notNull(),
  createdAt: tsNow('created_at'),
});

// The custodial keypair for a Google owner (mirror of agent_keys, keyed by owner id). The only place a
// custodial secret is persisted (encrypted) and read back; the row is deleted with the user (cascade).
export const userKeys = pgTable('user_keys', {
  ownerId: text('owner_id').primaryKey().references(() => users.wallet, { onDelete: 'cascade' }),
  pubkey: text('pubkey').notNull(),
  secretEnc: bytea('secret_enc').notNull(),
  iv: bytea('iv').notNull(),
  tag: bytea('tag').notNull(),
  createdAt: tsNow('created_at'),
});

// One open position per (agent, mint): base-unit amount held and the USDC cost basis of that amount.
// Buys add to it, sells reduce it (and realize P&L); the row is deleted when the amount reaches zero.
export const positions = pgTable('positions', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  agentId: text('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  mint: text('mint').notNull(),
  symbol: text('symbol').notNull().default(''),
  tokenAmount: bigint('token_amount', { mode: 'number' }).notNull(),   // base units held
  costMicro: micro('cost_micro'),                                       // USDC cost basis of the held amount
  openedAt: tsNow('opened_at'),
  updatedAt: tsNow('updated_at'),
}, (t) => [uniqueIndex('positions_agent_mint_uq').on(t.agentId, t.mint)]);

// One row per executed swap leg — the agent's trade history, with realized P&L stamped on sells.
export const trades = pgTable('trades', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  agentId: text('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  ts: tsNow('ts'),
  action: text('action').$type<'buy' | 'sell'>().notNull(),
  mint: text('mint').notNull(),
  symbol: text('symbol').notNull().default(''),
  usdcMicro: micro('usdc_micro'),                    // USDC spent (buy) or received (sell)
  tokenAmount: bigint('token_amount', { mode: 'number' }).notNull(),
  realizedPnlMicro: micro('realized_pnl_micro'),     // signed; nonzero on sells
  txSig: text('tx_sig'),
}, (t) => [index('trades_agent_idx').on(t.agentId, t.id)]);

export const ledger = pgTable('ledger', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  agentId: text('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  ts: tsNow('ts'),
  kind: text('kind').$type<LedgerKind>().notNull(),
  amountMicro: bigint('amount_micro', { mode: 'number' }).notNull(),           // signed
  balanceAfterMicro: bigint('balance_after_micro', { mode: 'number' }).notNull(),
  memo: text('memo').notNull().default(''),
  txSig: text('tx_sig'),
  counterparty: text('counterparty'),
  meta: meta('meta'),
  settled: boolean('settled').notNull().default(false),
}, (t) => [
  index('ledger_agent_idx').on(t.agentId, t.id),
  index('ledger_ts_idx').on(t.ts),
  index('ledger_kind_idx').on(t.kind),
]);

export const steps = pgTable('steps', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  agentId: text('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  n: integer('n').notNull(),
  startedAt: tsNow('started_at'),
  finishedAt: ts('finished_at'),
  model: text('model').notNull(),
  effort: text('effort').$type<Effort>().notNull(),
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
  cacheWriteTokens: integer('cache_write_tokens').notNull().default(0),
  costMicro: micro('cost_micro'),
  toolCalls: integer('tool_calls').notNull().default(0),
  rounds: integer('rounds').notNull().default(0),
  stopReason: text('stop_reason').$type<StopReason>(),
  status: text('status').$type<StepStatus>().notNull().default('running'),
  summary: text('summary').notNull().default(''),
  error: text('error'),
  transcript: jsonb('transcript').$type<LlmMessage[]>(),   // last step kept in full; pruned to null after 7 days
}, (t) => [
  uniqueIndex('steps_agent_n_uq').on(t.agentId, t.n),
  index('steps_started_idx').on(t.startedAt),
]);

export const decisions = pgTable('decisions', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  agentId: text('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  stepId: bigint('step_id', { mode: 'number' }),
  ts: tsNow('ts'),
  kind: text('kind').$type<DecisionKind>().notNull(),
  text: text('text').notNull(),
  meta: meta('meta'),
}, (t) => [index('decisions_agent_idx').on(t.agentId, t.id)]);

export const projects = pgTable('projects', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  kind: text('kind').$type<ProjectKind>().notNull(),
  status: text('status').$type<ProjectStatus>().notNull().default('idea'),
  url: text('url'),
  description: text('description').notNull().default(''),
  revenueMicro: micro('revenue_micro'),
  createdAt: tsNow('created_at'),
  updatedAt: tsNow('updated_at'),
}, (t) => [index('projects_agent_idx').on(t.agentId)]);

export const events = pgTable('events', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  ts: tsNow('ts'),
  kind: text('kind').$type<EventKind>().notNull(),
  agentId: text('agent_id').references(() => agents.id, { onDelete: 'set null' }),
  agentName: text('agent_name'),
  text: text('text').notNull(),
  amountMicro: bigint('amount_micro', { mode: 'number' }),
  meta: meta('meta'),
}, (t) => [index('events_ts_idx').on(t.ts, t.id), index('events_agent_idx').on(t.agentId, t.id)]);

// THE TREASURY (SPEC-V2 §4.4). Table name kept; the seed accounting is replaced by purchase
// accounting. Every dollar here arrived because somebody bought an agent.
export const pool = pgTable('pool', {
  id: integer('id').primaryKey(),                       // always 1
  walletPubkey: text('wallet_pubkey').notNull(),
  usdcMicro: micro('usdc_micro'),
  ethGwei: bigint('eth_gwei', { mode: 'number' }).notNull().default(0),
  ethPriceUsd: numeric('eth_price_usd', { precision: 14, scale: 4, mode: 'number' }).notNull().default(0),
  agentsFunded: integer('agents_funded').notNull().default(0),
  fundedMicro: micro('funded_micro'),
  purchasesMicro: micro('purchases_micro'),             // gross across all purchases
  founderFeesMicro: micro('founder_fees_micro'),
  paused: boolean('paused').notNull().default(false),
  lastSyncedAt: ts('last_synced_at'),
});

export const poolTxs = pgTable('pool_txs', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  ts: tsNow('ts'),
  kind: text('kind').$type<TreasuryTxKind>().notNull(),
  amountMicro: bigint('amount_micro', { mode: 'number' }).notNull(),
  txSig: text('tx_sig'),
  agentId: text('agent_id').references(() => agents.id, { onDelete: 'set null' }),
  meta: meta('meta'),                                   // a 'purchase' row carries { purchaseId, grossMicro, feeMicro }
}, (t) => [index('pool_txs_ts_idx').on(t.ts, t.id)]);

export const poolSnapshots = pgTable('pool_snapshots', {
  day: date('day', { mode: 'string' }).primaryKey(),     // YYYY-MM-DD
  usdcMicro: micro('usdc_micro'),
  ethGwei: bigint('eth_gwei', { mode: 'number' }).notNull().default(0),
});

export const depositsSeen = pgTable('deposits_seen', {
  sig: text('sig').primaryKey(),
  agentId: text('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  fromWallet: text('from_wallet').notNull(),
  amountMicro: bigint('amount_micro', { mode: 'number' }).notNull(),
  ts: tsNow('ts'),
  classified: text('classified').$type<DepositClass>().notNull(),
}, (t) => [index('deposits_seen_agent_idx').on(t.agentId)]);

export const bounties = pgTable('bounties', {
  id: text('id').primaryKey(),
  posterType: text('poster_type').$type<BountyPosterType>().notNull(),
  posterId: text('poster_id').notNull(),                // wallet, agent id or 'protocol'
  title: text('title').notNull(),
  description: text('description').notNull(),
  rewardMicro: bigint('reward_micro', { mode: 'number' }).notNull(),
  status: text('status').$type<BountyStatus>().notNull().default('open'),
  claimerAgentId: text('claimer_agent_id').references(() => agents.id, { onDelete: 'set null' }),
  submission: text('submission'),
  feedback: text('feedback'),
  rejections: integer('rejections').notNull().default(0), // claimer may resubmit once, then the bounty reopens
  createdAt: tsNow('created_at'),
  deadlineAt: ts('deadline_at').notNull(),
  paidAt: ts('paid_at'),
  escrowTx: text('escrow_tx'),                          // on-chain escrow deposit sig; unique so one deposit cannot fund two bounties
  claimedAt: ts('claimed_at'),
}, (t) => [
  index('bounties_status_idx').on(t.status, t.deadlineAt),
  index('bounties_poster_idx').on(t.posterId),
  index('bounties_claimer_idx').on(t.claimerAgentId),
  // NULLS DISTINCT leaves protocol- and agent-posted rows (no escrow sig) unconstrained, as intended.
  uniqueIndex('bounties_escrow_tx_uq').on(t.escrowTx),
]);

export const services = pgTable('services', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  priceMicro: bigint('price_micro', { mode: 'number' }).notNull(),
  handlerPath: text('handler_path').notNull(),
  status: text('status').$type<'active' | 'paused'>().notNull().default('active'),
  calls: integer('calls').notNull().default(0),
  revenueMicro: micro('revenue_micro'),
  createdAt: tsNow('created_at'),
}, (t) => [index('services_agent_idx').on(t.agentId), index('services_status_idx').on(t.status)]);

export const serviceCalls = pgTable('service_calls', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  serviceId: text('service_id').notNull().references(() => services.id, { onDelete: 'cascade' }),
  buyerType: text('buyer_type').$type<'agent' | 'user'>().notNull(),
  buyerId: text('buyer_id').notNull(),                  // agent id or wallet
  priceMicro: bigint('price_micro', { mode: 'number' }).notNull(),
  status: text('status').$type<'ok' | 'error' | 'timeout'>().notNull(),
  request: jsonb('request').$type<unknown>(),
  response: jsonb('response').$type<unknown>(),
  cpuMs: integer('cpu_ms').notNull().default(0),
  paymentTx: text('payment_tx'),                        // on-chain payment sig; unique so a tx cannot buy twice
  ts: tsNow('ts'),
}, (t) => [
  index('service_calls_service_idx').on(t.serviceId, t.id),
  uniqueIndex('service_calls_payment_tx_uq').on(t.paymentTx),
]);

export const forks = pgTable('forks', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  parentAgentId: text('parent_agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  childAgentId: text('child_agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  royaltyBps: integer('royalty_bps').notNull(),
  createdAt: tsNow('created_at'),
  royaltiesPaidMicro: micro('royalties_paid_micro'),
}, (t) => [uniqueIndex('forks_child_uq').on(t.childAgentId), index('forks_parent_idx').on(t.parentAgentId)]);

export const withdrawals = pgTable('withdrawals', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  agentId: text('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  ownerWallet: text('owner_wallet').notNull(),
  amountMicro: bigint('amount_micro', { mode: 'number' }).notNull(),
  feeMicro: bigint('fee_micro', { mode: 'number' }).notNull(),
  txSig: text('tx_sig'),
  ts: tsNow('ts'),
  status: text('status').$type<'pending' | 'sent' | 'failed'>().notNull().default('pending'),
}, (t) => [index('withdrawals_agent_idx').on(t.agentId)]);

export const ownerMessages = pgTable('owner_messages', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  agentId: text('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  ts: tsNow('ts'),
  fromRole: text('from_role').$type<'agent' | 'owner'>().notNull(),
  text: text('text').notNull(),
}, (t) => [index('owner_messages_agent_idx').on(t.agentId, t.id)]);

export const deployments = pgTable('deployments', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  agentId: text('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  slug: text('slug').notNull(),
  dirSizeBytes: bigint('dir_size_bytes', { mode: 'number' }).notNull().default(0),
  deployedAt: tsNow('deployed_at'),
  active: boolean('active').notNull().default(true),
  removedAt: ts('removed_at'),
}, (t) => [index('deployments_agent_idx').on(t.agentId), index('deployments_slug_idx').on(t.slug, t.active)]);

// THE LAUNCHPAD. A dev launched (or is about to launch) a Pons coin whose creator tax is wired to a
// fresh agent's wallet; that agent is `agent_id`. The agent's own token columns (`token_mint`,
// `token_curve`, `token_creator_tax_bps`, `creator_reward_micro`) stay the source of truth for the
// token itself; this row is the launch: who launched it, with what pitch, and where it stands.
// ON DELETE CASCADE: an `awaiting_signature` launch that expires removes its never-funded agent, and
// the launch goes with it — nothing else ever deletes an agent.
export const launches = pgTable('launches', {
  id: text('id').primaryKey(),                                          // 'la_' + nanoid, lib/ids
  agentId: text('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  devWallet: text('dev_wallet').notNull(),                              // EIP-55 (a demo id in memory mode)
  name: text('name').notNull(),
  ticker: text('ticker').notNull(),
  description: text('description').notNull(),
  logoUrl: text('logo_url'),
  website: text('website'),
  twitter: text('twitter'),
  telegram: text('telegram'),
  creatorTaxBps: integer('creator_tax_bps').notNull(),
  strategy: text('strategy').$type<StrategyPreset>(),
  instructions: text('instructions'),
  state: text('state').$type<LaunchState>().notNull(),
  launchTxSig: text('launch_tx_sig'),
  failureReason: text('failure_reason'),
  activationMicro: bigint('activation_micro', { mode: 'number' }).notNull(),
  activatedAt: ts('activated_at'),
  createdAt: tsNow('created_at'),
  launchedAt: ts('launched_at'),
}, (t) => [
  uniqueIndex('launches_agent_uq').on(t.agentId),
  index('launches_state_created_idx').on(t.state, t.createdAt),
  index('launches_dev_idx').on(t.devWallet),
]);

// One buyback-and-burn. The row is written when the buy lands (`burn_tx_sig` null = bought, burn
// pending) and completed when `token.burn` lands. `tokens` is base units at 18 dp, which overflows
// every JS number type, so it is numeric(78,0) read as a bigint.
export const burns = pgTable('burns', {
  id: serial('id').primaryKey(),
  launchId: text('launch_id').notNull().references(() => launches.id, { onDelete: 'cascade' }),
  agentId: text('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  ts: tsNow('ts'),
  spentMicro: bigint('spent_micro', { mode: 'number' }).notNull(),
  tokens: numeric('tokens', { precision: 78, scale: 0, mode: 'bigint' }).notNull(),
  buyTxSig: text('buy_tx_sig'),
  burnTxSig: text('burn_tx_sig'),
}, (t) => [index('burns_launch_idx').on(t.launchId, t.id), index('burns_agent_idx').on(t.agentId)]);

// An uploaded image: a coin's logo. The bytes live here, not on disk, because the container's disk is
// wiped on every redeploy while a logo's URL is written into Pons for good. `content_type` is what the
// bytes were sniffed as, never what the uploader declared (economy/images.ts).
export const images = pgTable('images', {
  id: text('id').primaryKey(),                                          // 'im_' + nanoid, lib/ids
  ownerId: text('owner_id').notNull(),                                  // the session that uploaded it
  contentType: text('content_type').$type<ImageType>().notNull(),
  bytes: bytea('bytes').notNull(),
  createdAt: tsNow('created_at'),
}, (t) => [index('images_owner_idx').on(t.ownerId)]);

export type UserRow = typeof users.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
export type AgentRow = typeof agents.$inferSelect;
export type NewAgent = typeof agents.$inferInsert;
export type AgentKeyRow = typeof agentKeys.$inferSelect;
export type UserKeyRow = typeof userKeys.$inferSelect;
export type LedgerRow = typeof ledger.$inferSelect;
export type PositionRow = typeof positions.$inferSelect;
export type NewPosition = typeof positions.$inferInsert;
export type TradeRow = typeof trades.$inferSelect;
export type NewTrade = typeof trades.$inferInsert;
export type NewLedger = typeof ledger.$inferInsert;
export type StepRow = typeof steps.$inferSelect;
export type NewStep = typeof steps.$inferInsert;
export type DecisionRow = typeof decisions.$inferSelect;
export type NewDecision = typeof decisions.$inferInsert;
export type ProjectRow = typeof projects.$inferSelect;
export type EventRow = typeof events.$inferSelect;
export type NewEvent = typeof events.$inferInsert;
export type PoolRow = typeof pool.$inferSelect;
export type PoolTxRow = typeof poolTxs.$inferSelect;
export type NewPoolTx = typeof poolTxs.$inferInsert;
export type PurchaseRow = typeof purchases.$inferSelect;
export type NewPurchase = typeof purchases.$inferInsert;
export type PoolSnapshotRow = typeof poolSnapshots.$inferSelect;
export type DepositSeenRow = typeof depositsSeen.$inferSelect;
export type BountyRow = typeof bounties.$inferSelect;
export type ServiceRow = typeof services.$inferSelect;
export type ServiceCallRow = typeof serviceCalls.$inferSelect;
export type ForkRow = typeof forks.$inferSelect;
export type WithdrawalRow = typeof withdrawals.$inferSelect;
export type OwnerMessageRow = typeof ownerMessages.$inferSelect;
export type DeploymentRow = typeof deployments.$inferSelect;
export type LaunchRow = typeof launches.$inferSelect;
export type NewLaunch = typeof launches.$inferInsert;
export type BurnRow = typeof burns.$inferSelect;
export type NewBurn = typeof burns.$inferInsert;
