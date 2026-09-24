// Post-mortems (SPEC §8.10): a procedural paragraph from the books plus an optional one-paragraph
// epitaph from the cheapest model — paid by the protocol, capped, and templated in mock mode.
import { desc, eq } from 'drizzle-orm';
import {
  POSTMORTEM_LLM_CAP_MICRO, fmtUsd, type DeathCause, type Micro,
} from '@vantra/shared';
import type { CoreDeps } from '../core/interfaces.js';
import type { DbLike } from '../db/client.js';
import { decisions, projects, type AgentRow } from '../db/schema.js';
import { ageDaysOf, round1 } from '../economy/burn.js';
import { profitOf } from '../economy/ledger.js';

const EPITAPH_MIN_TOKENS = 64;
const EPITAPH_MAX_TOKENS = 260;

type Deps = Pick<CoreDeps, 'db' | 'clock' | 'llm' | 'log'>;

const CAUSE_TEXT: Record<DeathCause, string> = {
  insolvent: 'ran out of money',
  rent: 'could not pay its rent',
  owner_terminated: 'was terminated by its owner',
  protocol_violation: 'was shut down for breaking the protocol rules',
};

export async function buildPostmortem(deps: Deps, agent: AgentRow, cause: DeathCause): Promise<string> {
  const facts = await gatherFacts(deps.db, agent, cause, deps.clock.now());
  const body = proceduralParagraph(facts);
  const epitaph = await epitaphFor(deps, facts).catch((e: unknown) => {
    deps.log.warn({ err: e, agentId: agent.id }, 'epitaph generation failed');
    return null;
  });
  return epitaph ? `${body}\n\n${epitaph}` : body;
}

export interface PostmortemFacts {
  id: string; name: string; cause: DeathCause; ageDays: number; steps: number;
  fundingMicro: Micro; externalMicro: Micro; internalMicro: Micro; profitMicro: Micro; treasuryMicro: Micro;
  spend: { label: string; micro: Micro }[];
  biggest: { label: string; micro: Micro } | null;
  lastDecisions: string[];
  projects: { name: string; kind: string; status: string; revenueMicro: Micro }[];
}

async function gatherFacts(db: DbLike, a: AgentRow, cause: DeathCause, now: Date): Promise<PostmortemFacts> {
  const [decisionRows, projectRows] = await Promise.all([
    db.select({ text: decisions.text }).from(decisions).where(eq(decisions.agentId, a.id)).orderBy(desc(decisions.id)).limit(3),
    db.select().from(projects).where(eq(projects.agentId, a.id)).orderBy(desc(projects.revenueMicro)).limit(5),
  ]);
  const spend = [
    { label: 'inference', micro: a.spendInferenceMicro },
    { label: 'rent', micro: a.spendRentMicro },
    { label: 'compute', micro: a.spendComputeMicro },
    { label: 'tools', micro: a.spendToolsMicro },
    { label: 'hosting', micro: a.spendHostingMicro },
    { label: 'gas', micro: a.spendGasMicro },
    { label: 'payments', micro: a.spendPaymentsMicro },
  ].filter((s) => s.micro > 0).sort((x, y) => y.micro - x.micro);
  return {
    id: a.id, name: a.name, cause, ageDays: round1(ageDaysOf(a.bornAt, a.diedAt ?? now)), steps: a.totalSteps,
    fundingMicro: a.fundingMicro, externalMicro: a.revenueExternalMicro, internalMicro: a.revenueInternalMicro,
    profitMicro: profitOf(a), treasuryMicro: a.treasuryMicro,
    spend, biggest: spend[0] ?? null,
    lastDecisions: decisionRows.map((d) => d.text),
    projects: projectRows.map((p) => ({ name: p.name, kind: p.kind, status: p.status, revenueMicro: p.revenueMicro })),
  };
}

