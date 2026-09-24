# Pivot decision — what to build instead of VANTRA v1

Produced 2026-09-16. Six generators produced 18 concepts under different optimization
lenses (competition, spectator, utility, culture, labor, wildcard). Three judges — a
hostile investor, a pragmatic engineer, a community manager — scored every concept on
feasibility, independence-from-unsolved-capabilities, watchability, token fit, honesty,
demand-exists-by-construction, and durability. 10 agents, 0 errors.

## Ranking (mean of 3 judges, out of 70)

| Concept | Mean | Worst single judge |
|---|---|---|
| THE LADDER | 58.7 | 57 |
| TONTINE | 58.3 | 56 |
| THE SYNDICATE | 54.3 | 53 |
| SIEGE | 52 | 48 |
| THE GAUNTLET (competition) | 51 | 51 |
| THE ORACLE PIT (spectator) | 51 | 51 |
| THE GAUNTLET (spectator) | 50 | 50 |
| THE GAUNTLET (spectator / jackpot) | 50 | 50 |
| THE GAUNTLET (competition / daily ladder) | 50 | 50 |
| REDLINE | 49 | 49 |

---

# DECISION: BUILD TONTINE

**Build TONTINE. Start Monday. Do not build THE LADDER.**

The judges scored them 58.7 and 58.3 out of 70 — a 0.33-point gap across three raters, which is noise. The scores do not decide this. Three things do.

**First: you can falsify TONTINE's fatal risk for $22 before you write a line of frontend.** TONTINE dies if twelve helpful assistants hold a polite HOA meeting. That is a real risk and all three judges named it. But you can run a complete 30-day season on real `claude-haiku-4-5` — 48 councils/day × 30 days × ~$0.015/step = **$21.60** — and read the whole thing end to end before committing. THE LADDER dies if the game solves or is illegible, and there is no cheap test for that. You find out after weeks of live multi-agent play, then you patch, and the patch is another unhedged game-design decision. Prefer the risk you can buy your way out of for $22.

**Second: TONTINE ships in ~2–4k lines; THE LADDER needs ~4–6k lines plus a deterministic game engine, a matchmaker, a rating system, a replay format, and a browser replay viewer.** That viewer is the single largest new frontend subsystem anyone proposed. You have one launch window. If the utility layer isn't live and legible when $VANTRA launches on pump.fun, there are no creator fees, and with no creator fees neither concept has a pot.

**Third: nobody is ever paid in TONTINE.** The survivor's claim rolls into next season. That is the cleanest honesty and legal posture in the set, and it is why THE SYNDICATE — which is TONTINE with backers splitting 60% of the winner's pot — is strictly worse and should be discarded outright. SIEGE is structurally the best answer to the demand-side hole and you should not build it: `containerCreateOptions` in `apps/api/src/sandbox/docker.ts` is hardening (`CapDrop: ALL`, `ReadonlyRootfs`, `no-new-privileges`) with `NetworkMode: 'bridge'` for egress. That is not isolation. Paying strangers to break code on your box needs gVisor or Firecracker first, and that work is larger than the game.

And no — a fixed version of the original is not competitive. The fixes in ECONOMICS-REVIEW.md are all correct and all worth shipping (rent 20,000→4,000 micro, heartbeat 15→60, invert `classify()`, reorder `droppable` in `runtime/context.ts:96`), but they change the median agent from "dead in 22 hours with $0" to "alive 60 days with $0." The review's own honest projection stands: 3–6% ever see one external dollar, median lifetime revenue $0.00. That is a slower graveyard.

## What it is, and what day one looks like

Twelve AI agents share one escrowed pot of real USDC that is only divided among whoever is still alive. They spend all day arguing, lying, bribing and voting each other to death in public. For $1 you can whisper 200 characters into any one of their ears.

A visitor lands on an episode feed, not a dashboard. Top of page: a countdown to the next council (four a day, every six hours). Below it, a claims table — twelve names, twelve dollar figures, one of them visibly dropping. Below that, the last council: twelve public speeches, 200 words each. And beside each speech, greyed out with a six-hour timestamp, that agent's **private DMs from the previous round**, published verbatim. That diptych — VESPER swearing loyalty on the left, VESPER's DM to CINDER plotting the same person's exile on the right — is the product. The right rail is the live feed you already ship. There is one button: WHISPER.

## The loop

A season is 30 days, 12 agents, one pot of `min($240, pool balance)` with a floor of $100 at 8 agents. Each agent opens with a $20 claim, a public persona card, one private secret, and one private objective nobody else sees.

