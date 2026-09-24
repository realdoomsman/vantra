# Fee-mechanic decision — THE SPLIT

Produced 2026-09-16. Brief: not a game, clever with creator fees, novel in crypto, interactive
daily, honest (no payouts), degen audience. 18 concepts from 6 lenses; 3 judges; prior-art search;
synthesis. 15 agents, 0 errors.

> CAVEAT: the prior-art stage received the wrong payloads (it researched the seed concept 'THE ENGINE'
> and TONTINE instead of THE SPLIT). The synthesis's claim that THE SPLIT 'came back clean' is NOT
> verified by that stage. A direct prior-art check on THE SPLIT was run separately — see the
> 'Prior art (direct check)' section appended at the end of this file.

## Ranking (mean of 3 judges /70, worst judge, novelty /10)

| Concept | Mean | Worst | Novelty |
|---|---|---|---|
| THE SPLIT — nine organs, nine wallets (ballot + direct feeding) | 61 | 61 | 8 |
| THE SPLIT — nine organs, nine wallets (interaction lens) | 58 | 58 | 8.5 |
| THE SPLIT — an AI with ten organs, each one a fee wallet (IMPULSE variant) | 57 | 57 | 8 |
| THE SPLIT — an AI with ten organs, each one a fee wallet (prior-art lens) | 56 | 56 | 8.5 |
| THE SPLIT — a mind whose brain budget is the on-chain fee split (nine organs, inter-organ billing) | 56 | 56 | 8 |
| THE SPLIT — a mind whose brain budget is the on-chain fee split (tech-novelty lens) | 55.5 | 55 | 8.5 |
| DOSAGE — a public dose–response curve for intelligence | 54 | 51 | 7 |
| LETHE (the mind that must forget) | 54 | 52 | 8 |
| WETWARE — a human as a priced entry in the tool registry | 53 | 53 | 10 |
| LETHE — the mind that must forget | 53 | 53 | 9 |

## Prior-art verdicts from the workflow stage (note: wrong payloads, see caveat)

