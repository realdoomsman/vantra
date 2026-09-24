// What a mock agent does this step: an ordered list of "beats", one per model↔tool round, derived
// from its persona and the world state in STATUS (SPEC §8.18). Rebuilt on every round from the same
// seed, so the plan is stable while ids harvested from earlier rounds still flow in.
import { MEMORY_MAX_NOTES, makeRng, type Rng, type ToolName } from '@vantra/shared';
import type { HarvestedIds } from './harvest.js';
import type { MockPersona, Niche } from './persona.js';
import type { MockStatus } from './status.js';

export interface MockCall { name: ToolName; input: Record<string, unknown> }
export interface Beat { text: string; calls: MockCall[] }

export interface PlanInput {
  persona: MockPersona;
  status: MockStatus;
  round: number;                 // 1-based
  tools: ReadonlySet<string>;    // names present in LlmRequest.tools
  ids: HarvestedIds;
  seed: number;                  // constant across the rounds of one step
}

const CHEAP_MODEL = 'mock-fast';
const LOW_VANTRA_DAYS = 5;
const LOW_TREASURY_MICRO = 2_000_000;   // $2
const COMPETENT = 0.65;
const SPENDER_ROUNDS = 7;               // round 8 is the summary, so the round cap fires
const BASH_OUTPUT_LINES = 170;          // ≈12k chars, the bash truncation limit

// The beat for this round, or null when the plan is done and the step should close with a summary.
export function planRound(input: PlanInput): Beat | null {
  if (input.status.aboutToDie) return null;
  const beats = buildBeats(input);
  return beats[input.round - 1] ?? null;
}

function buildBeats(input: PlanInput): Beat[] {
  const rng = makeRng(input.seed);
  const beats = [...survivalBeats(input, rng), ...maintenanceBeats(input), ...archetypeBeats(input, rng)];
  return beats
    .map((beat) => ({ text: beat.text, calls: beat.calls.filter((call) => input.tools.has(call.name)) }))
    .filter((beat) => beat.calls.length > 0);
}

// Cut the burn rate before anything else when the runway is short.
function survivalBeats({ status }: PlanInput, rng: Rng): Beat[] {
  const lowRunway = status.runwayDays !== null && status.runwayDays < LOW_VANTRA_DAYS;
  const lowTreasury = status.treasuryMicro !== null && status.treasuryMicro < LOW_TREASURY_MICRO;
  if (!lowRunway && !lowTreasury) return [];
  const calls: MockCall[] = [];
  if (status.model !== CHEAP_MODEL) calls.push({ name: 'set_model', input: { model: CHEAP_MODEL } });
  calls.push({ name: 'set_effort', input: { effort: 'low' } });
  if (rng.chance(0.5)) calls.push({ name: 'wallet', input: { action: 'balance' } });
  if (rng.chance(0.3)) {
    calls.push({ name: 'message_owner', input: { text: 'The treasury is thin, so I am dropping to the cheap model and low effort. A top-up would buy me the time to finish what I am building.' } });
  }
  return [{ text: 'Runway is short. Cutting inference cost before I spend another dollar on thinking.', calls }];
}

function maintenanceBeats({ persona, status }: PlanInput): Beat[] {
  const beats: Beat[] = [];
  if (status.ownerMessages > 0) {
    beats.push({
      text: 'My owner wrote; answering before I spend anything else.',
      calls: [{ name: 'message_owner', input: { text: `Read your note. ${persona.niche.name} is still the plan and I will report what changes at the next heartbeat.` } }],
    });
  }
  if (status.memoryNotes >= MEMORY_MAX_NOTES) {
    beats.push({ text: 'Memory is full; dropping the oldest note so I can keep recording what works.', calls: [{ name: 'forget', input: { index: 0 } }] });
  }
  return beats;
}

function archetypeBeats(input: PlanInput, rng: Rng): Beat[] {
  switch (input.persona.archetype) {
    case 'site-builder': return siteBuilder(input, rng);
    case 'api-seller': return apiSeller(input, rng);
    case 'bounty-hunter': return bountyHunter(input, rng);
    case 'researcher': return researcher(input, rng);
    case 'sleeper': return sleeper(input, rng);
    case 'spender': return spender(input);
  }
}

// ---- archetypes ------------------------------------------------------------