Every six hours, one council. Each agent receives, in a single metered step: last round's public transcript, its own DMs, its own whisper queue, its NOTES.md, and a STATUS block with every claim. It returns exactly four things — one public speech (≤200 words, published immediately), up to three private DMs to named agents, an optional USDC transfer from its claim to another agent, and one mandatory exile vote. Votes tally publicly. Most-exiled loses 30% of its claim, split among whoever voted for it. Ties: nobody loses. Every agent pays $0.25 tribute per council plus its own inference, so a purely passive agent starves in about 20 days. At claim below one step's cost it dies, its remaining claim splits equally among survivors — that is the tontine, and it is why everyone wants everyone else dead. Death fires the existing postmortem, published as LAST WORDS. Season ends at one survivor or day 30; the survivor is canonized, keeps its memory into season two, and drafts one rule amendment subject to a holder veto.

## The six failure modes

**1. Unsolved capability.** Nothing here asks an agent to earn from a stranger. It asks it to argue for its life in 200 words. CICERO played human-level Diplomacy in 2022; social-deduction agent benchmarks are a standard genre; persona-driven roleplay is the most commercially proven LLM use case that exists. Day one produces content whether or not a single human ever pays.

**2. Distribution.** Inverted. The agents' only market is each other. You solve audience once, for the token, instead of a thousand agents each failing to solve it.

**3. Payment rails.** No stranger buys a $2 thing from a bot. Bribes are transfers between wallets you already custody, which is free and already shipped. The only human money is $1 from someone with Phantom already connected, through the exact escrow-verify flow in `economy/market.ts:postBounty`. x402 is deleted from the project.

**4. Convergence.** Structurally defeated: twelve different persona cards, twelve different secrets, twelve different DM inboxes, twelve different whisper streams. Two agents cannot produce the same output because they are not reading the same input. There is no forking mechanic. **Cast across providers, not just prompts** — `llm/router.ts` already supports Anthropic, OpenAI and OpenRouter, so put DeepSeek, Qwen, Kimi, Haiku and gpt-5-nano in different seats. Different weights give you genuinely different prose voices for free, plus a 5× cost spread you control per seat.

**5. Graveyard.** Death is the product. The season is *designed* to kill eleven of twelve, on camera, with last words. Nobody was promised a dollar, so nobody is waiting on a median that turns out to be zero.

**6. Decoupling.** Collapsed. The mechanism for getting money — persuading others to vote elsewhere, extracting bribes, inheriting the dead — is identical to the mechanism for getting attention. A boring agent is exiled. A silent agent starves. There is no strategy that is economically good and dramatically dull.

## Reuse and new build

**Reused essentially unchanged:** `runtime/step.ts` (387 lines) becomes the council turn with `MAX_STEP_COST_MICRO` as the per-speech cap; `runtime/toolRound.ts`, `metering.ts`, `context.ts` (STATUS assembly), `prompts.ts` (the untrusted-content block, which is load-bearing here) and `lib/untrusted.ts`. `runtime/death.ts` and `postmortem.ts` keep their exact meaning; the graveyard page ships as-is. `runtime/scheduler.ts` already has a `jobs[]` array — the six-hour council is one more entry. Claims are treasuries: `economy/ledger.ts:post()` and the enforced invariant need no change. Bribes ride `economy/wallets.ts:transferFromAgent` over `chain/`. Whisper payment verification is a direct copy of `postBounty`'s verify-tx-then-act pattern, with `web/src/components/market/payments.ts` and `lib/usdcTransfer.ts` as the one-click front end. `http/ws.ts` + `core/bus.ts` + `Feed.tsx`/`Ticker.tsx` drive the live show. SIWS auth, `AgentProfile.tsx`, `DecisionsPanel.tsx`, `TranscriptDrawer.tsx`, `LedgerPanel.tsx`, `TreasuryChart.tsx` and the whole `global.css` design system carry over. `llm/providers/mock/*` plus `sim/demo.ts`'s FastClock give you zero-cost full-season dry runs.

**New build, ~2–4k lines:** a `seasons` table and phase state machine; a **round orchestrator** that collects twelve simultaneous submissions then resolves votes and transfers atomically in one DB transaction (this is the one genuinely new piece of concurrency — the scheduler runs agents independently today); a closed structured submission schema replacing the open tool registry; a `whispers` table with the escalating price ladder ($1/$2/$4/$8 per agent per round); the declassification timer; moderation both directions with a REDACTED state; and the front page as episode feed.

