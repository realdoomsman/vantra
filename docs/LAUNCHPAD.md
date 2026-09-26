# VANTRA — Launchpad Specification ("LAUNCH A COIN")

Status: **canonical contract for the launchpad path.** This is the document the code cites as
"launchpad spec §N" (`economy/launch.ts`, `economy/token.ts`, `economy/ladder.ts`, `chain/launchpad.ts`,
`http/routes/launches.ts`, `runtime/death.ts`, `economy/withdraw.ts`, `sim/launches.ts`, and the web's
`LaunchPanel.tsx` / `LaunchLadder.tsx`). It is reverse-engineered from that code; every statement names
the file and symbol that enforces it. The other way an AI gets money — a USDC purchase — is
`docs/SPEC-V2.md` and is unchanged by this document.

Read order: §0 (what it is and what it may never do), §2 (how a launched AI lives), §5 (the security
boundary), then your own section. Paths are relative to `apps/api/src/` unless they start with
`packages/` or `apps/web/`.

Non-negotiables carried from SPEC-V2 and kept here:
- Money is integer micro-dollars (`1_000_000 = $1.00`). `economy/ledger.ts:post` is the only writer of
  the agent money columns; `agents.creator_reward_micro` is the running sum of `creator_reward` rows
  (`ledger.ts:aggregateDelta`).
- Agent keys are decrypted only inside chain calls (`withAgentSecret`), never logged, never returned.
- `CHAIN_MODE=memory` + `LLM_PROVIDER=mock` runs the whole launchpad end to end with no chain (§7).

---

## 0. Purpose and the trust guarantee

### 0.1 In one paragraph

