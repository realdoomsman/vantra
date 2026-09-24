// Production only: the API serves the built web app at / (SPEC §8.15). Hashed Vite assets are immutable;
// everything else revalidates so a deploy is picked up on the next load.
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { REPO_ROOT } from '../lib/env.js';
import type { Logger } from '../lib/log.js';

export const WEB_DIST = path.resolve(REPO_ROOT, 'apps/web/dist');
const ONE_YEAR_S = 31_536_000;

// Returns false (and warns) when there is no build, so the API still boots for API-only deployments.
export async function registerWebApp(app: FastifyInstance, log: Logger, dist = WEB_DIST): Promise<boolean> {
  if (!existsSync(path.join(dist, 'index.html'))) {
    log.warn({ dist }, 'web build not found; serving API only');
    return false;
  }
  await app.register(fastifyStatic, {
    root: dist,
    prefix: '/',
    index: ['index.html'],
    cacheControl: false,
    setHeaders: (reply, filePath) => {
      const hashed = filePath.includes(`${path.sep}assets${path.sep}`);
      reply.header('cache-control', hashed ? `public, max-age=${ONE_YEAR_S}, immutable` : 'no-cache');
    },
  });
  log.info({ dist }, 'serving web app');
  return true;
}
