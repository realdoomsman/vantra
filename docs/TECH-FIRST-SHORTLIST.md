# Tech-first shortlist — the technology is the product, crypto is plumbing

Produced 2026-09-16. Brief (founder, verbatim): "AI agents exist to make you money in theory —
see how it doesn't have much to do with crypto in and of itself, but the tech itself carries the
product. I want an idea where people see something and think it's innovation, really cool."

21 concepts from 7 lenses. 3 judges (Hacker News front page; a skeptical ML engineer hunting for
what does not actually work; a crypto community lead), scoring the 20-second-video wow test double.
Prior-art web searches on the top 6. 17 agents, 0 errors.

> **Verdict: no great idea. The best is good.** The top scorer is dead on prior art AND a granted
> US patent. The best sentence belongs to a concept whose hero moment cannot fire for a solo founder.

## Ranking
| # | Concept | Mean /70 | Worst judge | Wow /10 |
|---|---|---|---|---|
| 1 | REVISIT | 52.3 | 46 | 8.7 |
| 2 | REPRO | 51.3 | 46 | 7.7 |
| 3 | PALIMPSEST | 51.3 | 49 | 7 |
| 4 | THE LOOKOUT | 48 | 43 | 8.7 |
| 5 | THE KEEP | 48 | 47 | 7.3 |
| 6 | WITNESS | 47.3 | 45 | 7.3 |
| 7 | LOOKOUT | 45 | 44 | 8.3 |
| 8 | SALVAGE | 48.3 | 41 | 6.3 |
| 9 | DISSENT | 46.3 | 43 | 7.3 |
| 10 | PATRON | 44.7 | 42 | 7.7 |
| 11 | DOUBT | 43.3 | 41 | 7 |
| 12 | LOOKOUT | 44 | 40 | 6 |

## Prior art (top 6)

**REVISIT** — incremental
  - EPA Region 1 DIST-ALERT permit dashboard (NASA/JPL OPERA DIST-ALERT + EPA permit layer) — same thing
  - Shovels.ai (permit corpus; 'Red Tag' agentic permit enforcement) — same thing
  - US Patent 12,321,998 — 'Automated detection of and response to probable unlawful activity at commercial or residential property' — same thing

**REPRO** — new combination
  - asexec — pre-registered trials for AI evals — very close
  - ClaimSentry — very close
  - readme2demo — very close

**PALIMPSEST** — new combination
  - Changeflow — very close
  - PageCrawl.io — very close
  - EDGI Federal Environmental Web Tracker + web-monitoring stack — very close

**THE LOOKOUT** — new combination
  - RentAHuman.ai — very close
  - ProxyPics — very close
  - Skylight (Allen Institute / AI2) maritime monitoring — very close

**THE KEEP** — new combination
  - Permanent Legacy Foundation (permanent.org) — very close
  - Internet Archive Vault (Archive-It) — very close
  - Arweave (+ AO / ar.io) — related

**WITNESS** — new combination
  - AMOS — Archive of Many Outdoor Scenes (WUSTL/MVRL) — very close
  - Vizzion (road imagery API) — very close
  - NATIX WorldSeek (Solana DePIN) — very close

---

No — not a great one. The best is good, and it is not the one that scored highest.

Here is the honest read. The top scorer (REVISIT) is dead on prior art and a granted patent. The best *sentence* in the set (THE LOOKOUT) belongs to a concept whose hero moment will not fire for a solo founder. What is left is one idea that is genuinely unoccupied, cheap, and shippable in two weeks — and it is narrower than you want. It will impress engineers. It will not stop a stranger scrolling.

---

## 1. REPRO — the machine that checks whether AI claims are true

**The sentence.** Paste a link to anyone's claim about what an AI can do. A machine writes a test for it in front of you, runs it twenty times, and publishes exactly what happened and what it cost.

**The 20-second video.** One empty input box. Someone pastes a viral post: "GPT-5.2 one-shots this every time." A terminal unfolds and the machine starts *writing a test*, twenty lines of Python appearing at reading speed. It runs. Twenty result rows fill in — PASS, FAIL, FAIL, PASS — while a cost meter ticks $0.04 → $0.38. A card snaps in: "CLAIM: one-shots it every time. WE RAN IT 20 TIMES: 6 passed." Under it: "sealed 11 seconds ago · this page cannot be edited," and a button that says REPRODUCE THIS YOURSELF.

**How it works.** A triage model sorts the claim into testable, testable-with-setup, or not-testable, and publishes the reason either way. If it is testable, a coding agent in a sealed container writes a runnable harness, states the pass condition in plain English *before* running, and freezes it. The harness runs. The verdict comes from executed code, never from a model's opinion. Everything — the harness source, the raw trial log, the exact dollars spent — is published as a receipt. The claimant, or anyone, can attach a corrected run for free, permanently.

