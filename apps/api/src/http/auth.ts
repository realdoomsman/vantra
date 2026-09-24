// Sessions (SPEC-V2 §6, §8.4). Two credentials mint the same `rw_session` cookie:
//   - Sign-In With Ethereum: nonce message → personal_sign → session for the wallet address.
//   - A claim code (POST /api/claim, routes/purchases.ts): session for `claim_pu_…`.
// Either way the session subject is an OWNER ID, exposed as `request.ownerId`.
import { createHash, randomBytes } from 'node:crypto';
import { getAddress, isAddress, verifyMessage } from 'viem';
import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import { DAY_MS, isEvmAddress, ownerKindOf, purchaseOfClaimOwnerId, sameAddress, type OwnerKind } from '@vantra/shared';
import type { Config } from '../config.js';
import { ApiError, unauthorized } from '../lib/errors.js';

declare module 'fastify' {
  interface FastifyRequest {
    ownerId: string | null;   // set by optionalAuth / requireAuth; an EIP-55 address or `claim_pu_…`
  }
}

export const SESSION_COOKIE = 'rw_session';
export const NONCE_TTL_MS = 10 * 60_000;
export const SESSION_TTL_MS = 30 * DAY_MS;

// The wallet line is any 0x address: the message is built here from the canonical form, and the
// signature is checked against that same string, so the regex only has to accept what we emit.
const MESSAGE_RE =
  /^VANTRA wants you to sign in\.\nWallet: (0x[0-9a-fA-F]{40})\nNonce: ([A-Za-z0-9_-]{16,64})\nIssued: (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\nThis signature does not send a transaction\.$/;
/** `0x` + r‖s‖v, the 65-byte result of personal_sign. */
export const SIGNATURE_RE = /^0x[0-9a-fA-F]{130}$/;

export function buildSignInMessage(wallet: string, nonce: string, issued: Date): string {
  return `VANTRA wants you to sign in.\nWallet: ${wallet}\nNonce: ${nonce}\nIssued: ${issued.toISOString()}\nThis signature does not send a transaction.`;
}

export function parseSignInMessage(message: string): { wallet: string; nonce: string; issued: string } | null {
  const m = MESSAGE_RE.exec(message);
  return m ? { wallet: m[1]!, nonce: m[2]!, issued: m[3]! } : null;
}

export function isWalletAddress(value: string): boolean {
  return isEvmAddress(value);
}

/** The EIP-55 spelling of an address, which is how every owner id is stored. */
export function canonicalWallet(value: string): string {
  return getAddress(value.trim());
}

/**
 * True when `signature` is a personal_sign of `message` by `wallet`. ECDSA recovery, not a public-key
 * check: viem recovers the signer from the signature and compares it to the address, which is why
 * a malformed signature is a false rather than a throw. Smart-contract wallets are not supported
 * here — an EOA signature is what the session is bound to.
 */
export async function verifyWalletSignature(message: string, signature: string, wallet: string): Promise<boolean> {
  if (!SIGNATURE_RE.test(signature) || !isAddress(wallet, { strict: false })) return false;
  try {
    return await verifyMessage({ address: getAddress(wallet), message, signature: signature as `0x${string}` });
  } catch {
    return false;
  }
}

// Cookies carry the raw token; the store only ever sees its hash.
export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

export interface AuthStore {
  putNonce(wallet: string, nonce: string, expiresAt: Date): Promise<void>;
  consumeNonce(wallet: string, nonce: string, now: Date): Promise<boolean>;   // removes it; true iff it matched and was unexpired
  // Insert, or bump last_login_at. `kind`/`purchaseId` are only written on insert: an existing
  // identity never changes shape (SPEC-V2 §8.4).
  touchUser(ownerId: string, kind: OwnerKind, purchaseId: string | null, now: Date): Promise<void>;
  createSession(tokenHash: string, ownerId: string, now: Date, expiresAt: Date): Promise<void>;
  findSession(tokenHash: string, now: Date): Promise<string | null>;         // owner id, or null when missing/expired
  deleteSession(tokenHash: string): Promise<void>;
}

export interface Auth {
  optionalAuth: preHandlerAsyncHookHandler;   // sets request.ownerId when a valid session cookie is present
  requireAuth: preHandlerAsyncHookHandler;    // 401 without one
  issueNonce(wallet: string): Promise<string>;                                             // returns the message to sign
  verifySignIn(input: { wallet: string; signature: string; message: string }): Promise<void>;  // 401 on any mismatch
  signIn(reply: FastifyReply, ownerId: string): Promise<void>;                             // wallet pubkey OR claim_pu_…
  signOut(request: FastifyRequest, reply: FastifyReply): Promise<void>;
}

export function ownerIdOf(request: FastifyRequest): string {
  if (!request.ownerId) throw unauthorized();
  return request.ownerId;
}

// Rate-limit key for authenticated routes. Rate limiting runs in `onRequest`, before the auth
// preHandler resolves an owner, so the session cookie (hashed, never stored raw) stands in for it
// and one signed-in user cannot spend everyone else's budget behind a shared IP.
export function sessionRateKey(request: FastifyRequest): string {
  const raw = request.cookies[SESSION_COOKIE];
  const unsigned = raw ? request.unsignCookie(raw) : null;
  return unsigned?.valid ? `s:${hashToken(unsigned.value)}` : `ip:${request.ip}`;
}

export function createAuth(config: Config, store: AuthStore): Auth {
  const cookieOptions = {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProduction,
    signed: true,
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  } as const;

  async function sessionOwner(request: FastifyRequest): Promise<string | null> {
    const raw = request.cookies[SESSION_COOKIE];
    if (!raw) return null;
    const unsigned = request.unsignCookie(raw);
    if (!unsigned.valid) return null;
    return store.findSession(hashToken(unsigned.value), new Date());
  }

  const optionalAuth: preHandlerAsyncHookHandler = async (request) => {
    request.ownerId = await sessionOwner(request);
  };

  const requireAuth: preHandlerAsyncHookHandler = async (request) => {
    request.ownerId = await sessionOwner(request);
    if (!request.ownerId) throw unauthorized();
  };

  return {
    optionalAuth,
    requireAuth,

    async issueNonce(wallet) {
      const now = new Date();
      const nonce = randomBytes(24).toString('base64url');
      await store.putNonce(wallet, nonce, new Date(now.getTime() + NONCE_TTL_MS));
      return buildSignInMessage(wallet, nonce, now);
    },

    async verifySignIn({ wallet, signature, message }) {
      const parsed = parseSignInMessage(message);
      // The message carries the address as it was signed; a wallet may echo a different casing of
      // the same address, which is the same identity and must not fail the check.
      if (!parsed || !sameAddress(parsed.wallet, wallet)) throw invalidSignature('Message is not a VANTRA sign-in message for this wallet');
      if (!(await verifyWalletSignature(message, signature, wallet))) throw invalidSignature('Signature verification failed');
      if (!(await store.consumeNonce(wallet, parsed.nonce, new Date()))) throw invalidSignature('Nonce expired or already used');
    },

    async signIn(reply, ownerId) {
      const now = new Date();
      const token = randomBytes(32).toString('base64url');
      // A claim identity records the purchase it was minted from in `users.purchase_id`.
      await store.touchUser(ownerId, ownerKindOf(ownerId), purchaseOfClaimOwnerId(ownerId), now);
      await store.createSession(hashToken(token), ownerId, now, new Date(now.getTime() + SESSION_TTL_MS));
      reply.setCookie(SESSION_COOKIE, token, cookieOptions);
    },

    async signOut(request, reply) {
      const raw = request.cookies[SESSION_COOKIE];
      if (raw) {
        const unsigned = request.unsignCookie(raw);
        if (unsigned.valid) await store.deleteSession(hashToken(unsigned.value));
      }
      reply.clearCookie(SESSION_COOKIE, { path: cookieOptions.path });
    },
  };
}

const invalidSignature = (message: string) => new ApiError(401, 'INVALID_SIGNATURE', message);
