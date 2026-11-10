import { createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { describe, expect, it } from '@jest/globals';

import {
  SENDGRID_TIMESTAMP_MAX_AGE_SECONDS,
  SENDGRID_TIMESTAMP_MAX_AHEAD_SECONDS,
  verifySendGridSignature,
} from '@helpers/sendGridSignature.js';

// The signature SendGrid puts on the requests of its Event Webhook: ECDSA over the curve P-256 with
// SHA-256, made over the timestamp of the request followed by its raw body, sent as the base64 of the
// DER signature next to the timestamp. The public half is kept as the base64 of the DER SPKI (the
// Verification Key SendGrid shows). A request is taken when the signature holds and the timestamp is
// neither too old nor in the future

const NOW_MS = Date.UTC(2026, 10, 9, 12, 0, 0);
const NOW_S = NOW_MS / 1000;

type Pair = { publicKey: string; privateKey: KeyObject };

function pairOf(curve: 'prime256v1' | 'secp384r1' = 'prime256v1'): Pair {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: curve });
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    privateKey,
  };
}

const ours = pairOf();
const another = pairOf();

function sign(pair: Pair, timestamp: string, body: string | Buffer): string {
  const signer = createSign('SHA256');
  signer.update(timestamp);
  signer.update(body);
  return signer.sign(pair.privateKey).toString('base64');
}

const BODY = JSON.stringify([{ event: 'bounce', campaignId: '5', recipientId: '9' }]);
const TIMESTAMP = String(NOW_S);

// a request that holds, and the arguments of the check with some of them changed
function check(over: Partial<Parameters<typeof verifySendGridSignature>[0]> = {}) {
  return verifySendGridSignature({
    publicKey: ours.publicKey,
    signature: sign(ours, TIMESTAMP, BODY),
    timestamp: TIMESTAMP,
    rawBody: BODY,
    nowMs: NOW_MS,
    ...over,
  });
}

