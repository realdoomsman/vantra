# Foundation Contract Audit — confirmed defects

Produced 2026-09-16 by a 5-dimension read-only audit of the foundation contracts
(shared types, pricing math, DB schema, core interfaces, wire contracts) against
`docs/SPEC.md` + `docs/SPEC-AMENDMENTS.md`. Every finding below was re-checked by a
separate adversarial verifier whose default position was that the claim is wrong;
only findings that survived that check appear here. 29 agents, 0 errors.

**Confirmed: 7** (1 blocker, 6 major, 0 minor)

These are NOT yet applied. Apply them after the build workflow completes, then re-run
`pnpm -r typecheck && pnpm -r test && pnpm -r build`.

---

## 1. [BLOCKER] No response type anywhere carries the escrow wallet address, so the frontend cannot build the escrow transfer it must sign before posting a bounty

- **File:** `packages/shared/src/api.ts`
- **Symbol:** `PostBountyRequest.escrowTxSig / ChainPublic`
- **Violates:** SPEC §8.15 (POST /api/market/bounties), §9 Market, §8.7 (escrow wallet is distinct from the pool wallet)
- **Blast radius:** web Market page (post-bounty form) and Protocol page (wallet links); http/routes/market.ts + routes/stats.ts; economy/stats.ts, which must now surface both pubkeys; chain/pool.ts key derivation.

### Problem

api.ts:79 requires the client to have already moved USDC to the escrow wallet:

  export interface PostBountyRequest { title: string; description: string; rewardMicro: Micro; deadlineHours: number; escrowTxSig: string }

SPEC §8.15 says the server "verifies the tx moved rewardMicro USDC from the caller to the escrow wallet", and §9 Market says the post-bounty form must "build USDC transfer to escrow with wallet-adapter, then submit sig". But no wire type exposes that address. types.ts:127 is the only place chain identity is published:

  export interface ChainPublic { mode: ChainMode; cluster: string; usdcMint: string; runwayMint: string | null; holdingGateEnabled: boolean }

and PoolPublic publishes only `walletPubkey` (the POOL wallet — a different key; config.ts has both POOL_WALLET_SECRET and ESCROW_WALLET_SECRET, and §8.7 classifies deposits from them differently). A grep for "escrow" across packages/shared/src returns only LedgerKind, DepositClass and this field. The finished web helper is `export type UsdcSender = (to: string, amountMicro: Micro, memo?: string) => Promise<string>` (apps/web/src/lib/usdcTransfer.ts) — there is no value the Market page can pass as `to`. The specced flow is unimplementable against the current contract. The same gap blocks SPEC §9 Protocol's "links (… wallet addresses)".

### Fix

Publish the two server wallet pubkeys on the existing chain block rather than inventing a market-only route, but make them nullable: in packages/shared/src/types.ts change `ChainPublic` to `{ mode: ChainMode; cluster: string; usdcMint: string; runwayMint: string | null; holdingGateEnabled: boolean; escrowWallet: string | null; protocolFeeWallet: string | null }`. Nullability is required because config.ts:172 declares `escrowWalletSecret: string | null` and `protocolFeeWallet: string | null`, and config.ts:132-136 only forces them to be set when CHAIN_MODE=solana (in memory mode the adapter may have generated an ephemeral escrow key or none at all). `stats()` derives `escrowWallet` as the pubkey of `config.chain.escrowWalletSecret` (never the secret itself) and passes `config.chain.protocolFeeWallet` through, so `GlobalStats.chain.escrowWallet` is reachable from the Market, Protocol and Spawn pages, which already read `GlobalStats.chain`. The Market post-bounty form must refuse to build the transfer when `escrowWallet === null` (empty/degraded state per AMENDMENT 38) instead of falling back to `pool.walletPubkey`, since an escrow deposit from the pool wallet is classified differently (SPEC:372). Also update the inline `chain: { ... }` literal in docs/SPEC.md:156 so the spec and the shared type stay in sync.

### Why the verifier confirmed it

Confirmed. SPEC §8.15 (docs/SPEC.md:431) has the server verify a tx that "moved rewardMicro USDC from the caller to the escrow wallet", and §9 Market (docs/SPEC.md:470) requires the post-bounty form to "build USDC transfer to escrow with wallet-adapter, then submit sig". packages/shared/src/api.ts:79 encodes the caller side of that (`escrowTxSig: string`), but no type in packages/shared exposes the destination: types.ts:127 `ChainPublic { mode; cluster; usdcMint; runwayMint; holdingGateEnabled }` has no escrow field, types.ts:122 `PoolPublic.walletPubkey` is the pool wallet (a distinct key — config.ts:172 holds `escrowWalletSecret` separately from `poolWalletSecret`, and SPEC:372 / `DepositClass` classify pool vs escrow inflows differently), and `TokenPublic`, `ProtocolRules`, `Bounty`, `Service` and `Me` carry nothing either. There is also no server-side escape hatch the frontend could use: `ChainAdapter` (apps/api/src/core/interfaces.ts:53-66) exposes no escrow accessor, the secret is redacted from logs (lib/log.ts:11), and apps/web/src/vite-env.d.ts declares only VITE_PUMP_URL and VITE_SOLANA_RPC_URL, so `useUsdcTransfer()`'s `to` argument has no value to receive. The gap cannot be closed inside a module being written — any route that returns the address needs a new/changed type in packages/shared — so it is a contract defect, not a module bug. That types.ts:127 faithfully copies SPEC §4 line 156 does not excuse it; the contract as published makes a specced flow impossible (it also blocks §9 Protocol's "wallet addresses" links for escrow and the protocol fee wallet).

