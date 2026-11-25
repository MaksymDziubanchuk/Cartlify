import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// The codes of an authenticator app (RFC 6238 over RFC 4226): HMAC-SHA1 of the number of the time
// step, six digits, a step of 30 seconds. These are the values every app takes by default; some
// apps ignore any other.
export const TOTP_DIGITS = 6;
export const TOTP_STEP_SECONDS = 30;
// a code of the step before or after the current one is taken too: the clock of a phone runs a
// little off, and a person types the code a few seconds after it showed
export const TOTP_WINDOW = 1;
// 20 bytes, the length of the HMAC-SHA1 key RFC 4226 recommends
const SECRET_BYTES = 20;

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';

  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];

  return out;
}

// the spaces, the lower case and the padding a person may bring along are taken off; a letter
// outside the alphabet gives null
export function base32Decode(text: string): Buffer | null {
  const clean = text.replace(/[\s=]/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];

  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index < 0) return null;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }

  return Buffer.from(out);
}

// a new secret of an app, in base32 as the app takes it
export function newTotpSecret(): string {
  return base32Encode(randomBytes(SECRET_BYTES));
}

export function totpStepAt(nowMs: number): number {
  return Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS);
}

// the code of one step
export function totpCode(secret: string, step: number, digits = TOTP_DIGITS): string {
  const key = base32Decode(secret);
  if (!key || key.length === 0) throw new Error('TOTP_SECRET_INVALID');

  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));

  const hmac = createHmac('sha1', key).update(counter).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const binary = hmac.readUInt32BE(offset) & 0x7fffffff;

  return String(binary % 10 ** digits).padStart(digits, '0');
}

// the step a code was made for, when it is one of the window around now and comes after the step
// taken last (a code works once); null otherwise
export function matchTotpCode(
  secret: string,
  code: string,
  { lastUsedStep, nowMs }: { lastUsedStep: number; nowMs: number },
): number | null {
  const typed = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(typed)) return null;

  const current = totpStepAt(nowMs);
  for (let step = current - TOTP_WINDOW; step <= current + TOTP_WINDOW; step += 1) {
    if (step <= lastUsedStep) continue;
    if (timingSafeEqual(Buffer.from(totpCode(secret, step)), Buffer.from(typed))) return step;
  }

  return null;
}

// the link an app reads from the QR code: the shop and the email of the account show in the app
export function otpauthUrl({
  secret,
  issuer,
  account,
}: {
  secret: string;
  issuer: string;
  account: string;
}): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const query = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });

  return `otpauth://totp/${label}?${query.toString()}`;
}
