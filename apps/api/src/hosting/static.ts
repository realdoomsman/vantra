// GET /sites/:slug/* — serves DATA_DIR/sites/<slug>. SPEC §8.15.
// index.html default, no directory listing, 1h cache, allow-listed extensions only, hardened headers.
// Routing is by path only: the Host header is ignored, so SITES_BASE_URL may point at any hostname.
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { normalizeRelPath } from '../sandbox/common.js';

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const SITE_CACHE_CONTROL = 'public, max-age=3600';

// These pages are written by autonomous agents competing with each other, and by default they are
// served by the same listener — and therefore the same origin — as the API and the SPA. Without the
// `sandbox` directive `script-src 'self'` would let any agent's site run JavaScript AS the app: a
// signed-in visitor opening a site link would have `/api/me` read and `/api/agents/:id/terminate`
// called with their own session cookie.
//
// `sandbox` WITHOUT `allow-same-origin` gives each page an opaque origin, so its requests to /api are
// cross-origin from `Origin: null` (rejected by CORS, and by the CSRF guard's custom header, which a
// null origin cannot preflight). `allow-scripts` keeps ordinary static sites working.
// `connect-src`/`img-src` are pinned to the site's own files so the page has no silent channel out.
// `allow-forms` is deliberately absent, together with `form-action 'none'`.
// Production should ALSO point SITES_BASE_URL at a hostname the session cookie is not scoped to.
export const SITE_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  'sandbox allow-scripts allow-popups allow-downloads',
].join('; ');

// SPEC §8.9 deploy_site allow-list.
export const SITE_CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};
export const SITE_ALLOWED_EXTENSIONS: ReadonlySet<string> = new Set(Object.keys(SITE_CONTENT_TYPES));

export const isAllowedSiteFile = (filename: string): boolean =>
  !filename.startsWith('.') && SITE_ALLOWED_EXTENSIONS.has(path.extname(filename).toLowerCase());

interface SiteParams { slug: string; '*': string }

export function registerSites(app: FastifyInstance, opts: { sitesDir: string }): void {
  const sitesDir = path.resolve(opts.sitesDir);

  app.get<{ Params: { slug: string } }>('/sites/:slug', async (req, reply) => {
    hardenedHeaders(reply);
    if (!SLUG_RE.test(req.params.slug)) return notFound(reply);
    return reply.redirect(`/sites/${req.params.slug}/`, 301);
  });

  app.get<{ Params: SiteParams }>('/sites/:slug/*', async (req, reply) => {
    hardenedHeaders(reply);
    const { slug } = req.params;
    const rest = req.params['*'] ?? '';
    if (!SLUG_RE.test(slug)) return notFound(reply);
    const rel = safeRelPath(rest);
    if (rel === null) return notFound(reply);

    const siteRoot = path.join(sitesDir, slug);
    let target = path.join(siteRoot, rel);
    let st = await stat(target).catch(() => null);
    if (st?.isDirectory()) {
      if (rest !== '' && !rest.endsWith('/')) return reply.redirect(`${req.url.split('?')[0]}/`, 301);
      target = path.join(target, 'index.html');
      st = await stat(target).catch(() => null);
    }
    if (!st?.isFile() || !isAllowedSiteFile(path.basename(target))) return notFound(reply);

    // A symlink inside the site must not reach outside DATA_DIR/sites/<slug>.
    const [realRoot, realTarget] = await Promise.all([realpath(siteRoot), realpath(target)]);
    if (!realTarget.startsWith(realRoot + path.sep)) return notFound(reply);

    return reply
      .header('Content-Type', SITE_CONTENT_TYPES[path.extname(target).toLowerCase()]!)
      .header('Content-Length', st.size)
      .header('Cache-Control', SITE_CACHE_CONTROL)
      .header('Last-Modified', st.mtime.toUTCString())
      .send(createReadStream(realTarget));
  });
}

// Decodes the wildcard, rejects traversal and hidden segments. Returns '' for the site root.
function safeRelPath(rest: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rest);
  } catch {
    return null;
  }
  try {
    const rel = normalizeRelPath(decoded, { allowRoot: true });
    return rel.split('/').some((seg) => seg.startsWith('.')) ? null : rel;
  } catch {
    return null;
  }
}

function hardenedHeaders(reply: FastifyReply): void {
  reply
    .header('Content-Security-Policy', SITE_CSP)
    .header('X-Frame-Options', 'DENY')
    .header('X-Content-Type-Options', 'nosniff')
    .header('Referrer-Policy', 'strict-origin-when-cross-origin');
}

function notFound(reply: FastifyReply): FastifyReply {
  return reply.code(404).header('Cache-Control', 'no-store').type('text/plain; charset=utf-8').send('Not found');
}
