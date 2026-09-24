// fetch_url may only reach the public internet: http(s) only, DNS resolved and vetted up front, and
// every private / loopback / link-local / metadata / reserved range refused. SPEC §8.9.
import { describe, expect, it } from 'vitest';
import { decodeEntities, hostnameOf, htmlToText, isBlockedIp, parseTarget, resolveTarget } from '../../src/tools/fetch.js';

const BLOCKED_V4 = [
  ['0.0.0.0', 'this-network'],
  ['10.1.2.3', 'RFC1918 /8'],
  ['127.0.0.1', 'loopback'],
  ['127.255.255.254', 'loopback range'],
  ['100.64.0.1', 'CGNAT'],
  ['169.254.169.254', 'cloud metadata'],
  ['172.16.0.1', 'RFC1918 /12 start'],
  ['172.31.255.255', 'RFC1918 /12 end'],
  ['192.0.0.1', 'IETF protocol assignments'],
  ['192.0.2.1', 'TEST-NET-1'],
  ['192.168.1.1', 'RFC1918 /16'],
  ['198.18.0.1', 'benchmarking'],
  ['198.51.100.1', 'TEST-NET-2'],
  ['203.0.113.1', 'TEST-NET-3'],
  ['224.0.0.1', 'multicast'],
  ['255.255.255.255', 'broadcast'],
] as const;

const ALLOWED_V4 = ['1.1.1.1', '8.8.8.8', '93.184.216.34', '172.15.0.1', '172.32.0.1', '100.63.255.255', '100.128.0.1', '192.0.1.1'];

const BLOCKED_V6 = [
  ['::', 'unspecified'],
  ['::1', 'loopback'],
  ['::ffff:127.0.0.1', 'v4-mapped loopback'],
  ['::ffff:169.254.169.254', 'v4-mapped metadata'],
  ['64:ff9b::a00:1', 'NAT64 over 10.0.0.1'],
  ['2002:a00:1::', '6to4 over 10.0.0.1'],
  ['fc00::1', 'unique local'],
  ['fd12:3456::1', 'unique local'],
  ['fe80::1', 'link-local'],
  ['fec0::1', 'site-local'],
  ['ff02::1', 'multicast'],
  ['2001:db8::1', 'documentation'],
  ['not an address', 'unparseable'],
] as const;

describe('isBlockedIp', () => {
  for (const [ip, why] of BLOCKED_V4) it(`blocks ${ip} (${why})`, () => expect(isBlockedIp(ip)).toBe(true));
  for (const ip of ALLOWED_V4) it(`allows public ${ip}`, () => expect(isBlockedIp(ip)).toBe(false));
  for (const [ip, why] of BLOCKED_V6) it(`blocks ${ip} (${why})`, () => expect(isBlockedIp(ip)).toBe(true));

  it('allows public IPv6', () => {
    expect(isBlockedIp('2606:4700:4700::1111')).toBe(false);
    expect(isBlockedIp('::ffff:8.8.8.8')).toBe(false);
  });

  it('ignores a zone id when classifying link-local', () => {
    expect(isBlockedIp('fe80::1%en0')).toBe(true);
  });
});

describe('parseTarget', () => {
  it('accepts absolute http and https URLs', () => {
    expect(parseTarget('https://example.com/docs').toString()).toBe('https://example.com/docs');
    expect(parseTarget('  http://example.com  ').host).toBe('example.com');
  });

  for (const url of ['file:///etc/passwd', 'ftp://example.com', 'gopher://example.com', 'data:text/html,hi', 'javascript:alert(1)']) {
    it(`refuses ${url}`, () => expect(() => parseTarget(url)).toThrow(/only http\(s\)/i));
  }

  it('refuses a relative URL', () => {
    expect(() => parseTarget('/etc/passwd')).toThrow(/not a valid absolute URL/i);
  });

  it('refuses embedded credentials', () => {
    expect(() => parseTarget('https://user:pass@example.com')).toThrow(/credentials/i);
  });

  for (const host of ['localhost', 'app.localhost', 'metadata.google.internal', 'db.internal', 'printer.local', 'router.home.arpa']) {
    it(`refuses the internal hostname ${host}`, () => expect(() => parseTarget(`http://${host}/x`)).toThrow(/not reachable/i));
  }

  it('refuses a literal loopback or metadata address via resolveTarget', async () => {
    await expect(resolveTarget(parseTarget('http://127.0.0.1:8787/api'))).rejects.toThrow(/private or internal/i);
    await expect(resolveTarget(parseTarget('http://169.254.169.254/latest/meta-data/'))).rejects.toThrow(/private or internal/i);
    await expect(resolveTarget(parseTarget('http://[::1]/'))).rejects.toThrow(/private or internal/i);
  });

  it('strips IPv6 brackets when reading the hostname', () => {
    expect(hostnameOf(parseTarget('http://[2606:4700::1111]/'))).toBe('2606:4700::1111');
  });
});

describe('resolveTarget', () => {
  it('pins the first resolved address for a public host', async () => {
    const address = await resolveTarget(parseTarget('https://example.com'), () => Promise.resolve(['93.184.216.34']));
    expect(address).toBe('93.184.216.34');
  });

  it('refuses when ANY resolved address is private (DNS rebinding defence)', async () => {
    const lookup = () => Promise.resolve(['93.184.216.34', '169.254.169.254']);
    await expect(resolveTarget(parseTarget('https://rebind.example'), lookup)).rejects.toThrow(/private or internal/i);
  });

  it('refuses a host that does not resolve', async () => {
    await expect(resolveTarget(parseTarget('https://nx.example'), () => Promise.resolve([]))).rejects.toThrow(/could not resolve/i);
  });
});

describe('htmlToText', () => {
  it('drops scripts, styles and markup and keeps the title', () => {
    const html = `<html><head><title>Pricing &amp; Plans</title><style>b{color:red}</style></head>
      <body><script>fetch('/steal')</script><h1>Plans</h1><p>From $9<br>per month</p><!-- hidden --></body></html>`;
    const text = htmlToText(html);
    expect(text).toContain('Title: Pricing & Plans');
    expect(text).toContain('Plans');
    expect(text).toContain('From $9');
    expect(text).not.toContain('fetch(');
    expect(text).not.toContain('color:red');
    expect(text).not.toContain('hidden');
    expect(text).not.toMatch(/<[a-z]/i);
  });

  it('collapses whitespace without gluing block elements together', () => {
    expect(htmlToText('<p>one</p><p>two</p>')).toBe('one\ntwo');
  });
});

describe('decodeEntities', () => {
  it('decodes named, decimal and hex entities and leaves unknown ones alone', () => {
    expect(decodeEntities('a &amp; b &#65; &#x42; &nbsp;c &unknownent;')).toBe('a & b A B  c &unknownent;');
  });
});
