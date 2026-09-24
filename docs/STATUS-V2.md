# WHERE VANTRA ACTUALLY STANDS

Written for you, not for an engineer. Every number below came from running the thing on
**2026-09-18** on this Mac (Darwin 25.5, Node 23.11, pnpm 10.13.1, Postgres 14.18, OrbStack 29.4.0,
solana-cli 2.1) with **no LLM API keys of any kind**.

The rule I worked to is yours: *"I don't want no fallback nothing. Just get the app ready to the point
where if I add keys, it works."* So this document has three sections and they are in the order you
should read them:

1. **WHAT IS PROVEN TO WORK** — things I ran, with what came back.
2. **WHAT NEEDS KEYS** — which key unlocks what, and what it costs.
3. **WHAT IS STILL UNPROVEN** — things nobody has ever watched work, and what it would take.

If a line is not in section 1, treat it as not proven. I have not put anything in section 1 that I did
not watch happen.

---

## THE ONE CHANGE THAT MATTERS IN THIS PASS

**The app will no longer pretend.** Before today, if you pasted an Anthropic key into `.env` and
forgot to also change `LLM_PROVIDER=mock` to `LLM_PROVIDER=router`, everything started up perfectly,
the dashboard looked alive, agents "thought" and "decided" — and every single one of them was reading
from a canned script. Your key was never called. Nothing anywhere told you.

That is now impossible. There is a check that runs before the server opens its door, and it refuses to
start on any configuration where you would believe you were running for real and were not. It prints
the problem and the exact line to change, and nothing else.

Here is one, verbatim, from a real run:

```
VANTRA refuses to start. 1 configuration problem would make it look like it was running for real
when it is not:

  1. ANTHROPIC_API_KEY is set, but LLM_PROVIDER=mock — every agent would think with a canned
     script and the key would never be called
     FIX: Set LLM_PROVIDER=router in .env to use the key, or remove the key if you meant to stay
     on the mock. `pnpm demo` forces the mock deliberately and is exempt from this check.

Run `pnpm ready` for the full report.
```

`pnpm demo` is the single deliberate exception, and it is exempt on purpose — see section 1.

---

# 1. WHAT IS PROVEN TO WORK

## 1.1 The demo runs, right now, with zero keys

This is how you show the product before paying for anything. I wiped the database and ran it from
scratch:

```
dropdb --if-exists runway && createdb vantra     # 22 tables after pnpm db:push
pnpm demo                                        # API on :8787
pnpm --filter @vantra/web exec vite --port 5173 --strictPort
```

**Both are running as I write this.** `curl localhost:8787/api/health` → `200`, `curl localhost:5173/`
→ `200`.