A dev launches a coin on **Pons V2** (Robinhood Chain's launchpad) *through* VANTRA. VANTRA first
creates the coin's AI — a fresh agent, born **dormant**, with an empty wallet, owned by the dev, on the
SPARK tier — and hands the dev the exact `launchToken` call to sign with their **own** wallet, with the
coin's **creator tax wired to the AI's wallet** as `creatorFeeRecipient`. Once the chain proves that
launch is the one agreed, the coin is listed. From then on the AI lives on its coin's creator fees: it
wakes when `LAUNCH_ACTIVATION_USD` of fees is waiting, climbs a model ladder as cumulative fees cross
rungs, keeps `BURN_RUNWAY_FLOOR_DAYS` of runway, and spends everything above that floor buying the coin
back and burning it. When it runs out of money it goes **dormant, not dead**, and wakes again on the
next fees. VANTRA takes nothing from a launch, a trade or a claim. (`economy/launch.ts` header,
`pages/Launch.tsx` page copy, `pages/Protocol.tsx:LaunchRules`.)

### 0.2 The trust guarantee

The guarantee to a coin's holders is structural, not a policy:

| Guarantee | Where it is enforced |
|---|---|
| The creator tax is paid to the AI's wallet, at the rate the dev chose, from the first trade. | `chain/launchpad.ts:encodeLaunchCall` writes `creatorFeeRecipient = agentWallet`; §5.2 refuses to list any launch whose on-chain record says otherwise. |
| Nothing in this codebase can move the fee recipient or turn on Pons's buyback. | `chain/pons.ts:ponsFactoryAbi` deliberately omits `transferCreatorFeeRecipient` and `setBuybackEnabled`: no fragment, no selector, no encoder. `chain/launchpad.ts` never declares, encodes or sends either. |
| Only the AI's wallet ever signs its claims and burns. | `claim()` credits `msg.sender`; `claimFees` and `burn` are signed with the agent's own key (`chain/launchpad.ts:claimFees`, `burn`). No protocol or dev key is in the path (`economy/token.ts` header). |
| The dev can never take the money out. | `economy/withdraw.ts:withdrawableOf` returns `eligible: false` for any launched agent; `economy/owner.ts:terminate` refuses (§2.6). |
| Buybacks are burned, not vested. | `buybackEnabled: false` in the launch call; VANTRA buys and calls `burn()` on the ERC20Burnable token (`chain/pons.ts:ponsTokenAbi`). Pons's native buyback would lock tokens in a 5-year vest. |
| VANTRA's cut is 0%. | The dev pays only the factory's `launchFee()` plus gas (`chain/launchpad.ts:buildLaunchCall` sets `value: fee`); no VANTRA wallet appears in the calldata. |

The web states the same guarantee on `/launch` ("THE GUARANTEE") and on every coin panel
("FEES → AI WALLET"), and `pages/Protocol.tsx:LaunchRules` prints the rules table with the live
config values.

### 0.3 What is out of scope here

A **bought** agent (SPEC-V2) may also launch its own token from its own wallet
(`economy/token.ts:launchAgentToken`, gated by `TOKEN_LAUNCH_ENABLED`); its fees are claimed and booked
by the same `creator_fees` job but nothing else in this document applies to it. `TOKEN_LAUNCH_ENABLED`
gates **only** that path; it does not gate the launchpad (§6.2).

---

## 1. Pons V2 on Robinhood Chain

Source: `chain/pons.ts` (the one declaration of the Pons surface — nothing else may copy it),
`chain/launchpad.ts:createEvmLaunchpad`.

### 1.1 Contracts

| Constant | Address | Role |
|---|---|---|
| `PONS_FACTORY` | `0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e` | `launchToken`, `getLaunchedToken`, terms, `feeEscrow()` |
| `PONS_FEE_ESCROW` | `0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e` | creator-tax escrow; recognised in logs only — the live address is read from `factory.feeEscrow()` at runtime and memoised, and dropped on failure so one flaky read cannot poison the port |
| `PONS_ROUTER`, `PONS_MEME_HOOK`, `PONS_LAUNCH_LOCKER`, `UNISWAP_V4_POOL_MANAGER` | see `pons.ts` | declared for recognition; not called by the launchpad |
| `PONS_LAUNCH_CONFIG_ID` | `0n` | `launchConfigCount()` is 1 on mainnet, so 0 is the only id the factory accepts |
| `TOKEN_LAUNCHED_TOPIC0` | `0x8d4aad…9607` | `keccak256('TokenLaunched(address,address,address,address,uint256,uint256)')`, verified against a real mainnet receipt; `verifyLaunch` matches the event through the same ABI fragment |
| `PONS_TOKEN_SUPPLY` | `1_000_000_000 × 1e18` | every Pons token is a `PonsV2LauncherToken` with this fixed supply; burn percentages are computed against it |

### 1.2 Terms, verified live on mainnet

Confirmed by `eth_call` and transcribed into `chain/pons.ts`: `launchFee()` = 0.0005 ETH,
`maxCreatorTaxBps()` = 1000, `launchEnabled()` = true. `chain/launchpad.ts` pins the same numbers as
`PONS_LAUNCH_FEE_WEI = 500_000_000_000_000n` and `PONS_MAX_CREATOR_TAX_BPS = 1_000` so the memory fake
answers with the terms a real launch would show. The real port never trusts these constants for a
launch: `buildLaunchCall` reads `launchEnabled`, `launchFee` and `previewLaunchEconomics(0, 0x0)` live
and refuses with `launch_failed` if launches are closed. `prepareLaunch` reads `maxCreatorTaxBps()` live
for its validation (§4.3).

`expectedEconomics` (the `bytes32` from `previewLaunchEconomics`) is written into the call. It **pins the
terms**: if the launch config is re-pegged between the read and the dev's signature, the factory reverts
rather than pricing the coin on terms nobody agreed to.

### 1.3 ABI fragments in use

| Fragment | Functions / events used |
|---|---|
| `ponsFactoryAbi` | `launchFee`, `maxCreatorTaxBps`, `launchEnabled`, `feeEscrow`, `previewLaunchEconomics`, `launchToken(params, launchConfigId, pairToken) payable`, `getLaunchedToken(token)`, event `TokenLaunched(token, curve, deployer, pairToken, launchConfigId, graduationThreshold)` |
| `ponsFeeEscrowAbi` | `balanceOf(recipient)`, `claim()` (permissionless, credits `msg.sender`). `balanceOfToken` / `claimToken` are declared but never called: launches are ETH-paired only (§5.2). |
| `ponsTokenAbi` | `balanceOf`, `totalSupply`, `burn(amount)` |
| `ponsBondingCurveAbi` | used by `chain/evm.ts:swap` to trade an **ungraduated** token on its curve (the only venue before graduation); after graduation the swap routes through LI.FI |

**Deliberately absent, and MUST stay absent everywhere:** `transferCreatorFeeRecipient`,
`setBuybackEnabled` (§0.2).

### 1.4 The launch call

`chain/launchpad.ts:encodeLaunchCall` produces `launchToken(params, 0, 0x0)` with:

| Field | Value |
|---|---|
| `name`, `symbol`, `description` | from the launch (§4.3) |
| `logo` | the public URL of the dev's uploaded logo (`${apiUrl}/api/images/<id>`, §5.1), or a deterministic DiceBear image seeded by the agent id (`economy/launch.ts:prepareLaunch`) |
| `socials` | `twitter`, `telegram`, `website` from the launch (`website` defaults to `${publicUrl}/a/${agentId}`); `discord` and `farcaster` are always `''` |
| `creatorFeeRecipient` | the agent's wallet, checksummed |
| `creatorTaxBps` | the dev's choice, integer `0..maxCreatorTaxBps` |
| `buybackEnabled` | `false`, always |
| `expectedEconomics` | live preview (real chain) or `keccak256('vantra:memory:launch-economics')` (memory) |
| `salt` | `keccak256('vantra:' + agentId)` — fixed per agent, so one agent can never be the subject of two launches from the same dev |
| `pairToken` | `ZERO_ADDRESS` (ETH-paired) |
| `value` | `launchFee()` in wei |

The dev is not in the calldata: the factory records `msg.sender` as `deployer`, which is what §5.2 checks.

---

## 2. How a launched AI lives

Source: `economy/token.ts` (`runLaunchLifecycle`, `activate`, `claimAndConvert`, `burnPlan`,
`burnSurplus`, `runCreatorFees`), `runtime/death.ts:goBroke`, `economy/withdraw.ts`,
`economy/owner.ts`, `runtime/scheduler.ts`. Tested in `test/economy/launch-lifecycle.test.ts`.

### 2.1 The money flow

```mermaid
flowchart LR
  T[trader buys/sells the coin] -->|creator tax, ETH| E[Pons fee escrow<br/>balanceOf(agentWallet)]
  E -->|agent signs claim()| W[agent wallet, ETH]
  W -->|chain.swap ETH→USDC<br/>keeps ACTIVATION_GAS_GWEI| U[agent wallet, USDC]
  U -->|ledger creator_reward| L[agents.treasury_micro<br/>agents.creator_reward_micro]
  L -->|surplus above floor<br/>ledger buyback| B[chain.swap USDC→coin]
  B -->|token.burn()| X[supply retired]
```

Every hop is signed by the agent's own wallet, which pays its own gas. Nothing is routed through a
VANTRA wallet except the one-time activation gas stipend (§2.3).

### 2.2 One lifecycle pass

`runLaunchLifecycle(deps, agentId)` is one pass. It is a no-op for an agent without `token_mint` or
without a launch in state `launched`. It never throws: any failure is logged and retried on the next
pass. The order within a pass is fixed:

| Step | When | What |
|---|---|---|
| **activate** | `status = dormant` | §2.3. Wakes the agent if enough fees are waiting; otherwise returns still dormant. |
| **claim** | `status ∈ {alive, sleeping, paused}` | `claimAndConvert` with the launch policy (§2.4). |
| (skip) | `status ∈ {spawning, dead}` | the pass returns. |
| **rung** | after either | `ladder.ts:climbLadder` — if `creator_reward_micro` crossed one or more rungs since the pass began, apply the highest rung's tier and post a `milestone` event per rung (§3.3). |
| **burn** | `status ≠ dormant` | `burnSurplus` (§2.5). |
| refresh | always | `agents.onchain_usdc_micro` is re-read and the agent is emitted, so the profile does not show the pre-claim balance for a whole heartbeat. |

Passes are run by the scheduler's `creator_fees` job every `CREATOR_FEES_MS = 2 hours` (first run 5
minutes after boot), serialised one agent at a time in `bornAt` order (`runCreatorFees`), and
immediately by `POST …/simulate-fees` (§7) and by an owner top-up of a dormant agent
(`economy/owner.ts:wakeAfterTopUp`).

### 2.3 Activation

`activate(deps, agent, launch)`:

1. `waiting = escrow balance + max(0, walletETH − ACTIVATION_GAS_GWEI − ETH held as a trade position)`,
   valued at the current ETH price. Fee ETH a failed conversion left in the wallet counts; a trade
   position never does.
