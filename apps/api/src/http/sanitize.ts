// Last line of defence before data leaves the process: model thinking, key material and
// owner-private fields never reach a public payload, whatever a producer put in.
import { TRANSCRIPT_PUBLIC_TRUNCATE_CHARS, type StepTranscript, type TranscriptBlock, type TranscriptMessage } from '@vantra/shared';
import { OWNER_PRIVATE_TOOLS } from '../economy/steps.js';
import { redactOwnerPrivate } from '../lib/ownerPrivate.js';
import { truncate } from '../lib/untrusted.js';

// `thinking` is NOT a sensitive key: reasoning only ever travels as a typed content block
// (dropped by HIDDEN_BLOCK_TYPES below), while ModelInfo.thinking is a public catalog field.
// SPEC-V2 §8.5 adds the purchase secrets: a deposit keypair, a claim code and the owner id behind
// it must never reach a WS frame or a public purchase payload, whatever a producer put in.
const SENSITIVE_KEYS = new Set([
  'redacted_thinking', 'secret', 'secretKey', 'privateKey', 'fromSecret', 'payerSecret',
  'treasurySecret', 'transcript', 'ownerMessages',
  'claimCode', 'claimCodeHash', 'claim_code_hash',
  'depositSecretEnc', 'deposit_secret_enc', 'depositIv', 'depositTag',
  'ownerId',
]);
const HIDDEN_BLOCK_TYPES = new Set(['thinking', 'redacted_thinking']);

// Deep copy of a broadcast payload without sensitive keys or thinking blocks.
export function stripSensitive<T>(value: T): T {
  return walk(value) as T;
}

function walk(value: unknown): unknown {
  if (Array.isArray(value)) return value.filter((item) => !isHiddenBlock(item)).map(walk);
  if (value instanceof Date) return value;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      if (!SENSITIVE_KEYS.has(key) && !isHiddenBlock(inner)) out[key] = walk(inner);
    }
    return out;
  }
  return value;
}

function isHiddenBlock(item: unknown): boolean {
  return !!item && typeof item === 'object' && HIDDEN_BLOCK_TYPES.has(String((item as { type?: unknown }).type));
}

// Public transcript view (AMENDMENTS C25): only text / tool_use / tool_result blocks, tool I/O cut to
// 2k chars. `ownerView` is the one case that keeps the owner-private sections (C21); the producer
// redacts them too, so this is a second, independent pass.
export interface TranscriptViewOpts { ownerView?: boolean }

export function sanitizeTranscript(transcript: StepTranscript, opts: TranscriptViewOpts = {}): StepTranscript {
  const ownerView = opts.ownerView === true;
  return { ...transcript, messages: transcript.messages.map((m) => sanitizeMessage(m, ownerView)) };
}

function sanitizeMessage(message: TranscriptMessage, ownerView: boolean): TranscriptMessage {
  const content: TranscriptBlock[] = [];
  for (const block of message.content as unknown[]) {
    const publicBlock = toPublicBlock(block, ownerView);
    if (publicBlock) content.push(publicBlock);
  }
  return { role: message.role, content };
}

function toPublicBlock(block: unknown, ownerView: boolean): TranscriptBlock | null {
  if (!block || typeof block !== 'object') return null;
  const b = block as Record<string, unknown>;
  switch (b.type) {
    case 'text': {
      const text = String(b.text ?? '');
      return { type: 'text', text: ownerView ? text : redactOwnerPrivate(text) };
    }
    case 'tool_use': {
      const name = String(b.name ?? '');
      const raw = typeof b.input === 'string' ? b.input : JSON.stringify(b.input ?? null);
      const input = !ownerView && OWNER_PRIVATE_TOOLS.has(name) ? '"[redacted: owner-private]"' : clip(raw);
      return { type: 'tool_use', id: String(b.id ?? ''), name, input };
    }
    case 'tool_result':
      return { type: 'tool_result', toolUseId: String(b.toolUseId ?? ''), content: clip(String(b.content ?? '')), isError: b.isError === true };
    default:
      return null;
  }
}

const clip = (s: string): string => truncate(s, TRANSCRIPT_PUBLIC_TRUNCATE_CHARS);
