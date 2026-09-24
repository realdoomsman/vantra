// Owner identity. SPEC-V2 §3.2.
// An OWNER ID is either a `0x` EIP-55 wallet address (the wallet path) or `claim_<purchaseId>` (the
// no-wallet path). Both are stored in `users.wallet` / `agents.owner_wallet`; only the public
// payload distinguishes them, via `ownerKind` and a nulled `ownerWallet`.
//
// Addresses are case-insensitive on chain but are STORED checksummed, so every comparison goes
// through `sameAddress` and every write canonicalizes first. Canonicalizing needs keccak256, which
// this dependency-free package deliberately does not carry: the API and the browser both hold viem
// and call `getAddress` at their boundary (sign-in, payout wallet, wallet connect) before anything
// reaches storage. What lives here is the shape rule and the comparison rule, which both sides share.
//
// Generation and hashing of claim codes are server-side (apps/api/src/payments/claim.ts); shared
// owns only the alphabet, the printed format and the normalizer so the web can validate a code
// before posting it.

/** A 20-byte hex address, any case. Checksum validity is viem's job, at the write boundary. */
export const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
export const isEvmAddress = (value: string): boolean => EVM_ADDRESS_RE.test(value.trim());
/** Address equality. Two spellings of one address differ only in case, so never use `===`. */
export const sameAddress = (a: string | null | undefined, b: string | null | undefined): boolean =>
  typeof a === 'string' && typeof b === 'string' && a.trim().toLowerCase() === b.trim().toLowerCase();

export type OwnerKind = 'wallet' | 'claim' | 'google';
export const CLAIM_OWNER_PREFIX = 'claim_';
// Google-authenticated owner: `google_<sub>` where sub is the stable Google account id. Like a claim
// identity it has no wallet of its own, so a payout wallet must be set before it can withdraw.
export const GOOGLE_OWNER_PREFIX = 'google_';

/** Owner id for the no-wallet path. `purchaseId` is a `pu_…` id. */
export const claimOwnerId = (purchaseId: string): string => `${CLAIM_OWNER_PREFIX}${purchaseId}`;
export const isClaimOwnerId = (id: string): boolean => id.startsWith(CLAIM_OWNER_PREFIX);
/** Owner id for the Google-login path. `sub` is the Google account's stable subject id. */
export const googleOwnerId = (sub: string): string => `${GOOGLE_OWNER_PREFIX}${sub}`;
export const isGoogleOwnerId = (id: string): boolean => id.startsWith(GOOGLE_OWNER_PREFIX);
/** True for any identity that has no wallet of its own (claim code or Google login). */
export const isWalletlessOwnerId = (id: string): boolean => isClaimOwnerId(id) || isGoogleOwnerId(id);
export const ownerKindOf = (id: string): OwnerKind =>
  isClaimOwnerId(id) ? 'claim' : isGoogleOwnerId(id) ? 'google' : 'wallet';
/** The wallet an owner id represents, or null for a walletless (claim / Google) identity. */
export const walletOfOwnerId = (id: string): string | null => (isWalletlessOwnerId(id) ? null : id);
/** The purchase id a claim owner id was minted from, or null. */
export const purchaseOfClaimOwnerId = (id: string): string | null =>
  (isClaimOwnerId(id) ? id.slice(CLAIM_OWNER_PREFIX.length) : null);

/** Claim codes: 100 bits, Crockford base32, printed RW-XXXXX-XXXXX-XXXXX-XXXXX. */
export const CLAIM_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';   // no I L O U
export const CLAIM_CODE_BODY_LEN = 20;
export const CLAIM_CODE_PREFIX = 'RW';
export const CLAIM_CODE_RE = /^RW[0-9A-HJKMNP-TV-Z]{20}$/;

/** Uppercases and strips every character outside the alphabet and the RW prefix. */
export function normalizeClaimCode(raw: string): string {
  const up = raw.toUpperCase();
  const kept = up.replace(/[^0-9A-Z]/g, '');
  const body = kept.startsWith(CLAIM_CODE_PREFIX) ? kept.slice(CLAIM_CODE_PREFIX.length) : kept;
  // Crockford aliases: I/L → 1, O → 0. U is excluded entirely and simply dropped.
  const mapped = body.replace(/[IL]/g, '1').replace(/O/g, '0').replace(/U/g, '');
  return `${CLAIM_CODE_PREFIX}${mapped}`;
}

/** 'RW-ABCDE-FGHJK-MNPQR-STVWX' from the normalized 22-char form. */
export function formatClaimCode(normalized: string): string {
  const body = normalized.startsWith(CLAIM_CODE_PREFIX) ? normalized.slice(CLAIM_CODE_PREFIX.length) : normalized;
  const groups = body.match(/.{1,5}/g) ?? [];
  return [CLAIM_CODE_PREFIX, ...groups].join('-');
}

export function isClaimCode(raw: string): boolean {
  return CLAIM_CODE_RE.test(normalizeClaimCode(raw));
}
