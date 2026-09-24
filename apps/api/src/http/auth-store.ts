// AuthStore over the users / sessions / auth_nonces tables (SPEC §7, SPEC-V2 §4.3/§8.4).
// `users.wallet` is the owner id: a base58 pubkey for the wallet path, `claim_pu_…` for the
// claim-code path. `kind` and `purchase_id` are written once, when the identity is first seen.
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { authNonces, sessions, users } from '../db/schema.js';
import type { AuthStore } from './auth.js';

export function createDbAuthStore(db: Db): AuthStore {
  return {
    async putNonce(wallet, nonce, expiresAt) {
      await db.insert(authNonces).values({ wallet, nonce, expiresAt })
        .onConflictDoUpdate({ target: authNonces.wallet, set: { nonce, expiresAt } });
    },

    async consumeNonce(wallet, nonce, now) {
      const [row] = await db.delete(authNonces)
        .where(and(eq(authNonces.wallet, wallet), eq(authNonces.nonce, nonce)))
        .returning({ expiresAt: authNonces.expiresAt });
      return row !== undefined && row.expiresAt.getTime() > now.getTime();
    },

    async touchUser(ownerId, kind, purchaseId, now) {
      await db.insert(users).values({ wallet: ownerId, kind, purchaseId, createdAt: now, lastLoginAt: now })
        .onConflictDoUpdate({ target: users.wallet, set: { lastLoginAt: now } });
    },

    async createSession(tokenHash, ownerId, now, expiresAt) {
      await db.insert(sessions).values({ token: tokenHash, wallet: ownerId, createdAt: now, expiresAt });
    },

    async findSession(tokenHash, now) {
      const [row] = await db.select({ wallet: sessions.wallet, expiresAt: sessions.expiresAt })
        .from(sessions).where(eq(sessions.token, tokenHash)).limit(1);
      if (!row) return null;
      if (row.expiresAt.getTime() <= now.getTime()) {
        await db.delete(sessions).where(eq(sessions.token, tokenHash));
        return null;
      }
      return row.wallet;
    },

    async deleteSession(tokenHash) {
      await db.delete(sessions).where(eq(sessions.token, tokenHash));
    },
  };
}
