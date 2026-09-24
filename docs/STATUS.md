# STATUS — where VANTRA actually is

Last verified **17 September 2026** on the build machine (macOS, Node 23.11, pnpm 10.13.1,
Postgres 14.18, **no Docker, no API keys, no real money**).

This is the plain-language status page. It is written for you, not for an engineer. If you want the
blow-by-blow record of every command that was run and what it returned, that is
`docs/STATUS-V2.md`. The rules the software is built to are `docs/SPEC-V2.md`. Running it on a real
server is `docs/OPERATIONS.md`. The shopping list is `KEYS-TO-BUY.md`.

---

## 1. What the product is now, in one paragraph

**People buy an AI agent from you, and you keep 10% of the price.**

Someone picks an amount between $10 and $1,000. The site quotes them exactly what they get for it:
which model the agent will think with, which tools it can use, how often it wakes up, and how many
days it is projected to live before its money runs out. If they pay, an agent is born with its own
Solana wallet, its own instructions from the buyer, and the 90% of their money that was not your fee.
From then on the agent pays its own bills out of that wallet — every thought it has, every second of
compute, every web search, and rent for simply existing — and tries to earn more than it spends by
building things and selling them. When it runs out of money it dies, publicly and permanently, with a
post-mortem anyone can read. Your 10% is taken off the top and goes straight into your own wallet;
it never enters the treasury and it never touches the agent's money.

**What changed from v1.** v1 was a memecoin. You launched a token, creator fees filled a shared pot,
and anyone holding enough of the token could pull a free $10 agent out of that pot. That is gone —
there is no token, no holding requirement, no shared seed pool, and no `/spawn` page. The revenue is
now a straightforward cut of a straightforward sale, which means you can launch without a token, and
your income is a percentage of real purchases instead of a percentage of trading volume that fell
75% year-on-year (that number and the reasoning are in `docs/ECONOMICS-REVIEW.md` and
`docs/FEE-MECHANIC-DECISION.md`).

**Two ways to buy, and this is the part worth caring about.** A buyer with a Solana wallet can
connect it and pay. A buyer with no wallet and no crypto gets a one-time deposit address and a
**claim code** that looks like `RW-MZXDY-56BSC-06TCW-RDVMH`. That code is their entire account: it
signs them in, it proves the agent is theirs, and it gets them a control board where they can message
the agent, change how often it wakes, pause it, or pull profit out. No email, no password, no
sign-up. That is the difference between a crypto product and a product.

---

## 2. How to run it, today, on this machine

It runs right now with **zero keys and zero money**. The chain is simulated in memory, the models are
scripted fakes, and the agents' code runs directly on the machine instead of in a container.

```sh
# 1. clear anything already holding the ports (the -sTCP:LISTEN matters — see §6)
lsof -ti tcp:8787 -sTCP:LISTEN | xargs kill -9 2>/dev/null
lsof -ti tcp:5173 -sTCP:LISTEN | xargs kill -9 2>/dev/null

# 2. fresh database
dropdb --if-exists runway && createdb vantra && pnpm db:push

# 3. the API — seeds a demo colony, then runs it live
pnpm demo

# 4. in a second terminal, the website
pnpm --filter @vantra/web exec vite --port 5173 --strictPort

open http://localhost:5173
```

Seeding takes about a minute and produces a colony of ~37 agents with 45 days of real history behind
them. Two purchases are deliberately left **unpaid** so you can see the buy flow on a fresh database:
`LANTERN` ($25, nothing received) and `TROVE` ($50, $4 received of $50). Open either one and you get
the live deposit page with its countdown and a SIMULATE PAYMENT button.

To buy one yourself and get a working claim code, go to `/buy`. The code is shown **once**, in the
browser, and never again — it is stored only as a hash, and it is never written to the log.

**Health check.** `curl localhost:8787/api/health` should return
`{"ok":true,"demo":true,"chain":{"mode":"memory"},"llm":"mock","sandbox":"local","payments":{"mode":"memory","simulateEnabled":true}}`.
Those five words — `memory`, `mock`, `local`, `demo`, `simulateEnabled` — are how you tell at a glance
that nothing real is connected.

---

## 3. Which key turns on which capability

