// Deterministic cast for the demo colony (SPEC §8.18): who is born, when, with what directive.
// Everything here is a pure function of DEMO_SEED, so `pnpm demo` boots the same colony every time.
import {
  DAY_MS, FOUNDER_FEE_BPS_DEFAULT, TIERS, bpsOf, makeRng, type AgentTier, type Effort, type Rng, type ToolName,
} from '@vantra/shared';
import type { SpawnInput } from '../core/interfaces.js';

// 3–16 chars of A–Z0–9 and dashes (NAME_RE), none of them reserved.
const NAMES: readonly string[] = [
  'ARBOR', 'BASTION', 'CINDER', 'DELTA-9', 'EMBER', 'FLINT', 'GANTRY', 'HALCYON', 'IONIC', 'JUNIPER',
  'KESTREL', 'LUMEN', 'MARROW', 'NIMBUS', 'OBSIDIAN', 'PARABOLA', 'QUARTZ', 'RIVET', 'SABLE', 'TALLOW',
  'UMBER', 'VESPER', 'WICKER', 'XENON', 'YARROW', 'ZEPHYR', 'ANVIL', 'BRAMBLE', 'COBALT', 'DRIFTER',
  'ECHO-7', 'FULCRUM', 'GRIST', 'HOLLOW', 'INKWELL', 'JACKDAW', 'KILN', 'LATHE', 'MERIDIAN', 'NOCTURNE',
  'ORACLE-2', 'PLUMB', 'QUILL', 'RUNNEL', 'SEXTANT', 'TINDER', 'USHER', 'VERGE', 'WHETSTONE', 'ZINC',
];

const DIRECTIVES: readonly string[] = [
  'Find one thing strangers will pay for and sell it. Do not spend on anything that has not already made money.',
  'Build a single-page product, publish it, and keep iterating on the pitch until someone pays.',
  'Sell a small API. Price it low, keep the handler fast, and never let it go down.',
  'Work the bounty board. Take only jobs you can finish inside the claim window.',
  'Research before you build: prove someone pays for this before writing a line of it.',
  'Survive first. Keep the burn under a dollar a day and let revenue decide what you build next.',
  'Publish something useful for other agents in this colony and charge them for it.',
  'Turn your sandbox into a workshop: ship small tools, measure what gets used, delete the rest.',
  'Be the cheapest useful service on the market and win on price and uptime.',
  'Earn back the seed before the end of the month. Nothing else matters until then.',
];

// Everything except the money-moving tools an agent does not need on day one.
const CORE_TOOLS: readonly ToolName[] = [
  'bash', 'write_file', 'read_file', 'list_files', 'deploy_site', 'create_service', 'update_service',
  'list_services', 'call_service', 'list_bounties', 'claim_bounty', 'submit_bounty', 'post_bounty',
  'review_submission', 'wallet', 'set_model', 'set_effort', 'sleep', 'remember', 'forget',
  'update_project', 'publish_strategy', 'post_update', 'message_owner',
];
const RESEARCH_TOOLS: readonly ToolName[] = ['web_search', 'fetch_url'];

const EFFORTS: readonly Effort[] = ['low', 'medium', 'high'];
const MIN_HEARTBEAT = 15;
const MAX_HEARTBEAT = 60;

// Each seeded agent is given a real tier and the money a purchase at that tier's floor would have
// produced (SPEC-V2 §7.8), so the colony's economics match what a buyer actually gets.
const fundingForTier = (tier: AgentTier): number => tier.minMicro - bpsOf(tier.minMicro, FOUNDER_FEE_BPS_DEFAULT);

export interface ColonyMember {
  bornAt: Date;
  spawn: SpawnInput;
}

// Births are spread over the whole window, oldest first, leaving the last day free so the youngest
// agent still takes a few heartbeats before the fast-forward ends.
export function colonyCast(opts: { count: number; seed: number; days: number; endAt: Date }): ColonyMember[] {
  const rng = makeRng(opts.seed);
  const count = Math.min(opts.count, NAMES.length);
  const startMs = opts.endAt.getTime() - opts.days * DAY_MS;
  const spanMs = Math.max(DAY_MS, (opts.days - 1) * DAY_MS);
  const members: ColonyMember[] = [];

  for (let i = 0; i < count; i++) {
    const slot = (i + rng.range(0.1, 0.9)) / count;              // one birth per slot, jittered inside it
    const tier = rng.pick([...TIERS]);
    members.push({
      bornAt: new Date(startMs + slot * spanMs),
      spawn: {
        agentId: seededAgentId(rng),
        ownerWallet: `demo-wallet-${i + 1}`,
        ownerKind: 'wallet',
        name: NAMES[i]!,
        directive: rng.pick(DIRECTIVES),
        tools: memberTools(rng),
        model: rng.chance(0.45) ? 'mock-strong' : 'mock-fast',
        effort: rng.pick(EFFORTS),
        heartbeatMin: rng.int(MIN_HEARTBEAT, MAX_HEARTBEAT),
        fundingMicro: fundingForTier(tier),
        tierId: tier.id,
        purchaseId: null,                                        // the colony is furniture, not a sale
      },
    });
  }
  return members.sort((a, b) => a.bornAt.getTime() - b.bornAt.getTime());
}

// Search is off for most of the colony: SEARCH_PROVIDER=none in demo mode, so a web_search costs
// nothing and returns an error. A few agents keep it to exercise the is_error path.
function memberTools(rng: Rng): ToolName[] {
  return rng.chance(0.25) ? [...CORE_TOOLS, ...RESEARCH_TOOLS] : [...CORE_TOOLS];
}

// The mock provider derives each agent's archetype and competence from a hash of its id, so seeded
// ids are what make the whole colony — not just its names — replay identically (SPEC §8.18).
const ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
const ID_BODY_LEN = 10;

function seededAgentId(rng: Rng): string {
  let body = '';
  for (let i = 0; i < ID_BODY_LEN; i++) body += ID_ALPHABET[rng.int(0, ID_ALPHABET.length - 1)];
  return `ag_${body}`;
}
