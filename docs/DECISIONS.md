# Decisions

Implementation choices not spelled out by `SPEC.md` / `SPEC-AMENDMENTS.md`, in the order they were made.
Each entry: what, why, where. Module agents append their own.

## Scaffold (workspace, shared, api foundation)

1. **`@vantra/shared` ships `dist/`, consumers resolve through `exports`.** `prepare` builds it on `pnpm install`,
   and its `typecheck` script emits `dist/` first so `pnpm -r typecheck` (topological) always checks the api against
   fresh types. `apps/api/vitest.config.ts` aliases `@vantra/shared` to the source so tests never see a stale build.
   The web app consumes the same `dist/` (`moduleResolution: bundler`); `pnpm dev` runs shared in `tsc --watch`.
2. **Schema sync: `db:push` for dev, SQL migrations for prod.** `src/db/migrate.ts` wraps drizzle's node-postgres
   migrator over `apps/api/drizzle/` (generated with `db:generate`). The API does not migrate at boot; `assertSchema`
   fails fast with the `pnpm db:push` hint instead. Never mix push and migrate on one database.
3. **`bytea` via `customType`.** drizzle-orm 0.45 has no pg `bytea` helper; `agent_keys.secret_enc/iv/tag` use a
   custom `Buffer` type. `pool.sol_price_usd` is `numeric(14,4)` read in `mode: 'number'`.
4. **Schema additions beyond §7** (all nullable or defaulted, names follow the spec's style):
   `agents.spawn_attempts` (retry job counter for §8.4 step 5), `bounties.rejections` (resubmit-once rule in §8.9),
   `service_calls.payment_tx` UNIQUE (a payment tx can buy exactly one call), `agents.heartbeat_min` exposed as
   `AgentPublic.heartbeatMin` and accepted by spawn (`heartbeatMin?`) because the spawn page and PATCH edit it.
   Child rows reference `agents.id` with `ON DELETE CASCADE` (agents are never deleted in v1; this keeps test teardown trivial).
5. **`GlobalStats.rules`** carries the live protocol constants (`ProtocolRules`) because §9 says the Protocol page's
   rules table is fed from `/api/stats`.
6. **Services beyond §8.1** so `http/` never touches the db for business logic: `retrySeed`, `recapitalize`,
   `refreshHoldings`, `stepTranscript`, `poolTxs`, `graveyard(limit, sort)` (C25); `reviewBounty`, `setHeartbeat`,
   `leaderboard` (routes in §8.15 with no service in §8.1). `getAgent(id, viewerWallet?)` returns `ownerMessages`
   only for the owner (C21). `callService` takes a `ServiceBuyer` union so the `call_service` tool and the two
   HTTP entry points share one implementation.
7. **`ChainAdapter.getUsdcTransfer(sig)`** was added: bounty escrow, recapitalize and paid service calls all verify a
   user-submitted signature, which `listUsdcInflows` alone cannot do. `faucet?` is optional and only present in memory mode.
8. **`LlmRouter` gains `mode` and `refreshPricing()`.** `mode` feeds `GlobalStats.llm.provider`; the OpenRouter boot
   pricing refresh (A5) needs an async hook, which the container awaits in `start()` before the runtime starts.
9. **Tool contract.** `ToolRegistry = { defs, execute, parallelSafe, summarize }`. `summarize` produces the ≤160-char
   secret-free `inputSummary` for the WS `tool` message. `ToolResult` carries optional `event` / `decision` so the step
   loop is the single writer of ledger, event and decision rows for tool side effects; tools write their own domain
   rows (projects, memory, owner_messages, services) directly through `deps.db`.
10. **Dependency container.** `CoreDeps` (config, db, clock, chain, sandbox, search, llm, bus, log) → `tools` →
    `Deps`; `services` and `runtime` are attached to the same object afterwards. Modules read `deps.services` /
    `deps.runtime` lazily at call time. Boot order: `assertSchema` → `llm.refreshPricing` → http listen →
    `runDemo` (DEMO=1 only) → `runtime.start`. `DEMO=1` swaps `systemClock` for a `FastClock` that the demo seeder
    drives (`set`/`advance`) and then `release()`s to wall time.
11. **Hosting is a Fastify plugin.** `src/hosting/index.ts` exports `registerHosting(app, deps)`; `http/server.ts`
    registers it so `/sites/:slug/*` and `/svc/:serviceId` share the API listener, CORS and shutdown.
12. **Config defaults** favour the free path: `CHAIN_MODE=memory`, `LLM_PROVIDER=mock`, `SANDBOX_DRIVER=local`,
    `SEARCH_PROVIDER=none`. `SESSION_SECRET` / `KEY_ENCRYPTION_KEY` fall back to fixed insecure values outside
    production (logged as warnings) and are mandatory in production. `DATA_DIR` resolves against the repo root, not cwd.
    `DEMO=1` requires memory + mock; solana mode requires the three wallet vars; router requires ≥1 provider key.
13. **Rent rate while paused** uses `RENT_SLEEP_PER_HOUR_MICRO` (B13 says paused agents pay the sleep rate).
14. **Money rounding.** `ceilMicro` rounds to the nearest micro before ceiling so IEEE noise (1000 × 0.2) never
    overcharges by one micro; `bpsOf` rounds to nearest.
15. **Logging** is pino with `redact` on secret-shaped keys (`secret`, `privateKey`, env secret names, cookies);
    `describeConfig` is the only config object that may be logged.
16. **Vitest 5 needs Vite ≥ 6**, but the web app pins Vite 5; `apps/api` and `packages/shared` declare their own
    `vite` devDependency so pnpm resolves a compatible peer per package.
17. **Root `package.json`** is now only the workspace root; the previous Vite app's deps (react 18.3, react-dom,
    react-router-dom 6, zustand 5, @vitejs/plugin-react 4, vite 5) live in `apps/web/package.json`.

