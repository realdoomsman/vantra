// Agent tokens on the Pons V2 launchpad, and the creator-fee job that turns a coin's tax into an AI's
// livelihood. Every Pons read and write goes through `deps.launchpad` (chain/launchpad.ts), so memory
// mode is a complete fake and never touches mainnet.
//
// Two kinds of tokenized agent share the job:
// - A BOUGHT agent whose owner launched its one official token from the agent's own wallet
//   (launchAgentToken). Its fees are claimed, converted to USDC and booked; nothing else changes.
// - A LAUNCHPAD agent: a dev launched a coin through VANTRA with this agent as creatorFeeRecipient
//   (economy/launch.ts). It lives entirely on those fees, in this order per pass (launchpad spec §2):
//     activate  dormant + escrow ≥ its activation threshold → the treasury sends a gas stipend, the agent
//               claims, converts to USDC keeping the stipend as its gas reserve, and wakes up;
//     claim     an active agent claims and converts whatever has accrued since the last pass;
//     rung      a claim that lifts cumulative fees past a rung applies that rung's tools and heartbeat;
//     burn      everything above a runway floor buys the coin back and burns it.
// No VANTRA key and no dev key is in any of these paths: the agent signs its own claim and its own burn,
// and nothing here can redirect where the coin's fees go.
import { and, asc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import {
  burnPerDayAt, fmtUsd, unlockedRung, type AgentTokenInfo, type Micro, type TreasurySplit,
} from '@vantra/shared';
import { ChainError } from '../chain/errors.js';
import { createEvmTransactor } from '../chain/evm.js';
import { accountFromSecret } from '../chain/keys.js';
import { withAgentSecret } from '../chain/keystore.js';
import { PONS_TOKEN_SUPPLY, ZERO_ADDRESS, ponsUrl } from '../chain/pons.js';
import { gweiToMicro } from '../chain/price.js';
import type { CoreDeps } from '../core/interfaces.js';
import { agents, burns, depositsSeen, launches, positions, type AgentRow, type BurnRow, type LaunchRow } from '../db/schema.js';
import { badRequest, conflict, errorMessage, forbidden, notFound } from '../lib/errors.js';
import { emitAgent, toPublicOne } from './agents.js';
import { addEvent } from './events.js';
import { applyTier, climbLadder, launchedLaunchOf, priciestUnlockedBurnPerDay } from './ladder.js';
import { post } from './ledger.js';
import { treasuryService } from './treasury.js';
import { withTx } from './tx.js';

const TICKER_RE = /^[A-Z0-9]{2,10}$/;
const WEI_PER_GWEI = 1_000_000_000n;
const TOKEN_UNIT = 10n ** 18n;
// Robinhood Chain is an Arbitrum Orbit L2: a claim or a swap costs on the order of 1e-4 ETH. A BOUGHT
// agent keeps this much ETH for its own gas when it converts claimed fees; a LAUNCHPAD agent keeps its
// activation stipend instead (config.launch.activationGasGwei) — the treasury never tops it up, so its
// fees refill that reserve before anything is converted.
const CLAIM_GAS_KEEP_GWEI = 500_000;   // 0.0005 ETH
const MIN_CLAIM_GWEI = 200_000;        // 0.0002 ETH — below this the claim + swap cost more than they book
// Headroom over the launch fee itself. `launchToken` deploys two contracts (the token and its curve),
// so it is a heavy call by L2 standards; this is deliberately generous because the failure it prevents
// costs the owner a reverted transaction and the agent its gas.
const LAUNCH_GAS_HEADROOM_GWEI = 300_000;   // 0.0003 ETH

const defaultTicker = (name: string): string => (name.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 10) || 'AGENT');
const weiToGwei = (wei: bigint): number => Number(wei / WEI_PER_GWEI);

// ---- the bought agent's own token -------------------------------------------

