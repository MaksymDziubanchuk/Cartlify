import { createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';

// The key pair of the Event Webhook of the newsletters (SendGrid signs its events with ECDSA over
// P-256; the app holds the public half in SENDGRID_NEWSLETTER_WEBHOOK_KEY, base64 of the DER
// SPKI). The tests make a pair of their own when a test file starts: tests/setup/isolateEnv.ts puts
// the public half in the env, and this file signs events with the private half the way SendGrid
// signs them. The private half exists in the memory of the test file only: it is no file of the
// repository, no env variable, and the app never sees it.
type Pair = { publicKey: string; privateKey: KeyObject };

// on the global of the test file and not in a variable of the module: jest.resetModules() gives a
// fresh copy of this file, which must find the pair the env already holds the public half of
const SLOT = Symbol.for('cartlify.tests.newsletterWebhookKey');
const holder = globalThis as unknown as { [SLOT]?: Pair };

function pair(): Pair {
  if (!holder[SLOT]) {
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    holder[SLOT] = {
      publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
      privateKey,
    };
  }

  return holder[SLOT];
}

// the value of SENDGRID_NEWSLETTER_WEBHOOK_KEY in the tests
export const newsletterWebhookPublicKey = (): string => pair().publicKey;

// The signature SendGrid sends in X-Twilio-Email-Event-Webhook-Signature: ECDSA with SHA-256 over
// the timestamp (X-Twilio-Email-Event-Webhook-Timestamp) followed by the raw body, the DER
// signature in base64
export function signNewsletterWebhook(timestamp: string, rawBody: string | Buffer): string {
  const signer = createSign('SHA256');
  signer.update(timestamp);
  signer.update(rawBody);

  return signer.sign(pair().privateKey).toString('base64');
}