## LLM router and providers (`src/llm/`)

18. **Per-request timeout.** A6 asks for `timeout: min(remainingStepMs, 300000)`, but `LlmRequest` carries no
    remaining-time field. Both SDK providers send a constant `timeout: 300_000` together with `signal: req.signal`;
    the step's `AbortController` (STEP_TIMEOUT_MS) enforces the shorter bound, so the effective deadline is still
    `min(remaining step time, 5 min)` without widening the request contract.
19. **"Retry 3×" = 3 total attempts** (initial + 2 retries, `LLM_MAX_ATTEMPTS`) with deterministic backoff 500 ms then
    1000 ms and no jitter — one process, and jitter would make the router tests non-reproducible.
20. **`resolve()` throws `ApiError(400, 'UNKNOWN_MODEL')`** rather than a bare `Error`, so `POST /api/agents` with a
    bad model and the `set_model` tool surface a clean 400 instead of a 500.
21. **B17 round 1 is priced at input + cache-write rates.** The amendment sets `inputTokens = ceil(chars/4)` *and*
    `cacheWriteTokens = inputTokens`, so a mock round 1 costs 2.25× input. Real Anthropic usage reports cache-creation
    instead of input tokens; the literal reading was kept because the amendment does not say to zero `inputTokens`.
22. **Mock thinking simulation is capped at `floor(maxTokens/2)`.** Uncapped, an `effort: 'max'` agent (2500 simulated
    thinking tokens) would report `max_tokens` on every 1024-token closing completion and every 600-token last-words
    completion, corrupting exactly the step-loop paths those completions exist to serve.
23. **Mock STATUS reading is tolerant.** It scans user-turn *text* blocks newest-first (tool results excluded) and
    takes the first JSON object matching ≥ 2 STATUS marker keys, looking each field up under several plausible names
    (breadth-first, depth 3; money accepted as micro, USD or `"$1,234.50"`). An unreadable STATUS degrades to a blank
    snapshot rather than throwing, so a context change can never break the demo.
24. **The mock plan is world-state driven, not step-counter driven.** Archetype beats branch on
    `siteUrl`/`liveProjects`/`services`/`runwayDays`/`memoryNotes`/`ownerMessages`; ids needed by later beats
    (`bt_`/`sv_`/`pj_`, urls) are harvested from earlier rounds' tool results, which is how a real model gets them too.
25. **`models()` returns live catalog references** (not copies) so an OpenRouter pricing refresh propagates to every holder.

## Chain (`src/chain/`)

26. **`ProtocolWallets` is exposed by the adapter** (`WalletAwareChain.wallets`, field `protocolFee`), so nothing
    re-derives wallets from env; `economy/wallets.ts:wallets(deps)` prefers the adapter's set over the config-derived one.
27. **`chain/index.ts` exports no pool factory.** `economy/pool.ts` owns the single cached `PoolService` per db — two
    instances would each cache their own `pool` row and double-book.
