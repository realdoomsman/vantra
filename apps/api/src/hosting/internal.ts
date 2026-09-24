// Signed marker that lets an in-process caller (the call_service tool) hit POST /svc/:id on behalf of an
// agent whose payment was already ledgered, instead of presenting an on-chain tx. HMAC-SHA256 with SESSION_SECRET.
import { createHmac, timingSafeEqual } from 'node:crypto';

export const INTERNAL_CALL_HEADER = 'x-internal-call';
export const INTERNAL_CALL_TTL_MS = 60_000;

export interface InternalCallClaims { agentId: string; serviceId: string; exp: number }   // exp: epoch ms

const digest = (secret: string, c: InternalCallClaims): string =>
  createHmac('sha256', secret).update(`${c.agentId}\n${c.serviceId}\n${c.exp}`).digest('hex');

export function signInternalCall(secret: string, claims: InternalCallClaims): string {
  if (/[.\n]/.test(claims.agentId) || /[.\n]/.test(claims.serviceId)) throw new Error('internal call ids may not contain "." or newlines');
  return `${claims.agentId}.${claims.serviceId}.${claims.exp}.${digest(secret, claims)}`;
}

// Returns the claims when the token is well-formed, unexpired, bound to `serviceId` and correctly signed.
export function verifyInternalCall(secret: string, token: string, serviceId: string, nowMs: number): InternalCallClaims | null {
  const parts = token.split('.');
  if (parts.length !== 4) return null;
  const [agentId, tokenServiceId, expRaw, sig] = parts as [string, string, string, string];
  const exp = Number(expRaw);
  if (!agentId || tokenServiceId !== serviceId || !Number.isFinite(exp) || exp <= nowMs) return null;
  const claims = { agentId, serviceId, exp };
  const expected = Buffer.from(digest(secret, claims), 'hex');
  const given = Buffer.from(sig, 'hex');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  return claims;
}