---

## 2. [MAJOR] slugify() is not injective over NAME_RE-valid names, so two legal names collide on the UNIQUE deploy_slug

- **File:** `packages/shared/src/names.ts`
- **Symbol:** `slugify()`
- **Violates:** SPEC §7 (agents.deploy_slug text UNIQUE) + §8.4 step 4 (spawn creates the agent + slug in one transaction)
- **Blast radius:** economy/spawn.ts (spawn, fork, retry-seed all derive deploy_slug from the name), http/routes/agents.ts (409 code mapping — collisions surface as 500), hosting/static.ts + hosting/svc.ts (slug → site directory routing, so colliding agents would also serve each other's files), apps/web Spawn page name-availability preview.

### Problem

`NAME_RE = /^[A-Z0-9][A-Z0-9-]{2,15}$/` accepts consecutive and trailing dashes, but slugify collapses and strips them:
```ts
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')      // 'X--Y' and 'X-Y' -> 'x-y'
    .replace(/^-+|-+$/g, '');    // 'ATLAS-' and 'ATLAS' -> 'atlas'
}
```
`validateName('X--Y')` and `validateName('X-Y')` both return ok (and `'ATLAS-'` / `'ATLAS'` likewise), so `agents.name` stays unique while `deploy_slug` does not. db/schema.ts declares `uniqueIndex('agents_deploy_slug_uq').on(t.deploySlug)`, so the second spawn raises a Postgres 23505 inside the spawn transaction instead of the specified 409 NAME_TAKEN — after the name check has already passed. packages/shared/test/names.test.ts even pins the collapsing behaviour (`expect(slugify('X--Y')).toBe('x-y')`, `expect(slugify('-A-')).toBe('a')`), so nobody downstream will notice.

### Fix

The primary half of the proposal is right; the fallback regex is wrong and must not be used.

Do BOTH of these, since either alone leaves a hole:

1. Make the slug a lossless function of a validated name — `packages/shared/src/names.ts`:
```ts
// Precondition: `name` has passed validateName (NAME_RE alphabet is [A-Z0-9-]).
export function slugify(name: string): string {
  return name.toLowerCase();
}
```
This is injective, and the alphabet is already URL-safe, so the two `replace` passes buy nothing and only destroy information. Test helpers already assume this identity (`apps/api/test/tools/helpers/env.ts:247` uses `name.toLowerCase()`).

2. Tighten NAME_RE so no legal name has leading/trailing/consecutive dashes — `packages/shared/src/constants.ts:43`:
```ts
export const NAME_RE = /^(?=[A-Z0-9-]{3,16}$)[A-Z0-9]+(?:-[A-Z0-9]+)*$/;
```
Do NOT use the claimant's suggested `/^[A-Z0-9](?:-?[A-Z0-9]){2,15}$/`: it counts ALPHANUMERICS, not characters, so `A-B-C-D-E-F-G-H-I-J-K-L-M-N-O-P` (31 chars) matches. That contradicts SPEC §8.4 / the validateName error string "Name must be 3-16 characters" and the existing `'SEVENTEEN-CHARS-X'` rejection test. The lookahead form above enforces the 3-16 total-character rule and the no-adjacent-dash rule together.

3. Update `packages/shared/test/names.test.ts:26-28`, which currently pins the defect: replace `expect(slugify('X--Y')).toBe('x-y')` and `expect(slugify('-A-')).toBe('a')` with an injectivity assertion plus `validateName('X--Y').ok === false` and `validateName('ATLAS-').ok === false`.

Note for whoever owns tools/deploy.ts (out of scope here, do not report as this finding): `resolveSlug` grants an agent every slug starting with `<deploySlug>-`, so `ATLAS` can still claim `atlas-foo` while agent `ATLAS-FOO` owns that exact slug. Fixing slugify closes the agents.deploy_slug UNIQUE violation but not that deployments-level namespace overlap.

### Why the verifier confirmed it

Confirmed against the actual files, not just the claim text.

1. `packages/shared/src/constants.ts:43` — `export const NAME_RE = /^[A-Z0-9][A-Z0-9-]{2,15}$/;` — only the FIRST character is constrained to be alphanumeric. Everything after it is `[A-Z0-9-]`, so consecutive dashes and a trailing dash are legal. I executed the regex and the slugify body: `X--Y`→valid→`x-y`, `X-Y`→valid→`x-y`, `ATLAS-`→valid→`atlas`, `ATLAS`→valid→`atlas`, `A--`→valid→`a`. slugify is provably non-injective over the set of names validateName accepts.

2. `packages/shared/src/names.ts:18` states the invariant that is false: `// deploySlug for /sites/:slug. Valid names lowercase to a unique, URL-safe slug.` Lines 23-24 (`.replace(/-{2,}/g, '-')` and `.replace(/^-+|-+$/g, '')`) are exactly what destroys the injectivity the comment asserts.

3. The contract that depends on that invariant is in scope (db/ is not in the excluded module list): `apps/api/src/db/schema.ts:56` `deploySlug: text('deploy_slug').notNull()` and `apps/api/src/db/schema.ts:100` `uniqueIndex('agents_deploy_slug_uq').on(t.deploySlug)`, matching SPEC §7 `agents ... deploy_slug text UNIQUE` (non-null, unlike the explicitly `null` columns beside it). Separately `agents_name_uq` is on `name`, so name-uniqueness does not imply slug-uniqueness.

I checked the three exculpatory possibilities and none hold:
- No other slug function or uniqueness guard exists. Grep over the repo shows `slugify` is defined once and consumed once, at `apps/api/src/economy/spawn.ts:55` (`deploySlug: slugify(name)`), and the only pre-insert guard is `if (await nameTaken(deps, name)) throw conflict('NAME_TAKEN', ...)` at spawn.ts:43 — it checks `name`, never the slug. So the second spawn passes the NAME_TAKEN check and then hits 23505 on `agents_deploy_slug_uq` inside `withTx`, i.e. a 500 where SPEC §8.4/§8.15 (`409 codes: NAME_TAKEN, ...`) requires a 409.
- SPEC-AMENDMENTS.md contains nothing about names, slugs or NAME_RE, so it does not supersede §7 or §8.4 here.
- The defect is in `packages/shared/src/{names,constants}.ts` and the `db/schema.ts` unique index — foundation contracts, not in the excluded `{llm,chain,sandbox,tools,runtime,economy,http,sim,hosting,search}` set. spawn.ts is cited only as evidence of impact, not as the finding.

The claimant's supporting detail also checks out: `packages/shared/test/names.test.ts:27-28` pins the lossy behaviour (`expect(slugify('X--Y')).toBe('x-y')`, `expect(slugify('-A-')).toBe('a')`), and `validateName('SIXTEEN-CHARS-OK')` is asserted ok, confirming the 3-16 total-character reading.

Real, but the proposed fix's ALTERNATIVE regex is wrong, so see correctedFix.

---

## 3. [MAJOR] AgentPublic carries every other Graveyard-card field but not postmortem, so `.g-cause` cannot be rendered

- **File:** `packages/shared/src/types.ts`
- **Symbol:** `AgentPublic (postmortem)`
- **Violates:** AMENDMENTS D37 (Graveyard card mapping) vs SPEC §8.15 `GET /api/graveyard → AgentPublic[]`
- **Blast radius:** economy/stats.ts + economy/agents.ts (the AgentRow → AgentPublic mapper and the graveyard query), http/routes/agents.ts (`GET /api/graveyard`), apps/web Graveyard page and Observatory "RECENT DEATHS" panel.

### Problem

D37 fixes the graveyard card as "`.g-marker` = deathCause uppercased; `.g-dates` ...; `.g-cause` first sentence of postmortem; `.g-stats` 'AGE {d}d · EXT REV $x · SEED PAID BACK|NOT PAID'". Every one of those fields is on AgentPublic — `deathCause`, `bornAt`/`diedAt`, `ageDays`, `revenueExternalMicro`, and `paidBackSeed: boolean;      // revenueExternalMicro ≥ seedMicro` (added by C20 specifically for this card) — except postmortem, which sits only on the detail type:
```ts
export interface AgentDetail extends AgentPublic {
  memory: string[]; strategy: string | null; postmortem: string | null;
```
The graveyard list is typed `export type GraveyardResponse = AgentPublic[];` (api.ts) and `graveyard(limit: number, sort?: GraveyardSort): Promise<AgentPublic[]>` (core/interfaces.ts), so the page would need up to 100 extra `/api/agents/:id` round-trips to fill one line of each card.

### Fix

Do not hoist postmortem onto AgentPublic: AgentPublic is also the row type for /api/agents (50 rows), /api/leaderboard, POST /api/agents and the WS `agent` patch (C27), so a multi-paragraph postmortem on it bloats all of those. Scope it to the graveyard instead: (1) packages/shared/src/types.ts, next to AgentPublic: `export interface GraveyardEntry extends AgentPublic { postmortem: string | null }` — already re-exported via `export * from './types.js'` in index.ts; (2) packages/shared/src/api.ts:66 → `export type GraveyardResponse = GraveyardEntry[];`; (3) apps/api/src/core/interfaces.ts:149 → `graveyard(limit: number, sort?: GraveyardSort): Promise<GraveyardEntry[]>;` and add GraveyardEntry to that file's shared-type import; (4) apps/web/src/api/client.ts:118 → `get<GraveyardResponse>('/api/graveyard', q)`; (5) the graveyard row mapper must select agents.postmortem (column already present at apps/api/src/db/schema.ts:87), and the page renders `.g-cause` with the existing firstSentence() helper, falling back to '' when postmortem is null. A narrower server-side `epitaph: string | null` (first sentence only) is an acceptable equivalent through the same four files, but then firstSentence() in apps/web/src/lib/format.ts becomes dead code.

### Why the verifier confirmed it

Verified in the files. packages/shared/src/types.ts:54-81 defines AgentPublic with every D37 graveyard-card field except postmortem: deathCause (line 55), bornAt/diedAt (55), ageDays (75), revenueExternalMicro (60), paidBackSeed (80). postmortem is declared only at line 89 on AgentDetail. The list response is typed AgentPublic[] in all three contract surfaces: packages/shared/src/api.ts:66 (`export type GraveyardResponse = AgentPublic[];`), apps/api/src/core/interfaces.ts:149 (`graveyard(limit: number, sort?: GraveyardSort): Promise<AgentPublic[]>;`), and apps/web/src/api/client.ts:118. No alias, intersection, re-export or graveyard-specific row type carries postmortem anywhere in packages/shared/src (grep finds only GraveyardSort/GraveyardQuery/GraveyardResponse), and there is no `epitaph` field. AMENDMENTS D37 fixes the card as `.g-cause` = first sentence of postmortem, so a 100-card grid cannot be rendered from the contract without one /api/agents/:id AgentDetail fetch per card. The defence that SPEC.md:427 says "AgentPublic[] (dead, newest first, with postmortem in detail endpoint)" does not hold: AMENDMENTS override SPEC where they conflict, D37 is exactly such a conflict, and D25 re-specifies this endpoint only to add `sort`. The rest of the D37 plumbing already exists outside the in-flight module scope — apps/web/src/lib/format.ts:106 exports `firstSentence()` commented "graveyard cause, D37", and apps/api/src/db/schema.ts:87 has the `postmortem` text column — so the wire type is the only missing link. `summary` is not a substitute; D37 names postmortem specifically and `summary` is the agent's own post_update line.

---

## 4. [MAJOR] No public type exposes the escrow (or protocol fee) wallet, so the client cannot build the escrow transfer the bounty API demands

- **File:** `packages/shared/src/types.ts`
- **Symbol:** `ChainPublic / PoolPublic (escrow + protocol fee wallet)`
- **Violates:** SPEC §8.15 `POST /api/market/bounties {... escrowTxSig}` + §9 Market ("build USDC transfer to escrow with wallet-adapter, then submit sig") and §9 Protocol ("links (... wallet addresses)")
- **Blast radius:** http/routes/stats.ts and economy/stats.ts (GlobalStats assembly), http/routes/market.ts and the bounty escrow verification path, apps/web Market page (post-bounty form) and Protocol page (wallet address links).

### Problem

The only wallet address reachable from any response type is the pool wallet:
```ts
export interface ChainPublic { mode: ChainMode; cluster: string; usdcMint: string; runwayMint: string | null; holdingGateEnabled: boolean }
export interface PoolPublic { walletPubkey: string; usdcMicro: Micro; ... }
```
`PostBountyRequest` requires `escrowTxSig: string` and the server "verifies the tx moved rewardMicro USDC from the caller to the escrow wallet", but the escrow wallet pubkey exists only in `config.chain.escrowWalletSecret` on the server — a grep for `escrow` across packages/shared/src and apps/web/src finds nothing but the ledger kinds and the tx-sig field. The frontend therefore has no destination to pass to `usdcTransfer.ts`, making the entire human bounty-posting flow unbuildable; the Protocol page's "wallet addresses" row has the same gap for PROTOCOL_FEE_WALLET.

### Fix

Extend `ChainPublic` in packages/shared/src/types.ts:127 with two public receive addresses (never secrets):

```ts
export interface ChainPublic {
  mode: ChainMode; cluster: string; usdcMint: string; runwayMint: string | null;
  holdingGateEnabled: boolean;
  escrowWallet: string | null;        // pubkey derived at boot from ESCROW_WALLET_SECRET; null when unconfigured
  protocolFeeWallet: string | null;   // config.chain.protocolFeeWallet; null when unconfigured
}
```

Completions the original fix misses:

1. `escrowWallet` must be the *derived pubkey*, not the secret. `config.chain` only holds `escrowWalletSecret`, so the composition root (apps/api/src/core/container.ts) has to derive the keypair pubkey once at boot and expose it (e.g. `chain.escrowPubkey` alongside `usdcMint` on `ChainAdapter`, or a resolved value on the container) so the `GET /api/stats` assembler can fill the field without re-reading the secret per request. "Populated from config" as written is not achievable for escrow — the config value is a secret, not an address.

2. Null is not only a memory-mode case: `ESCROW_WALLET_SECRET` and `PROTOCOL_FEE_WALLET` are `optional()` in config.ts, so both can be null on solana too. The Market page must disable the post-bounty form with an explicit message when `chain.escrowWallet === null`, and `POST /api/market/bounties` must return 409/500 rather than accept a sig it cannot verify against a destination.

3. The memory chain should register a deterministic escrow pubkey so the demo/integration bounty flow (`spawn → post → claim → submit → approve`, SPEC §10) still exercises the escrow path rather than silently skipping it.

4. Same class of gap, same fix site, worth closing in one pass: `Service` (types.ts:154) has `agentId`/`agentName` but no seller wallet pubkey, while `POST /api/market/services/:id/call { input, paymentTxSig }` and `POST /svc/:serviceId` (`x-payment-tx`) require the buyer to have paid *the agent wallet*. The Market page's "try" button is unbuildable for the same reason. Add `agentWallet: string` to `Service`.

Adding fields to these interfaces is additive and breaks nothing that already compiles: every `ChainPublic`/`Service` producer is in a module being written right now, and the only consumer in tree (apps/web/src/lib/mode.ts:34) uses `Pick<ChainPublic, 'mode' | 'cluster'>`.

### Why the verifier confirmed it

Verified against the actual files. `ChainPublic` (packages/shared/src/types.ts:127) is the only chain-config type reaching the client and carries mode/cluster/usdcMint/runwayMint/holdingGateEnabled — no escrow or protocol-fee address. No alias, intersection or re-export supplies it: `index.ts` re-exports all of shared and a grep over packages/shared/src plus apps/web/src finds `escrow` only in `LedgerKind` ('escrow_out'|'escrow_in'), `DepositClass`, and `PostBountyRequest.escrowTxSig` (api.ts:79). `ChainAdapter` (apps/api/src/core/interfaces.ts:53-67) exposes only `mode`, `cluster`, `usdcMint`; the escrow wallet lives solely in `config.chain.escrowWalletSecret` (config.ts:92-93) and `PROTOCOL_FEE_WALLET` in `config.chain.protocolFeeWallet` — neither is reachable from any response type. The client-side env escape hatch does not exist either: apps/web/src/vite-env.d.ts declares only VITE_PUMP_URL and VITE_SOLANA_RPC_URL, and .env.example has no VITE_ escrow var. `apps/web/src/lib/usdcTransfer.ts` requires `to: string` from its caller and pulls `usdcMint` from `stats.chain`, so the destination must come from the same place — and cannot. SPEC §8.15 (`POST /api/market/bounties { ... escrowTxSig }`, "server verifies the tx moved rewardMicro USDC from the caller to the escrow wallet") and §9 Market ("shows escrow tx flow: build USDC transfer to escrow with wallet-adapter, then submit sig") require the browser to know that address; no amendment supersedes either line (§C25 touches other market/agent routes only). This is not an in-flight module file: types.ts is a foundation contract, and the Market page is still a placeholder, so the gap is genuinely unfilled. Contract makes a spec-mandated flow unbuildable.

---

## 5. [MAJOR] bounties.escrow_tx is not UNIQUE, so one escrow deposit can fund unlimited bounties

- **File:** `apps/api/src/db/schema.ts`
- **Symbol:** `bounties.escrowTx`
- **Violates:** SPEC §8.15 POST /api/market/bounties; SPEC §11 ("v1 escrow is a protocol-custodied wallet"); AMENDMENTS C25
- **Blast radius:** economy/services.ts postBounty, http/routes/market.ts, and any escrow payout path in economy/ (review_submission approve → escrow pays claimer) — all of which currently have to trust an application-level dedupe that does not exist.

### Problem

`escrowTx: text('escrow_tx'),` carries no unique constraint, while the identical pattern one table above does: `uniqueIndex('service_calls_payment_tx_uq').on(t.paymentTx)`. SPEC §8.15 says the server "verifies the tx moved rewardMicro USDC from the caller to the escrow wallet" — verification alone is replayable. A caller can POST the same `escrowTxSig` N times and create N bounties each claiming the same on-chain deposit; the protocol-custodied escrow wallet then owes N × reward to claimers from one payment. The third tx-backed endpoint, `POST /api/agents/:id/recapitalize { txSig }`, is protected by `sig: text('sig').primaryKey()` on `deposits_seen`, so bounties are the only replayable money-in path in the schema — an internal inconsistency between three parallel flows.

### Fix

In apps/api/src/db/schema.ts, add to the bounties index list (lines 246-250):

  uniqueIndex('bounties_escrow_tx_uq').on(t.escrowTx),

and mirror the column comment used on service_calls.paymentTx so the intent travels with the column:

  escrowTx: text('escrow_tx'),   // on-chain escrow deposit sig; unique so one deposit cannot fund two bounties

Because apps/api/drizzle/0000_odd_paibok.sql is a checked-in migration applied incrementally by src/db/migrate.ts (production uses `runMigrations`, not `db:push`), the schema change alone is not enough: regenerate with `pnpm db:generate` so a matching

  CREATE UNIQUE INDEX "bounties_escrow_tx_uq" ON "bounties" USING btree ("escrow_tx");

statement lands beside the existing `service_calls_payment_tx_uq` line, otherwise schema.ts and the applied database disagree. Postgres's default NULLS DISTINCT leaves agent-posted-before-settlement and `posterType: 'protocol'` rows with null escrow_tx unconstrained, as intended. The economy/market.ts pre-check at line 64 should stay (it gives the caller a clean 409 instead of a raw constraint violation), but the unique index is what closes the concurrent-duplicate-POST window it cannot cover on its own; the insert path should catch the unique-violation error and return the same 409.

### Why the verifier confirmed it

Confirmed at apps/api/src/db/schema.ts:244 — `escrowTx: text('escrow_tx'),` with the bounties index list (lines 246-250) containing only `bounties_status_idx`, `bounties_poster_idx`, `bounties_claimer_idx`. No unique constraint on escrow_tx exists anywhere: `grep -rn "escrow_tx"` across the repo returns only the column declaration in schema.ts and the matching plain `"escrow_tx" text,` in the checked-in migration apps/api/drizzle/0000_odd_paibok.sql:88, whose UNIQUE INDEX list (lines 299-327) includes `service_calls_payment_tx_uq` but nothing for bounties. So the "exists under another name / different file" escape does not apply.

The parallel table in the same file makes the intent explicit: `paymentTx: text('payment_tx'),  // on-chain payment sig; unique so a tx cannot buy twice` + `uniqueIndex('service_calls_payment_tx_uq').on(t.paymentTx)` (lines 275-279), backing an endpoint whose spec wording is the same shape ("verifies payment to the agent wallet", SPEC.md:434) as the bounty one ("server verifies the tx moved rewardMicro USDC from the caller to the escrow wallet", SPEC.md:431). The third tx-backed path is guarded structurally by `sig: text('sig').primaryKey()` on deposits_seen (line 221). The codebase's own contract comment states the requirement directly — apps/api/src/chain/verify.ts:3: "Callers must ALSO guarantee single use of a signature (service_calls.payment_tx / bounties.escrow_tx / ...)" — i.e. bounties.escrow_tx is named as a single-use signature column and is the only one of the three with no uniqueness in the contract.

I checked whether one escrow sig could legitimately back several bounties: SPEC.md:298/431 pass exactly one `escrowTxSig` per `postBounty`, the agent tool path (SPEC.md:386) does one `escrow_out` transfer per bounty, protocol-posted bounties leave escrow_tx null, and nothing overwrites escrow_tx with a payout/refund sig (it is read back for refunds only). So uniqueness is the correct invariant and the fix breaks nothing; Postgres NULLS DISTINCT leaves protocol/agent rows with null escrow_tx unaffected.

One correction to the claim's wording: it is not true today that a caller "can POST the same escrowTxSig N times" without any resistance — economy/market.ts:64 does a `select ... where eq(bounties.escrowTx, transfer.sig)` guard first. But that is a select-then-insert TOCTOU: two concurrent POSTs with the same sig both see no row and both insert, and it lives in a module being rewritten by another agent, outside the contract. The schema is exactly the layer that makes the invariant enforceable, it enforces it for the two sibling flows, and it silently omits it here — a real contract defect, severity major.

---

## 6. [MAJOR] LlmRequest has no way to pass the remaining step budget, so `timeout: min(remainingStepMs, 300000)` is unimplementable

- **File:** `apps/api/src/core/interfaces.ts`
- **Symbol:** `LlmRequest`
- **Violates:** AMENDMENTS A6 (per-request timeout + router-owned retries); also A2, B12
- **Blast radius:** llm/router.ts and all four providers (anthropic, openai, openrouter, mock) plus runtime/step.ts — six writers are currently coding `complete()` against a request object that cannot express the timeout A6 requires.

### Problem

AMENDMENTS A6 mandates: "SDK client `maxRetries: 0`, per-request `{ signal, timeout: min(remainingStepMs, 300000) }`; the ROUTER owns retries (3× on 429/5xx/network, identical body)". The request type carries the signal but not the remaining time:

```ts
export interface LlmRequest {
  model: string; system: string; messages: LlmMessage[]; tools: LlmToolDef[];
  maxTokens: number;                 // default LLM_MAX_TOKENS_DEFAULT (16000)
  effort?: Effort;
  toolChoice?: 'auto' | 'none';      // default 'auto'; closing completions send the SAME tools with 'none'
  signal?: AbortSignal;
  agentId: string;
}
```

Nothing downstream can recover `remainingStepMs`: an `AbortSignal` exposes no deadline, `LlmProvider.complete(req, model)` gets only `req` and `ModelInfo`, and `LlmRouter.complete(req)` gets only `req`. The same file proves the omission is accidental — the tool path *does* carry it: `export interface ToolExecOpts { signal: AbortSignal; remainingMs: number }   // tool timeouts are capped by remainingMs`. Consequences: providers must hard-code 300s, and the router's 3 retries each get a fresh full timeout, so a single round can burn ~15 minutes against a `STEP_TIMEOUT_MS` of 8 minutes; the router also cannot decide to stop retrying because the step deadline is near.

### Fix

Add a remaining-budget field to `LlmRequest` in apps/api/src/core/interfaces.ts, mirroring `ToolExecOpts.remainingMs` (line 96) and `hosting/service.ts`'s `opts?.remainingMs`:

```ts
export interface LlmRequest {
  model: string; system: string; messages: LlmMessage[]; tools: LlmToolDef[];
  maxTokens: number;
  effort?: Effort;
  toolChoice?: 'auto' | 'none';
  signal?: AbortSignal;
  remainingMs?: number;   // remaining step budget; per-request timeout = min(remainingMs, LLM_REQUEST_TIMEOUT_MS)
  agentId: string;
}
```

Then:
- Add `export const LLM_REQUEST_TIMEOUT_MS = 300_000;` to `packages/shared/src/constants.ts` so the 300000 in A6 is one shared constant instead of a per-provider literal, and note the rule in the `LlmProvider` doc comment on line 39.
- Providers compute `timeout: Math.max(1_000, Math.min(req.remainingMs ?? LLM_REQUEST_TIMEOUT_MS, LLM_REQUEST_TIMEOUT_MS))` — the `Math.max` floor matters, otherwise a nearly-exhausted step yields a 0/negative timeout that the SDK rejects (the same clamp `tools/files.ts:47` and `tools/web.ts:56` get wrong in the other direction by subtracting without a floor).
- The router (`llm/router.ts`) treats `remainingMs` as a deadline for the whole call: it must not start retry N, and must not sleep a backoff, when the elapsed time plus the backoff would exceed it; it should decrement `remainingMs` on the retried request rather than resend the original value, keeping the body otherwise identical per A6.
- `runtime/step.ts` passes `STEP_TIMEOUT_MS − elapsed` on every round, including the closing/`toolChoice:'none'` completion and the last-words completion (B10/B14), alongside the existing step AbortController signal.
- Keep the field optional so non-step callers (postmortem epitaph) may omit it and fall back to the 300s cap; do not make it required, since that would force every existing call site to invent a value.

### Why the verifier confirmed it

Verified against the actual code, and the claim survives the obvious defences.

1. The field really is absent, and nowhere else. `apps/api/src/core/interfaces.ts:22-29` defines `LlmRequest` with exactly `model, system, messages, tools, maxTokens, effort?, toolChoice?, signal?, agentId` — no time budget. `LlmProvider.complete(req, model)` (line 39) and `LlmRouter.complete(req)` (line 44) take nothing else. `LlmRequest` is declared only in this file (grep over apps/api/src and packages/* finds no other declaration, alias, intersection or re-export), and `packages/shared/src/constants.ts` has no LLM request-timeout constant either (only `STEP_TIMEOUT_MS = 8 * 60_000` at line 30). An `AbortSignal` exposes only `aborted`/`reason`, never a remaining duration, so it cannot carry the value.

2. The AMENDMENTS really do require it. SPEC-AMENDMENTS A6 (line 11) is literal: "SDK client `maxRetries: 0`, per-request `{ signal, timeout: min(remainingStepMs, 300000) }`; the ROUTER owns retries (3× on 429/5xx/network, identical body)". The contract carries `signal` (added by A2) but not `remainingStepMs`, so the prescribed timeout expression is not computable by any implementer of `LlmProvider`/`LlmRouter`. The same file shows the intended pattern one path over: line 96 `export interface ToolExecOpts { signal: AbortSignal; remainingMs: number }`, and `hosting/service.ts:51` mirrors it with `opts?: { remainingMs?: number }`.

3. The omission has already propagated, as predicted: `apps/api/src/llm/providers/anthropic.ts:26` hard-codes `timeout: ANTHROPIC_REQUEST_TIMEOUT_MS` because `req` offers nothing better. (That provider file is out of scope as a finding; I cite it only as evidence that the contract, not the module, is what forces the constant.)

Where the claim overstates itself: the "3 retries × 300s = ~15 minutes against an 8-minute STEP_TIMEOUT_MS" consequence is not right when B12 is honoured — `STEP_TIMEOUT_MS` drives an AbortController passed as `signal`, and `llm/router.ts:62,65` already bails out of retries and backoff on `req.signal.aborted`, so the step-level signal bounds the whole round. The real, narrower defect is that (a) A6's prescribed per-request timeout is unimplementable as written, (b) the router cannot make a budget-aware retry decision (skip a retry or shorten backoff when only a few seconds of step time remain) — it can only react after the deadline has already blown, and (c) `signal` is optional, so a caller outside the step loop (e.g. the postmortem epitaph completion) gets an unbounded 300s request with no bound at all. That makes it a genuine contract gap rather than a merely cosmetic one, so real=true with the consequence and fix corrected below.

---

## 7. [MAJOR] Graveyard rows are AgentPublic, which has no postmortem, but D37 requires the postmortem's first sentence on every grave card

- **File:** `packages/shared/src/api.ts`
- **Symbol:** `GraveyardResponse / AgentPublic`
- **Violates:** AMENDMENTS D37 (overrides SPEC §8.15's "with postmortem in detail endpoint")
- **Blast radius:** web Graveyard page; http/routes/agents.ts graveyard handler; economy/stats.ts or economy/services.ts graveyard query (must join agents.postmortem); core/interfaces.ts Services.graveyard signature.

### Problem

api.ts:64-66 types the route as:

  export type GraveyardSort = 'recent' | 'age' | 'revenue';
  export interface GraveyardQuery { limit?: number; sort?: GraveyardSort }
  export type GraveyardResponse = AgentPublic[];

`AgentPublic` (types.ts:56-81) has no `postmortem`; it exists only on `AgentDetail` (types.ts:89 `memory: string[]; strategy: string | null; postmortem: string | null;`). AMENDMENTS D37 specifies the card mapping as "`.g-cause` = first sentence of postmortem", and the finished web app already ships the helper for exactly that: `/** First sentence of a paragraph (graveyard cause, D37). */ export function firstSentence(text: string)` in apps/web/src/lib/format.ts. Everything else D37 needs is present (deathCause, bornAt/diedAt, ageDays, revenueExternalMicro, paidBackSeed) — postmortem is the only missing field, so the Graveyard page would have to issue up to 100 `/api/agents/:id` calls (each returning ledgerRecent, decisions, series) to render one grid. AMENDMENTS override SPEC, so the §8.15 parenthetical does not settle this.

### Fix

Keep postmortem off `AgentPublic` (it is the WS `agent` patch shape per AMENDMENTS C27, and the list-row shape for /api/agents and /api/leaderboard), and add a graveyard-specific row type instead:

1. packages/shared/src/api.ts (replacing line 66):
   export interface GraveyardRow extends AgentPublic { postmortem: string | null }
   export type GraveyardResponse = GraveyardRow[];
   (exported automatically via packages/shared/src/index.ts `export * from './api.js'`.)

2. apps/api/src/core/interfaces.ts:149 — widen to
   graveyard(limit: number, sort?: GraveyardSort): Promise<GraveyardRow[]>;
   and add `GraveyardRow` to that file's type import from @vantra/shared.

3. The GET /api/graveyard handler must select `agents.postmortem` (the column already exists per SPEC.md:227 `postmortem text null`) and return it; it may be truncated/first-sentence-only server-side, but the field must be present on every row.

Alternative if a distinct row type is undesirable: reuse `AgentDetail`-style projection is wrong (too heavy); do NOT add `postmortem` to `AgentPublic` itself, since that pushes a long text field into every `/api/agents` row, `/api/leaderboard` row and every WS `agent` patch.

### Why the verifier confirmed it

Verified in the actual files. api.ts:64-66 declares `export type GraveyardResponse = AgentPublic[];` and types.ts:56-81 shows `AgentPublic` carries no `postmortem` — it exists only on `AgentDetail` (types.ts:89). AMENDMENTS D37 (SPEC-AMENDMENTS.md:48) requires the grave card to render `.g-cause` = "first sentence of postmortem", separately from `.g-marker` = deathCause, so deathCause does not satisfy it. SPEC.md:427 ("AgentPublic[] ... with postmortem in detail endpoint") is exactly the line D37 conflicts with, and the amendments preamble (line 3) states amendments override SPEC on conflict; C25 touches this endpoint only to add `sort` and does not re-bless the payload. D37 is also a genuine addition, not a restatement: SPEC §9 line 468 listed the card as "name, born–died, cause, lifetime ext revenue, age, seed paid back yes/no" with no postmortem. Corroboration that the list endpoint is the intended source: apps/web/src/lib/format.ts:105-106 already ships `/** First sentence of a paragraph (graveyard cause, D37). */ export function firstSentence(text: string)`, and global.css:466-470 defines `.grave-card .g-cause` as a distinct multi-line block alongside `.g-marker`. Graveyard.tsx is still a placeholder so it cannot rebut. The server side agrees with the defect: apps/api/src/core/interfaces.ts:149 is `graveyard(limit: number, sort?: GraveyardSort): Promise<AgentPublic[]>` (sort is present, payload is not). No alias, intersection or re-export supplies postmortem: packages/shared/src/index.ts re-exports types/api and there is no other Grave* type. Rendering the grid would otherwise require up to 100 `/api/agents/:id` calls, each returning ledgerRecent/decisions/series/projects/services/bounties. Files are in scope (packages/shared and apps/api/src/core are foundation contracts, not in the excluded module list).

---

