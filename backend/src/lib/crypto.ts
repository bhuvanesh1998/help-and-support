/**
 * crypto.ts — Symmetric encryption for secrets stored at rest.
 * ─────────────────────────────────────────────────────────────
 * AES-256-GCM with a 12-byte random nonce per value. The 32-byte key is
 * derived from SETTINGS_ENCRYPTION_KEY (falls back to JWT_SECRET) via SHA-256,
 * so the feature works out of the box without extra configuration.
 *
 * Rotating the underlying secret invalidates previously sealed values — they
 * simply need to be re-entered. Nothing here is recoverable without the secret.
 */

import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { env } from '../config/env.js';

const KEY = createHash('sha256').update(env.settingsEncryptionKey).digest(); // 32 bytes

export interface Sealed {
  ciphertext: string; // base64
  iv: string; // base64
  authTag: string; // base64
}

export function seal(plain: string): Sealed {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
  };
}

export function open(sealed: Sealed): string {
  const decipher = createDecipheriv('aes-256-gcm', KEY, Buffer.from(sealed.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(sealed.authTag, 'base64'));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(sealed.ciphertext, 'base64')),
    decipher.final(),
  ]);
  return plain.toString('utf8');
}
