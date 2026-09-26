# WHERE VANTRA STANDS — V3

Written for you, not for an engineer. Every number below came from running the thing on
**2026-09-23** on a Windows 11 PC (Node 24.18, pnpm 10.13.1, Postgres 16.15 in WSL Ubuntu 24.04, no
Docker) with **no LLM API keys and no chain keys of any kind**. It supersedes `docs/STATUS-V2.md`
wherever the two disagree; V2 was written on a Mac, on Solana, before the launchpad existed.

Same rule as V2: if a line is not in section 1, treat it as not proven.

1. **WHAT IS PROVEN TO WORK** — things I ran, with what came back.
2. **WHAT CHANGED IN THIS PASS** — bugs fixed and what was added.
3. **WHAT NEEDS KEYS** — which key unlocks what.
4. **WHAT IS STILL UNPROVEN** — things nobody has ever watched work.

---

# 1. WHAT IS PROVEN TO WORK

## 1.1 The four gates, on a fresh clone, on Windows

```
pnpm install      clean
pnpm -r typecheck @vantra/shared, @vantra/api, @vantra/web — 0 errors
pnpm -r test      shared 66 passed · api 1,349 passed, 0 failed, 63 skipped (see below)
pnpm -r build     shared + api compiled, web built
```

The 63 skips are the same gated groups V2 listed (Docker not installed here, no funded wallet, no live
network) plus five tests that need a Linux filesystem: four that create symlinks (Windows only lets an
administrator do that) and one that compares a shell `pwd` against a Windows path. They now skip
themselves with a stated reason instead of failing.

Two of those three test databases plus the demo database were created in WSL Postgres; the exact
commands are in `docs/OPERATIONS.md` under Tests.

## 1.2 The demo runs, with zero keys

```
pnpm demo                                        # API on :8787, colony seeded in ~2 minutes
pnpm --filter @vantra/web exec vite --port 5173  # the site
```

Read live from `/api/stats` after seeding: **51 born · 48 alive · 0 dead · 4 sleeping**, 36 bought agents
and 15 launchpad coins in every state (dormant part-way to activation, alive on SPARK, climbed to
OPERATOR / PRIME / FABLE, with burns). Nobody is dead right after seeding; that is the fast-forward
simulating only two steps a day. Left running, the 5-minute demo heartbeat burns a $9 SPARK in about
two days and the graveyard fills.

I opened every page in a real browser — landing, launch, observatory, agents, profiles, graveyard, buy,
claim, my agents, market, protocol, control board, a 404 — and captured the console on each. **Zero
JavaScript errors.** (Two requests that show as 404 in the console come from a wallet extension in the
browser, not from VANTRA; the `/api/me` 401 is the app asking "who am I" while signed out.)

## 1.3 Somebody can launch a coin, end to end

Walked in the browser, on the simulated chain:

| step | what I did | what came back |
|---|---|---|
| 1 | `/launch`, signed in with the demo wallet | the form, the rung ladder, the guarantee card |
| 2 | named it Test Coin / `TST`, 5% tax, PAID API strategy, **SIMULATE LAUNCH** | redirected to `/a/ag_…`: **DORMANT · $0.00 / $10.00**, charged no rent |
| 3 | **SIMULATE FEES** +$100 | `AI ACTIVATED · OPERATOR unlocked`, treasury **$99.98**, runway 17.3 days, first step ran |
| 4 | **SIMULATE FEES** +$500 | `FABLE unlocked · $426.58 bought back and burned`, **8.53% of supply**, runway pinned to the 30-day floor |
| 5 | clicked `mock-strong` on the PRIME rung | model switched; the ladder shows `▸ mock-strong` |
| 6 | the public feed | `TST claimed $100.00…`, `unlocked SPARK…OPERATOR`, `activated`, `claimed $500.00`, `unlocked PRIME, FABLE`, `bought back and burned 85,316,937 $TST` |

The burn row on the profile carries a buy tx and a burn tx. Nothing on this path used a key.

