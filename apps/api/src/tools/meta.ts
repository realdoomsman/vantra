// Self-management tools: set_model, set_effort, sleep, remember, forget, update_project,
// publish_strategy, post_update, message_owner. SPEC §8.9; AMENDMENTS A9 (model/effort take effect
// on the NEXT heartbeat), B16 (memory and projects feed the STATUS block).
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  EFFORTS, MAX_SLEEP_MIN, MEMORY_MAX_NOTES, MEMORY_NOTE_MAX_CHARS, MIN_SLEEP_MIN, fmtUsd,
} from '@vantra/shared';
import type { CoreDeps } from '../core/interfaces.js';
import type { DbLike } from '../db/client.js';
import { agents, ownerMessages, projects } from '../db/schema.js';
import { newProjectId } from '../lib/ids.js';
import { cut, fail, fmtMinutes, freshAgent, isHttpUrl, ok, toProject } from './common.js';
import { defineTool, type ToolSpec } from './spec.js';

export const STRATEGY_MAX_CHARS = 6_000;
export const UPDATE_MAX_CHARS = 240;
export const OWNER_MESSAGE_MAX_CHARS = 1_000;
export const PROJECT_NAME_MAX_CHARS = 80;
export const PROJECT_DESCRIPTION_MAX_CHARS = 1_000;
export const MAX_PROJECTS_PER_AGENT = 20;

const PROJECT_KINDS = ['site', 'api', 'service', 'product', 'bounty', 'research', 'other'] as const;
const PROJECT_STATUSES = ['idea', 'building', 'live', 'abandoned'] as const;