28. **§8.12 fee detection.** USDC inflows are always signature-based (`listUsdcInflows` + `pool_txs` dedupe by sig), but
    an unexplained *SOL* increase is only booked as `fee_in` once the row has been synced before; on the first sync the
    wallet's SOL is adopted as a baseline, otherwise the memory chain's genesis 10 SOL would look like $1 500 of
    phantom creator fees on every boot.
29. **`paySeed` is idempotent** per §8.4's retry job: it skips the seed and/or the gas transfer when the agent already
    holds them, returns null sigs for the skipped half, and books only what it actually sent.
30. **`parse.ts` reports `from` as the owner of the source token account**, falling back to the signing authority, which
    is correct when a delegate signs.
31. **`listUsdcInflows` returns the OLDEST `limit` inflows, newest-first inside that page**, in both adapters, so a
    caller that advances its cursor to the newest returned sig can never skip a deposit. An unknown or pruned cursor
    replays from the start rather than silently returning nothing.
32. **`PoolStore.load(walletPubkey, ethPriceUsd)` resets balances** when the operator repoints the pool wallet, and the
    row's `paused` flag is recomputed as "USDC < one seed" on every write.
33. **Solana mode is compile-verified only.** There are no devnet keys or RPC budget here, so `solana.ts` is covered by
    typecheck plus unit tests of its pure helpers (ATA derivation vectors, parsed-transaction fixtures, price source).
    Smoke-test `transferUsdc` / `ensureAta` / `listUsdcInflows` against a funded devnet keypair before any devnet run.
34. **Memory-chain keypairs are derived from `DEMO_SEED` when `DEMO=1`.** Agent wallet pubkeys appear in the STATUS
    block, which seeds the mock provider's per-step plan, so random keypairs would make a "deterministic" colony drift.
    Simulated money only — this never touches a real key path (`CHAIN_MODE=solana` always uses `Keypair.generate()`).

## Sandbox, hosting and search (`src/sandbox/`, `src/hosting/`, `src/search/`)

35. **`POST /svc` runs hosting's own `ServiceRunner`** (payment verify → sandbox exec → `service_calls` row → seller
    compute ledger). `economy/market.ts:callService` delegates to the same runner rather than reimplementing it, so
    there is exactly one service-call implementation behind the tool, the market route and the public endpoint.
36. **`deploySite` requires `index.html` at the site root** and silently drops dotfiles/dot-dirs (`.git`, `.env`) before
    validating extensions. The spec only names the extension allow-list and the 20 MB cap; the extra rule gives the
    agent an actionable error instead of a site whose root 404s.
37. **Site CSP** is the spec string plus `style-src 'self' 'unsafe-inline'`, `font-src 'self' data:` and
    `frame-ancestors 'none'` — `default-src 'self'` alone would break every inline-styled agent site.
38. **Docker `timedOut` heuristic** is `hostKilled || ((exit 137|124) && elapsed + 50ms >= timeoutMs)`, so sub-second
    timeouts are not misreported while a genuine OOM kill far from the deadline still reports `timedOut: false`.
39. **`services.calls` / `services.revenue_micro` increment for error and timeout outcomes on prepaid (`user`) calls:**
    the buyer's payment is already on chain and v1 has no refunds. Agent-to-agent calls are the opposite — see 44.
40. **Search provider `none`** rejects every query with `SearchDisabledError`, so `web_search` returns an `is_error`
    result at no cost instead of pretending to search.

## Integration (composition root, demo colony)

41. **`core/ports.ts` is the composition-root adapter layer.** The tool registry is built before `economy/` and
    `hosting/`, so `toolPorts(deps)` supplies its four ports there: `payments` and `escrow` from `economy/ports.ts`,
    `deploy` and the internal service invoker from `hosting/`. The invoker looks the service up, runs the handler
    through hosting's `createServiceInvoker` and writes the `service_calls` row the `call_service` tool needs an id for.
42. **The seller-compute ledger hook is wired twice, explicitly.** `toolPorts` passes `hostingLedgerHook(deps)` into
    the invoker, and the container also assigns `deps.hostingLedger` for `registerHosting`, which resolves it lazily at
    post time (hosting is registered before `economy/` exists as a Fastify plugin). Neither path can silently no-op.
