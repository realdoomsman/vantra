// SSRF-guarded HTTP(S) fetch for fetch_url: http(s) only, DNS resolved up front and every address checked
// against private / loopback / link-local / metadata / reserved ranges, the connection pinned to the vetted
// address (no rebinding), redirects re-vetted, hard timeout, byte cap, HTML reduced to text.
import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

export type LookupFn = (hostname: string) => Promise<string[]>;

export interface FetchOptions {
  timeoutMs: number;
  maxBytes: number;
  maxRedirects?: number;                 // default 5
  signal?: AbortSignal;
  lookup?: LookupFn;                     // injectable for tests
  isBlocked?: (ip: string) => boolean;   // injectable for tests; default isBlockedIp
}

export interface FetchedPage {
  url: string;                           // final URL after redirects
  status: number;
  contentType: string;
  text: string;
  bytes: number;
  capped: boolean;                       // body cut at maxBytes
}

const USER_AGENT = 'VANTRA-agent/1.0 (+https://runway.xyz)';
const BLOCKED_HOSTNAMES = new Set(['localhost', 'metadata.google.internal', 'metadata', 'instance-data']);
const BLOCKED_SUFFIXES = ['.localhost', '.internal', '.local', '.home.arpa'];
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const defaultLookup: LookupFn = async (hostname) => (await dns.lookup(hostname, { all: true })).map((a) => a.address);

export function parseTarget(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(`"${raw}" is not a valid absolute URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`only http(s) URLs can be fetched (got ${url.protocol})`);
  if (url.username || url.password) throw new Error('URLs with embedded credentials are not allowed');
  const host = hostnameOf(url);
  if (BLOCKED_HOSTNAMES.has(host) || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) throw new Error(`host "${host}" is not reachable from agents`);
  return url;
}

// URL.hostname keeps IPv6 brackets; strip them for net.isIP.
export const hostnameOf = (url: URL): string => url.hostname.replace(/^\[|\]$/g, '').toLowerCase();

// Resolves and vets the host; returns the single address the connection is pinned to.
export async function resolveTarget(url: URL, lookup: LookupFn = defaultLookup, isBlocked = isBlockedIp): Promise<string> {
  const host = hostnameOf(url);
  const addresses = net.isIP(host) ? [host] : await lookup(host).catch(() => []);
  if (addresses.length === 0) throw new Error(`could not resolve host "${host}"`);
  if (addresses.some(isBlocked)) throw new Error(`host "${host}" resolves to a private or internal address; agents may only fetch public sites`);
  return addresses[0]!;
}

export function isBlockedIp(ip: string): boolean {
  if (net.isIPv4(ip)) return isBlockedV4(ip.split('.').map(Number));
  const groups = expandV6(ip);
  if (!groups) return true;                                     // unparseable → refuse
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups;
  const embeddedV4 = (hi: number, lo: number) => [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];
  if (groups.every((g) => g === 0)) return true;                                        // ::
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0 && g7 === 1) return true;  // ::1
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) return isBlockedV4(embeddedV4(g6, g7));   // ::ffff:a.b.c.d
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return isBlockedV4(embeddedV4(g6, g7)); // NAT64
  if (g0 === 0x2002) return isBlockedV4(embeddedV4(g1, g2));                                 // 6to4
  if ((g0 & 0xfe00) === 0xfc00) return true;                                                // fc00::/7 ULA
  if ((g0 & 0xffc0) === 0xfe80) return true;                                                // fe80::/10 link-local
  if ((g0 & 0xffc0) === 0xfec0) return true;                                                // fec0::/10 site-local
  if ((g0 & 0xff00) === 0xff00) return true;                                                // ff00::/8 multicast
  if (g0 === 0x2001 && g1 === 0x0db8) return true;                                          // documentation
  return false;
}

function isBlockedV4(o: number[]): boolean {
  const [a = 0, b = 0, c = 0] = o;
  return (
    a === 0 || a === 10 || a === 127 ||                                   // this-network, private, loopback
    (a === 100 && b >= 64 && b <= 127) ||                                 // CGNAT
    (a === 169 && b === 254) ||                                           // link-local incl. cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||                                  // private
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||                     // IETF protocol assignments, TEST-NET-1
    (a === 192 && b === 168) ||                                           // private
    (a === 198 && (b === 18 || b === 19)) ||                              // benchmarking
    (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113) ||  // TEST-NET-2/3
    a >= 224                                                              // multicast, reserved, broadcast
  );
}

function expandV6(ip: string): number[] | null {
  let s = ip.split('%')[0] ?? '';
  const lastColon = s.lastIndexOf(':');
  const tail = s.slice(lastColon + 1);
  if (net.isIPv4(tail)) {
    const [a = 0, b = 0, c = 0, d = 0] = tail.split('.').map(Number);
    s = `${s.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string) => (part === '' ? [] : part.split(':').map((h) => Number.parseInt(h, 16)));
  const head = parse(halves[0] ?? '');
  const rest = halves.length === 2 ? parse(halves[1] ?? '') : [];
  if (head.length + rest.length > 8 || [...head, ...rest].some((n) => Number.isNaN(n) || n < 0 || n > 0xffff)) return null;
  if (halves.length === 1 && head.length !== 8) return null;
  return [...head, ...new Array<number>(8 - head.length - rest.length).fill(0), ...rest];
}

export async function fetchUrl(raw: string, opts: FetchOptions): Promise<FetchedPage> {
  const maxRedirects = opts.maxRedirects ?? 5;
  const deadline = Date.now() + opts.timeoutMs;
  let url = parseTarget(raw);
  for (let hop = 0; ; hop++) {
    const address = await resolveTarget(url, opts.lookup, opts.isBlocked);
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`timed out after ${opts.timeoutMs}ms`);
    const res = await request(url, address, { timeoutMs: remaining, maxBytes: opts.maxBytes, signal: opts.signal });
    const location = res.headers['location'];
    if (REDIRECT_STATUSES.has(res.status) && typeof location === 'string') {
      if (hop >= maxRedirects) throw new Error(`too many redirects (>${maxRedirects})`);
      url = parseTarget(new URL(location, url).toString());
      continue;
    }
    const contentType = (res.headers['content-type'] ?? 'application/octet-stream').split(';')[0]!.trim().toLowerCase();
    const kind = classify(contentType);
    if (kind === 'binary') throw new Error(`unsupported content type "${contentType}": only HTML, text, JSON and XML can be fetched`);
    const decoded = decode(res.body, res.headers['content-type'] ?? '');
    return {
      url: url.toString(), status: res.status, contentType, bytes: res.body.length, capped: res.capped,
      text: kind === 'html' ? htmlToText(decoded) : decoded,
    };
  }
}

