// agent_keys rows: the only place agent secrets are persisted (encrypted) and read back.
import { eq } from 'drizzle-orm';
import type { DbLike } from '../db/client.js';
import { agentKeys, userKeys } from '../db/schema.js';
import { notFound } from '../lib/errors.js';
import { decryptSecret, encryptSecret, pubkeyOfSecret, wipeSecret } from './keys.js';

export async function storeAgentKey(db: DbLike, keyHex: string, agentId: string, secret: Uint8Array): Promise<void> {
  const { enc, iv, tag } = encryptSecret(secret, keyHex);
  await db.insert(agentKeys).values({ agentId, pubkey: pubkeyOfSecret(secret), secretEnc: enc, iv, tag });
}

export async function loadAgentSecret(db: DbLike, keyHex: string, agentId: string): Promise<Uint8Array> {
  const [row] = await db.select().from(agentKeys).where(eq(agentKeys.agentId, agentId)).limit(1);
  if (!row) throw notFound(`Key for agent ${agentId}`);
  return decryptSecret({ enc: row.secretEnc, iv: row.iv, tag: row.tag }, keyHex);
}

// Decrypt, run one chain operation, zero the buffer. Callers never hold the secret beyond `fn`.
export async function withAgentSecret<T>(db: DbLike, keyHex: string, agentId: string, fn: (secret: Uint8Array) => Promise<T>): Promise<T> {
  const secret = await loadAgentSecret(db, keyHex, agentId);
  try {
    return await fn(secret);
  } finally {
    wipeSecret(secret);
  }
}

// The custodial keypair for a Google owner. Mirrors the agent-key helpers above, keyed by owner id.
export async function storeUserKey(db: DbLike, keyHex: string, ownerId: string, secret: Uint8Array): Promise<string> {
  const { enc, iv, tag } = encryptSecret(secret, keyHex);
  const pubkey = pubkeyOfSecret(secret);
  await db.insert(userKeys).values({ ownerId, pubkey, secretEnc: enc, iv, tag });
  return pubkey;
}

// Decrypt, run one chain operation, zero the buffer. Callers never hold the custodial secret beyond `fn`.
export async function withUserSecret<T>(db: DbLike, keyHex: string, ownerId: string, fn: (secret: Uint8Array) => Promise<T>): Promise<T> {
  const [row] = await db.select().from(userKeys).where(eq(userKeys.ownerId, ownerId)).limit(1);
  if (!row) throw notFound(`Custodial key for ${ownerId}`);
  const secret = decryptSecret({ enc: row.secretEnc, iv: row.iv, tag: row.tag }, keyHex);
  try {
    return await fn(secret);
  } finally {
    wipeSecret(secret);
  }
}