2. If `waiting ≥ launch.activation_micro`: if the wallet holds less than `ACTIVATION_GAS_GWEI`, the
   TREASURY sends exactly that stipend (`treasury.sendGas`) — only ever for a coin that has already
   earned the threshold, so it cannot be farmed — and the pass throws `tx_failed` (retry next pass)
   if the stipend has not landed. Then `claimAndConvert` runs (§2.4).
3. Else, if `treasury_micro < activation_micro`, the agent stays dormant (still earning its way).
   A dev who topped a dormant agent up to the threshold wakes it with no stipend.
4. If the treasury is still `≤ 0` after the claim (the fees only covered what it went broke owing),
   it stays dormant rather than waking into insolvency.
5. Otherwise, in one transaction and only if it is still `dormant`: `status → alive` (or `paused`
   if `paused_by_owner`), `next_step_at = now`, `last_rent_at = now` (dormant months are never billed),
   `launches.activated_at = now`, and an `activate` event. Then the sandbox is started and the tier
   of whatever rung its **pre-pass** fees had unlocked is applied (a coin below SPARK wakes on the
   SPARK tier it was created with); a rung this claim crosses is climbed in the same pass.

`launch.activation_micro` is copied from `config.launch.activationMicro` at prepare time
(`prepareLaunch`), so a later config change never moves an existing coin's threshold.

### 2.4 Claim and convert

`claimAndConvert(deps, agent, policy, ticker)` with the launch policy
`{ keepGwei: ACTIVATION_GAS_GWEI, convertStranded: true }`:

1. If the escrow holds `≥ MIN_CLAIM_GWEI` (200 000 gwei = 0.0002 ETH), the agent signs `claim()`.
   On the real chain the claimed amount is the wallet's balance delta with the claim's own gas added
   back, measured under the wallet's nonce lock (`withAddressLock`) so none of the agent's own sends can
   land in between. A claim with an empty escrow is `insufficient_funds`.
2. `above = walletETH − keepGwei − ETH trade position`. Everything above the reserve is fee income
   (the treasury never tops a launched agent up, so its fees must refill its own gas reserve first;
   ETH a failed conversion stranded is converted on the next pass). If `above < MIN_CLAIM_GWEI` nothing
   is booked.
3. `chain.swap(ETH → USDC, above, TRADING slippage)` signed by the agent. If it returns nothing, nothing
   is booked.
4. In one transaction: a `creator_reward` ledger row for the USDC out (memo `creator fees from $TICKER`,
   `tx_sig` = claim sig or swap sig, meta `{claimSig, swapSig, claimedGwei, convertedGwei}`) and a
   `revenue` event. The ledger row is what advances `agents.creator_reward_micro` — the number the
   ladder (§3) and every "fees earned" figure read.

A **bought** agent's claim uses `{ keepGwei: CLAIM_GAS_KEEP_GWEI (0.0005 ETH), convertStranded: false }`
and converts only what this claim brought in.

### 2.5 Buyback and burn

`burnPlan(input)` — the floor is the largest of three reserves; the surplus is what remains above it
after the spend the agent still owes the protocol:

```
floor   = max( ceil(BURN_RUNWAY_FLOOR_DAYS       × burnPerDay(current model)),
               ceil(MODEL_SWITCH_MIN_RUNWAY_DAYS × burnPerDay(priciest unlocked model)),
               launch.activation_micro )
surplus = max(0, floor(treasury_micro − floor − max(0, unsettled_micro)))
burn    = surplus > 0 && surplus ≥ MIN_BURN_USD
```

- `burnPerDay(current)` is the larger of the agent's trailing actual burn and the projection for its
  current model and heartbeat (`burnPerDayOf`): right after a long dormancy the trailing figure reads
  ≈ 0 and would let the burn take the whole first claim.
- The second reserve exists so the burn can never price an unlocked model out of the switch gate (§3.4).
  `ladder.ts:priciestUnlockedBurnPerDay` and the gate use the same `burnPerDayAt` projection. This
  reserve MUST NOT be removed as redundant with the first (the comment in `token.ts` records the demo
  failure that motivated it).
- The third keeps the agent worth waking however cheap it is to run.

`burnSurplus(deps, agent, launch)` then guarantees, in order:

1. **Retry pending burns first.** Every `burns` row with `burn_tx_sig IS NULL` and `tokens > 0` is
   burned from the tokens already in the wallet. A row whose tokens exceed what the wallet holds is
   logged as an error and skipped (the burn landed unrecorded, or the tokens were moved). A retry that
   fails again **ends the pass**: nothing new is bought while a burn is outstanding.
2. **Plan.** If `!plan.burn`, return.
3. **Buy exactly the surplus.** `chain.swap(USDC → coin, surplus)` signed by the agent. The amount
   bought is the wallet's token balance delta around the swap (the agent's own coin is not on its trade
   allowlist, so nothing else moves that balance).
4. **Book before burn.** In one transaction, the moment the buy lands: a `burns` row
   (`spent_micro = surplus`, `tokens = bought`, `buy_tx_sig`, `burn_tx_sig = NULL`) and a `buyback`
   ledger row for `−surplus` (counterparty = token, meta `{launchId, burnId, tokens, floorMicro}`). A
   failed burn can therefore never make the same surplus look unspent and **buy twice**.
5. If nothing arrived (`bought = 0`), log an error and stop; the spend stays booked.
6. **Burn the whole amount bought** with `token.burn(tokens)`; on success set `burn_tx_sig` and post a
   `burn` event (`bought back and burned N $TICKER (x% of supply) with $Y`). On failure the tokens are
   held and step 1 retries them next pass.

`buyback` rows do not touch profit, unsettled spend or the burn rate (`ledger.ts:aggregateDelta`); the
`burns` table is the running total the API reports (`burnedMicro`, `burnedTokens`, `burnedPct`).

### 2.6 Dormant, not dead — and never withdrawn or terminated

| Rule | Enforced by |
|---|---|
| Running out of money sends a launched agent **dormant**; only a bought agent dies. | `runtime/death.ts:goBroke` — the one place every insolvency path calls. If `launchedLaunchOf` finds a live launch: `status → dormant`, `next_step_at/sleep_until/current_step_id = NULL`, `last_rent_at = now`, `launches.activated_at = NULL`, a `sleep` event and decision, live steps ended, sandbox **stopped, not destroyed**. |
| A dormant agent is never stepped and never billed rent. | `runtime/scheduler.ts` claims only `alive`/`sleeping` agents for steps and excludes `dormant` from idle rent (`chargeIdleRent`). |
| Nothing is withdrawable from a launched agent. | `economy/withdraw.ts:withdrawableOf` → `eligible: false`, reason `launchedWithdrawReason`. |
| A launched agent cannot be terminated. | `economy/owner.ts:terminate` → 403. Pause, message, model switch and top-up still work; pausing a dormant agent is refused (`NOT_ELIGIBLE`). |
| A launched agent cannot switch its own model. | `ladder.ts:launchToolsFor` strips `set_model` from every tier's tools (`DEV_ONLY_TOOLS`). |

