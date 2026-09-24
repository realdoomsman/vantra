// deploy_site: export a static directory from the sandbox to hosting. SPEC §8.9.
// The deploy port (hosting/deploy.ts) owns the file swap and the `deployments` row; this tool owns
// the slug rules, the cost, the auto-created `site` project and the feed event.
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { HOSTING_PER_DAY_MICRO, TOOL_COST_MICRO, fmtUsd } from '@vantra/shared';
import type { CoreDeps } from '../core/interfaces.js';
import type { DbLike } from '../db/client.js';
import { projects, type ProjectRow } from '../db/schema.js';
import { newProjectId } from '../lib/ids.js';
import { fail, ok, toProject } from './common.js';
import { confinePath } from './files.js';
import type { PortResolver } from './ports.js';
import { defineTool, type ToolSpec } from './spec.js';

const DEPLOY_COST = TOOL_COST_MICRO['deploy_site']!;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,47}$/;

// An agent owns its deploySlug and any "<deploySlug>-<suffix>", so it can host several sites without
// being able to take a slug from another agent.
export function resolveSlug(deploySlug: string, requested: string | undefined): string {
  const slug = (requested ?? deploySlug).trim().toLowerCase();
  if (!SLUG_RE.test(slug)) throw new Error(`slug "${slug}" must be 2–48 lowercase letters, digits or dashes`);
  if (slug !== deploySlug && !slug.startsWith(`${deploySlug}-`)) {
    throw new Error(`slug must be "${deploySlug}" or start with "${deploySlug}-"`);
  }
  return slug;
}

export function deployTools(deps: CoreDeps, port: PortResolver): ToolSpec[] {
  const deploySite = defineTool({
    name: 'deploy_site',
    description:
      `Publish a directory of static files from /work as a public website. Call it once the site is ready and ` +
      `again after every meaningful change (each call replaces the previous deploy). The directory needs an ` +
      `index.html at its root; only static assets are kept (.html .css .js .json .png .jpg .svg .webp .txt .md ` +
      `.ico .woff2), max 20MB. Costs ${fmtUsd(DEPLOY_COST)} per deploy plus ${fmtUsd(HOSTING_PER_DAY_MICRO)}/day ` +
      `hosting for as long as the site stays up. Returns the public URL — put it in update_project so visitors ` +
      `and the observatory can find it.`,
    params: z.strictObject({
      dir: z.string().min(1).max(500).default('site').describe('Directory relative to /work to publish (default "site").'),
      slug: z.string().min(2).max(48).optional()
        .describe('Site slug. Omit to use your own slug; to host a second site use "<your-slug>-<suffix>".'),
    }),
    parallelSafe: false,
    summarize: (i) => `${i.dir} → ${i.slug ?? '(own slug)'}`,
    async run(ctx, input) {
      const dir = confinePath(input.dir);
      if (dir === '.') return fail('deploy_site needs a subdirectory of /work, not the root.');
      const slug = resolveSlug(ctx.agent.deploySlug, input.slug);

      const deployed = await port('deploy').deploySite(ctx.agent.id, dir, slug);
      const project = await ensureSiteProject(deps.db, ctx.agent.id, slug, deployed.url, deps.clock.now());
      if (project) deps.bus.emit({ type: 'project', project: toProject(project) });

      const kb = (deployed.bytes / 1024).toFixed(1);
      return ok(
        `Deployed ${deployed.files} files (${kb} KB) to ${deployed.url} — live now. ` +
        `Hosting bills ${fmtUsd(HOSTING_PER_DAY_MICRO)}/day while it stays up.`,
        {
          costMicro: DEPLOY_COST,
          event: {
            kind: 'deploy',
            text: `${ctx.agent.name} deployed a site → ${deployed.url}`,
            meta: { url: deployed.url, slug, bytes: deployed.bytes, files: deployed.files },
          },
        },
      );
    },
  });

  return [deploySite];
}

// deploy_site auto-creates a `site` project the first time (SPEC §8.9); later deploys only fill in a
// missing URL so the agent stays in control of the project's name, status and description.
async function ensureSiteProject(db: DbLike, agentId: string, slug: string, url: string, now: Date): Promise<ProjectRow | null> {
  const [existing] = await db.select().from(projects)
    .where(and(eq(projects.agentId, agentId), eq(projects.kind, 'site'))).limit(1);
  if (!existing) {
    const [created] = await db.insert(projects).values({
      id: newProjectId(), agentId, name: slug, kind: 'site', status: 'live', url,
      description: 'Static site', createdAt: now, updatedAt: now,
    }).returning();
    return created ?? null;
  }
  if (existing.url) return null;
  const [updated] = await db.update(projects).set({ url, status: 'live', updatedAt: now })
    .where(eq(projects.id, existing.id)).returning();
  return updated ?? null;
}