**Why not three years ago.** Doing this by hand was an afternoon of work per claim, which is why reproducibility efforts were annual volunteer events. Nothing in 2022 could turn a paragraph of English into a working test script, run it unsupervised, read the error and fix it. That loop is the whole product and it is a 2024-onward capability.

**Where crypto hides.** Not in the timestamp — hash-anchoring is commodity now and a legal-grade timestamp service does it better. The real one is funding: anyone can escrow $5 to commission an expensive check, the actual spend is drawn against it live on the page, the remainder returns, and the funder is visible so nobody can quietly buy a verdict. No account, no card, no invoice, no waiting. A token, if you attach one, gates free daily queue slots — and that is the last time it appears.

**Cost per day.** About $0.40 per run. At 30 runs a day, roughly $14/day, hard-capped per run so a runaway job publishes "exceeded budget" instead of eating the month. Commissioned runs push it toward zero.

**What gets reused.** More than anything else in the set — roughly 2,500 new lines. The Docker sandbox is the run environment unchanged. The metered runtime, the per-token accounting and the hard step cap stop being plumbing and literally *become* the published product. The LLM router with real per-provider prices is required, because claims are about specific models. The live websocket frontend is the run view with no redesign. Escrow funds commissioned runs.

**The thing most likely to kill it.** Most public AI claims cannot be mechanically tested. The concept guesses 60–75%; the sceptical judge says 85–90%. If that is right, your front page is a wall of polite refusals and the product reads as broken. (Second, smaller: rename it. "RePro," "REPRO-Bench" and "Repro" are all taken, and this is a product whose whole job is being findable.)

---

## 2. THE LOOKOUT — the machine that watches one place forever and pays people to go look

**The sentence.** A machine watches one harbour continuously, and when something happens it cannot explain, it pays a stranger three dollars to walk outside and look.

**The 20-second video.** A live map of one port. Ship tracks, weather, tide, a 246-day history bar. A detector trips at 04:12 — a vessel sitting where nothing sits. The machine checks its own records: "this has happened twice in 246 days." It cannot resolve it from sensors. A request goes out. Ninety seconds later a photograph comes back from a phone on the east pier, and a line prints: "$3.00 paid · 41 seconds ago."

**How it works.** Free public feeds — ship transponders, aircraft, weather, tide gauges — stream into a time-series store for one place. The AI does not watch. The AI *writes the watchers*: small statistical detectors it authors, tests against its own history and then runs as plain deterministic code, so no model judgement sits in the hot path. When a detector fires and the fused data cannot explain it, the system posts a tiny paid errand with one closed question, and settles the moment an acceptable photo comes back.

**Why not three years ago.** The sensing existed. What did not is a model that can look at a real data schema, write and repair its own detection rules against it, and phrase a closed question a stranger can answer with one photograph. Nor did the ability to settle $3 to an unknown person in under a minute.

**Where crypto hides.** It is the only rail that clears a $3 cross-border payment to someone with no account, in seconds, initiated by software rather than a person. A card cannot do it — the fee eats the payment. Be honest with yourself though: this rail is now rented, not built. Two marketplaces already sell exactly it.

**Cost per day.** The cheapest here: $2.00–$3.50/day median, including a capped errand budget. Feeds are free.

**What gets reused.** Heavy. The scheduler takes the ingest jobs as new entries. The metered runtime caps each investigation. The sandbox runs the detector code the AI writes. Bounty escrow and verified-transaction checking are the errand payment unchanged. The live feed frontend is the front page.

**The thing most likely to kill it.** The errand is the entire reason anyone shares this, and it needs a willing, opted-in human within walking distance of a specific pier at 4am. In one harbour that population is single digits. Money cannot fix it, because the constraint is bodies. Month one plausibly produces zero errands — at which point you have shipped a very good harbour dashboard.

---

## 3. PALIMPSEST — the machine that notices when institutions quietly rewrite the past

**The sentence.** Three thousand machines watch every official page on the internet and tell you the minute somebody quietly changes what it said yesterday.

**The 20-second video.** A federal statistics page. A red bar slides under line 14: "2019–2024" became "2020–2024," and a sentence about a revision is gone. Caption: "edited 11 minutes ago · 3rd silent revision this year." Pull back to 3,100 tiles, 47 flashing amber, 6 marked "rewrote the past." One tile goes red — a terminal opens by itself, an agent reads the new page layout, rewrites its own scraper, tests it against yesterday's known-good output, and the tile goes green. Nobody typed anything.

