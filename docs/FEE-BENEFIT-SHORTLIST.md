# Fee mechanics that actually benefit someone — ranked shortlist

Produced 2026-09-16. Brief: fees used in a novel way that delivers a GENUINE benefit to a user
or to another memecoin. 18 concepts from 6 lenses; 3 judges (hostile investor + securities lawyer,
degen community lead, staff engineer) with 'does a real person get a real thing' weighted double;
prior-art web searches on the top 6. 16 agents, 0 errors.

> **Headline verdict: no GREAT idea in this set. The best is good.** The reusable discovery is that
> pump.fun's ten-wallet fee split (reassignable since Jan 2026) is a working direct-debit mandate:
> no card, no contract, cancellable in one click, and cancellation is a public on-chain act.
> That rail is new. The products bolted onto it are ordinary.

## Ranking

| # | Concept | Mean /70 | Worst judge | Benefit-realness /10 |
|---|---|---|---|---|
| 1 | RELAY — the creator fees pay the network's toll | 57.7 | 56 | 8.3 |
| 2 | THE SLOT — a watchdog you cannot quietly fire | 55.3 | 51 | 6.3 |
| 3 | SLOT SEVEN — the fee-wallet subscription | 52 | 49 | 7.3 |
| 4 | BACKSTOP — rug cover minted by the coin's own trading fees | 52.3 | 49 | 7 |
| 5 | HANGAR — the fee stream is a public compute utility that runs programs you own | 49.3 | 48 | 6.7 |
| 6 | KEPT — bonding a promise with a live fee route | 54.3 | 52 | 3.7 |
| 7 | THE FLOAT — a revolving advance desk against other tokens' creator-fee streams | 47.3 | 46 | 7 |
| 8 | WHOLESALE — your volume buys the group's tools | 46 | 43 | 7 |
| 9 | SLOTS — hire with a slice of your fee stream instead of with tokens | 45.3 | 41 | 7.3 |
| 10 | STANDING ORDER — the ten-wallet fee split as a direct-debit mandate | 46.3 | 42 | 6.3 |
| 11 | FLOAT — buy what your coin needs on day one, pay out of fees it earns later | 43.7 | 42 | 7 |
| 12 | THE ALLOWANCE — the chart pays your AI bill | 44.7 | 43 | 6 |

## Prior-art verdicts (top 6)

**RELAY — the creator fees pay the network's toll** — new combination
  - relayrpc.com ($RELAY — free Solana/Robinhood Chain RPC funded by pump.fun creator fees) — very close
  - Sol Incinerator — very close
  - RefundYourSOL (Fee Payer mode) — very close

**THE SLOT — a watchdog you cannot quietly fire, because its salary is one of your** — new combination
  - pump.fun × Donate.gg "Charity Coins" (fee slot paid to an external third party) — very close
  - Bubblemaps Intel Desk (+ Sept 2026 Insider Score / pre-screened feed) — very close
  - QuillCheck (continuous post-launch monitoring with change alerts) — very close

**SLOT SEVEN — the fee-wallet subscription (rank 1)** — new combination
  - ClawPump (clawpump.tech / clawpumpsol.com) — very close
  - pump.fun Creator Fee Sharing (shipped Jan 2026) — very close
  - Bags (bags.fm) fee-share splits — very close

**BACKSTOP — rug cover minted by the coin's own trading fees** — new combination
  - Flaunch — Progressive Bid Wall (Base, Uniswap v4 hook) — very close
  - Mendel (mendel.fun, Robinhood Chain) — very close
  - Neptune Mutual — parametric cover pools — very close

**HANGAR — the fee stream is a public compute utility that runs programs you own** — new combination
  - ClawPump — very close
  - PumpClaw — very close
  - Val.town (Townie) / Cloudflare Workers cron — very close

**KEPT — bonding a promise with a live fee route (rank 3)** — new combination
  - 1f512 (1F916 society commitment registry) — very close
  - Ethos Network — related
  - Virtuals Protocol '60 Days' / Agent Sets commitment module — related

---

## Verdict

There is no great idea in this set. The best of them is good. I want to be blunt about why, because the reason is more useful than the ranking. Each of the top three has a hole in exactly the place you said the bar is. RELAY has the most real benefit — a number goes up in your wallet in thirty seconds — but the prior-art check destroyed it: two competitors already do the zero-SOL dust sweep at scale, and a live product called $RELAY already funds free infrastructure from pump.fun creator fees using the same words. THE SLOT has the only mechanism a smart person reacts to out loud, but what the paying customer buys is trust, which is real and unpriceable. SLOT SEVEN delivers the most obviously real thing, but it is an agency with a clever invoice, not a coin mechanic. Here is the thing worth taking away: all six top concepts are the same discovery wearing six costumes. The discovery is that pump.fun's ten-wallet fee split, which only became reassignable in January 2026, is a working direct-debit mandate — no card, no contract, no company, cancellable in one click, and cancellation is a public act anyone can see. That rail is genuinely new. Every product bolted onto it is ordinary. Your real question is not "which of these six," it is "what will someone actually pay for on that rail," and you can answer that for about a hundred dollars before you write the product.