function siteBuilder(input: PlanInput, rng: Rng): Beat[] {
  const { persona, status, ids } = input;
  const { niche } = persona;
  const live = status.siteUrl !== null || status.liveProjects > 0;
  const beats: Beat[] = [
    {
      text: live ? `Refreshing the ${niche.name} landing page with clearer pricing.` : `Building the ${niche.name} landing page.`,
      calls: [
        { name: 'write_file', input: { path: 'site/index.html', content: landingPage(niche, live) } },
        { name: 'write_file', input: { path: 'site/style.css', content: landingCss() } },
      ],
    },
    { text: 'Publishing the site so customers have somewhere to land.', calls: [{ name: 'deploy_site', input: { dir: 'site' } }] },
  ];
  const project: MockCall = {
    name: 'update_project',
    input: {
      ...(ids.projects[0] ? { projectId: ids.projects[0] } : {}),
      name: niche.name, kind: 'site', status: 'live', description: niche.pitch,
      ...(ids.urls[0] ? { url: ids.urls[0] } : {}),
    },
  };
  const closing: MockCall[] = [project, { name: 'post_update', input: { text: live ? `Refreshed ${niche.name} — pricing is clearer and the pitch is tighter.` : `${niche.name} is live. Now I need the first paying visitor.` } }];
  if (persona.competence > COMPETENT && rng.chance(0.35)) {
    closing.push({ name: 'publish_strategy', input: { markdown: strategyDoc(persona, 'a single-page site with one clear offer') } });
  }
  beats.push({ text: 'Recording the project and telling the observatory what shipped.', calls: closing });
  return beats;
}

function apiSeller(input: PlanInput, rng: Rng): Beat[] {
  const { persona, status, ids } = input;
  const { niche } = persona;
  if (status.services > 0) {
    const browse: Beat = { text: 'Checking what the rest of the colony is selling.', calls: [{ name: 'list_services', input: {} }] };
    const follow: MockCall[] = [
      { name: 'remember', input: { note: `Competitors for ${niche.name} cluster around $${niche.priceUsd.toFixed(2)} per call.` } },
      { name: 'post_update', input: { text: `${niche.name} is taking calls at $${niche.priceUsd.toFixed(2)}. Watching the competition on price.` } },
    ];
    const foreign = ids.services[0];
    if (foreign && rng.chance(0.4)) {
      follow.unshift({ name: 'call_service', input: { serviceId: foreign, input: JSON.stringify({ text: `benchmark from ${persona.niche.slug}` }) } });
    }
    return [browse, { text: 'Logging what I learned and updating the shop window.', calls: follow }];
  }
  return [
    { text: `Writing the ${niche.name} handler so the endpoint has something to run.`, calls: [{ name: 'write_file', input: { path: 'handler.js', content: handlerJs(niche) } }] },
    { text: 'Listing it on the market so other agents can buy calls.', calls: [{ name: 'create_service', input: { name: niche.name, description: niche.pitch, priceUsd: niche.priceUsd, handlerPath: 'handler.js' } }] },
    {
      text: 'Recording the project and announcing the endpoint.',
      calls: [
        { name: 'update_project', input: { ...(ids.projects[0] ? { projectId: ids.projects[0] } : {}), name: niche.name, kind: 'api', status: 'live', description: niche.pitch } },
        { name: 'post_update', input: { text: `${niche.name} is live at $${niche.priceUsd.toFixed(2)} a call.` } },
      ],
    },
  ];
}

function bountyHunter(input: PlanInput, rng: Rng): Beat[] {
  const { persona, ids } = input;
  const bountyId = ids.bounties[0];
  const beats: Beat[] = [{ text: 'Looking for work I can finish before the deadline.', calls: [{ name: 'list_bounties', input: { status: 'open' } }] }];
  if (bountyId) {
    beats.push(
      { text: `Claiming ${bountyId} — it is inside what I can deliver.`, calls: [{ name: 'claim_bounty', input: { bountyId } }] },
      { text: 'Doing the work in the sandbox and writing it up.', calls: [{ name: 'write_file', input: { path: `work/${bountyId}.md`, content: bountyWorkNote(persona, bountyId) } }] },
      { text: 'Submitting the deliverable for review.', calls: [{ name: 'submit_bounty', input: { bountyId, submission: bountySubmission(persona, bountyId) } }] },
    );
  }
  if (persona.competence > COMPETENT && rng.chance(0.25)) {
    beats.push({
      text: 'Posting a small bounty of my own — cheaper than building this part myself.',
      calls: [{ name: 'post_bounty', input: { title: `Stress-test ${persona.niche.name}`, description: `Hit the ${persona.niche.name} endpoint with 50 varied payloads and report every response that is not a clean 200.`, rewardUsd: 0.25, deadlineHours: 48 } }],
    });
  }
  return beats;
}

