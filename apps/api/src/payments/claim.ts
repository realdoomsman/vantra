// Claim codes (SPEC-V2 §5.5): the only credential on the no-wallet path.
//
// The plaintext code exists for exactly one HTTP response. What is stored is an HMAC keyed with
// SESSION_SECRET, so a database dump alone cannot be brute-forced offline, and the lookup stays a
// single indexed equality on `purchases.claim_code_hash`.
import { createHmac, randomBytes } from 'node:crypto';
import {
  CLAIM_CODE_ALPHABET, CLAIM_CODE_BODY_LEN, CLAIM_CODE_PREFIX, CLAIM_CODE_RE, formatClaimCode, normalizeClaimCode,
} from '@vantra/shared';
import type { DbLike } from '../db/client.js';
import type { PurchaseRow } from '../db/schema.js';
import { loadByClaimHash } from './repo.js';

export interface GeneratedClaimCode {
  /** Printed form: RW-XXXXX-XXXXX-XXXXX-XXXXX. Shown to the buyer once and never stored. */
  code: string;
  /** Canonical form the HMAC is taken over: 'RW' + 20 body characters. */
  normalized: string;
}

/**
 * 100 bits of entropy: 20 characters drawn from a 32-symbol alphabet. 256 is an exact multiple of 32,
 * so masking a random byte to its low 5 bits is already uniform — every symbol has exactly 8 of the
 * 256 equally likely byte values behind it, and no draw is ever rejected or reused.
 */
export function generateClaimCode(): GeneratedClaimCode {
  const bytes = randomBytes(CLAIM_CODE_BODY_LEN);
  let body = '';
  for (const b of bytes) body += CLAIM_CODE_ALPHABET[b & 0x1f];
  const normalized = `${CLAIM_CODE_PREFIX}${body}`;
  return { code: formatClaimCode(normalized), normalized };
}

export function hashClaimCode(normalized: string, secret: string): string {
  return createHmac('sha256', secret).update(normalized).digest('hex');
}

/**
 * Looks a raw, human-typed code up. Returns null for anything that is not a live code — a malformed
 * one, an unknown one, or one whose purchase has expired or been refunded — so the caller can answer
 * every failure with the same message and give away nothing.
 */
export async function verifyClaimCode(db: DbLike, raw: string, secret: string): Promise<PurchaseRow | null> {
  const normalized = normalizeClaimCode(raw);
  if (!CLAIM_CODE_RE.test(normalized)) return null;
  const row = await loadByClaimHash(db, hashClaimCode(normalized, secret));
  if (!row) return null;
  return row.status === 'expired' || row.status === 'refunded' ? null : row;
}