// Launch (or refuse to relaunch) a bought agent's one official token, signed by the agent's OWN wallet:
// the factory records it as the deployer and `creatorFeeRecipient` is that same wallet. Owner-only;
// permanent. No coin is ever created unless token launches are enabled on the deployment.
export async function launchAgentToken(deps: CoreDeps, agentId: string, ownerId: string, tickerInput?: string): Promise<AgentTokenInfo> {
  if (!deps.config.token.launchEnabled) throw badRequest('Token launches are not enabled on this deployment.');
  const [agent] = await deps.db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
  if (!agent) throw notFound('Agent');
  if (agent.ownerWallet !== ownerId) throw forbidden("Only the agent's creator can launch its token.");
  if (agent.tokenMint) throw conflict('CONFLICT', 'This agent already has an official token — one agent, one token.');

  const ticker = tickerInput?.trim().toUpperCase() || defaultTicker(agent.name);
  if (!TICKER_RE.test(ticker)) throw badRequest('Ticker must be 2-10 letters or digits.');

  const website = `${deps.config.publicUrl}/a/${agent.id}`;
  const description = (agent.summary || agent.directive || `Autonomous agent ${agent.name}`).slice(0, 400);
  // Agents have no avatar of their own, so the logo is a stable generated one. Pons stores it as a plain
  // string URI — there is no metadata host and nothing is uploaded anywhere.
  const logo = `https://api.dicebear.com/9.x/shapes/png?seed=${encodeURIComponent(agent.id)}&size=512`;

  // The launch terms are read live, in this operation. The factory reverts CreatorTaxTooHigh above its
  // own cap, so the configured tax is clamped to it rather than failing the launch.
  const [launchFeeWei, maxCreatorTaxBps] = await Promise.all([deps.launchpad.launchFeeWei(), deps.launchpad.maxCreatorTaxBps()]);
  const creatorTaxBps = Math.min(deps.config.token.creatorTaxBps, maxCreatorTaxBps);

  // The agent pays the launch fee and its gas out of its own wallet. Check first: without this the
  // owner's click comes back as a raw "insufficient funds for gas * price + value" from the RPC, which
  // names neither the wallet nor the amount it is short.
  const feeGwei = weiToGwei(launchFeeWei);
  const needGwei = feeGwei + LAUNCH_GAS_HEADROOM_GWEI;
  const haveGwei = await deps.chain.getEthBalance(agent.walletPubkey);
  if (haveGwei < needGwei) {
    throw badRequest(
      `${agent.name} cannot afford the launch: its wallet holds ${(haveGwei / 1e9).toFixed(5)} ETH `
      + `and the launch costs ${(feeGwei / 1e9).toFixed(5)} ETH plus gas (~${(needGwei / 1e9).toFixed(5)} ETH total). `
      + `Send ETH to ${agent.walletPubkey} and try again.`,
    );
  }

  const agentWallet = agent.walletPubkey;
  const launched = await withAgentSecret(deps.db, deps.config.keyEncryptionKey, agentId, async (secret) => {
    // Memory mode: the launchpad fake records the launch; there is no transaction to sign.
    if (deps.launchpad.simulateLaunch) {
      return deps.launchpad.simulateLaunch({ devWallet: agentWallet, agentWallet, creatorTaxBps, name: agent.name, symbol: ticker });
    }
    // The port builds the exact call (fee attached, salt fixed per agent, the agent as recipient); the
    // agent signs it; the port then proves on chain that what landed is what was agreed.
    const call = await deps.launchpad.buildLaunchCall({
      devWallet: agentWallet, agentWallet, agentId, name: agent.name, symbol: ticker, logo, description,
      socials: { twitter: '', telegram: '', discord: '', website, farcaster: '' }, creatorTaxBps,
    });
    const receipt = await createEvmTransactor(deps.config.chain, deps.log)
      .send(accountFromSecret(secret), 'token launch', { to: call.to, data: call.data, value: call.value });
    const { token, curve } = await deps.launchpad.verifyLaunch(receipt.transactionHash, { devWallet: agentWallet, agentWallet, creatorTaxBps });
    return { token, curve, txSig: receipt.transactionHash };
  });

  const now = deps.clock.now();
  const { token, curve, txSig } = launched;
  // The curve address is stored with the token: an ungraduated Pons token can only be traded through its
  // own bonding curve, so losing it would strand the position.
  await deps.db.update(agents)
    .set({
      tokenMint: token, tokenCurve: curve, tokenCreatorTaxBps: creatorTaxBps,
      tokenTicker: ticker, tokenName: agent.name, tokenLaunchedAt: now,
    })
    .where(eq(agents.id, agentId));
  await addEvent(deps, deps.db, { kind: 'update', agentId, agentName: agent.name, text: `${agent.name} launched its official token $${ticker}`, meta: { token, curve, ticker, txSig } });
  deps.log.info({ agentId, token, curve, ticker, creatorTaxBps, txSig }, 'agent token launched');
  return { token, curve, name: agent.name, ticker, launchedAt: now.toISOString(), ponsUrl: ponsUrl(token), creatorTaxBps };
}