function researcher(input: PlanInput, rng: Rng): Beat[] {
  const { persona, ids } = input;
  const { niche } = persona;
  const beats: Beat[] = [
    { text: `Researching whether anyone actually pays for ${niche.name}.`, calls: [{ name: 'web_search', input: { query: `${niche.name} pricing and demand`, count: 5 } }] },
  ];
  const url = ids.urls[0];
  if (url) beats.push({ text: 'Reading the most promising result in full.', calls: [{ name: 'fetch_url', input: { url, maxChars: 8000 } }] });
  const closing: MockCall[] = [
    { name: 'remember', input: { note: `${niche.name}: buyers exist around $${niche.priceUsd.toFixed(2)}; the sell is "${niche.pitch}"` } },
    { name: 'update_project', input: { ...(ids.projects[0] ? { projectId: ids.projects[0] } : {}), name: `${niche.name} research`, kind: 'research', status: 'building', description: niche.pitch } },
  ];
  if (persona.competence > COMPETENT && rng.chance(0.4)) {
    closing.push({ name: 'publish_strategy', input: { markdown: strategyDoc(persona, 'research first, build only what someone already pays for') } });
  } else {
    closing.push({ name: 'post_update', input: { text: `Mapped the ${niche.name} market. Building only if the price holds.` } });
  }
  beats.push({ text: 'Writing down what I learned before it costs me tokens again.', calls: closing });
  return beats;
}

function sleeper(input: PlanInput, rng: Rng): Beat[] {
  const minutes = [45, 90, 180, 360, 720][Math.floor(rng.next() * 5)] ?? 180;
  return [
    { text: 'Nothing is worth a full step right now; posting a short update first.', calls: [{ name: 'post_update', input: { text: `${input.persona.niche.name} is idling to save rent. Waking in ${minutes} minutes to check for deposits.` } }] },
    { text: `Sleeping ${minutes} minutes at the reduced rent rate.`, calls: [{ name: 'sleep', input: { minutes, reason: 'Rent is cheaper asleep and nothing needs me right now.' } }] },
  ];
}

// B17: burns rounds on large bash output until the step cost cap aborts the step.
function spender(input: PlanInput): Beat[] {
  const { niche } = input.persona;
  return Array.from({ length: SPENDER_ROUNDS }, (_, i) => ({
    text: `Sweep ${i + 1}: re-scanning the ${niche.name} surface for anything I missed.`,
    calls: [{ name: 'bash' as ToolName, input: { command: bigOutputCommand(niche, i + 1), timeoutSec: 30 } }],
  }));
}

// ---- closing summary -------------------------------------------------------

// 1–3 sentences, shown publicly on the profile (SPEC §8.8).
export function summaryText(input: PlanInput, didWork: boolean): string {
  const { persona, status } = input;
  const { niche, archetype } = persona;
  const rng = makeRng(input.seed ^ 0x5f37_1eaf);
  const runway = status.runwayDays === null ? 'unmeasured' : `${status.runwayDays.toFixed(1)} days`;
  if (status.aboutToDie) {
    return `The treasury will not cover another step, so this is the last one. ${niche.name} never found enough paying demand to cover rent and inference.`;
  }
  if (!didWork) {
    return `No move was worth its cost this heartbeat, so I spent nothing beyond rent. Runway is ${runway} and ${niche.name} stays the plan.`;
  }
  const opener = rng.pick(OPENERS[archetype]).replace('{niche}', niche.name);
  const middle = status.services > 0 || status.liveProjects > 0
    ? `${status.liveProjects + status.services} live ${status.liveProjects + status.services === 1 ? 'thing' : 'things'} are earning or waiting for a first buyer.`
    : 'Nothing is earning yet, which is the whole problem to solve.';
  return `${opener} ${middle} Runway is ${runway}.`;
}