43. **The seed is booked once.** §8.4 posts a `seed` ledger row at spawn and §8.7 would classify the same pool→agent
    transfer as a `refund` on the first deposit scan. `payAndActivate` now records the seed signature in
    `deposits_seen` and advances `agents.last_deposit_sig` inside the same transaction, so the scan skips it.
44. **A failed agent-to-agent service call is recorded at price 0.** `call_service` pays the seller only after a
    successful run, so booking the row at full price would overstate `services.revenue_micro`. The call still counts.
45. **Settlement re-reads the wallet after it moves USDC.** The balance read at the top of `settleAgent` is stale once
    the sweep or a royalty transfer has run, and reconcile compares it against the post-transfer books — which used to
    report a "drift" exactly equal to every swept amount.
46. **Reconcile only warns on a shortfall.** A surplus is normally USDC that landed since the agent's last heartbeat and
    is booked by the next `scanDeposits`; it is logged at debug. Money missing from the wallet is still a warning.
47. **Spend an agent died owing with an empty wallet is written off once** (a `settlement` row of amount 0 with
    `meta.uncollectible`), instead of the hourly job re-reading an empty wallet forever.
48. **`update_project` without a `projectId` updates the project of the same name.** Models forget ids between
    heartbeats and would otherwise re-create the same project every step until the 20-project cap.
49. **Revenue is attributed to a project.** Nothing on chain says which project a payment was for, so a deposit
    classified as revenue credits the agent's most recently updated *live* project (else its newest project). Without
    this, `Project.revenueMicro` (§4) is always 0, the `operating` phase (C20) is unreachable and the STRATEGIES
    WORKING panel always reads "0 earning".
50. **`SpawnInput.agentId` is an optional, sim-only field.** The mock provider derives an agent's archetype and
    competence from a hash of its id, so §8.18's "the same colony boots every time" needs seeded ids. The HTTP route
    builds its `SpawnInput` from a zod object that strips unknown keys, so no client can set it.
51. **Demo pacing: 12 virtual hours per tick.** Each tick advances the `FastClock`, spawns whoever is due, runs one
    pass of outside demand, steps every agent the scheduler would have claimed (`dueCondition`, birth order, sequential
    so the replay is stable), reviews VANTRA's bounties, expires bounties, settles and syncs the pool. 36 agents × 45
    days ≈ 1 400 real steps in ~70 s.
52. **Protocol bounties are reviewed by the simulator.** `posterType: 'protocol'` has no human reviewer in v1
    (`POST /api/market/bounties/:id/review` is poster-only), so `sim/market.ts` plays the operator: it escrows each
    reward from a simulated protocol treasury, approves ~75 % of submissions and rejects the rest with feedback. Their
    payouts classify as `revenue_internal` — protocol money is never external revenue.
53. **Outside demand is quadratic in competence.** `p = min(0.35, 0.30 × competence² × min(3, shipped))` per tick with a
    $0.15–$2.10 payment, against a burn of roughly $0.60 per agent-day. The long tail of mediocre agents cannot cover
    rent and dies, which is the point of the observatory; a seeded colony lands near 28 alive / 9 dead on ~1 500 steps
    and ~$160 of external revenue. `DEMO_SEED` fixes the cast, not the wall clock the window is anchored to, so the
    counts move by an agent or two between runs.
54. **Handover to real time gives each survivor a first step inside its own heartbeat window.** Every fast-forward
    `next_step_at` is in the past when the clock is released, so the whole colony would step at once and then go silent
    for a quarter of an hour. `handOverToRealTime` sets `next_step_at = now + ((i+1)/n) × heartbeat_min` in birth order
    (sleepers get a matching `sleep_until`), which puts the colony at its steady-state cadence — Σ 1/heartbeat, about one
    step a minute for 28 agents on 15–60 minute heartbeats — from the first minute, and keeps it there. Shortening the
    heartbeats instead would have multiplied every agent's inference burn and killed the colony.
55. **`runDemo` refuses to seed a database that already has agents.** It logs how to reseed (drop the database) and
    releases the clock, so restarting `pnpm demo` continues the colony instead of doubling it.
56. **`pnpm pool:swap` is a read-only quote.** §8.12 asks for a skeleton that "refuses on devnet". It reads the pool
    wallet's SOL, keeps 0.05 SOL back for gas stipends, quotes the rest through Jupiter and prints the route, the USDC
    it would return and how many seeds that buys — then stops. It never builds, signs or submits a transaction, so the
    operator's keys are never used by a script that has no way to check the price it is accepting.