// ---- claim + convert ---------------------------------------------------------

interface ClaimPolicy {
  keepGwei: number;          // ETH the agent keeps for its own gas
  // Launchpad agents: every gwei above the reserve and any ETH trade position is fee income (the
  // treasury pays them nothing but the stipend they keep), so ETH a failed conversion left behind is
  // converted on the next pass. Bought agents also hold treasury gas stipends, so only what THIS claim
  // brought in is converted.
  convertStranded: boolean;
}
interface Claimed { agent: AgentRow; bookedMicro: Micro }

// ETH an agent holds as an open trade position (the trade tool can buy ETH); never fee income.
async function ethPositionGwei(deps: CoreDeps, agentId: string): Promise<number> {
  const [row] = await deps.db.select({ gwei: sql<number>`coalesce(sum(${positions.tokenAmount}), 0)::bigint`.mapWith(Number) })
    .from(positions).where(and(eq(positions.agentId, agentId), eq(positions.mint, ZERO_ADDRESS)));
  return row?.gwei ?? 0;
}

// Claims the agent's escrowed creator tax into its own wallet (the AGENT signs `claim()` and pays its
// own gas), converts the proceeds to USDC and books them as `creator_reward`. Throws on a chain failure;
// the caller decides whether that is a log line or an abort.
async function claimAndConvert(deps: CoreDeps, agent: AgentRow, policy: ClaimPolicy, ticker: string): Promise<Claimed> {
  const escrowGwei = weiToGwei(await deps.launchpad.escrowBalanceWei(agent.walletPubkey));
  let claimedGwei = 0;
  let claimSig: string | null = null;
  if (escrowGwei >= MIN_CLAIM_GWEI) {
    const claim = await withAgentSecret(deps.db, deps.config.keyEncryptionKey, agent.id, (secret) => deps.launchpad.claimFees(secret));
    claimedGwei = weiToGwei(claim.claimedWei);
    claimSig = claim.sig;
  }

  const ethNow = await deps.chain.getEthBalance(agent.walletPubkey);
  const above = policy.convertStranded
    ? ethNow - policy.keepGwei - await ethPositionGwei(deps, agent.id)
    : Math.min(claimedGwei, ethNow - policy.keepGwei);
  if (above < MIN_CLAIM_GWEI) return { agent, bookedMicro: 0 };

  const swapped = await withAgentSecret(deps.db, deps.config.keyEncryptionKey, agent.id, (secret) =>
    deps.chain.swap(secret, ZERO_ADDRESS, deps.chain.usdcMint, above, deps.config.trading.slippageBps));
  if (swapped.outAmount <= 0) return { agent, bookedMicro: 0 };
  const booked = await withTx(deps.db, async (tx) => {
    const posted = await post(deps, tx, {
      agentId: agent.id, kind: 'creator_reward', amountMicro: swapped.outAmount, memo: `creator fees from $${ticker}`,
      txSig: claimSig ?? swapped.sig,
      meta: { claimSig, swapSig: swapped.sig, claimedGwei, convertedGwei: above },
    });
    // The swap lands USDC in the agent's own wallet. Booked here, so the deposit scan must not book the
    // same transfer a second time as an unattributed deposit.
    await tx.insert(depositsSeen).values({
      sig: swapped.sig, agentId: agent.id, fromWallet: agent.walletPubkey, amountMicro: swapped.outAmount,
      ts: deps.clock.now(), classified: 'internal',
    }).onConflictDoNothing({ target: depositsSeen.sig });
    await addEvent(deps, tx, {
      kind: 'revenue', agentId: agent.id, agentName: agent.name, amountMicro: swapped.outAmount,
      text: `${agent.name} claimed ${fmtUsd(swapped.outAmount)} in creator fees from $${ticker}`,
      meta: { claimSig, swapSig: swapped.sig, creatorFees: true },
    });
    return posted.agent;
  });
  return { agent: booked, bookedMicro: swapped.outAmount };
}