export function metaTools(deps: CoreDeps): ToolSpec[] {
  const setModel = defineTool({
    name: 'set_model',
    description:
      `Switch the model you think with from your next heartbeat onwards. Call it when the price no longer fits ` +
      `your runway — a cheap model on a shrinking treasury buys many more steps than a frontier model on a few ` +
      `— or when cheap reasoning is visibly failing at the work you are doing. Free; the change takes effect ` +
      `next heartbeat, not inside this step.`,
    params: z.strictObject({
      model: z.string().trim().min(1).max(100).describe('Model id from the price table in your instructions, e.g. "claude-haiku-4-5".'),
    }),
    parallelSafe: false,
    summarize: (i) => i.model,
    async run(ctx, input) {
      const available = deps.llm.models();
      const picked = available.find((m) => m.id === input.model);
      if (!picked) {
        return fail(`"${input.model}" is not available. Choose one of: ${available.map((m) => m.id).join(', ')}.`);
      }
      if (picked.id === ctx.agent.model) return ok(`You are already on ${picked.id}.`);
      await deps.db.update(agents).set({ model: picked.id, updatedAt: deps.clock.now() }).where(eq(agents.id, ctx.agent.id));

      const price = `${fmtUsd(Math.round(picked.inputPerM * 1_000_000), { decimals: 2 })}/M in, ${fmtUsd(Math.round(picked.outputPerM * 1_000_000), { decimals: 2 })}/M out`;
      return ok(
        `Model set to ${picked.id} (${picked.label}, ${price}). Takes effect next heartbeat; this step finishes on ${ctx.agent.model}.`,
        {
          decision: { kind: 'pivot', text: `Switched model ${ctx.agent.model} → ${picked.id}`, meta: { from: ctx.agent.model, to: picked.id } },
        },
      );
    },
  });

  const setEffort = defineTool({
    name: 'set_effort',
    description:
      `Set how hard the model thinks before answering, from your next heartbeat onwards. Call it when the work ` +
      `changes shape: raise effort for design and debugging, lower it for routine upkeep, because higher effort ` +
      `means more reasoning tokens and a higher cost per step. Free; takes effect next heartbeat. Models that do ` +
      `not support effort ignore it.`,
    params: z.strictObject({
      effort: z.enum(EFFORTS as unknown as [string, ...string[]]).describe('One of low, medium, high, xhigh, max.'),
    }),
    parallelSafe: false,
    summarize: (i) => i.effort,
    async run(ctx, input) {
      const effort = input.effort as (typeof EFFORTS)[number];
      if (effort === ctx.agent.effort) return ok(`Effort is already ${effort}.`);
      await deps.db.update(agents).set({ effort, updatedAt: deps.clock.now() }).where(eq(agents.id, ctx.agent.id));
      return ok(`Effort set to ${effort}. Takes effect next heartbeat; this step finishes on ${ctx.agent.effort}.`);
    },
  });

  const sleep = defineTool({
    name: 'sleep',
    description:
      `Skip your next heartbeats and wake up later. Call it when there is genuinely nothing to do — waiting on ` +
      `customers, on a bounty review, on a deadline — because sleeping drops your rent from $0.02/h to $0.004/h ` +
      `and saves a whole step's inference each heartbeat. Do not sleep while you still have work that earns. ` +
      `Free. Your site and services stay up and keep selling while you sleep.`,
    params: z.strictObject({
      minutes: z.number().int().min(MIN_SLEEP_MIN).max(MAX_SLEEP_MIN)
        .describe(`How long to sleep, ${MIN_SLEEP_MIN}–${MAX_SLEEP_MIN} minutes (${MAX_SLEEP_MIN / 60} hours max).`),
      reason: z.string().trim().max(200).optional().describe('Why you are sleeping — shown on your public profile.'),
    }),
    parallelSafe: false,
    summarize: (i) => `${i.minutes} min${i.reason ? ` · ${cut(i.reason, 110)}` : ''}`,
    async run(ctx, input) {
      const until = new Date(deps.clock.now().getTime() + input.minutes * 60_000);
      await deps.db.update(agents).set({ sleepUntil: until, updatedAt: deps.clock.now() }).where(eq(agents.id, ctx.agent.id));
      const why = input.reason ? ` — ${input.reason}` : '';
      return ok(`Sleeping for ${fmtMinutes(input.minutes)}, waking at ${until.toISOString()}. Rent drops to the sleep rate until then.`, {
        decision: { kind: 'sleep', text: `Sleeping ${fmtMinutes(input.minutes)}${why}`, meta: { minutes: input.minutes, until: until.toISOString() } },
        event: { kind: 'sleep', text: `${ctx.agent.name} went to sleep for ${fmtMinutes(input.minutes)}${why}`, meta: { minutes: input.minutes, until: until.toISOString() } },
      });
    },
  });

  const remember = defineTool({
    name: 'remember',
    description:
      `Save one short note to the memory that is replayed to you every heartbeat. Call it the moment you learn ` +
      `something you will need after this step — a customer's address, what failed and why, a price that worked ` +
      `— because your transcript is thrown away between steps and only memory and files under /work survive. ` +
      `Free. Up to ${MEMORY_NOTE_MAX_CHARS} characters per note and ${MEMORY_MAX_NOTES} notes; past that the ` +
      `oldest note is dropped, so keep notes durable, not chatty.`,
    params: z.strictObject({
      note: z.string().trim().min(1).max(MEMORY_NOTE_MAX_CHARS).describe(`The fact worth keeping, up to ${MEMORY_NOTE_MAX_CHARS} characters.`),
    }),
    parallelSafe: false,
    summarize: (i) => cut(i.note, 150),
    async run(ctx, input) {
      return deps.db.transaction(async (tx) => {
        const me = await freshAgent(tx, ctx.agent.id, true);
        if (me.memory.some((n) => n === input.note)) return ok(`You already remember that (note [${me.memory.indexOf(input.note)}]).`);
        const next = [...me.memory, input.note];
        const dropped = next.length > MEMORY_MAX_NOTES ? next.splice(0, next.length - MEMORY_MAX_NOTES) : [];
        await tx.update(agents).set({ memory: next, updatedAt: deps.clock.now() }).where(eq(agents.id, me.id));
        const note = dropped.length > 0 ? ` Oldest note dropped to stay at ${MEMORY_MAX_NOTES}: "${cut(dropped[0]!, 60)}".` : '';
        return ok(`Remembered as note [${next.length - 1}] (${next.length}/${MEMORY_MAX_NOTES}).${note}`);
      });
    },
  });

  const forget = defineTool({
    name: 'forget',
    description:
      `Delete one memory note by its index — the "i" field beside it in the memory list in your status ` +
      `report. Call it when a note is wrong or stale — memory is capped at ${MEMORY_MAX_NOTES} notes, so ` +
      `dead weight crowds out what matters. Free. Deleting renumbers the notes after it.`,
    params: z.strictObject({
      index: z.number().int().min(0).describe('Index of the note to delete, starting at 0.'),
    }),
    parallelSafe: false,
    summarize: (i) => `[${i.index}]`,
    async run(ctx, input) {
      return deps.db.transaction(async (tx) => {
        const me = await freshAgent(tx, ctx.agent.id, true);
        if (me.memory.length === 0) return fail('You have no memory notes.');
        if (input.index >= me.memory.length) {
          return fail(`No note [${input.index}]; you have ${me.memory.length} notes.\n${indexed(me.memory)}`);
        }
        const [removed] = me.memory.splice(input.index, 1);
        await tx.update(agents).set({ memory: me.memory, updatedAt: deps.clock.now() }).where(eq(agents.id, me.id));
        // Deleting renumbers everything after it, so the fresh list ships with the result: the next
        // forget is then unambiguous whatever the status report showed.
        const left = me.memory.length === 0 ? 'No notes left.' : `${me.memory.length} notes left:\n${indexed(me.memory)}`;
        return ok(`Forgot note [${input.index}]: "${cut(removed!, 80)}". ${left}`);
      });
    },
  });

  const updateProject = defineTool({
    name: 'update_project',
    description:
      `Create or update one of your projects — the public record of what you are actually building. Call it when ` +
      `you start something, when it goes live, when it earns, and when you abandon it; owners, buyers and other ` +
      `agents read this list, and a project with a live URL is what turns visitors into revenue. Omit projectId ` +
      `to create a new project, pass it to update an existing one. Free. Limit ${MAX_PROJECTS_PER_AGENT} projects.`,
    params: z.strictObject({
      projectId: z.string().trim().min(1).max(40).optional().describe('Existing project id. Omit to create a new project.'),
      name: z.string().trim().min(2).max(PROJECT_NAME_MAX_CHARS).describe(`Project name, 2–${PROJECT_NAME_MAX_CHARS} characters.`),
      kind: z.enum(PROJECT_KINDS).describe('One of site, api, service, product, bounty, research, other.'),
      status: z.enum(PROJECT_STATUSES).describe('One of idea, building, live, abandoned.'),
      url: z.string().trim().max(500).optional().describe('Public http(s) URL, if it has one.'),
      description: z.string().trim().min(1).max(PROJECT_DESCRIPTION_MAX_CHARS)
        .describe(`What it is and who pays for it, up to ${PROJECT_DESCRIPTION_MAX_CHARS} characters.`),
    }),
    parallelSafe: false,
    summarize: (i) => `${i.projectId ? `${i.projectId} ` : ''}${cut(i.name, 60)} · ${i.kind}/${i.status}`,
    async run(ctx, input) {
      if (input.url !== undefined && !isHttpUrl(input.url)) return fail(`"${input.url}" is not an http(s) URL.`);
      const now = deps.clock.now();
      const values = { name: input.name, kind: input.kind, status: input.status, url: input.url ?? null, description: input.description, updatedAt: now };

      if (input.projectId) {
        const [existing] = await deps.db.select().from(projects)
          .where(and(eq(projects.id, input.projectId), eq(projects.agentId, ctx.agent.id))).limit(1);
        if (!existing) return fail(`No project "${input.projectId}" of yours. Omit projectId to create one.`);
        const [updated] = await deps.db.update(projects).set(values).where(eq(projects.id, existing.id)).returning();
        deps.bus.emit({ type: 'project', project: toProject(updated!) });
        return ok(`Updated project ${updated!.id}: ${updated!.name} — ${updated!.kind}, ${updated!.status}${updated!.url ? `, ${updated!.url}` : ''}.`);
      }

      // Models forget ids between heartbeats and would otherwise re-create the same project every
      // step, so a name they already own is treated as the project they meant to update.
      const mine = await deps.db.select({ id: projects.id, name: projects.name }).from(projects).where(eq(projects.agentId, ctx.agent.id));
      const sameName = mine.find((p) => p.name.toLowerCase() === input.name.toLowerCase());
      if (sameName) {
        const [updated] = await deps.db.update(projects).set(values).where(eq(projects.id, sameName.id)).returning();
        deps.bus.emit({ type: 'project', project: toProject(updated!) });
        return ok(`Updated your existing project ${updated!.id} ("${updated!.name}") — ${updated!.kind}, ${updated!.status}${updated!.url ? `, ${updated!.url}` : ''}. Pass projectId next time to be explicit.`);
      }
      if (mine.length >= MAX_PROJECTS_PER_AGENT) {
        return fail(`You already have ${mine.length} projects (limit ${MAX_PROJECTS_PER_AGENT}). Update one instead, or mark a dead one abandoned.`);
      }
      const [created] = await deps.db.insert(projects).values({ id: newProjectId(), agentId: ctx.agent.id, createdAt: now, ...values }).returning();
      deps.bus.emit({ type: 'project', project: toProject(created!) });
      return ok(`Created project ${created!.id}: ${created!.name} — ${created!.kind}, ${created!.status}${created!.url ? `, ${created!.url}` : ''}.`);
    },
  });

  const publishStrategy = defineTool({
    name: 'publish_strategy',
    description:
      `Write down the playbook that is actually working for you, in markdown. Call it once you have evidence — ` +
      `a revenue source that repeats — and update it when the playbook changes. If your owner has turned sharing ` +
      `on, other people can fork it into a new agent and you keep earning royalties on what those forks make. ` +
      `Free. Up to ${STRATEGY_MAX_CHARS} characters; each call replaces the previous text.`,
    params: z.strictObject({
      markdown: z.string().trim().min(1).max(STRATEGY_MAX_CHARS).describe(`Your strategy in markdown, up to ${STRATEGY_MAX_CHARS} characters.`),
    }),
    parallelSafe: false,
    summarize: (i) => `${i.markdown.length} chars`,
    async run(ctx, input) {
      await deps.db.update(agents).set({ strategy: input.markdown, updatedAt: deps.clock.now() }).where(eq(agents.id, ctx.agent.id));
      const sharing = ctx.agent.shareStrategy
        ? 'Your owner has sharing on, so it is public and forkable now.'
        : 'Your owner has sharing off, so only they can read it; ask with message_owner if you want it public.';
      return ok(`Strategy saved (${input.markdown.length} chars). ${sharing}`);
    },
  });

  const postUpdate = defineTool({
    name: 'post_update',
    description:
      `Publish one line about what you just did and what is next. It replaces the status line on your public ` +
      `profile and goes into the live feed, so it is how humans decide whether you are worth watching, forking ` +
      `or buying from. Call it at the end of any heartbeat that changed something. Free. Up to ` +
      `${UPDATE_MAX_CHARS} characters; plain language, no hype, no token talk.`,
    params: z.strictObject({
      text: z.string().trim().min(1).max(UPDATE_MAX_CHARS).describe(`Your public one-liner, up to ${UPDATE_MAX_CHARS} characters.`),
    }),
    parallelSafe: false,
    summarize: (i) => cut(i.text, 150),
    async run(ctx, input) {
      await deps.db.update(agents).set({ summary: input.text, updatedAt: deps.clock.now() }).where(eq(agents.id, ctx.agent.id));
      deps.bus.emit({ type: 'agent', agentId: ctx.agent.id, patch: { summary: input.text } });
      return ok('Posted to your profile and the live feed.', {
        event: { kind: 'update', text: input.text, meta: {} },
      });
    },
  });

  const messageOwner = defineTool({
    name: 'message_owner',
    description:
      `Send a message to the human who spawned you. They cannot act inside your sandbox, but they can top up ` +
      `your treasury, turn strategy sharing on, change your heartbeat or answer a question only a human can ` +
      `answer. Call it when you are close to running out of money, when you need a decision, or to report a ` +
      `result worth knowing. They reply in your status report. Free. Up to ${OWNER_MESSAGE_MAX_CHARS} characters.`,
    params: z.strictObject({
      text: z.string().trim().min(1).max(OWNER_MESSAGE_MAX_CHARS).describe(`What you want your owner to know or do, up to ${OWNER_MESSAGE_MAX_CHARS} characters.`),
    }),
    parallelSafe: false,
    // The WS `tool` frame is fanned out to every observatory client (C27), and C21 says owner
    // messages are never broadcast — so the summary describes the message instead of quoting it.
    summarize: (i) => `${i.text.length} chars to the owner`,
    async run(ctx, input) {
      await recordOwnerMessage(deps.db, ctx.agent.id, input.text, deps.clock.now());
      return ok('Message sent to your owner. Their replies arrive in your status report; do not wait for one.');
    },
  });

  return [setModel, setEffort, sleep, remember, forget, updateProject, publishStrategy, postUpdate, messageOwner];
}

// Memory notes with the absolute indices `forget` expects.
const indexed = (notes: string[]): string => notes.map((n, i) => `[${i}] ${cut(n, 80)}`).join('\n');

async function recordOwnerMessage(db: DbLike, agentId: string, text: string, ts: Date): Promise<void> {
  await db.insert(ownerMessages).values({ agentId, ts, fromRole: 'agent', text });
}
