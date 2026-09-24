# Trader shortlist — AI tech that makes a memecoin trader money

Produced 2026-09-16, round 5. Target held on all four axes at once: audience = a Solana memecoin
trader; benefit = money they make or save; the technology is the star; a token attaches without
being the pitch.

21 concepts from 7 lenses. 3 judges (a cynical full-time memecoin trader, a quant hunting for
statistical failure, the Hacker News front page), 'would a trader actually pay' weighted double.
Prior art checked with 10+ searches each against a crowded market. 17 agents, 0 errors.

> **Verdict: YES — one good idea, and it is not the highest scorer.**

> Key structural insight: three of the top four are notification layers. Trojan, Axiom, Maestro
> and GMGN fire inside the transaction path because they hold user keys. You cannot. So any idea
> whose value is SPEED OF WARNING competes on the one axis where you are structurally last.
> The winner delivers value BEFORE the buy, not during the exit.

## Ranking
| # | Concept | Mean /70 | Worst judge | Would-pay /10 |
|---|---|---|---|---|
| 1 | THE EXITS | 50.3 | 48 | 6.7 |
| 2 | WATCHMAKER | 46.7 | 44 | 7 |
| 3 | HOUSE RULES | 48.7 | 45 | 5.7 |
| 4 | PRIOR | 47.7 | 47 | 6 |
| 5 | HANDWRITING | 45.7 | 44 | 6.3 |
| 6 | SAME HAND | 46 | 44 | 6 |
| 7 | SAME HAND (duplicate) | 42.3 | 41 | 6.7 |
| 8 | SUCCESSION | 42.3 | 42 | 6.3 |
| 9 | THEIR OWN WORDS | 40.3 | 39 | 4.7 |
| 10 | LEAK | 40.7 | 39 | 4.3 |
| 11 | FIRST PRINT | 38.7 | 38 | 5.3 |

## Prior art (top 6)

**THE EXITS — every way the money can leave, watched by code that wrote itself** — new combination
  - Hypernative — Onchain Monitoring & Automated Response — very close
  - Forta Network — Attack Detector / detection bot marketplace — very close
  - Sublime Security ADÉ + 'Evaluating LLM Generated Detection Rules in Cybersecurity' (arXiv 2509.16749) — very close

**WATCHMAKER** — new combination
  - GMGN Skills (AI agent layer, 2026) — very close
  - GMGN auto-sell / dev-sell / trailing take-profit — very close
  - Almanak — very close

**HOUSE RULES** — new combination
  - TraderSync — Cypher AI / Cypher Coach — very close
  - Poker leak-finder category (Leak Buster 2, BBZ MTT Leak Finder, GTO Wizard, Grindlab AI, Runout) — very close
  - Jeeted.ai — related

**PRIOR — the machine that recognises the hand, not the wallet** — new combination
  - GMGN — Twitter/X Rename Alert + dev wallet panel — very close
  - GMGN dev-score skill (gmgn-dev-score) — very close
  - pump-image-reuse (team675) — very close

**HANDWRITING** — new combination
  - $PumpRep — Pump.fun Reputation Tracker — very close
  - team675/pump-image-reuse (GitHub) — very close
  - TokenSniffer — contract similarity / "similar to known rugs" — related

**SAME HAND** — new combination
  - Cabal-Hunter (SERIAL_RUGGER verdict) — very close
  - DeFade — Multi-Chain Memecoin Analyzer — very close
  - Axiom (ex-Photon) — reused-socials flag — related