describe('verifySendGridSignature', () => {
  describe('the signature', () => {
    it('takes a request signed with the private half of the key', () => {
      expect(check()).toBe('valid');
    });

    it('reads the body as the bytes it is, a string or a buffer', () => {
      const body = JSON.stringify([{ note: 'ünï — 日本語 😀' }]);

      expect(check({ rawBody: body, signature: sign(ours, TIMESTAMP, body) })).toBe('valid');
      expect(
        check({
          rawBody: Buffer.from(body, 'utf8'),
          signature: sign(ours, TIMESTAMP, Buffer.from(body, 'utf8')),
        }),
      ).toBe('valid');
    });

    it('refuses a signature made with another key', () => {
      expect(check({ signature: sign(another, TIMESTAMP, BODY) })).toBe('signature_invalid');
    });

    it('refuses a body that changed by one byte', () => {
      expect(check({ rawBody: BODY.replace('"9"', '"8"') })).toBe('signature_invalid');
      expect(check({ rawBody: `${BODY} ` })).toBe('signature_invalid');
      expect(check({ rawBody: Buffer.concat([Buffer.from(BODY), Buffer.from([0])]) })).toBe(
        'signature_invalid',
      );
    });

    it('refuses a timestamp that is not the one that was signed', () => {
      expect(check({ timestamp: String(NOW_S - 1) })).toBe('signature_invalid');
    });

    it('refuses a signature made over the body alone, without the timestamp', () => {
      const signer = createSign('SHA256');
      signer.update(BODY);

      expect(check({ signature: signer.sign(ours.privateKey).toString('base64') })).toBe(
        'signature_invalid',
      );
    });

    it('refuses a signature made with another hash', () => {
      const signer = createSign('SHA512');
      signer.update(TIMESTAMP);
      signer.update(BODY);

      expect(check({ signature: signer.sign(ours.privateKey).toString('base64') })).toBe(
        'signature_invalid',
      );
    });

    it('refuses a signature that is not the DER form (the raw r and s)', () => {
      const raw = createSign('SHA256')
        .update(TIMESTAMP)
        .update(BODY)
        .sign({ key: ours.privateKey, dsaEncoding: 'ieee-p1363' })
        .toString('base64');

      expect(check({ signature: raw })).toBe('signature_invalid');
    });

    it.each([
      ['empty', ''],
      ['blank', '   '],
      ['not base64', 'not*a*base64!signature'],
      ['base64 of something else', Buffer.from('hello there').toString('base64')],
      ['too long', 'A'.repeat(5000)],
      ['a valid one with a letter cut', sign(ours, TIMESTAMP, BODY).slice(0, -4)],
    ])('refuses a signature that is %s', (_name, signature) => {
      expect(check({ signature })).toBe('signature_invalid');
    });

    // the text that decodes to the very bytes of a good signature, written another way: the header of
    // SendGrid is the plain base64 alphabet, nothing a decoder merely forgives
    it('refuses a good signature written with a line break, a trailing newline or the URL alphabet', () => {
      let good = sign(ours, TIMESTAMP, BODY);
      // the URL alphabet differs only where the signature has a + or a /, which most signatures have
      while (!/[+/]/.test(good)) good = sign(ours, TIMESTAMP, BODY);

      expect(check({ signature: good })).toBe('valid');
      expect(check({ signature: `${good.slice(0, 20)}\n${good.slice(20)}` })).toBe(
        'signature_invalid',
      );
      expect(check({ signature: `${good}\n` })).toBe('signature_invalid');
      expect(check({ signature: `${good} ` })).toBe('signature_invalid');
      expect(check({ signature: good.replaceAll('+', '-').replaceAll('/', '_') })).toBe(
        'signature_invalid',
      );
    });

    it('never throws on a header it cannot read', () => {
      for (const signature of ['\u0000', '🙂', '=', '====', 'AAAA'.repeat(30)]) {
        expect(() => check({ signature })).not.toThrow();
        expect(check({ signature })).toBe('signature_invalid');
      }
    });
  });

  describe('the key', () => {
    it.each([
      ['empty', ''],
      ['blank', '   \n '],
    ])('fails closed with a key that is %s', (_name, publicKey) => {
      expect(check({ publicKey })).toBe('key_missing');
    });

    it('does not let a request through when the key is missing, whatever it carries', () => {
      expect(check({ publicKey: '', signature: '', timestamp: 'x' })).toBe('key_missing');
    });

    it.each([
      ['not base64', 'this is not a key!'],
      ['base64 of something that is not a key', Buffer.from('not a der key').toString('base64')],
      ['a PEM text', `-----BEGIN PUBLIC KEY-----\n${ours.publicKey}\n-----END PUBLIC KEY-----`],
      ['a key of the curve P-384', pairOf('secp384r1').publicKey],
      [
        'an RSA key',
        generateKeyPairSync('rsa', { modulusLength: 2048 })
          .publicKey.export({ type: 'spki', format: 'der' })
          .toString('base64'),
      ],
      [
        'the private half',
        ours.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
      ],
    ])('fails closed with a key that is %s', (_name, publicKey) => {
      expect(check({ publicKey })).toBe('key_invalid');
    });
  });

  describe('the timestamp', () => {
    // the signature covers the text of the timestamp, so a text that is no whole number of seconds is
    // refused even when it was signed
    it.each([
      '',
      ' ',
      'abc',
      '12.5',
      '-5',
      '+5',
      '0x10',
      '1e9',
      ' 1789000000',
      '1789000000 ',
      '١٢٣٤٥٦٧٨٩٠',
    ])('refuses the timestamp %j even with a signature that holds', (timestamp) => {
      expect(check({ timestamp, signature: sign(ours, timestamp, BODY) })).toBe(
        'timestamp_invalid',
      );
    });

    it('refuses a timestamp of more than twelve digits', () => {
      const timestamp = '1'.repeat(13);

      expect(check({ timestamp, signature: sign(ours, timestamp, BODY) })).toBe(
        'timestamp_invalid',
      );
    });

    it('takes a request as old as the window is long, and refuses the second after', () => {
      const edge = String(NOW_S - SENDGRID_TIMESTAMP_MAX_AGE_SECONDS);
      const past = String(NOW_S - SENDGRID_TIMESTAMP_MAX_AGE_SECONDS - 1);

      expect(check({ timestamp: edge, signature: sign(ours, edge, BODY) })).toBe('valid');
      expect(check({ timestamp: past, signature: sign(ours, past, BODY) })).toBe(
        'timestamp_out_of_window',
      );
    });

    it('takes a request a little ahead of the clock, and refuses one further ahead', () => {
      const edge = String(NOW_S + SENDGRID_TIMESTAMP_MAX_AHEAD_SECONDS);
      const ahead = String(NOW_S + SENDGRID_TIMESTAMP_MAX_AHEAD_SECONDS + 1);

      expect(check({ timestamp: edge, signature: sign(ours, edge, BODY) })).toBe('valid');
      expect(check({ timestamp: ahead, signature: sign(ours, ahead, BODY) })).toBe(
        'timestamp_out_of_window',
      );
    });

    it('keeps a window of a day behind and minutes ahead (SendGrid delivers again for a day)', () => {
      expect(SENDGRID_TIMESTAMP_MAX_AGE_SECONDS).toBeGreaterThanOrEqual(24 * 3600);
      expect(SENDGRID_TIMESTAMP_MAX_AGE_SECONDS).toBeLessThanOrEqual(48 * 3600);
      expect(SENDGRID_TIMESTAMP_MAX_AHEAD_SECONDS).toBeGreaterThanOrEqual(60);
      expect(SENDGRID_TIMESTAMP_MAX_AHEAD_SECONDS).toBeLessThanOrEqual(15 * 60);
    });

    it('judges the window by the clock of the server when none is given', () => {
      const nowSeconds = Math.floor(Date.now() / 1000);
      const fresh = String(nowSeconds);
      const old = String(nowSeconds - SENDGRID_TIMESTAMP_MAX_AGE_SECONDS - 600);
      const rest = { publicKey: ours.publicKey, rawBody: BODY };

      expect(
        verifySendGridSignature({ ...rest, timestamp: fresh, signature: sign(ours, fresh, BODY) }),
      ).toBe('valid');
      expect(
        verifySendGridSignature({ ...rest, timestamp: old, signature: sign(ours, old, BODY) }),
      ).toBe('timestamp_out_of_window');
    });
  });

  describe('the order of the verdicts', () => {
    it('says the signature is wrong before it says the timestamp is out of the window', () => {
      const old = String(NOW_S - SENDGRID_TIMESTAMP_MAX_AGE_SECONDS - 10_000);

      expect(check({ timestamp: old, signature: sign(another, old, BODY) })).toBe(
        'signature_invalid',
      );
    });

    it('says the timestamp is not a number before it looks at the signature', () => {
      expect(check({ timestamp: 'abc', signature: 'garbage' })).toBe('timestamp_invalid');
    });
  });
});
