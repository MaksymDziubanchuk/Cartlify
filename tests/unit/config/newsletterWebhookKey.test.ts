import { createPrivateKey, createPublicKey, verify } from 'node:crypto';

import { describe, expect, it } from '@jest/globals';

import { importWithEnv } from '../../helpers/freshImport.js';
import {
  newsletterWebhookPublicKey,
  signNewsletterWebhook,
} from '../../helpers/newsletterWebhookKey.js';

// The key pair the tests sign the Event Webhook of the newsletters with (step 9 of the newsletters
// sends signed events to the route): the public half is the setting of the app, the private half is
// in the memory of the test file and nowhere else
const publicKey = () =>
  createPublicKey({
    key: Buffer.from(process.env.SENDGRID_NEWSLETTER_WEBHOOK_KEY!, 'base64'),
    format: 'der',
    type: 'spki',
  });

const isSignedBy = (timestamp: string, body: string | Buffer, signature: string) =>
  verify(
    'sha256',
    Buffer.concat([Buffer.from(timestamp), Buffer.from(body)]),
    publicKey(),
    Buffer.from(signature, 'base64'),
  );

describe('the key pair of the Event Webhook of the newsletters in the tests', () => {
  it('puts the public half in the env, the one the signatures are checked with', () => {
    expect(process.env.SENDGRID_NEWSLETTER_WEBHOOK_KEY).toBe(newsletterWebhookPublicKey());
  });

  it('signs the timestamp and the raw body the way SendGrid does, in base64', () => {
    const body = JSON.stringify([{ event: 'bounce', email: 'a@shop.example.com' }]);
    const signature = signNewsletterWebhook('1731100000', body);

    expect(signature).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(isSignedBy('1731100000', body, signature)).toBe(true);
    // the same bytes as a buffer
    expect(isSignedBy('1731100000', Buffer.from(body), signature)).toBe(true);
  });

  it('gives a signature that fails for another body or another timestamp', () => {
    const signature = signNewsletterWebhook('1731100000', '[{"event":"bounce"}]');

    expect(isSignedBy('1731100000', '[{"event":"dropped"}]', signature)).toBe(false);
    expect(isSignedBy('1731100001', '[{"event":"bounce"}]', signature)).toBe(false);
  });

  it('keeps the pair when the modules are loaded again', async () => {
    // the path is read from tests/helpers/freshImport.ts, which does the import
    const again = await importWithEnv<typeof import('../../helpers/newsletterWebhookKey.js')>(
      './newsletterWebhookKey.js',
      {},
    );

    expect(again.newsletterWebhookPublicKey()).toBe(process.env.SENDGRID_NEWSLETTER_WEBHOOK_KEY);
    expect(isSignedBy('1', 'x', again.signNewsletterWebhook('1', 'x'))).toBe(true);
  });

  // the private half is no setting and no file: no value of the env is a private key
  it('leaves the private half out of the env', () => {
    const privateKeys = Object.values(process.env).filter((value) => {
      try {
        createPrivateKey({ key: Buffer.from(value ?? '', 'base64'), format: 'der', type: 'pkcs8' });
        return true;
      } catch {
        return false;
      }
    });

    expect(privateKeys).toEqual([]);
  });
});