**How it works.** One cheap agent per source, with its own budget. It fetches and hashes; unchanged costs nothing. Changed, a deterministic cleaner strips timestamps and rotating junk, then a model is invoked once to label the diff: cosmetic, additive, substantive, or *retroactive* — meaning a published figure or statement was altered rather than superseded. That last label is the product. Snapshots are archived with a proof anyone can check later. When a page restructures and the scraper breaks, the agent repairs it against its own snapshot history as the test suite.

**Why not three years ago.** Watching 3,000 heterogeneous sources meant 3,000 hand-written scrapers and a person to keep them alive. And judging "does this change matter" had no rule-based answer and no cheap model good enough to run unsupervised 120 times a day.

**Where crypto hides.** The whole value is "we can show you what that page said on that date." A log you host and could edit is your word, not evidence. An hourly hash root anchored publicly costs half a cent a day and means a hostile reader can verify without trusting you. Weakest crypto case of the three — a qualified legal timestamp is arguably a better artifact.

**Cost per day.** About $7.40, hard-capped by per-agent budgets and a fixed bounty pool.

**What gets reused.** The closest fit to what exists. Per-source agents map one-to-one onto the metered runtime with budget caps and insolvency death — a source too expensive to watch literally starves, and the automatic postmortem becomes the public "why we stopped watching this" note. Sandbox for scraper repair. Ledger for per-source cost. The tile wall and feed are already built.

**The thing most likely to kill it.** Two 2026 vendors already sell the customer-facing product at $99/month, one of them with near-identical marketing copy, and Klaxon gives it to newsrooms free. The parts that are novel — agents that starve, USDC repair bounties — are things no FOIA lawyer will ever care about.

---

## What I discarded

**REVISIT, outright.** It scored highest and it is dead. EPA Region 1 is already running the exact loop — satellite disturbance alerts joined against a permit layer, flagging changes with no filing, dispatching staff — and NASA published the results in May 2026. Shovels.ai, which owns permit data from 2,770 jurisdictions, mocked up this precise product as an April Fools joke and did not build it. EagleView sells automated change detection to counties under the literal promise "identify unpermitted construction." And US Patent 12,321,998 claims the mechanism: compare property images across dates, query a permit database, flag the property as a probable site of unlawful activity. That is a freedom-to-operate problem on a product whose every output is a public accusation about a named person.

**Also gone, as differentiators rather than whole concepts:** the tamper-evident receipt layer (commoditised in the last year; several products, plus legal timestamping that is simply better); the agent-hires-a-human errand (RentAHuman, 110,000 workers, USDC escrow, shipped February 2026; ProxyPics, 180,000 collectors, API-triggerable); AI-classified website diffs sold to compliance teams (two vendors, $99/month); self-healing scrapers (a free API call from two vendors); and the self-writing anomaly detector, which is a published technique with follow-on papers.

## The most interesting thing that missed

REVISIT is the most interesting idea anyone wrote, and the reason is worth keeping even though the idea is not. Its insight is that the artifact of value is not the detection but the **published negative-search receipt**: here are the eleven registries we searched, here is each query string, here is each timestamp, and here is what we did not find. Nobody publishes that. Everyone publishes conclusions. That format is genuinely novel, it is cheap, and it is the honest answer to the thing that makes all four of these concepts legally dangerous — a machine that publishes what it looked for, rather than what it concluded, cannot defame anyone. Take that discipline into whatever you build. Do not take REVISIT.

## Recommendation, and the test

**Build REPRO.** Not because it is the coolest — LOOKOUT is — but because it is the only one whose core loop is not already somebody's shipped product, it is the cheapest thing here to build, it turns the infrastructure you already have into the visible product rather than hiding it, and both of its risks are testable before you write code.

**The week-long experiment, and it needs no code.** Collect 100 real public AI claims from the last 30 days, by hand — X posts, launch announcements, READMEs, paper abstracts. For each, spend ten minutes on one question: could a script settle this, yes or no, and what would the harness be? That is two days and costs nothing. Then take the 20 most testable and actually run them yourself, by hand, in a terminal. That is maybe $30 of API calls and two more days.

You get two numbers. **The testable rate** — if fewer than one in four claims can be settled by a script, the product is a wall of shrugs and you stop. **The survival rate** — if the claims almost all hold up, there is no drama, nothing gets shared, and you also stop. You need it to be somewhere near half and half. If it is, you have simultaneously produced the 100-claim seed corpus you would launch with, and you have learned what shape the harnesses actually take before you ask an agent to write one.

Under $50, under a week, and it kills the idea before the idea costs you a month.
