// Minimal tar codec used by the Docker driver's putArchive/getArchive paths.
import { describe, expect, it } from 'vitest';
import { packTar, readTar, type TarEntry } from '../../src/sandbox/tar.js';

async function unpack(archive: Buffer, opts: { readBodies?: boolean } = {}): Promise<{ entry: TarEntry; text: string }[]> {
  const out: { entry: TarEntry; text: string }[] = [];
  for await (const { entry, body } of readTar(chunked(archive, 137))) {
    let text = '';
    if (opts.readBodies !== false) {
      for await (const chunk of body()) text += chunk.toString('utf8');
    }
    out.push({ entry, text });
  }
  return out;
}

// Feeds the reader in awkward slices so its buffering is exercised.
async function* chunked(buf: Buffer, size: number): AsyncGenerator<Uint8Array> {
  for (let i = 0; i < buf.length; i += size) yield buf.subarray(i, i + size);
}

describe('packTar / readTar', () => {
  it('round-trips files and directories', async () => {
    const archive = packTar([
      { name: 'site', type: 'dir' },
      { name: 'site/index.html', type: 'file', content: Buffer.from('<h1>hi</h1>', 'utf8') },
      { name: 'site/css/app.css', type: 'file', content: Buffer.from('body{}', 'utf8') },
    ]);
    const entries = await unpack(archive);
    expect(entries.map((e) => [e.entry.name, e.entry.type, e.entry.size])).toEqual([
      ['site/', 'dir', 0],
      ['site/index.html', 'file', 11],
      ['site/css/app.css', 'file', 6],
    ]);
    expect(entries[1]!.text).toBe('<h1>hi</h1>');
    expect(entries[2]!.text).toBe('body{}');
  });

  it('round-trips content that is not a multiple of the 512-byte block', async () => {
    const content = Buffer.from('x'.repeat(1_100), 'utf8');
    const [only] = await unpack(packTar([{ name: 'big.txt', type: 'file', content }]));
    expect(only!.entry.size).toBe(1_100);
    expect(only!.text).toBe(content.toString('utf8'));
  });

  it('splits long paths into the ustar prefix field', async () => {
    const name = `${'d'.repeat(60)}/${'e'.repeat(60)}/f.txt`;
    const [only] = await unpack(packTar([{ name, type: 'file', content: Buffer.from('ok') }]));
    expect(only!.entry.name).toBe(name);
    expect(only!.text).toBe('ok');
  });

  it('skips unread bodies so the next entry still parses', async () => {
    const archive = packTar([
      { name: 'a.txt', type: 'file', content: Buffer.from('a'.repeat(900)) },
      { name: 'b.txt', type: 'file', content: Buffer.from('b') },
    ]);
    const entries = await unpack(archive, { readBodies: false });
    expect(entries.map((e) => e.entry.name)).toEqual(['a.txt', 'b.txt']);
  });

  it('stops at the end-of-archive blocks and ignores trailing padding', async () => {
    const archive = Buffer.concat([packTar([{ name: 'a.txt', type: 'file', content: Buffer.from('a') }]), Buffer.alloc(1024)]);
    expect((await unpack(archive)).map((e) => e.entry.name)).toEqual(['a.txt']);
  });

  it('reads GNU long-name (L) records', async () => {
    const longName = `${'g'.repeat(120)}/file.txt`;
    const archive = Buffer.concat([
      prefixRecord('L', '././@LongLink', Buffer.from(`${longName}\0`, 'utf8')),
      body(packTar([{ name: 'file.txt', type: 'file', content: Buffer.from('ok') }])),
      Buffer.alloc(1024),
    ]);
    const entries = await unpack(archive);
    expect(entries.map((e) => [e.entry.name, e.text])).toEqual([[longName, 'ok']]);
  });

  it('reads pax (x) path records and ignores global (g) records', async () => {
    const longName = `${'p'.repeat(130)}/file.txt`;
    const archive = Buffer.concat([
      prefixRecord('g', 'pax_global_header', Buffer.from(paxRecord('comment', 'ignored-by-the-reader'), 'utf8')),
      prefixRecord('x', 'PaxHeader/file.txt', Buffer.from(paxRecord('path', longName), 'utf8')),
      body(packTar([{ name: 'file.txt', type: 'file', content: Buffer.from('ok') }])),
      Buffer.alloc(1024),
    ]);
    const entries = await unpack(archive);
    expect(entries.map((e) => [e.entry.name, e.text])).toEqual([[longName, 'ok']]);
  });

  it('rejects a path that cannot be represented in ustar', () => {
    expect(() => packTar([{ name: 'x'.repeat(300), type: 'file', content: Buffer.alloc(0) }])).toThrow(/path too long/);
  });
});

// `"%d %s=%s\n"` where %d counts its own digits, exactly as GNU tar writes pax records.
function paxRecord(key: string, value: string): string {
  const record = `${key}=${value}\n`;
  for (let digits = 1; digits < 10; digits++) {
    const total = digits + 1 + record.length;
    if (String(total).length === digits) return `${total} ${record}`;
  }
  throw new Error('pax record too long');
}

// Drops the two end-of-archive blocks so records can be concatenated.
const body = (archive: Buffer): Buffer => archive.subarray(0, archive.length - 1024);

// A metadata record (typeflag 'L', 'x' or 'g'): packTar writes a plain file header, which we retype and re-checksum.
function prefixRecord(typeflag: string, name: string, payload: Buffer): Buffer {
  const block = Buffer.from(body(packTar([{ name, type: 'file', content: payload }])));
  block.write(typeflag, 156, 1, 'latin1');
  block.fill(0x20, 148, 156);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += block[i]!;
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'latin1');
  return block;
}