---

## 1. THE SLOT — the watchdog you cannot quietly fire

**What it is.** A memecoin team points one of its ten fee wallets at an independent monitor. pump.fun pays the monitor directly, so the team is not the one writing the cheque. If the team wants rid of the monitor, they have to change the setting on-chain, and the monitor sees that within a minute and publishes it as a permanent alarm. Hiring is expensive, firing is loud, and there is no quiet third option.

**Who benefits and with what.** Two people. A trader pays about a dollar and asks one question about one wallet: "who is holder number three?" An hour later there is a public answer with every transaction cited — "funded by the deployer eleven minutes before launch, has appeared in forty-one launches, sold inside the first hour in thirty-nine of them." That changed a buying decision for a dollar. That is real. The team's benefit is softer and I will not dress it up: they buy a promise that costs them money every hour to keep and makes a noise when they break it. No other trust signal in memecoins works that way. LP burns and revoked mints are one-time and binary.

**The fee mechanic.** (1) A member token assigns one of its ten slots, minimum 10%, to an address we publish on that token's page. (2) Our existing deposit scanner sees the inflow. (3) The hourly keeper claims the SOL and swaps to USDC. (4) That token's inflow becomes that token's monitoring budget, enforced by the metered runtime's hard cap. A token streaming two dollars a day gets two dollars a day of checking. No plans, no invoices. (5) The monitor runs cheap chain reads and only spends on AI when something changed: dev sells, LP moves, authority changes, holder concentration, copycat launches. (6) A signed daily report goes on a public page, including what the checking cost. (7) If they revoke the slot, we publish "WATCH REVOKED" with a timestamp, forever.

**Novelty.** The closest things are RugCheck and QuillCheck, which are free and automated, and Assure DeFi, which sells a one-time badge for cash. The uncomfortable one is Bubblemaps Intel Desk: a funded, live queue where people commission wallet investigations that get published. It is close on the paid-investigation half and it is moving toward your free half. What nobody has done — the prior-art pass looked hard and found nothing — is have the watched party pay the watcher through the platform, and treat cancelling that payment as a published reputation event. **The pass also found something better than what the concept asked for:** pump.fun's SDK has an `adminRevoked` flag that permanently locks a fee-share config. A team can make firing the watchdog literally impossible. That is a one-way door, and it turns the soft "trust" benefit into a hard one. Sell that as the top tier.

**At $10 a day.** It works, and it is the cheapest of the three. Split four ways: $4 to the wallet graph, $2 to servers, $2.50 to watching unpaid tokens so there is coverage on day one, $1.50 to subsidising retail investigations. Most of the work is chain reads, not AI, so $4 a day of cheap-model calls covers thousands of wallet classifications. The important bit: member tokens cost you nothing, because each one brings its own money. Member two hundred is free and makes the product better for everyone.

**Reuse.** Very heavy. The metered runtime becomes the billing engine — a token's fee income literally is its spending cap, already written and tested. Insolvency becomes graceful public degradation instead of silent cancellation. The wallet code, deposit scanner, ledger, scheduler, tool registry, bounty queue and the whole Observatory front end all carry over. Roughly 3,000–4,000 new lines.

**What kills it.** You will be publishing accusatory-sounding claims about named wallets, for money, as a solo founder with no legal budget. Mislabel one market maker and you have a defamation problem and a credibility collapse on the same afternoon. The rule that saves you is absolute: publish only facts a reader can reproduce in a block explorer, never a conclusion about who someone is. The second killer is demand. Assure DeFi, the incumbent paid trust badge, is shutting down in 2026 because that market shrank. That is evidence against the team-side revenue, and you should weigh it.

---

## 2. SLOT SEVEN — the fee wallet as a subscription

**What it is.** Any memecoin team points one fee wallet at us. In return we build and permanently run their actual infrastructure: a website, a live holder dashboard, a buy-alert bot, a daily on-chain report. No card, no invoice, no signup. Their own trading volume is the bill, and they cancel by changing one setting.

**Who benefits and with what.** The team. They get working, hosted, operating software. A freelancer quotes $300–1,500 to build it and $50–200 a month to keep it alive. They pay no cash. The comparison is not your $9 token, it is $800 they do not have on the day they have the most uncertainty and no treasury. Three extras make the trade good: cancelling is one click, the cost scales with how well they are doing, and the routing is visible on-chain, so "5% of our fees go to operations" is a credibility signal their own holders can check.

**The fee mechanic.** They sign in with the deployer wallet, we verify on-chain that it controls the mint, we mint them a custodied address, they assign a slot at 5%, 10% or 20%. We poll the split and only switch on once we see it. Hourly, the keeper claims, swaps to USDC, credits their ledger account. Each service draws a metered daily cost — hosting $0.02, dashboard $0.05, alert bot $0.10, daily report $0.08. Balance empty for 72 hours and a published ladder runs in order: report stops, bot stops, dashboard freezes, site falls back to a static snapshot that stays up free forever.

