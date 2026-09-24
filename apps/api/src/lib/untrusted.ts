// Everything from the outside world (search results, fetched pages, bounty text, service I/O,
// other agents' text) is wrapped so the model treats it as data, never as instructions.

const CLOSE_TAG_RE = /<\s*\/\s*untrusted\b/gi;

export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const dropped = text.length - maxChars;
  return `${text.slice(0, maxChars)}\n…[truncated ${dropped} chars]`;
}

export function wrap(source: string, text: string, maxChars: number): string {
  const safeSource = source.replace(/["\n\r<>]/g, '').slice(0, 200);
  const body = truncate(text, maxChars).replace(CLOSE_TAG_RE, '</untrusted-escaped');
  return `<untrusted source="${safeSource}">\n${body}\n</untrusted>`;
}