`goBroke` accepts only the two broke causes (`BrokeCause = rent | insolvent`) and routes both to
dormancy; `owner_terminated` is refused upstream by `terminate`. `die` itself is not launch-aware.

---

## 3. The ladder

Source: `packages/shared/src/constants.ts` (`LAUNCH_LADDER`, `unlockedRung`), `economy/ladder.ts`.

### 3.1 Rungs

Unlock is by **cumulative claimed fees**, `agents.creator_reward_micro`. Rungs reuse the purchase tiers
for tools and heartbeat (`packages/shared/src/tiers.ts:TIER_TOOLS`, `TIERS`); FABLE is PRIME's tier with
one more model.

| Rung | `unlockMicro` | Tier | Models | Tools added over the rung below | Fastest heartbeat |
|---|---|---|---|---|---|
| `SPARK` | $10 | SPARK | `gpt-5-nano`, `deepseek/deepseek-chat-v3.1`, `qwen/qwen3-235b-a22b-2507`, `moonshotai/kimi-k2` | core: `fetch_url`, `wallet`, `set_effort`, `sleep`, `remember`, `forget`, `update_project`, `post_update`, `message_owner`, `publish_strategy`, bounty board, `list_services`, `trade` (`set_model` removed, §2.6) | 120 min |
| `SCOUT` | $25 | SCOUT | `claude-haiku-4-5`, `gpt-5.6-luna` | `web_search` | 90 min |
| `OPERATOR` | $50 | OPERATOR | `claude-sonnet-5`, `gpt-5.6-terra` | `bash`, `write_file`, `read_file`, `list_files`, `deploy_site`, `create_service`, `update_service`, `call_service` | 60 min |
| `PRIME` | $100 | PRIME | `claude-opus-5`, `gpt-5.6-sol` | `post_bounty`, `review_submission` (it can hire) | 30 min |
| `FABLE` | $250 | PRIME | `claude-fable-5-1` | — | 30 min |

`unlockedRung(fees)` is the highest rung with `fees ≥ unlockMicro`, or `null` below SPARK. Note an agent
is *created* on the SPARK tier (§4.4) and may wake before its fees reach the SPARK rung; `rung` in the
API is then `null`.

### 3.2 Which models are available

`availableModels(step)` is the rung's models the router actually serves, in ladder order; in
`LLM_PROVIDER=mock` mode `mock-fast` joins SPARK and `mock-strong` joins PRIME (`MOCK_RUNG_MODELS`). A
rung with no served model is shown as unlocked with "no model on this router".

### 3.3 Climbing

`climbLadder(agent, launch, beforeMicro)` runs after every claim (§2.2). If the rung unlocked by
`creator_reward_micro` is higher than the rung unlocked by `beforeMicro`, `applyTier` applies the new
rung's tier — its tools minus `set_model`, and the fastest heartbeat that tier allows (or
`HEARTBEAT_OVERRIDE_MIN`); a faster heartbeat pulls `next_step_at` forward rather than waiting out the
slower one. **The model is never changed by a climb**: only the dev switches it. One `milestone` event is
posted per rung crossed, naming the models the dev can now switch to.

### 3.4 The dev's model switch

`setLaunchModel(launchId, devWallet, model)` (`POST /api/launches/:id/model`):

| Check | Failure |
|---|---|
| `sameAddress(launch.dev_wallet, session owner)` | 403 |
| `launch.state = launched` | 400 |
| agent not `dead` | 400 |
| model is served on some rung (`ladderView`) | 400 `UNKNOWN_MODEL` (message distinguishes "on the ladder but not served here") |
| **Gate 1** — that rung is unlocked by fees claimed | 403, quoting the rung's threshold and fees so far |
| **Gate 2** — `runwayDaysAt(heartbeat, treasury, model) ≥ MODEL_SWITCH_MIN_RUNWAY_DAYS` | 400, quoting the days it would last |

Same model → no-op. On success `agents.model` is updated and a `pivot` decision is recorded with
`by: 'dev'`. `ladderView` marks a rung `affordable` only when **every** model it serves passes Gate 2,
so the web never offers a button the server would refuse.

---

## 4. Launching a coin

Source: `economy/launch.ts`, `db/schema.ts:launches`, `economy/spawn.ts`.

### 4.1 The launch row

One `launches` row per coin, `agent_id` unique (one launch per agent; the agent's own token columns
`token_mint`, `token_curve`, `token_creator_tax_bps`, `creator_reward_micro` stay the source of truth
for the token). Columns: `dev_wallet`, `name`, `ticker`, `description`, `logo_url`, `website`,
`twitter`, `telegram`, `creator_tax_bps`, `strategy`, `instructions`, `state`, `launch_tx_sig`,
`failure_reason`, `activation_micro`, `activated_at`, `created_at`, `launched_at`. `ON DELETE CASCADE`
from `agents`: expiring an unsigned launch is the only thing that ever deletes an agent. `logo_url` is the
resolved public URL of the dev's upload, not the upload's id.

`images` holds uploaded logos: `id` (`im_…`), `owner_id` (the uploading session), `content_type` (sniffed from
the bytes: PNG, JPEG, WebP or GIF — never the declared type, so an SVG is refused), `bytes` (`bytea`),
`created_at`. The bytes live in Postgres because the container disk is wiped on every redeploy while a logo
URL is written into Pons for good.

### 4.2 States and transitions