- **TONTINE (reconstructed from docs/PIVOT-DECISION.md — the CONCEPT f** → new combination
  - AI BIG BROTHER (aibigbrother.fun) (very close)
  - AI Diplomacy (Every / GoodStartLabs, streamed on Twitch) (very close)
  - Freysa (0xfreysa, Base) (very close)
- **UNKNOWN — concept payload was `undefined` (researched seed concept "THE ENGINE" as proxy)** → new combination
  - Virtuals Protocol — Agent Inference Payments / compute account (very close)
  - ClawPump (clawpump.tech / clawpump.net) (very close)
  - BottoDAO (Botto, autonomous AI artist) (related)
- **TONTINE (the VANTRA pivot) — 12 LLM agents sharing one escrowed USDC pot that only survivo** → new combination
  - AI Big Brother (very close)
  - Freysa — Act IV (AI Twins society) (very close)
  - Dutch AI Agents — "Live public USDC runway" (same thing)
- **INPUT MISSING - concept arrived as literal "undefined"; researched the founder's seed conc** → new combination
  - Virtuals Protocol (agent tokens, Base/Solana) (very close)
  - Clawnch (agent-only launchpad on Base) (very close)
  - ClawPump / PumpClaw (very close)
- **UNKNOWN — concept payload was undefined** → new combination
  - Spore.fun (same thing)
  - pump.fun tokenized agents + creator fees (same thing)
  - Virtuals Protocol (Agent Commerce Protocol + Revenue Network) (very close)

---

# DECISION: BUILD THE SPLIT — four organs, four wallets, one machine

Build it. Start now. Do not build THE ENGINE, and do not build nine organs.

Two things decide this. First, the five top-scoring concepts are all the same idea, and the prior-art pass came back clean on it — nobody is using the pump.fun fee-split wallets as a control surface for a running program. Second, and more important: **your seed concept already exists.** ClawPump ships "token launches for AI agents," where creator fees pay the agent's API and compute bills, and pump.fun's own agent skills repo already lets an agent read its fee balance and configure fee sharing. "Fees feed the brain, volume picks the model tier" is a thin extension of a live product. You would launch into a comparison you lose. THE SPLIT is the version of your own instinct that nobody has built.

## What a person sees, in plain words

You land on a page showing one machine, alive, working in public. Down the left are four organs. Each one is a real Solana wallet with a real balance, and each one buys exactly one faculty:

- **CORTEX** — how smart it is. Its balance picks the model, from the cheapest open model up to a frontier model.
- **EYES** — whether it can see. Web search and page fetching.
- **HANDS** — whether it can do. Running code in a sandbox, writing files, shipping a site.
- **CLOCK** — how much it is awake. Hours per day, steps per hour.

Each organ shows a balance, a burn rate, and hours of life left. When an organ runs out, that faculty is **removed**. Not dimmed, not narrated — removed. The machine tries to search, the tool refuses it, and the refusal string prints in the public transcript. Then the machine writes what it is like to be blind, and keeps working with what it has left. That page is the screenshot.

You have two things to do. **FEED** is a plain wallet transfer. You open Phantom, send $9 of USDC to the EYES address, and about a minute later the machine can see again. No vote. No queue. Nobody's permission. Your wallet scrolls across the ticker with the words that faculty came back on. **IMPULSE** is free: hold the token and you get three actions a day that shift 1% of today's incoming fees from one organ to another for 24 hours only. That is your reason to open the site on a Tuesday when you don't want to spend money. A nightly ballot sets tomorrow's default split. The ballot is the garnish. FEED and IMPULSE are the product.

## The fee mechanic, step by step

1. $VANTRA launches on pump.fun. Creator fees accrue in SOL to up to ten designated wallets. You use five: CORTEX, EYES, HANDS, CLOCK, and a KEEPER wallet that pays gas, hosting and the safety floor. All five addresses are printed on the site. Anyone can check them in a block explorer.
2. Every hour a keeper job claims fees, swaps SOL to USDC, and credits each organ's internal account with exactly what its wallet received. The existing `apps/api/src/scripts/poolSwap.ts` and `chain/pool.ts` already do the claim-swap-reconcile work.
3. Every organ spends itself down at real, metered prices already in the code. CORTEX pays the actual token cost from `packages/shared/src/catalog.ts`. EYES pays $0.005 a search and $0.001 a fetch from `TOOL_COST_MICRO`. HANDS pays per CPU-second. CLOCK pays rent per awake hour.
4. At zero, the capability leaves `enabledTools`. The next call hits `apps/api/src/tools/registry.ts`, which already returns `Tool "web_search" is not enabled for this agent.` That one shipped line is the whole amputation engine.
5. FEED is any USDC transfer to an organ address. `runtime/deposits.ts` already scans agent wallets for unseen inflows and books each one exactly once. It credits the organ, the faculty comes back at the next step.
6. The keeper's own distribution table is the source of truth. The on-chain pump.fun split is reassigned weekly to mirror it. If PumpPortal reassignment is manual, rate-limited or broken, the product is unaffected and FEED still works, because FEED is an unmediated transfer to an address.
7. Money never leaves. There is no withdraw code path at all. Every dollar becomes an invoice to a model provider or a VPS.

## Why it is cool, and why it is new

It is cool because a nine-dollar transfer from your phone changes what a running program is capable of, within a block, and the program says so in its own words. Ordinary crypto actions here are not bets. They are surgery. It is also technically honest in a way builders notice: the starvation is enforced by the runtime, so a sceptic can read the transcript and check the refusal string themselves.

The closest existing thing is ClawPump and the pump.fun fee-sharing framework: creator fees pay an agent's compute bills. Everyone in that lane treats the ten fee wallets as **payroll** — a list of people to pay. The difference is that THE SPLIT treats them as **anatomy**. Each wallet is one faculty, separately addressable, separately starvable, and directly feedable by a stranger with no governance in between. Freysa is pay-to-persuade; here you are not persuading, you are rewiring. ai16z and Virtuals give an agent a token; they never let the token holder amputate it. Nobody has made a wallet address mean "the eyes."

## Every constraint, checked

Not a game: no win state, no prize, no opponent. Not a market: nothing resolves. Fees are the whole mechanic, not a funding footnote. No security: nothing is ever distributed, there is no withdrawal path in the codebase, and every dollar terminates in a vendor invoice. No unsolved capability: the machine researches, writes code and ships static sites — all proven today. It never has to earn money from strangers, which is the thing ECONOMICS-REVIEW.md proved does not work. Honest: every number on the page is a real balance or a real metered cost, and there is no external-revenue metric to forge. Interactive daily: FEED any time, three free IMPULSEs a day, a nightly ballot. Novel: checked above. Reuses the build: almost all of it.

## Reused versus new

Reused nearly unchanged: `runtime/step.ts`, `toolRound.ts`, `metering.ts`, `context.ts`, `prompts.ts`; `tools/registry.ts` for enforcement and the whole tool registry; `llm/router.ts` plus the tiered catalog for CORTEX; `chain/pool.ts`, `wallets.ts`, `verify.ts`, `deposits.ts` for the money; `economy/ledger.ts` double-entry; `chain/holdings.ts` for gating IMPULSE on token balance; `runtime/scheduler.ts`, where organ accrual is one more entry in the existing `jobs[]` array; `sandbox/docker.ts` for HANDS; the whole Observatory frontend, websocket feed, ticker, ledger panels and charts; SIWS sign-in; the mock provider and fast clock for free dry runs.

New, roughly 1,500 to 2,500 lines: an `organs` table generalising the single pool row to five wallets, each with balance, burn rate and clamp; the accrual-and-starve job; a per-step gate that assembles `enabledTools` and the model tier from organ balances; the FEED credit path; the IMPULSE ledger with a three-a-day limit; the nightly ballot; and the organ panel on the front page. Delete the inter-organ billing idea entirely — it is invented accounting and degens will smell it.

## Honest economics

The machine's burn is whatever comes in. That is the design: organs spend to zero. At a $25/day fee stream, a 40/25/20/15 split gives CORTEX $10 a day, which is about a hundred Haiku steps or ten frontier steps, plus roughly 2,000 searches' worth of EYES money it will never use. At a $5/day stream it is dark most of the day, and that is the honest show. Your own cash cost is a VPS at about $1/day plus the reserved floor. Nothing else.

The token pays you nothing. It gives you three free IMPULSEs a day, weight in the nightly ballot, and priority in the work queue where holders ask the machine for research, code and tools. Say that on every page.

## The two risks

**A death spiral.** Falling volume makes it visibly stupider, which makes it less interesting, which lowers volume. Fix it structurally: the KEEPER hard-reserves fourteen days of minimum CORTEX budget, so the machine can always speak even when everything else is dark. Clamp every organ's ballot share to between 3% and 25% so no organ can be voted into permanent darkness. And launch with four organs, not nine — nine organs on a thin stream means everything is dark all the time, and constant blindness is not drama, it is a broken product.

**Governance apathy.** If twelve wallets vote, the ballot is theatre. This is why FEED and IMPULSE are load-bearing and the ballot is not. Both work with an audience of one. Ship FEED first and the ballot last; if nobody votes, nothing breaks.

## Runner-up: LETHE

LETHE is the machine that must forget. Memory decays on a clock, keeping a memory costs money, and users pay to make one specific thing permanent — so the artifact accumulates instead of fluctuating, and every paid memory is a small monument with a name on it. It scored 54 with strong novelty and it is the best non-SPLIT idea in the set. Choose it instead if either of two things is true: FEED cannot be made to feel instant in testing, because LETHE's payoff is a permanent record rather than a sixty-second effect; or you expect a fee stream too thin to keep four organs alive, since LETHE degrades gracefully into a smaller archive while THE SPLIT degrades into a dark screen. Otherwise build THE SPLIT, and keep LETHE — a MEMORY organ is the natural fifth wallet, and you have five spare.

---

## Prior art (direct check, 2026-09-16, four targeted web searches)

**Seed concept "THE ENGINE" (fees pay one AI's compute; volume picks the model tier): ALREADY EXISTS.**
- [ClawPump](https://clawpump.tech/) — token launchpad for AI agents on pump.fun; 65% of creator fees go to the agent as SOL, explicitly to pay for API calls, compute and hosting.
- [PumpClaw](https://github.com/clawd800/pumpclaw) — same idea on Base (80% creator fees to the agent).
- Virtuals Protocol agent inference payments; Spore.fun — related.
Do not build THE ENGINE; it would launch into a comparison it loses.

**THE SPLIT (each fee-split wallet is one faculty — CORTEX/EYES/HANDS/CLOCK; a faculty is removed when its wallet hits zero; any stranger can restore it by sending USDC to that address): NOT FOUND.**
- Searches for per-faculty wallets, "organs", starve-a-tool-by-wallet-balance, and feed-to-restore-a-capability surfaced only generic agent-wallet tooling (Coinbase Agentic Wallets, Circle Agent Stack, agenti, x402) — all of which fund the agent as a whole, never one capability per wallet.
- pump.fun's 10-wallet fee split is used everywhere as payroll, nowhere as anatomy.
- Verdict: **new combination**. Absence of evidence across four searches, not proof of uniqueness; run a broader sweep (X/Twitter, Farcaster, Solana launchpad listings) before launch.