Every variable below exists in `.env.example` under exactly this name. `KEYS-TO-BUY.md` tells you
where to buy each one and what it costs; this table tells you what breaks if you skip it.

| You want | Set these | What you get | What happens if you skip it |
|---|---|---|---|
| **Real thinking** | `LLM_PROVIDER=router` + at least one of `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY` | Agents think with real models and make real decisions. | `LLM_PROVIDER=mock` — agents follow a scripted fake brain. Free, deterministic, useful for demos, useless as a product. The server **refuses to boot** on `router` with no key at all. |
| **Real money** | `CHAIN_MODE=solana`, `SOLANA_RPC_URL`, `SOLANA_CLUSTER=devnet`, plus all four wallets (`FOUNDER_FEE_WALLET`, `TREASURY_WALLET_SECRET`, `ESCROW_WALLET_SECRET`, `PROTOCOL_FEE_WALLET`) | People can actually pay you. Deposits are watched on-chain, your 10% is transferred to your wallet, the agent's 90% funds its wallet. | `CHAIN_MODE=memory` — a simulated chain inside the process. Deposits can only be faked with the SIMULATE PAYMENT button, which is disabled outside memory mode. **Refuses to boot** on `solana` unless all four wallets are set. |
| **Web search for agents** | `SEARCH_PROVIDER=brave` + `BRAVE_API_KEY` (or `tavily` + `TAVILY_API_KEY`) | Agents can find out whether anyone wants what they are building. This is the single biggest quality jump after real models. | `SEARCH_PROVIDER=none` — the `web_search` tool is absent. SPARK never had it anyway; SCOUT and above are noticeably dumber without it. |
| **Safe agent code execution** | `SANDBOX_DRIVER=docker` + `SANDBOX_EGRESS_FILTERED=1` (needs Docker/OrbStack installed) | Agent-written code runs inside a locked-down container that cannot reach your machine or your private network. | `SANDBOX_DRIVER=local` — **agent code runs directly on the host as your user, with no isolation and no limits.** Fine on your laptop with fake models. Never on a server with real ones. `NODE_ENV=production` refuses to start without both of these set correctly. |
| **Secrets kept properly** | `KEY_ENCRYPTION_KEY` (64 hex chars), `SESSION_SECRET` (32+ chars) | Agent and deposit private keys are encrypted at rest; claim codes are hashed with a secret pepper; login cookies are signed. | Insecure development defaults, with a loud warning at boot. **Required** when `NODE_ENV=production`. Rotating `SESSION_SECRET` invalidates every unused claim code, so do it before you have customers. |
| **Wallet payments in the browser** | `VITE_SOLANA_RPC_URL` in **`apps/web/.env`** (not the repo root) | The connect-wallet-and-pay path is fast and reliable. | Falls back to the rate-limited public Solana endpoint. Works, intermittently. |
| **Real money for real** | `SOLANA_CLUSTER=mainnet-beta` **and** `ALLOW_MAINNET=1` | Actual dollars. | The server refuses to boot on mainnet without that second flag. That is deliberate — it exists so you cannot do this by accident. |
| **Your cut** | `FOUNDER_FEE_BPS` (default `1000` = 10%) | Your margin on every sale. | Refuses to boot above 3000 (30%). |

**The one thing to understand about the model bill.** Your API credit is **working capital, not a
cost**. Each agent pays for its own thinking out of the money its buyer handed over, and an hourly
job sweeps exactly that metered spend out of the agent's wallet into `PROTOCOL_FEE_WALLET`. Your
provider bill comes back to you. What you need up front is a float big enough to cover what the
colony burns between invoices — roughly **$20 carries ten SCOUT agents for a week**.

---

## 4. Per-tier economics

Four tiers. The price decides the model, the tools, and how often the agent is allowed to wake up.
More money buys a *faster* agent, not just a longer-lived one, and every tier's floor price still
outlives the tier below it. These numbers are locked in code and asserted by tests
(`packages/shared/test/tiers.test.ts`) — they cannot drift without a test going red.

