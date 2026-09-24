import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { toHex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import {
  accountFromSecret, decryptSecret, encryptSecret, loadSecret, pubkeyOfSecret, wipeSecret,
} from '../../src/chain/keys.js';
import { isChainError } from '../../src/chain/errors.js';
import { TEST_KEY_HEX } from './helpers.js';

const OTHER_KEY_HEX = 'cd'.repeat(32);

const newSecret = (): Uint8Array => Uint8Array.from(Buffer.from(generatePrivateKey().slice(2), 'hex'));

describe('chain/keys', () => {
  it('round-trips an agent secret through AES-256-GCM', () => {
    const secret = newSecret();
    const row = encryptSecret(secret, TEST_KEY_HEX);
    expect(row.iv).toHaveLength(12);
    expect(row.tag).toHaveLength(16);
    expect(Buffer.from(secret).equals(row.enc)).toBe(false);   // ciphertext, not the key
    expect(Array.from(decryptSecret(row, TEST_KEY_HEX))).toEqual(Array.from(secret));
  });

  it('uses a fresh iv per encryption', () => {
    const secret = newSecret();
    const a = encryptSecret(secret, TEST_KEY_HEX);
    const b = encryptSecret(secret, TEST_KEY_HEX);
    expect(a.iv.equals(b.iv)).toBe(false);
    expect(a.enc.equals(b.enc)).toBe(false);
  });

  it('refuses the wrong key and tampered ciphertext', () => {
    const row = encryptSecret(newSecret(), TEST_KEY_HEX);
    expect(() => decryptSecret(row, OTHER_KEY_HEX)).toThrowError(/could not be decrypted/);
    const tampered = { ...row, enc: Buffer.concat([row.enc.subarray(0, row.enc.length - 1), Buffer.from([row.enc[row.enc.length - 1]! ^ 0xff])]) };
    expect(() => decryptSecret(tampered, TEST_KEY_HEX)).toThrowError(/could not be decrypted/);
  });

  it('rejects a malformed KEY_ENCRYPTION_KEY', () => {
    const secret = newSecret();
    expect(() => encryptSecret(secret, 'too-short')).toThrowError(/64 hex chars/);
    expect(() => encryptSecret(secret, 'zz'.repeat(32))).toThrowError(/64 hex chars/);
    expect(() => decryptSecret(encryptSecret(secret, TEST_KEY_HEX), '')).toThrowError(/64 hex chars/);
  });

  it('loads an operator secret from 0x hex, bare hex, a byte array and a file', () => {
    const secret = newSecret();
    const expected = Array.from(secret);
    const hex = toHex(secret);
    expect(Array.from(loadSecret(hex))).toEqual(expected);
    expect(Array.from(loadSecret(hex.slice(2)))).toEqual(expected);
    expect(Array.from(loadSecret(` ${hex} `))).toEqual(expected);
    expect(Array.from(loadSecret(JSON.stringify(expected)))).toEqual(expected);

    const file = path.join(mkdtempSync(path.join(tmpdir(), 'vantra-keys-')), 'treasury.json');
    writeFileSync(file, JSON.stringify(expected));
    expect(Array.from(loadSecret(file))).toEqual(expected);
    expect(pubkeyOfSecret(loadSecret(file))).toBe(privateKeyToAccount(hex).address);
  });

  it('never echoes the secret in its errors', () => {
    try {
      loadSecret('not-hex-!!!-supersecret');
      expect.unreachable('loadSecret should have thrown');
    } catch (e) {
      expect(isChainError(e, 'invalid_key')).toBe(true);
      expect((e as Error).message).not.toContain('supersecret');
    }
    expect(() => loadSecret('')).toThrowError(/empty/);
    expect(() => loadSecret(JSON.stringify(Array.from(new Uint8Array(10))))).toThrowError(/must decode to 32 bytes/);
    expect(() => loadSecret('/no/such/keypair.json')).toThrowError(/could not be read/);
  });

  // 32 bytes of zero is a structurally valid byte array and not a key: it has to be refused where it
  // is loaded, not at the first transfer it signs.
  it('refuses 32 bytes that are not a usable private key', () => {
    expect(() => loadSecret(JSON.stringify(Array.from(new Uint8Array(32))))).toThrowError(/not a valid secp256k1/);
  });

  it('derives the EIP-55 address from a secret and wipes buffers', () => {
    const hex = generatePrivateKey();
    const secret = Uint8Array.from(Buffer.from(hex.slice(2), 'hex'));
    expect(pubkeyOfSecret(secret)).toBe(privateKeyToAccount(hex).address);
    expect(pubkeyOfSecret(secret)).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(() => accountFromSecret(new Uint8Array(31))).toThrowError(/32 bytes/);
    const copy = Uint8Array.from(secret);
    wipeSecret(copy);
    expect(copy.every((b) => b === 0)).toBe(true);
  });
});
