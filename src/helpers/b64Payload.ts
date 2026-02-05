import { createHmac } from 'node:crypto';

// base64url encode helpers
export function b64url(input: Buffer | string) {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');
}

// json to base64url payload
export function b64urlJson(obj: unknown) {
  return b64url(JSON.stringify(obj));
}

// sign oauth state payload
export function signState(payloadB64: string, secret: string) {
  return b64url(createHmac('sha256', secret).update(payloadB64).digest());
}