57. **`chain/verify.ts:verifyUsdcTransfer` is the only verifier of a user-submitted signature.** Bounty escrow
    (`economy/market.ts`), owner recapitalization (`economy/owner.ts`) and prepaid service calls (`hosting/service.ts`)
    each had their own recipient/sender/amount checks with their own wording; they now share one, so every rejection is
    an `ApiError(400, 'INVALID_TX')` that names what was credited and what was expected. Single use of a signature stays
    with the caller — `bounties.escrow_tx`, `deposits_seen.sig` and the unique `service_calls.payment_tx` are what make a
    replay impossible, and no shared helper can enforce that.
58. **An expired bounty's refund claims its own signature in `deposits_seen`.** `expireOne` transfers the reward from
    escrow back to an agent poster *and* posts the `refund` ledger row, so the poster's next deposit scan found the same
    inflow on chain and booked it a second time (§8.7 classifies escrow inflows as refunds) — the books then sat one
    refund above the wallet forever and reconcile warned on every settlement. It now inserts the signature in the same
    transaction, the way spawn does for the seed (43) and settlement does for a fork royalty. Bounty *payouts* were
    always correct: they post no ledger row and let the claimer's scan classify the inflow.
59. **`CLIENT_HEADER` lives in `@vantra/shared`.** The CSRF guard (`x-vantra-client: web` on every mutating `/api` call)
    was a server-side constant the web client never sent, so every POST and PATCH from the UI — sign-in included —
    answered 403. Both sides now import the same constant, which is what makes the contract checkable by the compiler
    instead of by hand.
60. **External revenue is default-deny.** SPEC §8.7 books any unknown sender as `revenue_external`, which made the
    protocol's headline metric — and the seed-payback milestone, the fork royalty and the withdrawal gate that hang off
    it — mintable with a second keypair. `classify` now promotes an inflow only on positive evidence: the payer is on
    `EXTERNAL_PAYER_WALLETS`, or the signature is the `payment_tx` of an `ok` `service_calls` row this agent served for
    a `user` buyer who does not own an agent, or the escrow payout is for a bounty a non-owner user posted. Everything
    else books as the new `revenue_pending` kind (`agents.revenue_pending_micro`): real money, spendable, counted in
    `profitMicro`, counted nowhere that claims the business works. A buyer who pays just before a heartbeat would
    otherwise be stranded, so each scan re-checks recent pending rows and promotes the ones whose service call has since
    landed (`promotePendingToExternal`, the only writer allowed to move money between those two aggregates).
61. **`DEMO=1` allow-lists the demo colony's customers.** They are the entire outside world in memory mode, so without
    it the observatory would show a colony that never earns. The list is single-sourced as `DEMO_CUSTOMER_WALLETS` in
    `config.ts` and consumed by `sim/revenue.ts`.
62. **A paid-up-front buyer is refunded when the handler fails.** `call_service` never charges an agent for a failed
    run (`core/ports.ts` records price 0); the HTTP buyer had already moved USDC on chain, and `hosting/service.ts` kept
    it. The runner now sends it back through `hostingRefund`, records the call at price 0 so `services.revenue_micro`
    stays honest, and posts the outflow as `payment` (the buyer's inbound transfer is booked by the deposit scan, so the
    two net to zero). The refund is best-effort and loudly logged: the buyer already has the error response, and a chain
    failure must not turn into a 500 that hides both.
63. **A service payment must be fresh, exact and the caller's own.** `>= price` turned every larger historical inbound
    transfer to an agent wallet — the $10 seed included — into a coupon, since `service_calls.payment_tx` only stops the
    *second* use of a signature. The runner now requires the exact price, a transfer no older than `PAYMENT_MAX_AGE_MS`
    (15 min), and, when the caller is signed in, a `from` equal to their wallet. The anonymous `/svc` path can still only
    prove the destination; a seller-issued nonce (or x402) is the remaining gap and is a product decision, not a fix.
64. **Hosted agent sites get an opaque origin.** They are written by competing autonomous agents and are served by the
    same listener as the API, so `script-src 'self'` let any of them run JavaScript *as the app* against a signed-in
    visitor's cookie. `SITE_CSP` now carries `sandbox allow-scripts allow-popups allow-downloads` (no
    `allow-same-origin`), `img-src`/`connect-src` are pinned to the site's own files, and the CSRF guard rejects a
    mutating `/api` call whose referer is under `/sites/`. Production should still give sites their own hostname.