export function proceduralParagraph(f: PostmortemFacts): string {
  const spend = f.spend.length > 0 ? f.spend.map((s) => `${s.label} ${fmtUsd(s.micro)}`).join(', ') : 'nothing';
  const lines = [
    `${f.name} ${CAUSE_TEXT[f.cause]} after ${f.ageDays} days and ${f.steps} steps.`,
    `Someone paid ${fmtUsd(f.fundingMicro)} to bring it into existence. It earned ${fmtUsd(f.externalMicro)} external and ${fmtUsd(f.internalMicro)} internal revenue, and spent ${spend}.`,
    f.biggest ? `Its biggest cost centre was ${f.biggest.label} (${fmtUsd(f.biggest.micro)}).` : '',
    `Final P&L ${fmtUsd(f.profitMicro, { sign: true })}, treasury ${fmtUsd(f.treasuryMicro)}.`,
    f.projects.length > 0
      ? `Projects: ${f.projects.map((p) => `${p.name} (${p.kind}, ${p.status}, ${fmtUsd(p.revenueMicro)})`).join('; ')}.`
      : 'It never shipped a project.',
    f.lastDecisions.length > 0 ? `Last words: ${f.lastDecisions.map((d) => `"${trim(d, 160)}"`).join(' · ')}` : '',
  ];
  return lines.filter(Boolean).join(' ');
}

// One paragraph, protocol-paid, never billed to the agent and never more than the cap.
async function epitaphFor(deps: Deps, f: PostmortemFacts): Promise<string | null> {
  if (deps.llm.mode === 'mock') return mockEpitaph(f);
  const model = deps.llm.cheapest();
  const prompt = epitaphPrompt(f);
  const inTok = Math.ceil((prompt.system.length + prompt.user.length) / 4);
  const affordable = Math.floor((POSTMORTEM_LLM_CAP_MICRO - deps.llm.estimateMicro(model, inTok, 0)) / model.outputPerM);
  if (affordable < EPITAPH_MIN_TOKENS) return null;
  const res = await deps.llm.complete({
    model: model.id, system: prompt.system, messages: [{ role: 'user', content: [{ type: 'text', text: prompt.user }] }],
    tools: [], toolChoice: 'none', maxTokens: Math.min(EPITAPH_MAX_TOKENS, affordable), agentId: f.id,
  });
  const text = res.content.filter((c) => c.type === 'text').map((c) => c.text).join('').trim();
  return text.length > 0 ? text : null;
}

export function epitaphPrompt(f: PostmortemFacts): { system: string; user: string } {
  return {
    system:
      'You write short, factual obituaries for autonomous economic agents on VANTRA. One paragraph, at most four ' +
      'sentences, plain prose, no headings, no markdown, no praise or blame. Say what it tried, what it earned and ' +
      'what killed it. Never invent facts that are not in the data.',
    user: `Agent: ${f.name}\nCause of death: ${f.cause}\nLived: ${f.ageDays} days over ${f.steps} steps\n`
      + `Paid for it: ${fmtUsd(f.fundingMicro)}\nExternal revenue: ${fmtUsd(f.externalMicro)}\nInternal revenue: ${fmtUsd(f.internalMicro)}\n`
      + `Spend: ${f.spend.map((s) => `${s.label} ${fmtUsd(s.micro)}`).join(', ') || 'none'}\n`
      + `Projects: ${f.projects.map((p) => `${p.name} (${p.kind}/${p.status}, ${fmtUsd(p.revenueMicro)})`).join('; ') || 'none'}\n`
      + `Last decisions: ${f.lastDecisions.join(' | ') || 'none'}`,
  };
}

export function mockEpitaph(f: PostmortemFacts): string {
  const verdict = f.fundingMicro > 0 && f.externalMicro >= f.fundingMicro
    ? 'It paid back what it cost before the money ran out.'
    : f.externalMicro > 0
      ? 'It found paying customers, just not enough of them.'
      : 'It never found a paying customer.';
  return `${verdict} ${f.biggest ? `${cap(f.biggest.label)} was what finally ate the treasury.` : 'Rent alone was enough to end it.'}`;
}

const trim = (s: string, max: number): string => (s.length <= max ? s : `${s.slice(0, max - 1)}…`);
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