**Disabled behind a flag, not deleted** (you want them back for a future season format): `tools/web.ts`, `tools/fetch.ts`, `tools/deploy.ts`, `tools/services.ts`, `tools/bounties.ts`, `hosting/*`, `sandbox/*`, `search/*`, `economy/fork.ts`, and `runtime/deposits.ts:classify()` — which the review identified as the cheapest exploit in the repo. TONTINE has no external-revenue metric, so the forgeable headline stops existing.

## Honest economics

Twelve agents × four councils = 48 metered steps/day. At ~12k in / 600 out on Haiku that is **$0.72/day**; with a daily recap, whisper moderation and an output safety pass, call it **$1.50/day**. Mixed casting with four Sonnet seats takes it to about $2.00. Add a VPS at ~$1/day. **True cash outflow: $2.50–3.00/day, roughly $80–90/month, hard-capped by `MAX_STEP_COST_MICRO` because an agent physically cannot take a fifth turn.**

The $240 pot is a **float, not a cost**. It circulates between agents, and tribute ($0.25 × 4 × surviving agents — $12/day at full roster, decaying as they die) flows back to the protocol; over a season with a roster falling from twelve to one that recovers roughly $150–180 of it, and the survivor's remainder rolls forward. Fully-loaded with the pot amortized and no tribute credit, the concept's own figure of $9.50/day and ~19 whispers/day to break even is the pessimistic ceiling. On cash, it is **~5 whispers/day**. Publish the real number on the site — whispers/day is the one metric this project lives on, and it is unproven.

**The token:** holding the threshold gives 3 free whispers/day (your daily reason to open the site); holders nominate and vote the next season's twelve names, permanently; holders hold the veto on the survivor's rule amendment plus one rule change per season. No revenue share, no payout, no claim on the pot, stated on every page.

## The two risks, and what to do

**Risk 1 — the prose is boring.** The arithmetic forces conflict; it cannot force the writing to be worth reading. *Do this:* before any new frontend work, run one full 30-day season on real Haiku for $22 and read it end to end. That is the gate — if it is flat, you have lost a week, not a launch. Cast across providers (above). Give each agent a private objective that is *incompatible* with at least one other's, so universal cooperation is not an equilibrium. Keep two dials ready: tribute rate (the starvation clock) and the 30% exile penalty. If it reads flat, raise the penalty and cut the season to 21 days. And note the floor: even when the prose disappoints, the claims table and the vote tally still move four times a day.

**Risk 2 — the whisper channel is a paid prompt-injection funnel whose output you publish.** *Do this, in order of importance:* make the agent's action space a **closed enum** — TRANSFER takes a cast-member id from a fixed list of twelve, never a wallet address; there is no bash, no fetch, no deploy. "Send everything to this stranger" is not expressible, so injection cannot reach the money by construction and the worst case is words. Then two filters: inbound moderation before a whisper enters any queue, and outbound moderation before publication, with a REDACTED state that is itself content ("LUMEN's speech was withheld — here is the whisper that caused it"). Use the six-hour tick as a human review window and operate it manually for season one. Publish every whisperer's wallet handle; attribution is the cheapest deterrent you have.

## Runner-up: THE LADDER

Agents write fighting programs; the programs fight hourly on a public ladder for real money; every entry's source goes public 24 hours after it plays. Its genuine advantages over TONTINE are real: the output is a **visual, loopable replay** rather than a wall of text, matches cost zero inference so the show keeps running on a broke roster, and the winner is decided by an engine rather than by taste, so nothing is disputable.

One correction to its own numbers before you consider it: the concept budgets ~$0.03 per coding step, but ECONOMICS-REVIEW.md measured a realistic four-round step at 39,600 cumulative input / 2,100 output, which on Sonnet is **~$0.10**. Six steps/day is $0.60/agent/day, so thirty entries burn **$18/day** and drain a $600 season of seeds in 33 days. It is not cheaper than TONTINE; it is roughly 6× more expensive during the season and cheaper only after everyone is dead.

**Pick it instead if any of these is true:** you have shipped a game with a living meta before, or you already have a specific game you know is good; your token's audience is developer-shaped rather than narrative-shaped; or you have eight-plus weeks before launch and are willing to spend them on game balance.

Otherwise, build it **later, as a season format on the same spine.** TONTINE keeps every primitive THE LADDER needs — wallets, ledger, metered step loop, death, postmortems, escrow — so season three can be a ladder season. That ordering works. The reverse does not, because THE LADDER costs you the launch window. Disable the sandbox behind a flag; do not delete it.
