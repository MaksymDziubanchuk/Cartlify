import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

import env from '@config/env.js';

// Two keys come from TWO_FACTOR_SECRET_KEY: one encrypts the secrets of the apps in the database,
// the other signs the ticket between the two steps of a login. Neither can stand for the other.
function keyOf(purpose: string): Buffer {
  const raw = env.TWO_FACTOR_SECRET_KEY;
  // only a test may run without the key (src/config/env.ts); the second step does not work then
  if (!raw) throw new Error('TWO_FACTOR_SECRET_KEY_MISSING');

  return Buffer.from(hkdfSync('sha256', Buffer.from(raw, 'base64'), '', purpose, 32));
}

let secretKey: Buffer | undefined;
let ticketKey: Buffer | undefined;

export const twoFactorTicketKey = (): Buffer => (ticketKey ??= keyOf('cartlify two factor ticket'));
const twoFactorSecretKey = (): Buffer => (secretKey ??= keyOf('cartlify two factor secret'));

// the version of the key goes in front of what it encrypted, so a new key can come next to the old
// one without a new column
const VERSION = 'v1';
const IV_BYTES = 12;

// AES-256-GCM: v1:<iv>:<tag>:<data>, each in base64url
export function encryptTwoFactorSecret(secret: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', twoFactorSecretKey(), iv);
  const data = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [VERSION, iv, tag, data]
    .map((part) => (typeof part === 'string' ? part : part.toString('base64url')))
    .join(':');
}

// throws on a text of another version, another key or a changed byte
export function decryptTwoFactorSecret(text: string): string {
  const [version, iv, tag, data, ...rest] = text.split(':');
  if (version !== VERSION || !iv || !tag || !data || rest.length > 0) {
    throw new Error('TWO_FACTOR_SECRET_UNREADABLE');
  }

  const decipher = createDecipheriv(
    'aes-256-gcm',
    twoFactorSecretKey(),
    Buffer.from(iv, 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));

  return Buffer.concat([
    decipher.update(Buffer.from(data, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}