interface RawResponse { status: number; headers: http.IncomingHttpHeaders; body: Buffer; capped: boolean }

function request(url: URL, address: string, opts: { timeoutMs: number; maxBytes: number; signal?: AbortSignal }): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === 'https:' ? https : http;
    const family = net.isIPv6(address) ? 6 : 4;
    // Pinning the address here keeps SNI / certificate checks on the hostname while defeating DNS rebinding.
    const lookup: net.LookupFunction = (_host, options, cb) => {
      if (options.all) (cb as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, [{ address, family }]);
      else cb(null, address, family);
    };
    const req = mod.request(url, {
      method: 'GET',
      lookup,
      signal: opts.signal,
      headers: {
        'user-agent': USER_AGENT,
        accept: 'text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.5',
        'accept-encoding': 'identity',
      },
    });
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      finish(() => reject(new Error(`timed out after ${opts.timeoutMs}ms`)));
      req.destroy();
    }, opts.timeoutMs);

    req.on('error', (e) => finish(() => reject(e)));
    req.on('response', (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let capped = false;
      res.on('data', (chunk: Buffer) => {
        if (settled) return;
        const room = opts.maxBytes - size;
        if (chunk.length >= room) {
          chunks.push(chunk.subarray(0, room));
          size += room;
          capped = true;
          finish(() => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks), capped }));
          res.destroy();
          return;
        }
        chunks.push(chunk);
        size += chunk.length;
      });
      res.on('end', () => finish(() => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks), capped })));
      res.on('error', (e) => finish(() => reject(e)));
    });
    req.end();
  });
}

function classify(contentType: string): 'html' | 'text' | 'binary' {
  if (contentType === 'text/html' || contentType === 'application/xhtml+xml') return 'html';
  if (contentType.startsWith('text/') || contentType.endsWith('+json') || contentType.endsWith('+xml')) return 'text';
  if (['application/json', 'application/xml', 'application/javascript', 'application/x-yaml', 'application/yaml'].includes(contentType)) return 'text';
  return 'binary';
}

function decode(body: Buffer, contentTypeHeader: string): string {
  const charset = /charset=["']?([\w-]+)/i.exec(contentTypeHeader)?.[1] ?? 'utf-8';
  try {
    return new TextDecoder(charset).decode(body);
  } catch {
    return body.toString('utf8');
  }
}

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', mdash: '—', ndash: '–', hellip: '…', laquo: '«', raquo: '»' };

export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => safeCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => safeCodePoint(Number(dec)))
    .replace(/&([a-z]+);/gi, (m, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? m);
}

const safeCodePoint = (n: number): string => (n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '');

export function htmlToText(html: string): string {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  const body = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|template|iframe)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<\/(p|div|section|article|header|footer|main|nav|aside|h[1-6]|li|tr|blockquote|pre|table|ul|ol|dd|dt|figcaption)\s*>/gi, '\n')
    .replace(/<(br|hr)\b[^>]*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  const text = decodeEntities(body)
    .replace(/[ \t\r\f\v ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const cleanTitle = title ? decodeEntities(title).replace(/\s+/g, ' ').trim() : '';
  return cleanTitle ? `Title: ${cleanTitle}\n\n${text}` : text;
}