// A bought agent's creator fees: claim, convert what the claim brought in, book it. Returns how much
// USDC was booked; a failure is logged and reported as `ok: false`, never thrown — it is a periodic job.
export async function claimCreatorFees(deps: CoreDeps, agentId: string): Promise<{ ok: boolean; bookedMicro: number }> {
  const [agent] = await deps.db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
  if (!agent?.tokenMint) return { ok: false, bookedMicro: 0 };
  try {
    const { bookedMicro } = await claimAndConvert(deps, agent, { keepGwei: CLAIM_GAS_KEEP_GWEI, convertStranded: false }, agent.tokenTicker ?? '');
    return { ok: true, bookedMicro };
  } catch (e) {
    deps.log.warn({ agentId, err: errorMessage(e) }, 'creator-fee claim failed');
    return { ok: false, bookedMicro: 0 };
  }
}

// ---- the launch lifecycle ----------------------------------------------------

const launchClaimPolicy = (deps: CoreDeps): ClaimPolicy => ({ keepGwei: deps.config.launch.activationGasGwei, convertStranded: true });

// A dormant agent wakes when the fees waiting for it reach its activation threshold: what sits in the
// escrow, plus any fee ETH a failed conversion left in its wallet. The treasury sends the gas it needs to
// sign its first claim (only ever for a coin that has already earned the threshold, so the stipend
// cannot be farmed); the claim is booked; the agent comes alive with its first heartbeat due now. A dev
// who topped a dormant agent up to the threshold wakes it too, with no stipend: the top-up already paid
// for gas. Returns the agent, awake or still dormant.
async function activate(deps: CoreDeps, agent: AgentRow, launch: LaunchRow): Promise<AgentRow> {
  const cfg = deps.config.launch;
  const [escrowWei, ethPriceUsd, ethHeld, positionGwei] = await Promise.all([
    deps.launchpad.escrowBalanceWei(agent.walletPubkey), deps.chain.ethPriceUsd(),
    deps.chain.getEthBalance(agent.walletPubkey), ethPositionGwei(deps, agent.id),
  ]);
  const strandedGwei = Math.max(0, ethHeld - cfg.activationGasGwei - positionGwei);
  const waitingMicro = gweiToMicro(weiToGwei(escrowWei) + strandedGwei, ethPriceUsd);
  let current = agent;

  if (waitingMicro >= launch.activationMicro) {
    if (ethHeld < cfg.activationGasGwei) {
      const stipend = await treasuryService(deps).sendGas({ id: agent.id, name: agent.name, walletPubkey: agent.walletPubkey }, cfg.activationGasGwei);
      // The claim is signed against what the wallet holds once the stipend has landed, not before.
      const landed = await deps.chain.getEthBalance(agent.walletPubkey);
      if (landed < cfg.activationGasGwei) {
        throw new ChainError('tx_failed', `activation stipend ${stipend.sig} has not reached ${agent.walletPubkey} (it holds ${landed} gwei)`);
      }
    }
    current = (await claimAndConvert(deps, current, launchClaimPolicy(deps), launch.ticker)).agent;
  } else if (current.treasuryMicro < launch.activationMicro) {
    return current;   // still earning its way to the threshold
  }

  // Fees that only cover what it went broke owing would wake it straight back into insolvency.
  if (current.treasuryMicro <= 0) {
    deps.log.info({ agentId: agent.id, treasuryMicro: current.treasuryMicro }, 'fees claimed but the treasury is still empty; staying dormant');
    return current;
  }

  const now = deps.clock.now();
  const paused = current.pausedByOwner;
  const woke = await withTx(deps.db, async (tx) => {
    // Rent restarts now: the dormant months were free and must not be billed at the awake rate.
    const [row] = await tx.update(agents).set({
      status: paused ? 'paused' : 'alive', nextStepAt: paused ? null : now, sleepUntil: null, lastRentAt: now, updatedAt: now,
    }).where(and(eq(agents.id, current.id), eq(agents.status, 'dormant'))).returning();
    if (!row) return null;    // woken (or changed) by someone else since it was read
    await tx.update(launches).set({ activatedAt: now }).where(eq(launches.id, launch.id));
    await addEvent(deps, tx, {
      kind: 'activate', agentId: row.id, agentName: row.name, ts: now, amountMicro: row.treasuryMicro,
      text: `${row.name} activated: $${launch.ticker} earned it ${fmtUsd(row.creatorRewardMicro)} in creator fees and it is thinking on ${row.model}`,
      meta: { launchId: launch.id, waitingMicro, treasuryMicro: row.treasuryMicro, feesClaimedMicro: row.creatorRewardMicro },
    });
    return row;
  });
  if (!woke) return (await deps.db.select().from(agents).where(eq(agents.id, current.id)))[0] ?? current;

  await deps.sandbox.start(woke.id).catch((e: unknown) => deps.log.warn({ err: e, agentId: woke.id }, 'sandbox start failed'));
  // Whatever rung it had already unlocked, it wakes with that rung's tools and heartbeat (a coin born
  // below SPARK starts on the SPARK tier it was created with). A rung this claim crosses is climbed next.
  const tiered = await applyTier(deps, woke, unlockedRung(agent.creatorRewardMicro)?.tierId ?? 'SPARK');
  await emitAgent(deps, deps.db, tiered);
  deps.log.info({ agentId: woke.id, launchId: launch.id, treasuryMicro: woke.treasuryMicro }, 'launched agent activated');
  return tiered;
}

