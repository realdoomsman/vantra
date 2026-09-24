import type { OwnerKind } from '@vantra/shared';
import type { AuthStore } from '../../../src/http/auth.js';

export interface StoredUser { kind: OwnerKind; purchaseId: string | null; createdAt: Date; lastLoginAt: Date }

export interface MemoryAuthStore extends AuthStore {
  nonces: Map<string, { nonce: string; expiresAt: Date }>;
  sessions: Map<string, { ownerId: string; expiresAt: Date }>;
  users: Map<string, StoredUser>;
}

export function createMemoryAuthStore(): MemoryAuthStore {
  const nonces = new Map<string, { nonce: string; expiresAt: Date }>();
  const sessions = new Map<string, { ownerId: string; expiresAt: Date }>();
  const users = new Map<string, StoredUser>();
  return {
    nonces, sessions, users,
    async putNonce(wallet, nonce, expiresAt) { nonces.set(wallet, { nonce, expiresAt }); },
    async consumeNonce(wallet, nonce, now) {
      const row = nonces.get(wallet);
      if (!row || row.nonce !== nonce) return false;
      nonces.delete(wallet);
      return row.expiresAt > now;
    },
    // Mirrors the db store: `kind` and `purchaseId` are written on insert only.
    async touchUser(ownerId, kind, purchaseId, now) {
      const u = users.get(ownerId);
      users.set(ownerId, u
        ? { ...u, lastLoginAt: now }
        : { kind, purchaseId, createdAt: now, lastLoginAt: now });
    },
    async createSession(tokenHash, ownerId, _now, expiresAt) { sessions.set(tokenHash, { ownerId, expiresAt }); },
    async findSession(tokenHash, now) {
      const row = sessions.get(tokenHash);
      if (!row) return null;
      if (row.expiresAt <= now) {
        sessions.delete(tokenHash);
        return null;
      }
      return row.ownerId;
    },
    async deleteSession(tokenHash) { sessions.delete(tokenHash); },
  };
}