**Novelty.** ClawPump routes creator fees into an agent so the agent pays its own bills. This is the same machinery pointed the other way: fees go out to a provider and work comes back. Nobody is doing that. But be honest about the moat — it is a convention on someone else's platform, and ClawPump already has the custodied wallets, the hourly claim and 2,700 funded agents. They could copy the billing model in an afternoon.

**At $10 a day.** $304 a month. Servers and domains take $25, leaving $275 of model budget. A small build is $0.15–0.60 of cheap-model tokens, so 15–60 free builds a day. A client routing 10% of a $10/day stream sends $1.00 a day against $0.40 a day of running costs. Adding clients costs you nothing.

**Reuse.** The highest in the set. The metered runtime becomes the per-client build budget. The Docker sandbox and static deploy ship the sites. The ledger becomes the client's statement. The Observatory becomes their console.

**What kills it.** Two things, and the second is worse. Quality — an LLM-built dashboard showing a wrong holder count is now your public failure on someone else's ticker, and one person cannot check 200 clients. And hosting. You become a host for whatever anonymous teams publish, from your own domain, and your repo has zero takedown, report or blocklist code. One phishing page gets your API, every client site and the payment flow blocklisted at once. That must exist before customer one. Also worth facing: the free alternatives are decent now. Tokly's free tier plus a free alert bot gets a broke deployer 70% of the way in twenty minutes.

---

## 3. RELAY, but only the business half

**What it is.** Another token pays us from a fee slot, and we pay the gas and the account rent for strangers making their *first* buy of that token. Someone holding only stablecoins, who literally cannot buy anything on Solana because they have no SOL, can buy.

**Who benefits and with what.** The project, and the arithmetic is the sharpest thing in this whole document. Sponsoring a first buy costs about $0.45. After graduation the creator fee is 0.95%, so any sponsored buy over about $45 generates more fee than the sponsorship cost. The project acquires holders out of the revenue those holders produce. The prior-art pass could not find that anywhere.

**At $10 a day.** $10 buys about 24 sponsored first buys. Thin, but it is self-funding after graduation, so the client's stream pays, not yours.

**What kills it, and why I have demoted it.** The consumer half of this concept is gone. RefundYourSOL markets "no SOL needed to start recovering" and claims 650,000 wallets. Sol Incinerator already fronts the fee for empty wallets. Pump Layer already does gasless pump.fun trading paid in a memecoin. The Solana Foundation shipped Kora in April, which is your entire relayer as a config file. And relayrpc.com is a live product called $RELAY funding free infrastructure from pump.fun creator fees with your exact sentence. Three judges ranked this first partly on a claim — "Sol Incinerator requires you to already have SOL" — that is simply false. Strip out the false bits and what is left is one clever B2B trick, which is a feature, not a company.

---

## What I discarded, and why

**BACKSTOP** (rug cover minted by the coin's own fees) — Flaunch has shipped fee-minted, dev-unwithdrawable downside protection since 2025, and Mendel claws unvested creator fees back to holders when a coin is drained. That is your thesis sentence, live. On top of that it is unlicensed insurance, and "discretionary and capped" is a defence, not a shield.

**THE ALLOWANCE / any "fees pay the AI's bill"** — that is ClawPump and Virtuals, already shipped, already rejected in your own docs.

**KEPT (benefit 3.7) and THE WORKS (benefit 3.3)** — both fail the one test you set. Nobody gets anything they would call real.

**The retail half of RELAY** — commodity, as above.

---

## The near miss

BACKSTOP had the best sentence anyone wrote: *the rug's own trading fees pay its victims.* The structure is genuinely elegant — the party creating the risk funds the protection automatically, cannot claw back what already accrued because it lands at an address they do not control, and capacity grows with exactly the attention the risk is attracting. No premiums, no capital providers, no yield, no claims committee, and therefore none of the things that make DeFi insurance look like a security. It died for two separate reasons, either one fatal. Flaunch and Mendel already built the mechanism. And rugs happen in the first hours, when the vault is empty by construction — so on the rug that actually hurts people, you pay out almost nothing, and the first "BACKSTOP didn't pay" thread ends the brand.

---

## My recommendation

Build THE SLOT, with the permanent lock as the headline. But do not build the product first, because the product is 4,000 lines and the thing you do not know is whether anyone will assign you a slot.

**Build this first, in a weekend, for about the cost of a server:** a public page that watches the fee-split configuration of every pump.fun token above some floor, and publishes every change as a timestamped, permanent event. Nothing else. No AI, no wallet graph, no investigations.

It is cheap because it is chain reads on a loop. It is useful on day one to anyone holding a bag, which gives you an audience before you have a product. And it answers the three questions that decide everything, with data instead of opinion. How often does any token change its fee split — is the alarm a real signal or background noise? Has *any* token ever pointed a slot at a third-party service, which tells you whether you are capturing a behaviour or inventing one? And when a split does change, does the price move — because if it does, the alarm is the product and the monitoring is the excuse.

If tokens never touch their splits, the mechanic is theatre and you have spent a weekend finding out. If they do, you have already built the load-bearing half and you can go sell the first slot with a live page to point at.