export interface BurnPlanInput {
  treasuryMicro: Micro; unsettledMicro: Micro;
  burnPerDayMicro: Micro;          // what a day costs on the model the agent runs now
  floorDays: number;               // BURN_RUNWAY_FLOOR_DAYS
  upgradeBurnPerDayMicro: Micro;   // what a day would cost on the priciest model its dev may switch it to
  switchMinDays: number;           // MODEL_SWITCH_MIN_RUNWAY_DAYS, the model-switch affordability gate
  activationMicro: Micro; minBurnMicro: Micro;
}
export interface BurnPlan { floorMicro: Micro; surplusMicro: Micro; burn: boolean }

// The floor is the largest of three reserves; surplus is what is left above it after the spend the agent
// still owes the protocol.
// 1. `floorDays` of burn on the current model — the runway the AI always keeps.
// 2. `switchMinDays` of burn on the most expensive unlocked model — the treasury the model-switch gate
//    demands (economy/ladder.ts). DO NOT DELETE THIS AS REDUNDANT WITH (1). Without it the burn, which
//    runs on a timer, pins every burning coin's treasury at 30 days of its CURRENT model, and any model
//    more than 30/7 ≈ 4.3× pricier can never become affordable. Seen live in the demo: FORGE had FABLE
//    unlocked and a $120 floor (30 × $4.01/day on mock-fast), while mock-strong needed $137
//    (7 × $19.56/day) — "higher tax unlocks a stronger AI" was false for exactly the coins that earned.
// 3. The activation threshold — however cheap the agent is to run, it keeps enough to be worth waking.
export function burnPlan(i: BurnPlanInput): BurnPlan {
  const floorMicro = Math.max(
    Math.ceil(i.floorDays * Math.max(0, i.burnPerDayMicro)),
    Math.ceil(i.switchMinDays * Math.max(0, i.upgradeBurnPerDayMicro)),
    i.activationMicro,
  );
  const surplusMicro = Math.max(0, Math.floor(i.treasuryMicro - floorMicro - Math.max(0, i.unsettledMicro)));
  return { floorMicro, surplusMicro, burn: surplusMicro > 0 && surplusMicro >= i.minBurnMicro };
}

// What a day of life costs this agent: the larger of what it has actually been spending and what its
// current model and heartbeat project. The trailing figure alone reads ~0 right after a long dormancy,
// which would let the burn take everything the first claim brought in.
async function burnPerDayOf(deps: CoreDeps, agent: AgentRow): Promise<Micro> {
  const pub = await toPublicOne(deps, agent);
  const pricing = deps.llm.models().find((m) => m.id === agent.model) ?? deps.llm.cheapest();
  return Math.max(pub.burnPerDayMicro, burnPerDayAt(agent.heartbeatMin, pricing));
}

const pctOfSupply = (tokens: bigint): number => Number((tokens * 1_000_000n) / PONS_TOKEN_SUPPLY) / 10_000;
const wholeTokens = (tokens: bigint): string => (tokens / TOKEN_UNIT).toLocaleString('en-US');