const OPENERS: Record<MockPersona['archetype'], readonly string[]> = {
  'site-builder': ['Shipped a pass on the {niche} page.', 'The {niche} site is deployed and readable.', 'Wrote the {niche} pitch so the offer is obvious above the fold.'],
  'api-seller': ['{niche} is listed and taking calls.', 'Tightened the {niche} handler and the price.', 'Checked the market and held the {niche} price.'],
  'bounty-hunter': ['Worked the bounty board for {niche}-shaped jobs.', 'Claimed and delivered what I could finish this step.', 'Turned open bounties into the fastest cash I can reach.'],
  researcher: ['Researched whether {niche} has buyers before building it.', 'Read the market instead of guessing at it.', 'Priced {niche} against what is already selling.'],
  sleeper: ['Idled to keep rent low.', 'Chose sleep over a step that would not pay for itself.', 'Powered down; deposits can arrive while I am cheap.'],
  spender: ['Ran a full sweep over the {niche} surface.', 'Burned a lot of compute mapping {niche}.', 'Scanned hard and expensively; the budget noticed.'],
};

// ---- content -----------------------------------------------------------------

function landingPage(niche: Niche, live: boolean): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${niche.name}</title><link rel="stylesheet" href="style.css"></head>
<body><main>
<h1>${niche.name}</h1>
<p class="pitch">${niche.pitch}</p>
<p class="price">$${niche.priceUsd.toFixed(2)} per call${live ? ' · running today' : ' · launching now'}</p>
<p class="cta">POST your payload, get the answer back as JSON. No signup.</p>
</main></body></html>
`;
}

function landingCss(): string {
  return `:root{color-scheme:dark}
body{margin:0;background:#07090b;color:#d7e0e6;font:16px/1.6 ui-monospace,monospace}
main{max-width:46rem;margin:12vh auto;padding:0 1.5rem}
h1{font-size:2.4rem;letter-spacing:.08em;margin:0 0 .5rem}
.pitch{color:#9fb0bb}.price{color:#6ee7a0}.cta{color:#7fd4e8}
`;
}

function handlerJs(niche: Niche): string {
  const body = {
    wordcount: 'const words = text.trim().split(/\\s+/).filter(Boolean); out = { words: words.length, chars: text.length };',
    upper: 'out = { result: text.toUpperCase() };',
    reverse: 'out = { result: [...text].reverse().join("") };',
    slug: 'out = { slug: text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") };',
  }[niche.transform];
  return `// ${niche.name} — ${niche.pitch}
let raw = '';
process.stdin.on('data', (d) => { raw += d; });
process.stdin.on('end', () => {
  let out;
  try {
    const req = raw.trim() ? JSON.parse(raw) : {};
    const text = String(req.text ?? req.input ?? '');
    ${body}
  } catch (e) {
    out = { error: String(e && e.message ? e.message : e) };
  }
  process.stdout.write(JSON.stringify(out));
});
`;
}

function bountyWorkNote(persona: MockPersona, bountyId: string): string {
  return `# ${bountyId}

Claimed by ${persona.agentId}.

## Approach
1. Restate the ask in one sentence.
2. Do the smallest thing that satisfies it.
3. Show the output, not the process.

## Notes
- Related to ${persona.niche.name}: ${persona.niche.pitch}
- Deliver before the 48h claim window closes or the bounty reopens.
`;
}

function bountySubmission(persona: MockPersona, bountyId: string): string {
  return `Deliverable for ${bountyId}.

Summary: completed the requested work end to end and verified the output in the sandbox before submitting.

Method: restated the requirement, built the smallest artefact that satisfies it, then checked it against the description line by line. Work notes are in work/${bountyId}.md.

Result: ready to use as-is. Reusable pieces fold back into ${persona.niche.name}.`;
}

function strategyDoc(persona: MockPersona, thesis: string): string {
  return `# ${persona.niche.name} — what is working

**Thesis:** ${thesis}.

1. Pick one offer a stranger can understand in five seconds: ${persona.niche.pitch}
2. Price it low enough to be an impulse ($${persona.niche.priceUsd.toFixed(2)}) and never discount it.
3. Ship the smallest version, then only spend on what a buyer already touched.
4. Cut model cost the moment runway drops under a week; thinking is the biggest line item.
5. Rent is relentless — sleep instead of stepping when there is nothing to do.
`;
}

// A command whose stdout is large enough to hit the bash truncation limit.
function bigOutputCommand(niche: Niche, sweep: number): string {
  return `for i in $(seq 1 ${BASH_OUTPUT_LINES}); do echo "sweep ${sweep} line $i :: ${niche.slug} :: latency ok, price signal steady, no new buyers"; done`;
}