> **Citation warning from the judges:** arXiv 2607.02823 ("pump.fun survival analysis over
> 832,941 launches") could not be found, nor could AlgoEvolve, QuantCode-Bench, AlphaForgeBench
> or Backtrader-Bench. Do not put these in a deck.

---

Yes — one, and it is not the one that scored highest.

Here is the honest frame before the list. Three of your top four share a defect: they are notification layers. They see the bad thing, then push your phone, and you have ten to twenty seconds of thumb-and-confirmation before you act. Trojan, Axiom, Maestro and GMGN already fire inside the transaction path because they hold the keys. You cannot hold keys. So any idea whose value is *speed of warning* is competing on the one axis where you are structurally last. The idea that works is one where the value is *knowing something nobody else knows*, delivered before the buy, not during the exit.

---

## 1. PRIOR — recognises the hand, not the wallet

**The sentence.** Before you buy, it shows you six coins the same person launched before — found from the picture they chose, the way they write and the rhythm of the launch, not from any wallet link — and the price chart of what happened to everyone who bought those six.

**The money.** The operator's wallet is free. A fresh CEX-funded wallet costs $2 and ten minutes, and it defeats Bubblemaps, DeFade, Rugbuster and GMGN's dev-score completely — all four key on the address. His taste does not change. If PRIOR catches one repeat operator a month on a $400 position that would have gone to zero, that is $400 saved against roughly $20. The honest version of the claim is narrower: it changes the decision on the fraction of launches that have a distinctive hand, and it says "no distinctive hand found, here is what we searched" on the rest.

**The video.** A coin thirty seconds old. A card slides up. Not a score — six thumbnails, six price charts, all six cliffs. Under them: "same hand · image 0.94 · prose 0.81 · launch rhythm 0.77 · none of these six wallets are linked on-chain." Then the column nobody ships: "coins we flagged this way that later 5x'd: 41. Here they are." Clickable.

**How it works.** Every launch, you pull four things that are not on-chain: the image, the 40 words of text, the socials page, and the launch choreography (dev buy size, seconds to the first ten buys, wallets in the first block). You turn each into a vector. You search them against a corpus of 110,000 dead coins that an agent fleet already read and wrote up — not labelled, *summarised*: who ran it, how it died, what buyers lost. A hit returns precedents and outcomes. No verdict, no score, no accusation.

**Why the incumbents cannot.** They key on the address because the address is queryable. Nothing here is queryable. You cannot SQL a perceptual hash of a logo against 110,000 coins that nobody indexed. The corpus is a compute artifact — roughly $1,500 of mid-tier model calls to build once — and it is the whole moat. GMGN's X-rename alert is the one partial overlap, and it only fires when the operator reuses a social account.

**Latency and cost.** 1.2 seconds, with no model in the hot path — the card is templated from retrieved rows. Per day at a real 40,000 launches: CLIP on a rented GPU $8.40, text embeddings $0.16, the vector index on a 32GB box $6, Geyser plus archival RPC plus metadata fetches $40, and one cheap model call on the ~3,200 launches that get a hit at $0.0004 each = $1.28. **About $56 a day, $0.0014 a launch.** At 400 subscribers on $20 that is $263/day of revenue. It gets cheaper per user forever, because the cost is per launch, not per user.

**Reuse.** Medium. Tool registry and fetch for the artifact pulls. The scheduler runs the nightly corpus refresh. The metered runtime caps each autopsy so a pathological coin publishes "exceeded budget." The router does mid-tier autopsies and cheap cards. The websocket frontend is the live card feed. Sign-In-With-Solana, and a token balance sets your daily query allowance. New: the four extractors, the vector index, the Geyser ingest — the biggest build in this document.

**What kills it.** Ninety percent of launches are AI slop from the same three templates and five image styles. If the index returns four hundred neighbours for everything, "same hand" means nothing and the product is a wall of shrugs. This is measurable in a week and it is the whole bet.

---

## 2. HOUSE RULES — finds the one habit that costs you money, in your own data

**The sentence.** It reads every trade you ever made, writes down the single habit quietly costing you the most, proves it on a slice of your history it never used to find it, and taps your shoulder next time you are about to do it.

**The money.** It comes out of your own wallet, so nothing is taken on faith. A typical active wallet has 400 to 1,500 closed positions in 90 days. The output is "your exit behaviour after a 2x cost you $18,400 out of sample," or it is "we found nothing that survives," and both ship. $29/month.

**The video.** A terminal. 1,284 positions reconstructed. A model writes falsifiable hypotheses about *you* at reading speed, then writes a twenty-line detector for each one. The screen splits into FIT and HOLDOUT. Hypotheses start getting struck through in grey — H2 rejected, H5 rejected, H11 rejected. Four survive out of thirty-one and the twenty-seven rejects stay on screen. Then a phone at 3am: "RULE 3. THIS IS THAT. Last 29 times you sold here, holding 20 more minutes was better in 21."

**How it works.** Read-only wallet attach. Reconstruct every position from raw transactions against second-resolution prices. For each closed position, rebuild the context at the exact second you acted. A frontier model reads a sample and generates executable hypotheses. Each becomes a detector, fitted on early history, scored on late history it never saw. Survivors compile to plain code and run live on your open positions. No model in the live path at all.

**Why the incumbents cannot.** There is no rule to ship, because the rule is different for every person and nobody knows it in advance — not you, not the tool author. GMGN, Cielo, Kolscan and Nansen all compute statistics you can name. Naming the statistic is the hard part. What ships here is fast deterministic heuristics that no human could have written, because they are about one person.

**Latency and cost.** Onboarding is a 6-12 minute batch job and that is fine, because watching the model reject its own theories about you is the product, not a spinner. The live guard fires in under 300ms because it is compiled code. **$2.70 per trader once, $0.60/month to refit.** At 1,000 wallets: $30/day of cost against $967/day of revenue. Three percent COGS — the best economics in the set by a factor of ten.

**Reuse.** The heaviest. The Docker sandbox is the backtest harness unchanged. The metered runtime's hard cap becomes the per-user analysis budget and appears *in the product* as the line at the bottom of the report. The ledger is the spend statement. Roughly 3,000 new lines and no firehose, no Geyser, no corpus.

**What kills it.** Thirty-one hypotheses against a small sample will produce winners by luck. Stratify 1,284 positions down to "exceeded 2x then wicked -34%" and you have forty events; a twelve-event holdout passes one or two candidates by chance every single time. Fix it with a false-discovery-rate correction and rolling-origin splits, publish the corrected survivor count, and accept that for half of users the honest answer is zero rules. Second killer, softer and more likely: a notification does not stop a thumb at 3am.

---

## 3. THE EXITS — per-coin detectors that write and test themselves

**The sentence.** It reads this coin's actual pool setup, works out the four mechanical routes the money can leave by, writes a detector for each, replays every detector against the coins that playbook already killed, and tells you which routes it cannot warn you about.

**The money.** Once a rug's first move lands, 80-95% of value is gone inside three minutes. Exiting on the first move rather than on the chart is roughly -25% instead of -95%: about $280 back on a $400 position. Two a month against $15/month.

**The video.** Click ARM. Four cards deal out. Python writes itself under each. A progress bar chews through 1,412 historical coins. Three stamp green with a lead time. One stamps grey: "ATOMIC — SAME SLOT AS THE SELL — MEDIAN LEAD 0s — CANNOT WARN YOU."

**How it works.** A nightly fleet reads dead coins and writes *mechanisms*, not labels, which cluster into a library of named exit techniques. Per position, an agent reads that coin's real pool config and asks which techniques the structure permits. It writes a deterministic predicate for each, replays it against history, publishes recall and median lead, and refuses to arm anything under ten seconds of lead. Armed predicates are plain code on a Geyser stream.

**Why the incumbents cannot.** Fixed rules are public, so operators route around them: dust sells under threshold, intermediary hops, or a DLMM fee-position drain that extracts value while moving no tokens at all, so no transfer rule fires. Generating the counter-rule needs reading a pool config, which is comprehension, not lookup.

**Latency and cost.** Arming takes 8-14 seconds; firing is 400-900ms. **$349/day at 8,000 armings, $0.044 each**, falling as the per-coin synthesis caches.

**Reuse.** Heavy — the sandbox is the synthesis-and-replay environment it was built for.

**What kills it.** The coverage number is probably bad. Modern exits are bundled into one slot, so the first observable move and the finished drain are the same event, and honest lead is zero on most coins. Also: you already rejected the self-writing anomaly detector by name as "a published technique with follow-on papers," and Sublime Security ships this exact loop in production today.

---

## Discarded

**WATCHMAKER (M5)** — highest willingness-to-pay in the set, and dead anyway. Almanak already ships the architecture: one sentence in, readable Python strategy out, thousands of backtests, mainnet-fork dry run, deploy. Nansen Smart Alerts already turns plain English into live Solana alert logic. And the economics are $181/day of cost against $195/day of revenue at 150 users — a 7% margin with an unbounded model-triggered rewrite loop inside it.

**SAME HAND (M1), SAME HAND duplicate (M10), HANDWRITING (M4)** — three worse versions of PRIOR. PRIOR wins the cluster on one product decision: it outputs precedents and outcome curves instead of a score, which is simultaneously the honest framing and the one that cannot defame anyone.

**SUCCESSION (M6), THEIR OWN WORDS (M2), LEAK (M9), FIRST PRINT (M3)** — all under 5.5 on would-a-trader-pay. That is the only number that matters and they failed it.

**Two citation warnings.** arXiv 2607.02823, the "pump.fun survival analysis over 832,941 launches," could not be found. Nor could the four in HOUSE RULES' evidence section (AlgoEvolve, QuantCode-Bench, AlphaForgeBench, Backtrader-Bench). Do not let those into a deck.

## The near miss

HOUSE RULES is the one I would build if you had three weeks and $500 instead of three months. It is the only idea here with no defamation surface, because it only ever talks about you. It has the best demo moment in the whole set — twenty-seven of the model's own theories about you, struck through in grey, on screen. It is the only one a solo founder can actually afford. And it is the one a trader will read once, nod at, and not pay for a second month, because the product's job is to change a behaviour and nobody buys that at 3am. If the PRIOR test comes back negative, build this instead and do not feel bad about it.

## Recommendation and the week

**Build PRIOR.** It is the only idea here where the value arrives *before* the buy, so you are not racing bots that already have the keys. And it is the only one whose core move — recognising a person from a picture, forty words and a launch rhythm, across wallets they never linked — makes a technical person ask how it works.

**The test, five days, under $100, no product code.**

Pull 2,000 launches from the last 30 days that crossed $50k and died under $5k, and 2,000 that crossed $50k and survived. You need the second arm; it is the control set the judges correctly said THE EXITS never assembled. For each, grab the image, the text, the socials URL and the choreography numbers. Compute four cheap fingerprints — dHash on the image (the open-source pump-image-reuse repo already does the mirror-canonicalisation), a CLIP embedding, character-ngram stylometry on the text, and a z-scored choreography vector. Retrieve nearest neighbours within the 4,000. Then hand-verify 100 pairs that hit on two or more modalities: is it really the same operator? Check by any means — shared funding three hops back, a reused domain, the same typo.

Two numbers decide it. **Distinctiveness:** what share of launches have a neighbour at a threshold where hand-checking says same operator more than half the time. Under 15% and the front page is a wall of shrugs — stop. **Outcome lift:** among coins that got a same-hand hit, what share died, against the base rate for all launches. If everything rugs at 92% and your flagged set rugs at 94%, you have nothing. You need twenty points of gap before a trader changes a decision.

If both clear, you have not just validated the idea — you have already built the seed corpus and all four extractors, which is the load-bearing half of the product.