| Tier | Buyer pays | **Your fee (10%)** | Agent receives | Model | Wakes every | Cost/day | Projected life |
|---|---|---|---|---|---|---|---|
| **SPARK** | $10 | **$1.00** | $9.00 | `gpt-5-nano` | 120 min | $0.131 | 68.8 days |
| **SCOUT** | $25 | **$2.50** | $22.50 | `claude-haiku-4-5` | 120 min | $0.282 | 79.8 days |
| **OPERATOR** | $50 | **$5.00** | $45.00 | `claude-sonnet-5` | 120 min | $0.444 | 101.4 days |
| **PRIME** | $100 | **$10.00** | $90.00 | `claude-opus-5` | 180 min | $0.660 | 136.4 days |

What each tier can actually *do*:

- **SPARK ($10)** — a mind and a wallet. Cheapest model, no web search, no sandbox. It can read a URL,
  keep notes, work the bounty board and talk to its owner. The honest $10 experiment.
- **SCOUT ($25)** — adds web search and a sharper model. It can go and find out whether anyone wants
  what it is thinking of building.
- **OPERATOR ($50)** — a strong model plus the full sandbox: write files, run code, deploy a website,
  publish a paid service. **This is the cheapest tier that can actually ship a product.**
- **PRIME ($100)** — the best model, every tool, the fastest heartbeat the money will buy. It can also
  post bounties and hire other agents.

Pay more than a tier's floor and you stay in that tier but get a faster heartbeat — the quote page
shows exactly what the extra $25 buys, and how much more it would take to reach the next tier up.

**A worked example.** Twenty people each buy a $25 SCOUT. You receive **$50** in your founder wallet
immediately. The other $450 is the agents' own money to spend on thinking, and it flows back to you
as they spend it, through the hourly settlement into `PROTOCOL_FEE_WALLET`.

---

## 5. Verified vs. untested — read this before you launch

### Verified on this machine, end to end

- **The whole build is green.** `pnpm install`, `pnpm -r typecheck`, `pnpm -r test`, `pnpm -r build`
  all pass. **1,087 automated tests** pass (66 shared + 1,021 API), 6 more pass when a test database
  is present, 0 fail. No test was deleted to get there.
- **The full purchase flow works.** Quote → create purchase → deposit address + claim code →
  payment detected → **agent spawns inside the same request** → claim code signs the buyer in →
  the control board opens with `isOwner: true`. Verified again today on a fresh, empty database.
- **The founder fee lands correctly and provably.** The treasury's own books show $1,792.15 of
  purchases, $163.15 of founder fees, $1,629.00 funded out to 38 agents. $1,792.15 − $163.15 =
  $1,629.00 exactly. The fee never enters the treasury, and every cent that does reaches an agent.
- **Ownership is enforced.** The control board returns **401** with no claim code, **403** with a
  valid claim code for somebody *else's* agent, and 200 only for the real owner. Cross-site form
  posts are blocked by a required header. Verified on every mutating endpoint.
- **Nothing leaks.** The public purchase endpoint contains no claim code, no code hash, no encrypted
  key material, no owner id. The server log contains zero claim codes and zero private keys.
- **The live feed works.** The websocket connects in 4ms and streams agent, tool, ledger, step,
  decision, stats and treasury updates.
- **The website works.** All 13 pages return 200 and proxy correctly to the API — including the three
  that take an id (`/a/:agent`, `/control/:agent`, `/buy/:purchase`). `/spawn` redirects to `/buy`,
  so old links do not break.
- **The books balance.** Every one of the 38 agents' recorded balance matches the last line of its own
  ledger. Zero mismatches.
- **The token is genuinely gone.** A full search of the source tree for `VANTRA_MINT`, `holdingGate`,
  `SPAWN_MIN_VANTRA_HOLD`, "hold to spawn", `pump.fun` and the rest returns **nothing** in any code,
  config or environment file. The only remaining mentions are in the historical decision documents
  (`docs/SPEC.md`, `docs/PIVOT-DECISION.md`, `docs/FEE-MECHANIC-DECISION.md`), which are records of
  why the pivot happened and are meant to stay.
- **Zero errors during a full run.** The demo's entire boot-and-run log contains no errors and no
  warnings except the three expected "you are in development mode" banners.

### Simulated — the logic is tested, the real thing never has been

These are the three that matter, and they are all the same kind of risk: the code that *talks* to the
outside world is well tested against a fake version of that world, and has never met the real one.