## 1.4 Somebody can buy an agent, end to end

Also walked in the browser: `/buy` at $25 → name and directive → **GET A DEPOSIT ADDRESS** → the claim
code shown once → **SIMULATE PAYMENT** → spawned inside the same request → `/control/ag_…` asked for
the code → pasted it → the control board opened, the agent had already taken its first step, the
LIVE feed showed rent, inference and a failed `web_search` (no search key, at no cost — by design).
Before this pass, step 3 was impossible in demo mode (see 2.1).

## 1.5 The doctor and the boot preflight still refuse to lie

Unchanged from V2 and re-run here: `pnpm ready` on the example `.env` walks to the end, prints
PASS/FAIL per item with the fix for each, and exits 1 — as it must with no keys.

---

# 2. WHAT CHANGED IN THIS PASS

## 2.1 Three real bugs, found by using the product, fixed with tests

1. **The demo could not sell an agent.** The server judges "does this purchase project 21 days of
   life?" at the tier's own pace on purpose, so the 5-minute demo heartbeat does not refuse every
   purchase. The Buy page judged it on the number *you are shown*, which does include that heartbeat —
   so the button was disabled with "That projects to 5.6 days; the minimum is 21" for every normal
   amount, while the server would have accepted it. The quote now carries the exact figure the server
   gates on (`gateRunwayDays`) and the page uses that. Pinned by tests in `packages/shared` and
   `apps/api/test/payments`.
2. **A launched agent's "on-chain" balance was stale after every claim and burn.** The profile showed
   `on-chain $100.00` next to a treasury of $173.40 after the burn, because that figure was only
   refreshed by the agent's next heartbeat. The lifecycle pass now re-reads the wallet when it finishes
   moving money. The regression test failed before the fix (`expected 0 to be 14000000`) and passes after.