65. **Agents run on their own Docker bridge, and production must confirm the egress rules.** Docker can express a
    dedicated network with inter-container communication off and the metadata hostnames blackholed; it cannot express
    "drop RFC1918", which is what `fetch_url` enforces and `bash` did not. `sandbox/egress.ts` owns both halves — the
    container options and the exact iptables rules — and `SANDBOX_EGRESS_FILTERED=1` is required in production, the same
    shape as the existing refusal to run `SANDBOX_DRIVER=local` there.
66. **Owner-private text is marked where it is written.** The owner's messages reach the model inside STATUS and are
    persisted in `steps.transcript`, which has a public endpoint. `buildContext` wraps each one in `<owner-private>`, and
    both the producer (`economy/steps.ts`) and the last line of defence (`http/sanitize.ts`) strip those sections — plus
    the `message_owner` tool input — for everyone but the owner. `message_owner`'s WS summary became a length, not a
    quote (C21: never broadcast).
67. **Contract additions.** `NAME_RE` now forbids leading, trailing and doubled dashes so `slugify` (a plain lowercase)
    is injective and two legal names cannot collide on the UNIQUE `deploy_slug`. `ChainPublic` publishes `escrowWallet`
    and `protocolFeeWallet` (pubkeys only) so the Market page can build the escrow transfer §8.15 demands; `Service`
    publishes `agentWallet` for the same reason. `GraveyardEntry extends AgentPublic` carries `postmortem` so D37's
    `.g-cause` does not need one detail fetch per card. `LlmRequest.remainingMs` makes A6's
    `timeout: min(remainingStepMs, 300000)` computable and lets the router skip a retry the step has no time for.
    `bounties.escrow_tx` and `agents(owner_wallet) where status <> 'dead'` are UNIQUE: the application checks they back
    up were read-then-insert races worth a bounty payout and a $10 seed respectively.

## Robinhood Chain and the launchpad (`src/chain/`, `src/economy/token.ts`, `src/economy/launch.ts`)

68. **The chain is Robinhood Chain, ported method for method from Solana.** `chain/evm.ts` is viem against an
    Arbitrum Orbit L2 — mainnet 4663, testnet 46630 (`core/preflight.ts:CHAIN_IDS`, the single table both the boot
    probe and the viem chain definitions read) — with ETH as gas and a 6-decimal ERC-20 as settlement:
    `config.ts:USDC_ADDRESSES` names bridged USDC and USDG, `USDC_ADDRESS` overrides, and testnet must name one because
    no canonical test stablecoin exists. Three things did not port one-for-one and are handled where they bite: there
    are no associated token accounts, so nothing is created before a wallet can be paid; there is no fee payer, so the
    treasury pre-funds a deposit address's gas (`ensureGas`) instead of co-signing its sweep, and an agent is spawned
    with an `ETH_GAS_STIPEND_GWEI` (0.005 ETH) stipend; and sends from one address are nonce-ordered, so every one is
    serialised through `chain/mutex.ts` under a pinned nonce, which is also what makes a broadcast retry byte-identical
    and therefore safe. A plain ERC-20 has no multi-transfer, so `sweepUsdc` sends its legs sequentially and, on a
    failure, names the hashes already sent rather than hiding a partial sweep. `ACCEPT_ETH_DEPOSITS` values ETH at a
    deposit address at the live price with `ETH_PRICE_USD` as the fallback (`.env.example`).
69. **Pons V2 has exactly one declaration.** `chain/pons.ts` holds the factory, escrow, router, hook, locker and pool
    manager addresses and every ABI fragment, transcribed from the verified sources and confirmed against mainnet by
    `eth_call` — `launchFee()` 0.0005 ETH, `maxCreatorTaxBps()` 1000, `launchEnabled()` true, `launchConfigCount()` 1
    (so `PONS_LAUNCH_CONFIG_ID` 0 is the only id the factory accepts) — and the `TokenLaunched` topic checked against a
    real launch receipt. `economy/token.ts` launches and claims through it and `chain/evm.ts` trades ungraduated tokens
    on their curve through it; there is no second copy anywhere, so the surface the doctor probes (`chain.pons`) is the
    surface the app calls.
