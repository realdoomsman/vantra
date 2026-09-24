// Minimal ustar/pax tar codec for the Docker archive API (putArchive / getArchive).
// Reads ustar, GNU long names ('L') and pax 'path' records; writes ustar with prefix splitting.

const BLOCK = 512;

export type TarEntryType = 'file' | 'dir' | 'symlink' | 'other';
export interface TarEntry { name: string; type: TarEntryType; size: number; mode: number }
export interface TarRecord { entry: TarEntry; body: () => AsyncIterable<Buffer> }

export interface TarInput {
  name: string;               // relative path inside the archive
  type: 'file' | 'dir';
  content?: Buffer;           // files only
  mode?: number;
  uid?: number;
  gid?: number;
}

// ---- writer -----------------------------------------------------------------

export function packTar(inputs: TarInput[], mtimeSec = Math.floor(Date.now() / 1000)): Buffer {
  const parts: Buffer[] = [];
  for (const input of inputs) {
    const content = input.type === 'file' ? input.content ?? Buffer.alloc(0) : Buffer.alloc(0);
    const name = input.type === 'dir' && !input.name.endsWith('/') ? `${input.name}/` : input.name;
    parts.push(header(name, content.length, input.type === 'dir' ? '5' : '0', input.mode ?? (input.type === 'dir' ? 0o755 : 0o644), input.uid ?? 0, input.gid ?? 0, mtimeSec));
    if (content.length > 0) {
      parts.push(content);
      const pad = (BLOCK - (content.length % BLOCK)) % BLOCK;
      if (pad) parts.push(Buffer.alloc(pad));
    }
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(parts);
}

function header(name: string, size: number, typeflag: string, mode: number, uid: number, gid: number, mtime: number): Buffer {
  const { base, prefix } = splitName(name);
  const buf = Buffer.alloc(BLOCK);
  buf.write(base, 0, 100, 'utf8');
  writeOctal(buf, 100, 8, mode & 0o7777);
  writeOctal(buf, 108, 8, uid);
  writeOctal(buf, 116, 8, gid);
  writeOctal(buf, 124, 12, size);
  writeOctal(buf, 136, 12, mtime);
  buf.write(typeflag, 156, 1, 'latin1');
  buf.write('ustar\0', 257, 6, 'latin1');
  buf.write('00', 263, 2, 'latin1');
  buf.write('agent', 265, 32, 'latin1');
  buf.write('agent', 297, 32, 'latin1');
  buf.write(prefix, 345, 155, 'utf8');
  buf.fill(0x20, 148, 156);
  let sum = 0;
  for (const b of buf) sum += b;
  buf.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'latin1');
  return buf;
}

function writeOctal(buf: Buffer, off: number, len: number, value: number): void {
  buf.write(`${Math.max(0, Math.floor(value)).toString(8).padStart(len - 1, '0')}\0`, off, len, 'latin1');
}

function splitName(name: string): { base: string; prefix: string } {
  if (Buffer.byteLength(name) <= 100) return { base: name, prefix: '' };
  for (let i = name.indexOf('/'); i !== -1; i = name.indexOf('/', i + 1)) {
    const prefix = name.slice(0, i);
    const base = name.slice(i + 1);
    if (Buffer.byteLength(prefix) <= 155 && base.length > 0 && Buffer.byteLength(base) <= 100) return { base, prefix };
  }
  throw new Error(`tar: path too long: ${name}`);
}

// ---- reader -----------------------------------------------------------------

class ByteSource {
  private readonly iter: AsyncIterator<Uint8Array>;
  private buf = Buffer.alloc(0);
  private ended = false;

  constructor(source: AsyncIterable<Uint8Array>) {
    this.iter = source[Symbol.asyncIterator]();
  }

  private async fill(n: number): Promise<boolean> {
    while (this.buf.length < n && !this.ended) {
      const { value, done } = await this.iter.next();
      if (done) { this.ended = true; break; }
      // Node stream chunks are ArrayBuffer-backed; the cast only drops the SharedArrayBuffer branch.
      const chunk = Buffer.from(value.buffer as ArrayBuffer, value.byteOffset, value.byteLength);
      this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    }
    return this.buf.length >= n;
  }

  async take(n: number): Promise<Buffer | null> {
    if (!(await this.fill(n))) return null;
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }

  async *chunks(n: number): AsyncGenerator<Buffer> {
    let left = n;
    while (left > 0) {
      if (this.buf.length === 0 && !(await this.fill(1))) throw new Error('tar: unexpected end of archive');
      const part = this.buf.subarray(0, Math.min(left, this.buf.length));
      this.buf = this.buf.subarray(part.length);
      left -= part.length;
      yield part;
    }
  }

  async skip(n: number): Promise<void> {
    for await (const _ of this.chunks(n)) { /* discard */ }
  }

  async readAll(n: number): Promise<Buffer> {
    const parts: Buffer[] = [];
    for await (const c of this.chunks(n)) parts.push(c);
    return Buffer.concat(parts);
  }

  async close(): Promise<void> {
    await this.iter.return?.();
  }
}

interface RawHeader { name: string; mode: number; size: number; typeflag: string }

function parseHeader(block: Buffer): RawHeader {
  const magic = block.toString('latin1', 257, 262);
  const prefix = magic === 'ustar' ? readString(block, 345, 155) : '';
  const base = readString(block, 0, 100);
  return {
    name: prefix ? `${prefix}/${base}` : base,
    mode: readOctal(block, 100, 8),
    size: readOctal(block, 124, 12),
    typeflag: block[156] === 0 ? '0' : String.fromCharCode(block[156]!),
  };
}

function readString(buf: Buffer, off: number, len: number): string {
  const end = buf.indexOf(0, off);
  return buf.toString('utf8', off, end === -1 || end > off + len ? off + len : end);
}

function readOctal(buf: Buffer, off: number, len: number): number {
  if (buf[off]! & 0x80) {                       // GNU base-256 encoding for large values
    let n = 0;
    for (let i = 1; i < len; i++) n = n * 256 + buf[off + i]!;
    return n;
  }
  const s = readString(buf, off, len).trim();
  return s === '' ? 0 : parseInt(s, 8);
}

function parsePax(body: Buffer): Map<string, string> {
  const records = new Map<string, string>();
  let pos = 0;
  while (pos < body.length) {
    const space = body.indexOf(0x20, pos);
    if (space === -1) break;
    const len = parseInt(body.toString('latin1', pos, space), 10);
    if (!Number.isFinite(len) || len <= 0) break;
    const record = body.toString('utf8', space + 1, pos + len - 1);
    const eq = record.indexOf('=');
    if (eq !== -1) records.set(record.slice(0, eq), record.slice(eq + 1));
    pos += len;
  }
  return records;
}

function entryType(typeflag: string): TarEntryType {
  switch (typeflag) {
    case '0': case '7': return 'file';
    case '5': return 'dir';
    case '2': return 'symlink';
    default: return 'other';
  }
}

const isZeroBlock = (block: Buffer): boolean => block.every((b) => b === 0);

// Yields entries in order. The consumer may read `body()` fully, partially or not at all;
// unread bytes are skipped before the next entry. Breaking out closes the source.
export async function* readTar(source: AsyncIterable<Uint8Array>): AsyncGenerator<TarRecord> {
  const src = new ByteSource(source);
  let longName: string | null = null;
  try {
    for (;;) {
      const block = await src.take(BLOCK);
      if (!block || isZeroBlock(block)) return;
      const h = parseHeader(block);
      const padded = Math.ceil(h.size / BLOCK) * BLOCK;
      if (h.typeflag === 'L') {
        longName = (await src.readAll(h.size)).toString('utf8').replace(/\0+$/, '');
        await src.skip(padded - h.size);
        continue;
      }
      if (h.typeflag === 'x') {
        const path = parsePax(await src.readAll(h.size)).get('path');
        if (path) longName = path;
        await src.skip(padded - h.size);
        continue;
      }
      if (h.typeflag === 'g') {
        await src.skip(padded);
        continue;
      }
      const entry: TarEntry = { name: longName ?? h.name, type: entryType(h.typeflag), size: h.size, mode: h.mode };
      longName = null;
      let consumed = 0;
      const body = async function* (): AsyncGenerator<Buffer> {
        for await (const chunk of src.chunks(entry.size - consumed)) {
          consumed += chunk.length;
          yield chunk;
        }
      };
      yield { entry, body };
      if (consumed < entry.size) await src.skip(entry.size - consumed);
      await src.skip(padded - entry.size);
    }
  } finally {
    await src.close();
  }
}