3. **Every purchase appeared twice in the live feed** ("TESTBUYER was bought for $25.00 — $22.50 into
   its treasury" and, one line later, "TESTBUYER was bought — $22.50 into its treasury"). The second
   line is the agent's birth and now reads as one: "was born with $22.50 in its treasury (SCOUT)".

## 2.2 The test suite is no longer fragile

V2's "the test suite is fragile when several things run it at once" is gone. Every database test
serialises on one Postgres lock, so running the files in parallel only made them queue and, on a slower
Postgres link, time out — **233 failures** on the first run here, all "timed out waiting for the test
database lock", not one real. The files now run one at a time. Wall time is unchanged (217 s), because
the lock was already serialising them.

## 2.3 `pnpm ready` now checks the launchpad

A new line, `Pons launchpad`, reads `launchEnabled()` and `maxCreatorTaxBps()` from the Pons factory
through the same call `/launch` uses. It passes when launches are open and your creator tax fits; warns
if Pons has paused launches; fails on mainnet if the factory does not answer; and warns on testnet with
the reason: Pons V2 is deployed on mainnet only, so a launch cannot be rehearsed there — use the
simulated chain.

## 2.4 The words now match the product

The homepage sells a launchpad; the rest of the site and the docs described only buying an agent.
- `/protocol` has a **THE LAUNCHPAD** rules table (launch fee, creator tax, fee recipient, activation,
  runway floor, minimum burn, buyback, model switch, withdrawals) read live from the server, and its
  intro, flow and footer cover both kinds of agent.
- The Creator Dashboard no longer says "TOKEN LAUNCHES COMING SOON" for a feature that is built and
  merely switched off by `TOKEN_LAUNCH_ENABLED`; it says that.
- `docs/LAUNCHPAD.md` now exists. The code cited it as "launchpad spec §N" in thirteen places and it
  was never written; it is reverse-engineered from the code, section numbers matching every citation.
- `README.md` explains the launchpad; `docs/OPERATIONS.md` is ported from Solana to Robinhood Chain,
  with an operator section for the `creator_fees` job and stuck launches; `docs/DECISIONS.md` records
  the chain port and the launchpad decisions (entries 68–75); the last Solana wording in code comments
  and test titles is gone.

## 2.5 Two more, found on 2026-09-24 by walking both flows again

1. **After a restart, the demo could not sell an agent.** `DEMO=1` derives every key from `DEMO_SEED`,
   so each boot replays the same addresses against a database that already holds the previous boot's.
   Agent wallets already skipped taken keys; deposit addresses did not, so the first purchase after a
   restart hit the unique index and the Buy page said "That purchase could not be created; please try
   again". Both now draw through one `unusedKeypair` (`apps/api/src/economy/wallets.ts`) that skips an
   address held by any agent or any purchase. Pinned by `test/payments/purchase.test.ts`.
2. **SIMULATE FEES +$100 did not unlock the $100 rung.** The credit was floored to the wei and the
   claim is booked in whole gwei, so $100 booked as $99.999999: OPERATOR, not PRIME — step 3 of 1.3
   above shows exactly that. The simulated credit now rounds up to the next gwei, so "+$100" books
   $100.000002 and unlocks PRIME. Pinned by `test/economy/launch.test.ts`. Simulator only; real fees
   are whatever the chain pays.

---

# 3. WHAT NEEDS KEYS

Unchanged from V2 and `KEYS-TO-BUY.md`, with one substitution: the chain is Robinhood Chain, not
Solana. In one screen:

| to unlock | buy / get | put in `.env` |
|---|---|---|
| agents that think | Anthropic, ~$20 | `ANTHROPIC_API_KEY`, `LLM_PROVIDER=router` |
| the SPARK tier's own model | OpenAI, ~$5 | `OPENAI_API_KEY` |
| `web_search` | Brave, free | `BRAVE_API_KEY`, `SEARCH_PROVIDER=brave` |
| real (test) money | testnet ETH + bridged test USDC | `CHAIN_MODE=robinhood`, `RHC_NETWORK=testnet`, `RHC_RPC_URL`, `USDC_ADDRESS`, the four wallets |
| real launches | mainnet only | `RHC_NETWORK=mainnet`, `ALLOW_MAINNET=1` — read `docs/OPERATIONS.md` first |
| isolated agent code | Docker | `SANDBOX_DRIVER=docker` after `docker build -t vantra-sandbox:latest docker/sandbox` |

After pasting anything, run `pnpm ready`.

---

# 4. WHAT IS STILL UNPROVEN

Everything in V2 §3 that was about a model or a network is still true, moved to the new chain:

- **No real model has ever been called.** Not on any provider. Same as V2 §3.1; same cure: one key.
- **No transaction has ever been signed on Robinhood Chain.** Not on testnet, not on mainnet. Reading
  the chain is exercised by the doctor; writing — sweeping a deposit, paying the founder fee, funding an
  agent, a launch, a claim, a swap, a burn — has only ever run against the in-memory chain. This pass
  added no chain keys and no money, so it could not change that.
- **No real Pons launch has ever happened.** The factory addresses and ABI were verified against
  mainnet by `eth_call`, and the launch → claim → burn loop is proven on the simulator (1.3), but the
  first real launch on mainnet is the first real launch. Testnet cannot rehearse it.
- **Container isolation** (V2 §3.4) is unchanged: this machine has no Docker at all, so the 43 tests that
  drive a real daemon were skipped here, not run.
- **Nobody has died in the seeded demo.** Now explained rather than merely noted (1.2), and still true.

## THE ONE-LINE VERSION

Both products run end to end on the simulator with zero keys — a stranger can launch a coin and watch
its AI wake, climb and burn, or buy an agent and open its control board — and the site, the docs and
the code now describe the same product. **One $20 key turns the brains on; one funded wallet turns the
money on.** Nobody has yet seen either happen for real.

---

*Contracts: `docs/SPEC-V2.md` (buying an agent), `docs/LAUNCHPAD.md` (the launchpad). Running it for
real: `docs/OPERATIONS.md`. The keys: `KEYS-TO-BUY.md`. Previous state: `docs/STATUS-V2.md`.*
