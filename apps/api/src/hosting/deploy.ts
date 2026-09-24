// deploy_site support: export a sandbox directory, validate it as a static site, atomically swap it into
// DATA_DIR/sites/<slug> and upsert the deployments row. SPEC §8.9 deploy_site, §7 deployments.
import { randomBytes } from 'node:crypto';
import { mkdir, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import type { Clock, SandboxDriver } from '../core/interfaces.js';
import type { Db } from '../db/client.js';
import { deployments } from '../db/schema.js';
import { badRequest, conflict } from '../lib/errors.js';
import type { Logger } from '../lib/log.js';
import { SandboxLimitError, SandboxPathError } from '../sandbox/common.js';
import { SLUG_RE, isAllowedSiteFile } from './static.js';

export const SITE_MAX_BYTES = 20 * 1024 * 1024;

export interface DeploymentStore {
  activeOwner(slug: string): Promise<string | null>;                       // agent id holding the slug, if any
  upsert(row: { agentId: string; slug: string; dirSizeBytes: number; deployedAt: Date }): Promise<void>;
  deactivate(slug: string, removedAt: Date): Promise<void>;
}

export interface DeployContext {
  sandbox: SandboxDriver;
  store: DeploymentStore;
  sitesDir: string;         // DATA_DIR/sites
  sitesBaseUrl: string;     // config.sitesBaseUrl
  clock: Clock;
  log: Logger;
}

export interface DeployResult { slug: string; url: string; bytes: number; files: number }

export const siteUrl = (sitesBaseUrl: string, slug: string): string => `${sitesBaseUrl}/${slug}/`;

export async function deploySite(ctx: DeployContext, agentId: string, dir: string, slug: string): Promise<DeployResult> {
  if (!SLUG_RE.test(slug)) throw badRequest(`invalid site slug: ${slug}`);
  const owner = await ctx.store.activeOwner(slug);
  if (owner !== null && owner !== agentId) throw conflict('CONFLICT', `slug "${slug}" is deployed by another agent`);

  await mkdir(ctx.sitesDir, { recursive: true });
  const nonce = randomBytes(4).toString('hex');
  const staging = path.join(ctx.sitesDir, `.staging-${slug}-${nonce}`);
  let exported: { bytes: number; files: number };
  try {
    exported = await exportChecked(ctx.sandbox, agentId, dir, staging);
    await validateSiteTree(staging);
    await swapIn(ctx.sitesDir, slug, staging, nonce);
  } catch (e) {
    await rm(staging, { recursive: true, force: true });
    throw e;
  }
  await ctx.store.upsert({ agentId, slug, dirSizeBytes: exported.bytes, deployedAt: ctx.clock.now() });
  ctx.log.info({ agentId, slug, ...exported }, 'site deployed');
  return { slug, url: siteUrl(ctx.sitesBaseUrl, slug), ...exported };
}

// Removes the site directory (if present) and deactivates its deployment rows. Returns whether files existed.
export async function removeSite(ctx: DeployContext, slug: string): Promise<boolean> {
  if (!SLUG_RE.test(slug)) throw badRequest(`invalid site slug: ${slug}`);
  const live = path.join(ctx.sitesDir, slug);
  const existed = await readdir(live).then(() => true, () => false);
  await rm(live, { recursive: true, force: true });
  await ctx.store.deactivate(slug, ctx.clock.now());
  if (existed) ctx.log.info({ slug }, 'site removed');
  return existed;
}

async function exportChecked(sandbox: SandboxDriver, agentId: string, dir: string, staging: string): Promise<{ bytes: number; files: number }> {
  try {
    return await sandbox.exportDir(agentId, dir, staging, SITE_MAX_BYTES);
  } catch (e) {
    if (e instanceof SandboxLimitError) throw badRequest(`site directory "${dir}" exceeds ${SITE_MAX_BYTES / (1024 * 1024)}MB`);
    if (e instanceof SandboxPathError) throw badRequest(e.message);
    throw e;
  }
}

// Hidden entries (.git, .env, …) are dropped; any other file must carry an allow-listed extension;
// the site must have an index.html at its root.
async function validateSiteTree(root: string): Promise<void> {
  const rejected: string[] = [];
  const walk = async (dir: string, rel: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.name.startsWith('.')) {
        await rm(path.join(dir, entry.name), { recursive: true, force: true });
      } else if (entry.isDirectory()) {
        await walk(path.join(dir, entry.name), relPath);
      } else if (!entry.isFile() || !isAllowedSiteFile(entry.name)) {
        rejected.push(relPath);
      }
    }
  };
  await walk(root, '');
  if (rejected.length > 0) {
    const shown = rejected.slice(0, 5).join(', ');
    const more = rejected.length > 5 ? ` (+${rejected.length - 5} more)` : '';
    throw badRequest(`site contains files that cannot be hosted: ${shown}${more}. Allowed: .html .css .js .json .png .jpg .svg .webp .txt .md .ico .woff2`);
  }
  const hasIndex = await readdir(root).then((names) => names.includes('index.html'));
  if (!hasIndex) throw badRequest('site directory must contain index.html at its root');
}

async function swapIn(sitesDir: string, slug: string, staging: string, nonce: string): Promise<void> {
  const live = path.join(sitesDir, slug);
  const retired = path.join(sitesDir, `.old-${slug}-${nonce}`);
  const hadPrevious = await rename(live, retired).then(() => true, (e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT') return false;
    throw e;
  });
  await rename(staging, live);
  if (hadPrevious) await rm(retired, { recursive: true, force: true });
}

export function createDeploymentStore(db: Db): DeploymentStore {
  const activeFor = (slug: string) => and(eq(deployments.slug, slug), eq(deployments.active, true));
  return {
    async activeOwner(slug) {
      const [row] = await db.select({ agentId: deployments.agentId }).from(deployments).where(activeFor(slug)).limit(1);
      return row?.agentId ?? null;
    },
    async upsert({ agentId, slug, dirSizeBytes, deployedAt }) {
      await db.transaction(async (tx) => {
        const [existing] = await tx.select({ id: deployments.id }).from(deployments)
          .where(and(activeFor(slug), eq(deployments.agentId, agentId))).limit(1);
        if (existing) {
          await tx.update(deployments).set({ dirSizeBytes, deployedAt }).where(eq(deployments.id, existing.id));
        } else {
          await tx.insert(deployments).values({ agentId, slug, dirSizeBytes, deployedAt, active: true });
        }
      });
    },
    async deactivate(slug, removedAt) {
      await db.update(deployments).set({ active: false, removedAt }).where(activeFor(slug));
    },
  };
}
