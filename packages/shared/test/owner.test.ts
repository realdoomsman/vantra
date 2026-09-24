// SPEC-V2 §3.2 + §11(A): owner identity and the printed claim-code format.
import { describe, expect, it } from 'vitest';
import {
  CLAIM_CODE_ALPHABET, CLAIM_CODE_BODY_LEN, CLAIM_CODE_RE, CLAIM_OWNER_PREFIX,
  claimOwnerId, formatClaimCode, isClaimCode, isClaimOwnerId, normalizeClaimCode, ownerKindOf,
  purchaseOfClaimOwnerId, walletOfOwnerId,
} from '../src/index.js';

const WALLET = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const PURCHASE = 'pu_x7k2m9p4q1';
const BODY = 'ABCDEFGHJKMNPQRSTVWX';            // 20 legal Crockford characters
const NORMALIZED = `RW${BODY}`;
const PRINTED = 'RW-ABCDE-FGHJK-MNPQR-STVWX';

describe('owner ids', () => {
  it('distinguishes a wallet identity from a claim identity', () => {
    expect(claimOwnerId(PURCHASE)).toBe(`${CLAIM_OWNER_PREFIX}${PURCHASE}`);
    expect(claimOwnerId(PURCHASE)).toBe('claim_pu_x7k2m9p4q1');
    expect(isClaimOwnerId(claimOwnerId(PURCHASE))).toBe(true);
    expect(isClaimOwnerId(WALLET)).toBe(false);
    expect(ownerKindOf(claimOwnerId(PURCHASE))).toBe('claim');
    expect(ownerKindOf(WALLET)).toBe('wallet');
  });

  it('never surfaces a purchase id as a wallet', () => {
    expect(walletOfOwnerId(WALLET)).toBe(WALLET);
    expect(walletOfOwnerId(claimOwnerId(PURCHASE))).toBeNull();
  });

  it('round-trips the purchase id out of a claim owner id', () => {
    expect(purchaseOfClaimOwnerId(claimOwnerId(PURCHASE))).toBe(PURCHASE);
    expect(purchaseOfClaimOwnerId(WALLET)).toBeNull();
  });
});

describe('claim codes', () => {
  it('has a 100-bit Crockford alphabet with no ambiguous letters', () => {
    expect(CLAIM_CODE_ALPHABET).toHaveLength(32);
    expect(new Set(CLAIM_CODE_ALPHABET).size).toBe(32);
    for (const bad of ['I', 'L', 'O', 'U']) expect(CLAIM_CODE_ALPHABET).not.toContain(bad);
    expect(CLAIM_CODE_BODY_LEN).toBe(20);
    expect(Math.log2(32) * CLAIM_CODE_BODY_LEN).toBe(100);
  });

  it('formats and normalizes as a round trip', () => {
    expect(formatClaimCode(NORMALIZED)).toBe(PRINTED);
    expect(normalizeClaimCode(PRINTED)).toBe(NORMALIZED);
    expect(normalizeClaimCode(formatClaimCode(NORMALIZED))).toBe(NORMALIZED);
    expect(formatClaimCode(normalizeClaimCode(PRINTED))).toBe(PRINTED);
  });

  it('is tolerant of case, spaces and missing dashes', () => {
    for (const variant of [
      PRINTED,
      PRINTED.toLowerCase(),
      PRINTED.replace(/-/g, ''),
      PRINTED.replace(/-/g, ' '),
      `  ${PRINTED.toLowerCase()}  `,
      PRINTED.split('').join(' '),
    ]) {
      expect(normalizeClaimCode(variant)).toBe(NORMALIZED);
      expect(isClaimCode(variant)).toBe(true);
    }
  });

  it('maps the Crockford look-alikes a human will mistype', () => {
    // I and L read as 1, O reads as 0. U is not in the alphabet at all.
    expect(normalizeClaimCode('RW-IL234-56789-ABCDE-FGHJK')).toBe('RW11234567 89ABCDEFGHJK'.replace(/ /g, ''));
    expect(normalizeClaimCode('RW-O1234-56789-ABCDE-FGHJK')).toBe('RW01234567 89ABCDEFGHJK'.replace(/ /g, ''));
  });

  it('rejects anything that is not a 20-character body', () => {
    expect(isClaimCode('')).toBe(false);
    expect(isClaimCode('RW')).toBe(false);
    expect(isClaimCode('RW-ABCDE-FGHJK-MNPQR')).toBe(false);             // 15 chars
    expect(isClaimCode(`${PRINTED}Z`)).toBe(false);                      // 21 chars
    expect(isClaimCode('nonsense')).toBe(false);
    expect(CLAIM_CODE_RE.test(NORMALIZED)).toBe(true);
    expect(CLAIM_CODE_RE.test(PRINTED)).toBe(false);                     // the RE wants the normal form
  });

  it('accepts every character of the alphabet in a body', () => {
    const body = (CLAIM_CODE_ALPHABET + CLAIM_CODE_ALPHABET).slice(0, CLAIM_CODE_BODY_LEN);
    expect(isClaimCode(formatClaimCode(`RW${body}`))).toBe(true);
  });
});
