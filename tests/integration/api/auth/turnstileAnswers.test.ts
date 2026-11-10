import { describe, expect, it } from '@jest/globals';

import {
  CAPTCHA_TOKEN,
  realTurnstile,
  siteverifyMock,
  TURNSTILE_SITEVERIFY,
} from '../../../helpers/turnstile.js';
import { TURNSTILE_TEST_SECRETS } from '../../../setup/isolateEnv.js';

// The answers of Cloudflare siteverify the app and the tests rely on, for the dummy secrets Cloudflare
// publishes (taken from the real service on 08.11.2026). It runs in both modes, so the mock
// (tests/helpers/turnstile.ts) answers what the real service answers; a change at Cloudflare shows
// here first. Run it for real with: npm test -- api:auth service:turnstile (no account, no secret)

const { pass, fail, spent } = TURNSTILE_TEST_SECRETS;

type Answer = { status: number; body: Record<string, unknown> };

// one request, through the fetch the tests put in place: the mock, or the real service
async function siteverify(secret: string, response: string, remoteip?: string): Promise<Answer> {
  const form = new URLSearchParams({ secret, response });
  if (remoteip) form.set('remoteip', remoteip);

  const res = await fetch(TURNSTILE_SITEVERIFY, { method: 'POST', body: form });

  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

// the time of the check is the clock of whoever answers: near ours
const MINUTE = 60_000;
const withoutTime = ({ status, body }: Answer): Answer => {
  const { challenge_ts: time, ...rest } = body;
  if (time !== undefined) {
    expect(Math.abs(Date.parse(String(time)) - Date.now())).toBeLessThan(2 * MINUTE);
  }
  return { status, body: rest };
};

const failure = (code: string, testing = true) => ({
  status: 200,
  body: {
    'error-codes': [code],
    success: false,
    messages: [],
    ...(testing ? { metadata: { result_with_testing_key: true } } : {}),
  },
});

describe(`siteverify (${realTurnstile ? 'the real service' : 'the mock'})`, () => {
  describe('the dummy secret that passes', () => {
    it.each([
      ['the answer of a dummy widget', CAPTCHA_TOKEN],
      ['any other text', 'any-non-empty-answer'],
      ['an answer of 2048 characters', 'x'.repeat(2048)],
    ])('passes %s', async (_case, response) => {
      expect(withoutTime(await siteverify(pass, response))).toEqual({
        status: 200,
        body: {
          'error-codes': [],
          hostname: 'example.com',
          metadata: { result_with_testing_key: true },
          success: true,
        },
      });
    });

    it('passes with the address of the visitor too', async () => {
      const answer = await siteverify(pass, CAPTCHA_TOKEN, '203.0.113.7');

      expect(answer.status).toBe(200);
      expect(answer.body.success).toBe(true);
    });

    it('says the time of the check', async () => {
      const answer = await siteverify(pass, CAPTCHA_TOKEN);

      expect(typeof answer.body.challenge_ts).toBe('string');
      withoutTime(answer);
    });

    it('asks for an answer: an empty one is missing-input-response', async () => {
      expect(await siteverify(pass, '')).toEqual(failure('missing-input-response', false));
    });
  });

  describe('the other dummy secrets', () => {
    it('fails every answer with invalid-input-response', async () => {
      expect(await siteverify(fail, CAPTCHA_TOKEN)).toEqual(failure('invalid-input-response'));
    });

    it('says a spent answer is timeout-or-duplicate', async () => {
      expect(await siteverify(spent, CAPTCHA_TOKEN)).toEqual(failure('timeout-or-duplicate'));
    });

    it.each([
      ['fails', fail],
      ['spends', spent],
    ])('still asks for an answer when the secret %s every answer', async (_case, secret) => {
      expect(await siteverify(secret, '')).toEqual(failure('missing-input-response', false));
    });
  });

  // 400 and not 200: Cloudflare takes the secret for a fault of the request, the app takes it for a
  // fault of its own (503), not of the visitor
  describe('a secret it does not take', () => {
    // the answer is looked at first: no answer is missing-input-response whatever the secret
    it('asks for the answer first: no answer is missing-input-response also for an unknown secret', async () => {
      expect(await siteverify('a-secret-cloudflare-does-not-know', '')).toEqual(
        failure('missing-input-response', false),
      );
    });

    it('says invalid-input-secret to a secret it does not know', async () => {
      expect(await siteverify('a-secret-cloudflare-does-not-know', CAPTCHA_TOKEN)).toEqual({
        status: 400,
        body: { 'error-codes': ['invalid-input-secret'], success: false, messages: [] },
      });
    });

    it('says missing-input-secret to no secret at all', async () => {
      expect(await siteverify('', CAPTCHA_TOKEN)).toEqual({
        status: 400,
        body: { 'error-codes': ['missing-input-secret'], success: false, messages: [] },
      });
    });
  });
});

// the mock and the real service side by side, over every pair of secret and answer the mock knows;
// only for real: with the mock in place it would compare the mock with itself
const realOnly = realTurnstile ? describe : describe.skip;

realOnly('the mock of siteverify against the real service', () => {
  const SECRETS = [
    { secretName: 'no secret', secret: '' },
    { secretName: 'an unknown secret', secret: 'a-secret-cloudflare-does-not-know' },
    { secretName: 'the secret that passes', secret: pass },
    { secretName: 'the secret that fails', secret: fail },
    { secretName: 'the secret that spends', secret: spent },
  ];
  const RESPONSES = [
    { responseName: 'no answer', response: '' },
    { responseName: 'the dummy answer', response: CAPTCHA_TOKEN },
    { responseName: 'any other text', response: 'any other text' },
    { responseName: 'an answer of 3000 characters', response: 'x'.repeat(3000) },
  ];

  it.each(SECRETS.flatMap((secret) => RESPONSES.map((response) => ({ ...secret, ...response }))))(
    'answers the same to $secretName with $responseName',
    async ({ secret, response }) => {
      const real = withoutTime(await siteverify(secret, response));
      const mock = withoutTime(siteverifyMock(secret, response));

      expect(mock).toEqual(real);
    },
  );
});
