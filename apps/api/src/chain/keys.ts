// Agent keys at rest: AES-256-GCM with KEY_ENCRYPTION_KEY (SPEC §8.3). Secrets are decrypted only
// inside chain calls, never logged, never handed to the sandbox, never returned by any API.
// A secret is a raw 32-byte secp256k1 private key; the public identity is its EIP-55 address.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { toHex, type PrivateKeyAccount } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ChainError } from './errors.js';

export interface EncryptedSecret { enc: Buffer; iv: Buffer; tag: Buffer }

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const KEY_HEX_RE = /^[0-9a-fA-F]{64}$/;
export const SECRET_KEY_BYTES = 32;     // secp256k1 private key
const HEX_SECRET_RE = /^(0x)?[0-9a-fA-F]{64}$/;

function keyFromHex(keyHex: string): Buffer {
  if (!KEY_HEX_RE.test(keyHex)) throw new ChainError('invalid_key', 'KEY_ENCRYPTION_KEY must be 64 hex chars');
  return Buffer.from(keyHex, 'hex');
}

export function encryptSecret(secret: Uint8Array, keyHex: string): EncryptedSecret {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, keyFromHex(keyHex), iv);
  const enc = Buffer.concat([cipher.update(secret), cipher.final()]);
  return { enc, iv, tag: cipher.getAuthTag() };
}

export function decryptSecret(row: EncryptedSecret, keyHex: string): Uint8Array {
  const decipher = createDecipheriv(ALGORITHM, keyFromHex(keyHex), row.iv);
  decipher.setAuthTag(row.tag);
  try {
    return new Uint8Array(Buffer.concat([decipher.update(row.enc), decipher.final()]));
  } catch {
    throw new ChainError('invalid_key', 'agent key could not be decrypted (wrong KEY_ENCRYPTION_KEY or corrupt row)');
  }
}

// Zero a secret buffer once a chain call is done with it.
export function wipeSecret(secret: Uint8Array): void {
  secret.fill(0);
}

// The local signer for a secret. Every send in chain/evm.ts and economy/token.ts goes through one of
// these: the private key never leaves this process and no RPC is ever asked to sign anything.
export function accountFromSecret(secret: Uint8Array): PrivateKeyAccount {
  if (secret.length !== SECRET_KEY_BYTES) throw new ChainError('invalid_key', `private key must be ${SECRET_KEY_BYTES} bytes`);
  try {
    return privateKeyToAccount(toHex(secret));
  } catch {
    // Zero, or ≥ the secp256k1 group order: a 32-byte string that is not a usable key.
    throw new ChainError('invalid_key', 'secret is not a valid secp256k1 private key');
  }
}

export const pubkeyOfSecret = (secret: Uint8Array): string => accountFromSecret(secret).address;

// Operator-supplied secret: a 0x-prefixed (or bare) 64-char hex private key, a JSON byte array, or a
// path to a file holding that array. Error messages deliberately never echo the value.
export function loadSecret(source: string): Uint8Array {
  const value = source.trim();
  if (value === '') throw new ChainError('invalid_key', 'wallet secret is empty');
  const bytes = value.startsWith('[') ? parseJsonKeypair(value)
    : HEX_SECRET_RE.test(value) ? decodeHex(value)
    : looksLikePath(value) ? parseJsonKeypair(readKeypairFile(value))
    : throwShape();
  if (bytes.length !== SECRET_KEY_BYTES) {
    throw new ChainError('invalid_key', `wallet secret must decode to ${SECRET_KEY_BYTES} bytes, got ${bytes.length}`);
  }
  // Prove it is a key and not just 32 bytes, here rather than at the first transfer.
  accountFromSecret(bytes);
  return bytes;
}

const looksLikePath = (v: string): boolean => v.endsWith('.json') || v.includes('/') || existsSync(v);

function throwShape(): never {
  throw new ChainError('invalid_key', 'wallet secret must be a 0x-prefixed 32-byte hex private key, a JSON byte array, or a path to one');
}

function readKeypairFile(file: string): string {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    throw new ChainError('invalid_key', 'wallet keypair file could not be read');
  }
}

function parseJsonKeypair(json: string): Uint8Array {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new ChainError('invalid_key', 'wallet keypair file is not valid JSON');
  }
  if (!Array.isArray(parsed) || !parsed.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
    throw new ChainError('invalid_key', 'wallet keypair JSON must be an array of bytes');
  }
  return Uint8Array.from(parsed as number[]);
}

function decodeHex(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value.startsWith('0x') ? value.slice(2) : value, 'hex'));
}