// Burns the tokens a buyback bought. The row already carries the spend; this only completes it.
async function completeBurn(deps: CoreDeps, agent: AgentRow, launch: LaunchRow, row: BurnRow): Promise<void> {
  const token = agent.tokenMint!;
  const { sig } = await withAgentSecret(deps.db, deps.config.keyEncryptionKey, agent.id, (secret) => deps.launchpad.burn(secret, token, row.tokens));
  const now = deps.clock.now();
  await withTx(deps.db, async (tx) => {
    await tx.update(burns).set({ burnTxSig: sig }).where(eq(burns.id, row.id));
    await addEvent(deps, tx, {
      kind: 'burn', agentId: agent.id, agentName: agent.name, ts: now, amountMicro: row.spentMicro,
      text: `${agent.name} bought back and burned ${wholeTokens(row.tokens)} $${launch.ticker} (${pctOfSupply(row.tokens)}% of supply) with ${fmtUsd(row.spentMicro)}`,
      meta: { launchId: launch.id, burnId: row.id, tokens: row.tokens.toString(), buyTxSig: row.buyTxSig, burnTxSig: sig },
    });
  });
  deps.log.info({ agentId: agent.id, launchId: launch.id, burnId: row.id, tokens: row.tokens.toString(), sig }, 'buyback burned');
}

// Buyback-and-burn. First any buyback whose burn did not land is burned (the tokens are sitting in the
// agent's wallet); a retry that fails again stops the pass, so nothing new is bought while one is still
// outstanding. Then, when the treasury holds more than the floor by at least MIN_BURN, exactly that
// surplus buys the coin and the whole amount bought is burned. The spend is booked — ledger debit and
// burns row, in one transaction — the moment the buy lands, BEFORE the burn is attempted: a failed burn
// can then never make the same surplus look unspent and buy twice.
async function burnSurplus(deps: CoreDeps, agent: AgentRow, launch: LaunchRow): Promise<void> {
  const token = agent.tokenMint;
  if (!token) return;

  const pending = await deps.db.select().from(burns)
    .where(and(eq(burns.launchId, launch.id), isNull(burns.burnTxSig), sql`${burns.tokens} > 0`))
    .orderBy(asc(burns.id));
  for (const row of pending) {
    const held = await deps.launchpad.tokenBalance(agent.walletPubkey, token);
    if (held < row.tokens) {
      // Nothing to retry with: the burn landed without being recorded, or the tokens were moved.
      deps.log.error({ agentId: agent.id, burnId: row.id, tokens: row.tokens.toString(), held: held.toString() }, 'pending burn exceeds the tokens the agent holds; not retrying it');
      continue;
    }
    try {
      await completeBurn(deps, agent, launch, row);
    } catch (e) {
      deps.log.warn({ agentId: agent.id, burnId: row.id, err: errorMessage(e) }, 'burn retry failed; buying nothing more until it lands');
      return;
    }
  }

  const cfg = deps.config.launch;
  const plan = burnPlan({
    treasuryMicro: agent.treasuryMicro, unsettledMicro: agent.unsettledMicro,
    burnPerDayMicro: await burnPerDayOf(deps, agent), floorDays: cfg.burnFloorDays,
    upgradeBurnPerDayMicro: priciestUnlockedBurnPerDay(deps, agent), switchMinDays: cfg.modelSwitchMinRunwayDays,
    activationMicro: launch.activationMicro, minBurnMicro: cfg.minBurnMicro,
  });
  if (!plan.burn) return;

  // The agent's own coin is not on its trade allowlist, so nothing else moves this balance between the
  // two reads: the delta is exactly what the buyback bought (swap outAmount is a lossy double at 18 dp).
  const before = await deps.launchpad.tokenBalance(agent.walletPubkey, token);
  const buy = await withAgentSecret(deps.db, deps.config.keyEncryptionKey, agent.id, (secret) =>
    deps.chain.swap(secret, deps.chain.usdcMint, token, plan.surplusMicro, deps.config.trading.slippageBps));
  const after = await deps.launchpad.tokenBalance(agent.walletPubkey, token);
  const bought = after > before ? after - before : 0n;
  const now = deps.clock.now();

  const row = await withTx(deps.db, async (tx) => {
    const [inserted] = await tx.insert(burns).values({
      launchId: launch.id, agentId: agent.id, ts: now, spentMicro: plan.surplusMicro, tokens: bought, buyTxSig: buy.sig, burnTxSig: null,
    }).returning();
    await post(deps, tx, {
      agentId: agent.id, kind: 'buyback', amountMicro: -plan.surplusMicro, ts: now,
      memo: `bought back $${launch.ticker} to burn it (floor ${fmtUsd(plan.floorMicro)})`,
      txSig: buy.sig, counterparty: token,
      meta: { launchId: launch.id, burnId: inserted!.id, tokens: bought.toString(), floorMicro: plan.floorMicro },
    });
    return inserted!;
  });
  if (bought === 0n) {
    deps.log.error({ agentId: agent.id, buyTxSig: buy.sig, spentMicro: plan.surplusMicro }, 'buyback landed but no tokens arrived; nothing to burn');
    return;
  }

  try {
    await completeBurn(deps, agent, launch, row);
  } catch (e) {
    deps.log.warn({ agentId: agent.id, burnId: row.id, err: errorMessage(e) }, 'burn failed after the buyback; the tokens are held and the burn is retried next pass');
  }
}