Seeding took **66 seconds** (`05:09:25` → `05:10:31`, "demo colony ready; the live scheduler has it
now"). What it produced, read live from `/api/stats`:

| | |
|---|---|
| agents | **38 born · 38 alive · 0 dead · 4 sleeping** |
| bought | 38 purchases, **$1,792.15** gross |
| your cut | **$163.15** of founder fees |
| spent by agents | $149.83 on inference, rent, compute, tools and hosting |
| earned from outside | $37.20 |
| treasury float | $2,000.00 |

The live socket works: a capture on `ws://localhost:8787/ws` returned frames of type `hello`, `stats`,
`treasury`, `ledger`, `agent`, `step_start`, `step`, `tool`, `decision`, `event` — and the same
through the web server's proxy on `:5173`, which is what the browser actually uses.

## 1.2 Somebody can buy an agent, end to end

I walked the whole purchase on the running demo. Every line here is a real HTTP response:

| step | what I did | what came back |
|---|---|---|
| 1 | `GET /api/tiers` | 4 tiers, each naming the model it will really run |
| 2 | `POST /api/quote` $25 | tier `SCOUT`, fee **$2.50**, funding **$22.50**, 5.6 days of runway, a death date |
| 3 | `POST /api/purchases` | `pu_9i62m40bx0`, a deposit address, a `RW-…` claim code shown **once** |
| 4 | `POST /…/simulate-pay` | `spawned` **inside the same request**, agent `ag_6jbusu76qj`, tier `SCOUT` |
| 5 | `GET /api/purchases/:id` | no claim code, no deposit secret, no owner id anywhere in the payload |
| 6 | `POST /api/claim` with the code | signed in as `claim_pu_9i62m40bx0`, 1 agent, session cookie set |
| 7 | `GET /api/agents/:id` signed in | `HARDENER19242`, `isOwner: true`, $22.48 treasury, 5-minute heartbeat |
| 8 | `POST /…/message` | `{"ok": true}` |
| 9 | same agent, **not** signed in | `isOwner: false`; the public live view still answers `200` |
| 10 | every other public route | `/api/stats`, `/stats/series`, `/agents`, `/graveyard`, `/events`, `/treasury`, `/treasury/txs`, `/market/bounties`, `/market/services`, `/models`, `/leaderboard`, `/tiers` — **all 200** |

$2.50 + $22.50 = $25.00. Your fee never touches the treasury; it goes straight to your wallet.

## 1.3 The app refuses to start when it would be lying to you

I ran the **built** server — the real one, `node dist/index.js`, not a test — seven times with a
deliberately wrong `.env`. All seven refused, with exit code 1 and a plain-English reason:

| what I broke | what it said |
|---|---|
| `LLM_PROVIDER=router`, no key at all | `needs at least one of ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY` |
| `CHAIN_MODE=solana`, no RPC address | `SOLANA_RPC_URL is required when CHAIN_MODE=solana: name the endpoint explicitly rather than inheriting the devnet default` |
| `SANDBOX_DRIVER=docker`, Docker not running | `the Docker daemon did not answer … FIX: Start Docker (OrbStack or Docker Desktop) and check docker info` |
| a key pasted, mode still `mock` | `every agent would think with a canned script and the key would never be called` |
| wallets set up, chain still simulated | `deposit addresses are fake, no USDC moves and no founder fee is ever paid` |
| `mainnet` selected, test-network address | **two** problems: the address names devnet, and the network itself answered as devnet |
| real chain on the built-in dev secrets | **three** problems: the encryption key is a public constant in this repo, so is the session secret, and agent code would run unsandboxed on the host |

That last one matters more than it looks. The encryption key protects every agent wallet in your
database. The old behaviour was a warning in a log nobody reads. It is now a refusal, and it says
*"before any wallet is stored — it cannot be changed afterwards without losing every stored secret."*

**`pnpm demo` is exempt from the "you set a key but are not using it" family, on purpose.** It forces
the whole simulated stack itself, so it keeps working with a completely full `.env`. That is what makes
it safe to show the product on a laptop that also has your real keys sitting in the file.

## 1.4 The screen tells the truth about what you are looking at

The amber banner across the top used to be picked from a table keyed on one thing. It now states three
separate facts, each of which has been checked, and it only disappears when all three are real:

- `DEMO COLONY · SEEDED, NOT REAL CUSTOMERS`
- `SIMULATED CHAIN · NO REAL MONEY` (or `DEVNET · TEST USDC, NOT REAL MONEY`)
- `MOCK BRAINS · AGENTS ARE SCRIPTED, NOT THINKING`

The old version had a real hole: on devnet it said "DEVNET · CIRCLE TEST USDC" and **said nothing at
all about the agents being scripted.** You could have wallets, a real network, a real dashboard, and
mock brains, and the screen would not have mentioned it. There is also a new mode chip in the top bar
next to your treasury figure — `DEMO`, `SIM`, `DEVNET` or `MAINNET` — amber for everything except
`MAINNET`, so no number in that bar can be mistaken for real money.

## 1.5 `pnpm ready` checks everything and crashes at nothing

Run with no keys present. It took the report to the end, printed **21 passed · 5 failed · 2 warnings ·
4 skipped**, ended with `NOT READY` and a numbered to-do list, and exited 1. It found exactly the four
things that are genuinely missing (no brain, `LLM_PROVIDER=mock`, treasury holds 0 SOL, agent network
not firewalled) and nothing else.

> Type **`pnpm ready`**, not `pnpm doctor`. `doctor` is a name pnpm has taken for itself — that form
> runs pnpm's own unrelated check and exits 0, which looks like an all-clear and is not one.
> `pnpm run doctor` also works; the word `run` is what forces it.

Every PASS in that report was produced by doing the thing, not by reading a setting:

- **Postgres** — real connection, `PostgreSQL 14.18`, all 22 tables present.
- **Solana** — real request to devnet, `solana-core 4.3.0-rc.0`; it asked the network for its identity
  rather than trusting the address, and the answer matched `devnet`; USDC confirmed on-chain as a real
  token with 6 decimals; rent priced live at 0.00148844 SOL per agent token account.
- **Docker** — engine 29.4.0, image `vantra-sandbox:latest` (134 MB) found, and then a **real container
  started**, ran a command as the `agent` user, wrote a file and read it back.

## 1.6 The sandbox is really locked down, in the kernel

Read from *inside* a running container, not from the request that created it: all Linux capabilities
dropped to zero, no-new-privileges on, memory capped at 512 MB, processes capped at 256, CPU capped at
half a core, running as user 1000, root filesystem read-only (`touch /rootfile` → "Read-only file
system") while `/tmp` and `/work` are writable. All six cloud-metadata addresses resolve to nowhere.
**106 sandbox tests pass, including 43 driven against the real daemon.**

## 1.7 Four real bugs found and fixed in this pass

1. **A refund could have been redirected to a stranger.** When one transaction pays a deposit address,
   the code picks which sender to refund. It used to take whichever leg the network happened to list
   first. Anyone could have attached a one-hundredth-of-a-cent payment to someone else's $100 deposit
   and had the entire refund sent to themselves. It now takes the *largest* payment, which makes the
   attack cost more than it can win, and it writes an error line naming every sender when a single
   transaction genuinely comes from more than one.
2. **A conversation that outgrew the model burned a second paid call.** Two different failures were
   being reported as the same thing: "your reply was too long" (cure: allow a longer reply) and "the
   conversation no longer fits" (cure: definitely not that). The app retried the second one at double
   the length, which is guaranteed to fail again and costs real money. They are now separate.
3. **The container's own error text was handed to the agent as program output.** When Docker cannot
   start a process at all, it writes its own error onto the same channel a program's output comes out
   of. An agent would read "Cannot fork" as the result of its own code and act on it. I proved the
   exact behaviour against the real daemon — a missing program gives
   `{"exitCode":127,"pid":0,"out":"OCI runtime exec failed…"}` while a program that genuinely runs and
   fails gives `{"exitCode":127,"pid":86824}` — and used that difference, not a guess at the wording,
   to tell them apart. It is now reported as an error, not output, with a distinct code.
4. **Deposit history could be silently truncated.** Scanning a very busy wallet stops after 5,000
   transactions. It used to stop in silence, which is indistinguishable from "there is nothing older".
   It now says so, loudly, and names the oldest transaction it saw.

## 1.8 The four gates, run in order, all green

```
pnpm install      clean
pnpm -r typecheck @vantra/shared, @vantra/api, @vantra/web — 0 errors
pnpm -r test      shared 66 passed · api 1,350 passed, 0 failed (47 gated, see below)
pnpm -r build     shared + api compiled, web built 592 modules
```

**1,416 tests green.** Machine-checked from the test runner's own JSON, not read off the screen:
`numTotalTests 1397, numPassedTests 1350, numFailedTests 0` for the API, plus 66 in shared. That is up
from 1,087 when this pass started, and **no test was deleted or weakened** to get there.

Of the 47 that sit out a normal run, I ran two of the four groups and they pass too: the database
group (**6 passed** with a test database) and the live OpenRouter group (**14 passed** against
openrouter.ai's real public catalogue, just now). The remaining 27 need a funded devnet wallet — see
section 3.

---

# 2. WHAT NEEDS KEYS

Everything here is quoted from `KEYS-TO-BUY.md`, which is the step-by-step version with the buttons to
click. After pasting anything, run `pnpm ready`.

## The one that turns it into a product — about $20

> **Anthropic — $20 of credit (start here)** · console.anthropic.com → Billing → then API keys →
> Create key · put it in `.env` as `ANTHROPIC_API_KEY`
>
> Then set `LLM_PROVIDER=router`.

**This is the only item on the list that is really a purchase.** It unlocks: agents that actually
think; three of your four price tiers; the cost accounting on every step; and the one check in
`pnpm ready` that has never run.

Each tier is sold with a named model, and Anthropic covers three of them:

| tier | buyer pays | model it is sold with | whose key |
|---|---|---|---|
| SPARK | $10 | `gpt-5-nano` | OpenAI |
| SCOUT | $25 | `claude-haiku-4-5` | **Anthropic** |
| OPERATOR | $50 | `claude-sonnet-5` | **Anthropic** |
| PRIME | $100 | `claude-opus-5` | **Anthropic** |

If a tier's model is missing, it substitutes a different one rather than refusing to sell. That is
deliberate and the buyer is shown the real model on the tier list — but it is no longer quiet. On the
demo running right now the boot log says, once per tier:

```
tier PRIME is sold with claude-opus-5 but will run mock-strong — buyers are shown the substitute
on /api/tiers
```

`pnpm ready` reports the same thing. If you only ever buy the Anthropic key, expect to see that line
for SPARK, and decide whether you mind.

Optional, cheap, and only if you want the fourth tier and a cheap fallback:

> OpenAI — $5 of credit · platform.openai.com → Billing · `OPENAI_API_KEY`
> OpenRouter — $5 of credit · openrouter.ai/credits · `OPENROUTER_API_KEY`

## Free, but agents are much worse without it

> **Brave Search** · brave.com/search/api · Free plan: 2,000 queries/month (card required, charges
> $0) · `BRAVE_API_KEY` — then set `SEARCH_PROVIDER=brave`.

Unlocks the `web_search` tool for SCOUT and above. Without it they cannot go and find out whether
anyone wants what they are building. Paste the key and leave `SEARCH_PROVIDER=none` and the server now
refuses to start rather than letting the key sit unused.

## Free — the Solana connection

> Helius · helius.dev → dashboard · `SOLANA_RPC_URL=https://devnet.helius-rpc.com/?api-key=YOURKEY`

The free public address `https://api.devnet.solana.com` works and is what is in your `.env` today. It
is rate limited and not good enough for anything real. **You now have to type this line in** — leaving
it blank used to mean "quietly use the test network", which is how a live deployment ends up reading
the wrong chain.

## Free — but a human has to click it

- **Devnet SOL.** Your treasury `334Zcj5Cg4HBceowmWqCgFPTMximZ7VQ4inuSxbcibkR` holds **0 SOL** and
  cannot pay a single transaction fee. I tried the automatic route 24 more times today across two
  amounts; every one came back rate limited. Go to **faucet.solana.com** in a browser (it signs you in
  with GitHub) and send some to that address. This is the single thing standing between "proven on a
  local copy of Solana" and "proven on the real test network".
- **Devnet USDC.** **faucet.circle.com** → pick Solana Devnet → 20 USDC every 2 hours, to the same
  address. It is a web form; it cannot be automated from here.

## Free — containers

> Install **OrbStack** (orbstack.dev) and open it once. Build the image, once:
> `docker build -t vantra-sandbox:latest docker/sandbox`. Then set `SANDBOX_DRIVER=docker`.

Already done on this machine and proven working. `SANDBOX_DRIVER=docker` with Docker not running is
now a refusal at startup rather than a surprise the first time an agent runs code.

---

# 3. WHAT IS STILL UNPROVEN

Read this section as the honest list. Nothing here is broken as far as anyone knows — it is the list of
things **nobody has ever watched work**, and what it would take to watch them.

## 3.1 No real model has ever been called. Not once. On any provider.

This is the big one and there is no way around it: there are no keys on this machine.

I went as far as the services allow without one. The wire format — the exact JSON the app sends — is
pinned by tests that build the real Anthropic and OpenAI client libraries and capture what they
actually put on the network, so the shape is known to survive the library. And real HTTPS requests were
made to all three services: Anthropic answered `401 authentication_error`, OpenAI answered
`401 Incorrect API key provided`, OpenRouter answered `401`. That proves the app reaches the right
address, sends credentials the right way, and handles a rejection correctly.

It does **not** prove a successful call. Specifically unproven:

- That a completion comes back at all.
- That the token counts and the money arithmetic match what the provider actually bills. The line in
  `pnpm ready` that prints "model, speed, real cost" has **never executed**.
- That prompt caching works. The app warns when a cache read comes back empty, but whether the cache
  is being hit can only be seen with a key.
- **The four OpenAI models are entirely unverified** — that those model names exist, that their prices
  are right, that they accept the combination of settings the app sends. If OpenAI is the first key you
  add, that is the path most likely to fail on the first call.

**What it would take:** one Anthropic key and about a dollar. Run `pnpm ready`. The first thing you
should do after pasting a key is watch that line go green, and treat it as code that has never run,
because it is.

## 3.2 No transaction has ever been signed on the real Solana test network

Reading the network is proven — balances, the network's identity, the USDC token, transaction history,
rate-limit recovery, all against the real public devnet endpoint.

**Writing is not.** Sending USDC, creating token accounts, sweeping a deposit, paying your founder fee,
funding an agent, refunding an underpayment — none of that has ever run on devnet, because the wallet
has 0 SOL and the free faucet has refused every request from this internet connection (60 attempts
across two addresses in earlier sessions, 24 more today, all rate limited).

What *was* done: every one of those operations was proven against a **full copy of Solana running
locally** — the same software, the same real token programs — including a complete purchase: money
arrives, gets swept, your fee lands in your wallet, the agent is funded, the deposit is emptied.

The difference between that and the real test network is real network delay, real congestion, real
competition for block space. Those are exactly the conditions the retry logic exists for.

**What it would take:** put devnet SOL in
`334Zcj5Cg4HBceowmWqCgFPTMximZ7VQ4inuSxbcibkR` from faucet.solana.com in a browser, then re-run the
write tests pointed at devnet. One command, already written. It is genuinely the last step.

Also unproven, same cause: **no real Circle USDC has ever moved.** The write tests used a stand-in
token the tester created. Circle's devnet USDC has been read from the real network, and it is an
ordinary 6-decimal token, so this should be identical — but "should be" is not proof.

## 3.3 Mainnet — real money — has never been touched

No part of the real-money path has ever run: not the mainnet network check, not a mainnet purchase, not
the "READY FOR REAL MONEY" verdict. Nobody has seen that screen. The guard rails are real (you must set
`ALLOW_MAINNET=1` out loud, and the app refuses mock brains on mainnet), but the path itself is
untravelled.

**What it would take:** devnet purchases working end to end first, then a small real purchase you make
yourself and watch.

## 3.4 Two things about container isolation that this Mac cannot answer

1. **Agents can currently reach each other.** The containers are put on a network created with
   agent-to-agent traffic switched off, and the daemon confirms it recorded that setting — but on
   OrbStack (the Docker used here) one container could still reach another. The setting is correct and
   standard Docker on a Linux server should honour it; **that has to be re-checked on the real server.**
   No test claims isolation, deliberately, because it would be a false pass.
2. **Half the outbound firewall is not installed.** The app knows which addresses agents must not be
   able to reach and can print the exact firewall rules, but those rules are a Linux thing and this is a
   Mac. They have never been switched on, so it has never been proven they block anything. The server
   refuses to start in production without you confirming they are installed, and the boot log says so
   plainly every time it starts without them.

**What it would take:** a Linux server, the rules from `docs/OPERATIONS.md`, and one command each to
confirm they are in place.

## 3.5 Smaller things, listed so they are not forgotten

- **A command that leaves something running in the background costs an agent its whole time budget.**
  `npm run dev &` returns only when the clock runs out. Known, pinned by a test as current behaviour,
  not redesigned.
- **One safety net in the container code has never fired.** If a command ignores its own timeout, the
  host kills the container. Three different attempts failed to make a real container ignore its timeout,
  so that path is covered only by a stand-in. It has never run against a real daemon.
- **A container whose process table is exhausted does not repair itself.** Containment works and the
  machine stays healthy, but the only cure is destroying and recreating the container. The error is now
  reported honestly (see 1.7) instead of being disguised as program output, but nothing fixes it
  automatically.
- **Web search has only ever failed.** A bad key gets a correct rejection from Brave's real service.
  A successful search has never run.
- **One Anthropic model has a condition attached that only shows up on the first call.**
  `claude-fable-5-1` needs 30-day data retention on your Anthropic account; without it, every call
  fails. It is not in the default set and you would have to add it on purpose — and if you do, the boot
  log now warns you.
- **The test suite is fragile when several things run it at once.** All the database tests share one
  lock. Run alone (as above) they are green; run while something else is hammering the same database,
  they time out. That is a test-harness problem, not an application one, but it will bite on a build
  server.
- **Nobody has died.** After 45 simulated days the graveyard is empty. That is the survival tuning
  working as designed, not a bug — but it means the death and post-mortem path has only been exercised
  by tests, not by the demo.

---

## THE ONE-LINE VERSION

The product runs, a stranger can buy an agent and it works end to end, and the app can no longer fool
you about which of its parts are real. **One $20 Anthropic key turns the agents on; one browser visit
to a faucet turns the money on.** Until those two things happen, nobody — including me — has seen a
real model answer or a real transaction settle, and this document says so on purpose.

---

*The contract this is measured against is `docs/SPEC-V2.md`. Running it for real is `docs/OPERATIONS.md`.
The keys are `KEYS-TO-BUY.md`. The v1 record is `docs/STATUS.md` and its numbers are superseded
wherever the two disagree.*
