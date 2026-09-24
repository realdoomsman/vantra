// Owner↔agent messages are private (AMENDMENTS C21: returned only to the owner, never broadcast), but
// they also have to reach the model — which means they are persisted verbatim inside steps.transcript,
// and that transcript has a public endpoint. Marking the section at the point it is built is what lets
// every public payload strip it without parsing the STATUS JSON.
const TAG = 'owner-private';
const CLOSE_RE = /<\s*\/\s*owner-private/gi;
const SECTION_RE = /<owner-private>[\s\S]*?<\/owner-private>/gi;
const REDACTED = `<${TAG}>[redacted: owner-private]</${TAG}>`;

export function ownerPrivate(text: string): string {
  return `<${TAG}>${text.replace(CLOSE_RE, `<\\/${TAG}`)}</${TAG}>`;
}

export function redactOwnerPrivate(text: string): string {
  return text.replace(SECTION_RE, REDACTED);
}