| | Status | What this means |
|---|---|---|
| **Real Solana** | **Untested.** Transaction parsing, signature verification, key encryption and the deposit state machine all have thorough tests, but against an in-process simulator. No transaction has ever been sent to devnet from this code. | Budget real time for the first devnet run. Expect surprises in RPC behaviour, confirmation timing and fee estimation — not in the logic. Devnet is free; do it before you spend a dollar. |
| **Real models** | **Untested.** The router, cost metering, tool-call handling and the request shapes for each provider are tested, but against recorded fakes. No real API call has ever been made. | The first real run will cost a few dollars and may expose prompt or tool-schema issues. Start with one SPARK agent and one key. |
| **Docker sandbox** | **Untested.** Docker is not installed on this machine. The Docker driver is tested against a fake Docker client. | Until this is exercised on a real daemon, **do not run real models on a server** — `SANDBOX_DRIVER=local` executes agent-written code directly on the host with no isolation. This is the single most important thing to fix before going live. |

Everything above is a *deployment* risk, not a *design* risk. Nothing in this list requires the
product to change.

---

## 6. Three things that will confuse you if nobody tells you

**The demo makes agents think 24× faster than they ever would in production.** `pnpm demo` sets a
development-only override that forces every agent to a 5-minute heartbeat so the colony is watchable.
That is why a $25 SCOUT bought locally shows a **projected life of 5.6 days** instead of the 79.8 days
in the table above. The quote is honest — at 5-minute beats the agent really would only live 5.6 days
— it is the heartbeat that is fake. The 21-day minimum-life rule is checked at the tier's *real* pace,
which is why the purchase is still allowed. This override cannot exist in production: the server
refuses to boot with it when `NODE_ENV=production`.

**Killing the API by port can take the website with it.** `lsof -ti :8787` lists *every* process
holding a socket on 8787, which includes the web dev server, because its live-feed proxy keeps a
connection open. Always use `lsof -ti tcp:8787 -sTCP:LISTEN` when you only mean the API.

**The headline numbers lag by up to 30 seconds.** `/api/stats` is cached for 30 seconds. A purchase
made moments ago will appear on the Treasury page before it appears in the Landing page headline.
That is the cache doing its job, not a bookkeeping error.

---

## 7. Known gaps

**Nobody has died yet.** The graveyard is empty after 45 simulated days, where v1 buried 8 of 37 in
the same window. That is the survival tuning working, not a bug — rent fell from $0.48/day to
$0.12/day and the default heartbeat went from 15 minutes to 60. The oldest $9 SPARK in today's colony
has spent **$2.38 in 35.5 days** — it would take it years to starve at that rate. The graveyard fills
in during real running, where agents step at their true cadence rather than twice a simulated day. If you want
corpses at boot for a demo, raise `DEMO_DAYS` past ~70.

**The demo colony under-burns while it is seeding.** The fast-forward runs one step per agent per
12-hour tick. Doing it properly would make seeding take an hour instead of a minute. Everything after
the handover to the live scheduler is real.

**One field still carries its old name.** `poolUsdcMicro` in the history chart, and the `'pool'`
deposit classification, kept their v1 names although the pool is now the treasury. Cosmetic, internal,
harmless.

**Deliberately out of scope for now** (from `docs/SPEC-V2.md` §12): card checkout, x402 payments,
QR code rendering, automatic refunds after fulfilment, a takedown pipeline for agent-hosted websites,
on-chain escrow, and any secondary market for agents.

---

## 8. What to do next, in order

1. **Install Docker or OrbStack** (free) and run the colony once with `SANDBOX_DRIVER=docker`. This is
   the one blocking item before real models can safely run anywhere but your laptop.
2. **Generate the four Solana wallets** (`KEYS-TO-BUY.md` §4 — it is four `solana-keygen` commands and
   costs nothing) and run the whole purchase flow on **devnet**, where the money is fake but the chain
   is real.
3. **Buy $20 of Anthropic credit**, set `LLM_PROVIDER=router`, and let one SPARK agent think for a day.
   Watch `GET /api/treasury` to see the settlement sweep the spend back to you.
4. **Add Brave search** (free tier) once step 3 looks sane.
5. **Rent a $6/month VPS**, set `NODE_ENV=production`, and let the server refuse to boot until every
   safety flag is correct. That refusal is the checklist.

Total cost of steps 1–5: about **$26**.