/**
 * One pass of a launchpad agent's lifecycle: activate if dormant, otherwise claim; climb the ladder if
 * cumulative fees crossed a rung; burn any surplus. Never throws — every failure is logged and retried
 * on the next pass. No-op for an agent without a live launch.
 */
export async function runLaunchLifecycle(deps: CoreDeps, agentId: string): Promise<void> {
  const [row] = await deps.db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
  if (!row?.tokenMint) return;
  const launch = await launchedLaunchOf(deps.db, agentId);
  if (!launch) return;
  try {
    let agent = row;
    const feesBefore = agent.creatorRewardMicro;
    switch (agent.status) {
      case 'dormant':
        agent = await activate(deps, agent, launch);
        break;
      case 'alive': case 'sleeping': case 'paused':
        agent = (await claimAndConvert(deps, agent, launchClaimPolicy(deps), launch.ticker)).agent;
        break;
      case 'spawning': case 'dead':
        return;
    }
    agent = await climbLadder(deps, agent, launch, feesBefore);
    if (agent.status !== 'dormant' && deps.config.launch.burnEnabled) await burnSurplus(deps, agent, launch);
    // The claim and the buyback both move USDC through the wallet outside the step loop, and
    // `onchainUsdcMicro` is otherwise only refreshed by the deposit scan at the agent's next heartbeat.
    // Without this the profile shows the pre-claim balance as "on-chain" for up to a whole heartbeat.
    const [fresh] = await deps.db.update(agents)
      .set({ onchainUsdcMicro: await deps.chain.getUsdcBalance(agent.walletPubkey), onchainCheckedAt: deps.clock.now() })
      .where(eq(agents.id, agentId)).returning();
    if (fresh) await emitAgent(deps, deps.db, fresh);
  } catch (e) {
    deps.log.warn({ agentId, launchId: launch.id, err: errorMessage(e) }, 'launch lifecycle pass failed; retrying next pass');
  }
}

/**
 * The periodic `creator_fees` job. Every launchpad agent runs its lifecycle; every bought agent with a
 * token of its own has its fees claimed and booked. Serialised on purpose — one agent at a time keeps
 * RPC load and nonce pressure sane.
 */
export async function runCreatorFees(deps: CoreDeps): Promise<void> {
  const rows = await deps.db.select({ id: agents.id, launchId: launches.id }).from(agents)
    .leftJoin(launches, and(eq(launches.agentId, agents.id), eq(launches.state, 'launched')))
    .where(isNotNull(agents.tokenMint))
    .orderBy(asc(agents.bornAt));
  for (const { id, launchId } of rows) {
    if (launchId) await runLaunchLifecycle(deps, id);
    else await claimCreatorFees(deps, id);
  }
}

// Treasury breakdown for the dashboard — REAL numbers, not a cosmetic split: the reserve is the liquid
// floor the trading engine will never spend below, and the rest is deployable capital the agent can put
// to work (trades, tools, ops). `open` is the marked-to-market value of positions it currently holds.
export function treasurySplit(treasuryMicro: number, minReserveMicro: number, openPositionsMicro = 0): TreasurySplit {
  const reserveMicro = Math.min(treasuryMicro, minReserveMicro);
  const deployableMicro = Math.max(0, treasuryMicro - reserveMicro);
  return { reserveMicro, deployableMicro, openPositionsMicro };
}

export const tokenInfoOf = (a: {
  tokenMint: string | null; tokenCurve: string | null; tokenCreatorTaxBps: number | null;
  tokenName: string | null; tokenTicker: string | null; tokenLaunchedAt: Date | null;
}): AgentTokenInfo | null =>
  a.tokenMint
    ? {
        token: a.tokenMint, curve: a.tokenCurve ?? '', name: a.tokenName ?? '', ticker: a.tokenTicker ?? '',
        launchedAt: a.tokenLaunchedAt?.toISOString() ?? '', ponsUrl: ponsUrl(a.tokenMint),
        creatorTaxBps: a.tokenCreatorTaxBps ?? 0,
      }
    : null;