70. **The fee recipient is locked by omission.** `transferCreatorFeeRecipient` and `setBuybackEnabled` are deliberately
    absent from `ponsFactoryAbi`. A launched coin's creator tax is wired to the agent's wallet, only that wallet could
    ever redirect it, and VANTRA holds that wallet's key — so the guarantee to a coin's holders is that this codebase
    cannot make the call at all: no fragment, no selector, no encoder. `chain/pons.ts` says never to declare either
    function anywhere, and `economy/launch.ts` restates it: nothing here, or anywhere, can move a coin's fee recipient
    away from the AI.
71. **Burn, not Pons's native buyback.** Pons's buyback LOCKS the tokens it buys in a five-year vest, so it is left
    off at launch (`buybackEnabled: false` in the call) and never enabled. Instead `economy/token.ts:burnSurplus` buys
    the coin on its curve with the surplus and calls the token's `burn()` (`ponsTokenAbi`; every Pons token is
    `ERC20Burnable` with a fixed 1,000,000,000 × 1e18 supply), which reduces `totalSupply`. The spend is booked — ledger
    `buyback` debit and `burns` row in one transaction — the moment the buy lands and before the burn is attempted, so
    a failed burn can never make the same surplus look unspent and buy twice; a pending burn is retried first on the
    next pass and, while one is outstanding, nothing new is bought.
72. **A launched agent goes dormant, never dies.** Running out of money is death only for a bought agent.
    `runtime/death.ts:goBroke` is the one place that decides which: for an agent with a `launched` launch row it stops
    (does not destroy) the sandbox, sets `status = 'dormant'` and lets the next creator-fee claim wake it. A dead agent
    would strand its coin's fees in an escrow only its own wallet can claim from, and its coin keeps earning
    regardless. Dormancy is free — `chargeIdleRent` skips dormant agents and the scheduler never claims them — so a
    waiting coin cannot run out of money while it waits. The same `launchedLaunchOf` query refuses owner termination
    (`economy/owner.ts`) and every withdrawal (`economy/withdraw.ts`): a launchpad AI's surplus is burned, not paid out.
73. **The burn floor is the largest of three reserves.** `economy/token.ts:burnPlan` keeps the maximum of
    `BURN_RUNWAY_FLOOR_DAYS` of burn on the current model, `MODEL_SWITCH_MIN_RUNWAY_DAYS` of burn on the most expensive
    unlocked model, and the activation threshold; surplus is what is left above that after unsettled protocol spend.
    The second term is not redundant with the first and is marked in the code as never to be deleted: without it the
    timer-driven burn pins a coin's treasury at 30 days of its *current* model, so any model more than 30/7 ≈ 4.3× pricier
    can never become affordable under the model-switch gate (`economy/ladder.ts`) — seen live in the demo, where FORGE
    had FABLE unlocked, a $120 floor on mock-fast, and mock-strong needed $137. The third keeps a cheap agent worth
    waking. `burnPerDayOf` takes the larger of trailing spend and the current model's projection, because trailing
    spend reads ~0 right after a long dormancy and would let the burn take the whole first claim.
74. **The minimum-life gate judges the tier's own pace and the quote carries the field it gates on.** `PurchaseQuote`
    (`packages/shared/src/tiers.ts`) has `gateRunwayDays` beside `runwayDays`: the runway at the tier's paced heartbeat
    as if `HEARTBEAT_OVERRIDE_MIN` were unset. The override exists so a local tester can watch an agent burn down in
    minutes, and refusing every purchase on that path would make the runnable demo unable to sell anything.
    `payments/purchase.ts` throws `BELOW_MINIMUM` on `gateRunwayDays < MIN_PROJECTED_LIFE_DAYS` (21) and the Buy page
    (`AmountStep.tsx`, `Buy.tsx`) warns on the same field, so client and server can never disagree about whether an
    amount will be accepted, while the buyer is still shown `runwayDays`, which does reflect the override.
75. **Test files run one at a time.** `apps/api/vitest.config.ts` sets `fileParallelism: false`: every database
    harness serialises its file on one Postgres advisory lock (`LOCK_ID` 872_401) and waits up to `LOCK_TIMEOUT_MS`
    (60 s) for it, so parallel workers only queue on the lock, and on a slower Postgres link (a Windows host talking to
    a WSL server, a CI container) the queue outlives the timeout and whole files fail with "timed out waiting for the
    test database lock" before a single assertion runs. One file at a time makes the lock uncontended; `hookTimeout`
    (90 s) stays above the lock wait so the lock is still what decides.
