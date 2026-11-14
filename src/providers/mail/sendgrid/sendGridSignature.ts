import { createPublicKey, createVerify, type KeyObject } from 'node:crypto';

// The signature SendGrid puts on the requests of its Event Webhook ("Signed Event Webhook"): ECDSA
// over the curve P-256 with SHA-256, made over the text of the timestamp header followed by the raw
// body (the exact bytes, not the parsed JSON), and sent as the base64 of the DER signature in
// X-Twilio-Email-Event-Webhook-Signature, with the timestamp (seconds since the epoch) in
// X-Twilio-Email-Event-Webhook-Timestamp. The public half, the Verification Key of the webhook, is
// kept as the base64 of the DER SPKI.
export const SENDGRID_SIGNATURE_HEADER = 'x-twilio-email-event-webhook-signature';
export const SENDGRID_TIMESTAMP_HEADER = 'x-twilio-email-event-webhook-timestamp';

// How old and how far ahead the timestamp of a request may be. A request that SendGrid could not
// deliver is delivered again for 24 hours, and it is not known to date the new try anew, so the
// window is that day and an hour. Taking an old request again is harmless in any case: an event
// applies once, a repeat changes nothing. A timestamp from the future is only a clock that runs a
// little fast, so minutes are enough
export const SENDGRID_TIMESTAMP_MAX_AGE_SECONDS = 25 * 60 * 60;
export const SENDGRID_TIMESTAMP_MAX_AHEAD_SECONDS = 5 * 60;

// What the check found:
// - valid: the request is SendGrid's and fresh;
// - key_missing, key_invalid: the server has no usable key (a fault of the server, not of the request);
// - timestamp_invalid: the timestamp is no whole number of seconds;
// - signature_invalid: the signature does not hold (not base64, not a signature, wrong key or body);
// - timestamp_out_of_window: the signature holds but the request is too old or from the future
export type SignatureVerdict =
  | 'valid'
  | 'key_missing'
  | 'key_invalid'
  | 'timestamp_invalid'
  | 'signature_invalid'
  | 'timestamp_out_of_window';

type Check = {
  publicKey: string;
  signature: string;
  timestamp: string;
  rawBody: string | Buffer;
  // the clock of the check; the server clock when left out
  nowMs?: number;
};

// a DER signature of P-256 is at most 72 bytes, which is 96 characters of base64
const SIGNATURE_MAX_CHARS = 128;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
// a whole number of seconds: ten digits for the next centuries, a few more for a reader's slip
const SECONDS = /^\d{1,12}$/;

function publicKeyOf(value: string) {
  if (!BASE64.test(value)) return null;

  try {
    const key = createPublicKey({ key: Buffer.from(value, 'base64'), format: 'der', type: 'spki' });
    const isP256 =
      key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1';

    return isP256 ? key : null;
  } catch {
    return null;
  }
}

// the signature over the timestamp and the body; a signature that is not the DER form of one makes
// the check throw, which is the same refusal
function signatureHolds(key: KeyObject, check: Check): boolean {
  try {
    return createVerify('SHA256')
      .update(check.timestamp)
      .update(check.rawBody)
      .verify(key, Buffer.from(check.signature, 'base64'));
  } catch {
    return false;
  }
}

// Checks one request of the Event Webhook. The order is the order of what can be told without
// trusting the request: the key of the server first (fails closed, without it nothing is taken), the
// shape of the timestamp, the signature, and last the age, so a request that is not SendGrid's is
// refused as such whatever its timestamp says
export function verifySendGridSignature(check: Check): SignatureVerdict {
  const keyText = check.publicKey.trim();
  if (!keyText) return 'key_missing';

  const key = publicKeyOf(keyText);
  if (!key) return 'key_invalid';

  if (!SECONDS.test(check.timestamp)) return 'timestamp_invalid';

  if (check.signature.length > SIGNATURE_MAX_CHARS || !BASE64.test(check.signature)) {
    return 'signature_invalid';
  }

  if (!signatureHolds(key, check)) return 'signature_invalid';

  const nowSeconds = (check.nowMs ?? Date.now()) / 1000;
  const sentAt = Number(check.timestamp);
  const inWindow =
    sentAt >= nowSeconds - SENDGRID_TIMESTAMP_MAX_AGE_SECONDS &&
    sentAt <= nowSeconds + SENDGRID_TIMESTAMP_MAX_AHEAD_SECONDS;

  return inWindow ? 'valid' : 'timestamp_out_of_window';
}