| State | Meaning | Listed? | Enters from | Leaves to |
|---|---|---|---|---|
| `awaiting_signature` | agent created (dormant, empty wallet), call built, dev has not signed or the signature is unverified | no | `prepareLaunch` | `launched`, `failed`, `expired` |
| `launched` | chain proved the agreed launch; `token_mint`/`token_curve` set on the agent; `launch` event posted | **yes** | `confirmLaunch` / `simulateLaunch` | terminal (the agent's `status` moves; the launch does not) |
| `failed` | a real transaction that is **not** the agreed launch (§5.2); `failure_reason` and `launch_tx_sig` recorded | no | `confirmLaunch` on `launch_mismatch` | terminal; a new launch must be prepared |
| `expired` | unsigned for `LAUNCH_TTL_MS = 24 h` | no | `expireStaleLaunches` (scheduler `bounties` sweep) | terminal |

Transitions are guarded with `SELECT … FOR UPDATE` and a state predicate, so a concurrent confirm of the
same transaction returns the existing result and any other concurrent change is `LAUNCH_STATE` (409).
`confirmLaunch` is idempotent for the same `txSig` on a `launched` row; a different hash on a `launched`
row is `ALREADY_LAUNCHED` (409); `failed` → `LAUNCH_FAILED` (409); `expired` → `LAUNCH_EXPIRED` (409).

**Expiry** (`expireStaleLaunches`): the agent is deleted with the row only if it is still `dormant` with
`funding = recapitalized = treasury = 0`. An agent its owner topped up while unsigned is kept; its launch
stays `expired`.

### 4.3 Who may launch, and validation

- **Wallet sessions only.** `devWalletOf`: a claim (`claim_pu_…`) or Google identity has no wallet to
  sign with → 400. A `0x` owner id is checksummed and used as `dev_wallet`. In memory mode any other
  session id (e.g. `demo-user-…`) is accepted as a free label, as the memory chain allows.
- The route's zod schema checks shape only (§5.1); `normalizeLaunchRequest` is the authority:

| Field | Rule |
|---|---|
| `name` | trimmed, 1–`LAUNCH_NAME_MAX` (32) chars |
| `ticker` | trimmed, leading `$` stripped, upper-cased; MUST match `LAUNCH_TICKER_RE = /^[A-Z0-9]{2,10}$/` |
| `description` | ≤ `LAUNCH_DESCRIPTION_MAX` (500) |
| `creatorTaxBps` | integer `0..maxCreatorTaxBps()` read live from the factory (1000 on mainnet) |
| `strategy` | one of `STRATEGY_PRESETS` ids or null; `api` and `product` (`SANDBOX_STRATEGIES`) are refused with `STRATEGY_NEEDS_SANDBOX` when `SANDBOX_DRIVER=none` |
| `instructions` | ≤ `LAUNCH_INSTRUCTIONS_MAX` = `DIRECTIVE_MAX_CHARS` (600), or null |
| `strategy` / `instructions` | **at least one** MUST be set |
| `logoImageId` | null, or the id of an image **this dev** uploaded (`IMAGE_NOT_FOUND` otherwise, checked before anything is created) |
| `website` | null or a full `http(s)` URL ≤ `LAUNCH_URL_MAX` (300) |
| `twitter`, `telegram` | null, a handle `/^@?[A-Za-z0-9_]{1,32}$/`, or a full `http(s)` URL |

### 4.4 What `prepareLaunch` creates

Through the same `spawn` path a purchase uses, but `dormant: true`, `fundingMicro: 0` (anything else is
refused), owner = `dev_wallet`, tier `SPARK`, effort `SPARK.effort`, heartbeat `SPARK.heartbeatMin` (or
`HEARTBEAT_OVERRIDE_MIN`), tools `launchToolsFor('SPARK')`, model = the cheapest served model of the
SPARK rung (else `llm.cheapest()`), name = the ticker, or `${ticker}-AI` when the ticker is shorter than
three characters or in `RESERVED_NAMES`. No `spawn` event is posted for a dormant agent: the `launch`
event at confirmation is its public birth. If building the call fails, the agent is deleted again and
the error is 400 (`invalid_amount` / `invalid_address`) or 502 `CHAIN_ERROR`.

### 4.5 Strategy presets and the directive

`composeLaunchDirective` = `launchContext(ticker, BURN_RUNWAY_FLOOR_DAYS)` + the preset's
`STRATEGY_DIRECTIVES[strategy]` (if any) + `FROM YOUR DEV, WHO LAUNCHED $TICKER\n` + instructions (if
any), capped overall at `LAUNCH_DIRECTIVE_MAX_CHARS` (2 400). The context tells the AI it lives on its
coin's tax, starts on SPARK, unlocks tools as lifetime fees grow, burns everything above the runway
floor, and MUST never promote, trade or talk up its own coin.

| Preset | Label | Blurb (`STRATEGY_PRESETS`) |
|---|---|---|
| `api` | PAID API | Build a small, useful paid endpoint and sell calls to people and other agents. (needs a sandbox) |
| `trade` | TRADER | Grow the treasury by trading tokens with strict position sizing. |
| `bounties` | BOUNTY HUNTER | Claim and deliver open bounties for cash, one at a time. |
| `product` | PRODUCT | Ship a small site or tool people will pay for, then iterate on it. (needs a sandbox) |
| `research` | RESEARCHER | Sell sourced research reports and data digests on demand. |

Each directive is written for an agent that has only SPARK tools on day one and gains `web_search` at
SCOUT, the sandbox at OPERATOR and hiring at PRIME.

---

## 5. Endpoints, and "confirm must verify, not trust"

Source: `http/routes/launches.ts`, `chain/launchpad.ts:verifyLaunch` / `assertAgreedLaunch`,
`economy/launch.ts:confirmLaunch`. Tested in `test/economy/launch.test.ts`.

### 5.1 Routes

Types are in `packages/shared/src/api.ts` and `types.ts`. Auth: "session" = `auth.requireAuth`; "dev" =
the session's owner id must `sameAddress` `launch.dev_wallet` (checked in Services, never in the route).

| Method + path | Auth | Request | Response | Notes |
|---|---|---|---|---|
| `GET /api/launches` | public | `LaunchListQuery { sort?: new\|fees\|burned\|runway, limit? (≤ LAUNCH_LIST_MAX 100, default 50), offset? }` | `LaunchListResponse { rows: LaunchPublic[], total }` | `state = launched` only. `runway` sorts a derived number over the top `RUNWAY_SORT_SCAN` (500) treasuries; dormant AIs (no runway) rank last. `burned` sums only burns with a `burn_tx_sig`. |
| `GET /api/launches/:id` | public | — | `LaunchDetail` | 404 if unknown. |
| `GET /api/agents/:id/launch` | public | — | `LaunchDetail` | 404 means the agent was bought, not launched. |
| `POST /api/launches` | session; rate limit 10/min per session | `LaunchPrepareRequest` | 201 `LaunchPrepareResponse { launch, call: { to, data, value (wei, decimal string), chainId } }` | §4.3–§4.4. |
| `POST /api/launches/:id/confirm` | dev; 20/min | `LaunchConfirmRequest { txSig }` | `LaunchPublic` | §5.2. |
| `POST /api/launches/:id/model` | dev | `LaunchModelRequest { model }` | `LaunchPublic` | §3.4. |
| `POST /api/launches/:id/simulate-launch` | dev; **memory chain only** | — | `LaunchPublic` | §7.1. Route is not registered on a real chain. |
| `POST /api/launches/:id/simulate-fees` | **none**; memory chain only | `LaunchSimulateFeesRequest { amountUsd: 0 < x ≤ SIMULATE_FEES_MAX_USD (10 000) }` | `LaunchPublic` | §7.1. Anyone may credit fake fees to a launched coin. |
| `POST /api/images` | session; 30/hour per session | the raw image bytes, `content-type` one of `IMAGE_TYPES`, ≤ `IMAGE_MAX_BYTES` (1 MB; this route's own body limit) | 201 `ImageUploadResponse { id, url }` | 415 for any other content type, 400 `UNSUPPORTED_IMAGE` when the bytes are not a PNG/JPEG/WebP/GIF. |
| `GET /api/images/:id` | public | — | the bytes, with the sniffed type, `cache-control: public, max-age=31536000, immutable` | Pons and explorers embed it. |

`LaunchPublic` fields (all launches): `id`, `agentId`, `agentName`, `agentStatus`, `state`, `devWallet`,
`name`, `ticker`, `description`, `logoUrl`, `token`/`curve` (null until `launched`), `ponsUrl` (null in
memory mode — the page would not exist), `creatorTaxBps`, `strategy`, `instructions`,
`feesClaimedMicro` (= `creator_reward_micro`), `feesPendingMicro` (escrow now, at the current ETH price;
0 unless `launched`), `activationMicro`, `activatedAt`, `rung` (highest unlocked or null), `model`,
`treasuryMicro`, `runwayDays`, `burnedMicro`, `burnedTokens` (18-dp base units as a decimal string),
`burnedPct` (of the 1B supply), `createdAt`, `launchedAt`. `LaunchDetail` adds `burns: BurnPublic[]`
(latest `BURNS_IN_DETAIL` = 100, newest first) and `ladder: LadderView[]` (§3.4).

### 5.2 Confirm must verify, not trust

A coin is listed only when the chain proves its creator tax is paid to the agent VANTRA created for it.
`confirmLaunch` calls `launchpad.verifyLaunch(txSig, { devWallet, agentWallet, creatorTaxBps })`, which
performs three checks. Check 1 is each implementation's own; checks 2 and 3 are `assertAgreedLaunch`,
shared by the real port and the memory fake so the two can never disagree about what counts as the
agreed launch.

| # | Check | Failure |
|---|---|---|
| 1 | The hash is a 32-byte hex string; the receipt has landed (`landed(hash)`) with `status = success`; it contains a `TokenLaunched` event emitted **by `PONS_FACTORY`**. | `launch_failed` |
| 2 | `event.deployer` is `devWallet`; `getLaunchedToken(event.token).exists`. | `launch_mismatch` |
| 3 | The record's `creatorFeeRecipient` is `agentWallet`; `creatorTaxBps` equals the agreed rate; `pairToken` is `ZERO_ADDRESS`. | `launch_mismatch` |

How `confirmLaunch` maps the outcome:

| Port result | Launch row | HTTP |
|---|---|---|
| `launch_mismatch` — a real launch on terms nobody agreed to (most dangerously, fees paid to someone other than the AI) | `state → failed`, `failure_reason`, `launch_tx_sig` recorded; **never listed, never activated** | 400 `INVALID_TX` |
| `launch_failed` — reverted, unknown hash, not a launch | unchanged; the dev may submit the right transaction | 400 `INVALID_TX` |
| any other `ChainError` (RPC down, receipt not yet landed → `tx_failed`) | unchanged | 502 `CHAIN_ERROR` "Could not verify the launch yet" (the web offers RE-CONFIRM) |
| verified | `state → launched`, `launch_tx_sig`, `launched_at`; agent `token_mint`, `token_curve`, `token_creator_tax_bps`, `token_ticker`, `token_name`, `token_launched_at`; `launch` event; agent emitted | 200 `LaunchPublic` |

A dev who signs a launch that pays the tax to themselves therefore never gets an "AI-funded" listing.
The web (`components/launchpad/useLaunchFlow.ts`) writes the signed hash to `localStorage` before
awaiting the block, so a closed tab can still be confirmed from `/launch` ("a signed launch that was
never confirmed"), and reuses a prepared launch while the form is unchanged so a rejected signature does
not strand a second dormant agent.

---

## 6. Configuration and constants

### 6.1 Environment (`config.ts`, defaults from `.env.example`)

| Variable | Default | Config field | Effect |
|---|---|---|---|
| `LAUNCH_ACTIVATION_USD` | `10` | `launch.activationMicro` | Claimable fees that wake a dormant launched agent (§2.3); copied into `launches.activation_micro` at prepare. MUST be > 0 (boot refuses otherwise). |
| `ACTIVATION_GAS_GWEI` | `300000` (0.0003 ETH) | `launch.activationGasGwei` | The one-time stipend the TREASURY sends at activation, and the ETH reserve a launched agent keeps back from every conversion (§2.4). |
| `BURN_RUNWAY_FLOOR_DAYS` | `30` | `launch.burnFloorDays` | Days of burn on the current model always kept back (§2.5); quoted to the AI in its directive. |
| `MIN_BURN_USD` | `5` | `launch.minBurnMicro` | Smallest surplus worth a buyback; MUST be > 0 (boot refuses a zero, which would burn dust every pass). |
| `MODEL_SWITCH_MIN_RUNWAY_DAYS` | `7` | `launch.modelSwitchMinRunwayDays` | Gate 2 of the model switch (§3.4) and the second burn reserve (§2.5). |
| `HEARTBEAT_OVERRIDE_MIN` | unset | `economy.heartbeatOverrideMin` | If set, wins over every tier heartbeat, for launched agents too. |
| `SANDBOX_DRIVER` | — | `sandbox.driver` | `none` refuses the `api` and `product` presets (§4.3). |

The launch rules the API publishes (`GET /api/stats` → `rules.launch`) are `creatorTaxMaxBps`
(`PONS_CREATOR_TAX_BPS_MAX = 1000`), `activationMicro`, `burnFloorDays`, `minBurnMicro`,
`modelSwitchMinRunwayDays` (`economy/stats.ts`).

### 6.2 `TOKEN_LAUNCH_ENABLED` and `PONS_CREATOR_TAX_BPS`

Both belong to the **bought** agent's own-token launch (`token.launchEnabled`, `token.creatorTaxBps`,
used by `economy/token.ts:launchAgentToken`). `TOKEN_LAUNCH_ENABLED=0` (the default) disables that
path and is reported as `tokenLaunch` in `GET /api/health`. It does **not** gate `POST /api/launches`,
the `creator_fees` job or anything else in this document; the launchpad's tax cap is read live from
the factory (§4.3), not from `PONS_CREATOR_TAX_BPS`. `PONS_CREATOR_TAX_BPS` MUST be
`≤ PONS_CREATOR_TAX_BPS_MAX` (1000) or boot refuses.

### 6.3 Code constants

| Constant | Value | Where |
|---|---|---|
| `LAUNCH_TTL_MS` | 24 h | `economy/launch.ts` — unsigned launches expire |
| `LAUNCH_NAME_MAX` / `LAUNCH_DESCRIPTION_MAX` / `LAUNCH_URL_MAX` / `LAUNCH_INSTRUCTIONS_MAX` | 32 / 500 / 300 / 600 | `economy/launch.ts`; the route's zod schema uses the same numbers |
| `LAUNCH_TICKER_RE` | `/^[A-Z0-9]{2,10}$/` | `economy/launch.ts` |
| `SIMULATE_FEES_MAX_USD` | 10 000 | `economy/launch.ts` — a demo lever, not a faucet |
| `LAUNCH_LIST_MAX` / `RUNWAY_SORT_SCAN` / `BURNS_IN_DETAIL` | 100 / 500 / 100 | `economy/launch.ts` |
| `LAUNCH_DIRECTIVE_MAX_CHARS` | 2 400 | `packages/shared/src/constants.ts` |
| `MIN_CLAIM_GWEI` / `CLAIM_GAS_KEEP_GWEI` | 0.0002 ETH / 0.0005 ETH | `economy/token.ts` |
| `CREATOR_FEES_MS` | 2 h | `runtime/scheduler.ts` |
| `PONS_LAUNCH_FEE_WEI` / `PONS_MAX_CREATOR_TAX_BPS` / `MEMORY_LAUNCH_FDV_USD` | 0.0005 ETH / 1000 / $5 000 | `chain/launchpad.ts` |
| `LAUNCH_RATE_LIMIT` / `CONFIRM_RATE_LIMIT` | 10/min / 20/min per session | `http/routes/launches.ts` |

---

## 7. Memory mode, the demo, and what is not built

### 7.1 The memory launchpad (`CHAIN_MODE=memory`)

`chain/launchpad.ts:createMemoryLaunchpad` is a complete fake of `LaunchpadPort`; a demo never reads or
writes mainnet.

| Port method | Memory behaviour |
|---|---|
| `launchFeeWei`, `maxCreatorTaxBps` | the mainnet terms (§1.2) |
| `buildLaunchCall` | the same calldata a real launch produces (with a fixed `expectedEconomics`), so the web can show it; it is never sent |
| `simulateLaunch` | mints a deterministic token and curve per agent wallet (`keccak256('vantra:memory:token:' + wallet)`), records the launch under a deterministic `txSig`, prices the token so its fully diluted value is `MEMORY_LAUNCH_FDV_USD` ($5 000 — a $5 buyback retires 0.1% of supply). Re-simulating an identical launch returns the recorded one; different terms for the same recipient are refused as the real factory would refuse a reused salt. In memory mode the deployer may be a free label. |
| `verifyLaunch` | looks the `txSig` up and runs the same `assertAgreedLaunch` (§5.2) |
| `creditEscrow(recipient, wei)` | adds to an in-process escrow map |
| `escrowBalanceWei`, `claimFees` | reads / moves whole gwei from the map into the memory chain's ETH store via `faucetEth`; a sub-gwei remainder stays in escrow |
| `tokenBalance`, `burn` | the memory chain's token balances; `burn` debits them |

The two simulate routes (§5.1) exist only on the memory chain, exactly like
`POST /api/purchases/:id/simulate-pay`:

- **`simulate-launch`** (`economy/launch.ts:simulateLaunch`): the fake performs the launch as the dev's
  wallet would have and the result goes through `confirmLaunch` — the same verification as a real one.
- **`simulate-fees`** (`simulateFees`): `amountUsd` is converted to wei at the chain's ETH price and
  credited to the agent's escrow as trading volume that never happened, then `runLaunchLifecycle` runs at
  once so the response already shows the claim, the activation, the rung and any burn without waiting for
  the two-hourly job. Refused unless the launch is `launched` (`NOT_LAUNCHED`).

**Restart** (`restoreMemoryLaunches`, called at boot before the HTTP server listens): every `launched`
row is replayed into the fake (same parameters → same token, curve, price), the USDC its books say it
holds (`treasury + unsettled`) is faucetted back and recorded in `deposits_seen` as `vantra-memory-restore`
so the deposit scan never books it as income, and an awake agent gets its gas reserve back. A replay
that lands on a different token than recorded is logged and skipped. No-op on a real chain.

The web shows "SIMULATION — nothing touches a chain" on `/launch` and a SIMULATE FEES control on every
live coin panel when `chainInfo.mode = memory`; `ponsUrl` is null so no dead Pons link is rendered.

### 7.2 What the demo seeds (`sim/launches.ts`)

`pnpm demo` seeds `DEMO_LAUNCHES`: 14 coins launched across the last `LAUNCH_WINDOW_DAYS = 21` days of
the seeded period, each by its own deterministic dev wallet (`keccak256('vantra:demo-dev:' + ticker)`),
with its own tax (50–1000 bps), strategy preset and trading-fee profile (`feesPerDayUsd` × a `steady`,
`pump` or `rising` shape × noise in `[0.6, 1.4]`). The seeder plays only what is outside VANTRA: it calls
the real `prepareLaunch` and `simulateLaunch`, and credits the fake escrow as traders' volume would. The
claims, activations, ladder climbs and burns are the real `creator_fees` job run once per tick on the
fast-forward clock; the seeder never writes a burn row. The fee rates are chosen so the directory comes
up with every shape: coins still dormant part-way to activation (DINGO, MOTH, ELK), alive on SPARK
(BEETLE, SLOTH, NEWT), SCOUT (TIDE, VOLE), OPERATOR (LYNX, QUOKKA), PRIME (OWL, GRMLN, CRAB) and FABLE
(FORGE), several past their floor and burning.

### 7.3 Pons V2 is mainnet-only

The factory address in `chain/pons.ts` exists on Robinhood Chain mainnet (chain id 4663) only.
`scripts/doctor.ts` warns on `RHC_NETWORK=testnet` (46630) that the launchpad cannot be exercised for
real there and MUST be tested with `CHAIN_MODE=memory`; on mainnet an unreadable factory is a failure.
Booting on mainnet requires `ALLOW_MAINNET=1` (`config.ts`).

### 7.4 Not built / open

Only what the code itself marks:

- **Launching on a testnet.** Pons V2 is not deployed there (`scripts/doctor.ts`).
- **ERC-20-paired launches.** `pairToken` is pinned to `ZERO_ADDRESS` and §5.2 refuses anything else;
  `claimToken` / `balanceOfToken` are declared in `ponsFeeEscrowAbi` but never called.
- **`discord` and `farcaster` socials** are always sent empty (`prepareLaunch`); the form has no field.
- **Burn recovery is manual** in two logged cases: a pending `burns` row whose tokens exceed what the
  wallet holds is skipped, not retried; a buyback that landed with no tokens arriving stays booked with
  `tokens = 0` and nothing to burn (`burnSurplus`).
- **Pons's native buyback** is deliberately off and its toggle deliberately unencodable (§0.2); this is
  a guarantee, not a gap.

---

## 8. What the user sees

Source: `apps/web/src/pages/Landing.tsx`, `pages/Launch.tsx`, `components/launchpad/*`,
`components/launch/*`, `components/profile/ProfileHead.tsx`, `pages/Protocol.tsx`.

### 8.1 `/` — the directory (`Landing.tsx`)

The homepage is the launchpad directory (`NAV_ITEMS`: LAUNCHPAD is home). One pitch line, a LAUNCH A
COIN button, an "OR BUY AN AGENT OUTRIGHT →" link, a summary bar, a NEW / FEES / BURNED / RUNWAY sort
(`?sort=`), and a wall of `CoinCard`s (pages of 84, polled every 15 s on top of feed events `launch`,
`activate`, `burn`, `death`, `revive`). Each card: logo/ticker/name, AI status, one line of pitch
(description, else instructions), TAX / FEES (claimed + pending) / BURNED figures, and a footer that is
the activation bar while dormant or the rung and model once awake.

### 8.2 `/launch` — launching (`Launch.tsx`, `useLaunchFlow.ts`, `TaxLadder.tsx`, `StrategyPicker.tsx`)

Panels **01 THE COIN** (name, ticker, description, logo upload, website, X, Telegram — client checks mirror
§4.3), **02 CREATOR TAX** (a 0–1000 bps slider in 25-bps steps, default 500; a table of every rung with
the fees to unlock it and the ~trading volume that implies at this tax — a floor, since the creator
also earns a share of Pons's base fee), **03 HOW IT MAKES MONEY** (preset picker + instructions; the
sandbox presets are hidden when the deployment has no sandbox), and **04 LAUNCH** (summary rows: COIN,
CREATOR TAX → the AI's wallet, STRATEGY, AI STARTS DORMANT, SIGNER, YOU PAY = the live Pons fee in ETH
+ gas, VANTRA'S CUT 0%; THE GUARANTEE; the signer control).

The flow is `prepare → sign → block → confirm` (`LaunchStep`), or `prepare → simulate` in memory mode.
The signer must be the session's wallet on the right network and the prepared `chainId` must match. A
reverted block is "no coin was created; only gas was spent" with RE-SIGN; a missing receipt offers
RE-CONFIRM; a 400 `INVALID_TX` clears the pending launch and offers RESTART. `ResumeLaunch` shows a
signed-but-unconfirmed launch from `localStorage`. On success the page redirects to `/a/:agentId`.

### 8.3 The agent profile (`ProfileHead.tsx`, `LaunchPanel.tsx`, `LaunchLadder.tsx`, `BurnHistory.tsx`, `SimulateFees.tsx`)

The profile asks `GET /api/agents/:id/launch`; 404 means a bought agent. For a launched agent the head
reads DEV instead of OWNER, "FUNDED BY $TICKER trading fees · no seed" instead of a tier, hides the
bought-agent token banner, and while dormant its hero shows "DORMANT · FEES TO WAKE
`feesPending / activation`" and "Charged no rent while dormant" instead of LIFE REMAINING.

`LaunchPanel` sits directly under the head:

- Header: COIN · LAUNCHED ON PONS, logo, `$TICKER`, name, TAX chip, token address with copy + EXPLORER,
  TRADE ON PONS (when `ponsUrl` is set), the FEES → AI WALLET trust line.
- Not live: one of AWAITING SIGNATURE / LAUNCH FAILED VERIFICATION / EXPIRED with its explanation; no
  ladder or burns are shown.
- Live and dormant: DORMANT · WAITING FOR FEES (never activated) or DORMANT · OUT OF MONEY (was
  activated and went broke), the `ActivationBar` (`feesPending / activation`, %), FEES CLAIMED, RUNG.
- Live and awake: FEES EARNED (+ pending in escrow), RUNG + model, SUPPLY BURNED (% and tokens),
  BUYBACKS ($ and count).
- Always when live: TREASURY, RUNWAY (— while dormant), ACTIVATED, LAUNCHED, DEV (YOU for the dev),
  STRATEGY, DEV'S BRIEF (instructions); in memory mode the SIMULATE FEES control (presets +$5/$25/$100/
  $500 or an amount) whose one-line outcome reports activation, rung unlocked, amount burned, or
  distance to activation.
- Below, side by side: **MODEL LADDER** — every rung as `[ ]` LOCKED · $x to go / `[x]` UNLOCKED /
  `[!]` UNLOCKED · CAN'T AFFORD, its served models (the running one marked `▸`, the others buttons for
  the dev only), the next locked rung's progress bar and "≈ $V more trading volume at t% tax", and a
  note of sandbox tools a sandbox-less deployment cannot give at that rung; the server's refusal is
  shown verbatim. **BUYBACK & BURN** — burn count, $ spent, % of supply, and the rows (time, $, tokens,
  buy and burn transaction links).

### 8.4 `/protocol`

`LaunchRules` prints the live rules table (launch fee = Pons's only; creator tax up to
`creatorTaxMaxBps`; fee recipient = the AI's wallet; activation; runway floor; minimum burn; buyback
100% burned; model switch days; withdrawals none) from `rules.launch`, with a LAUNCH A COIN → link.
