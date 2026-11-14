import { describe, expect, it } from '@jest/globals';

import { captchaProvider } from '@providers/captcha/index.js';

import { rejectedBy } from '../../helpers/errors.js';
import { captchaHarness } from '../../helpers/providers.js';

// The contract of a captcha: what the forms count on, whoever checks the answer of the widget
// (src/providers/captcha/types.ts). The captcha of the server goes through these tests, made to
// answer by its entry in tests/helpers/providers.ts (its mock, or the real service with its dummy
// secrets when the run takes it); another captcha passes them without tests of its own.

const harness = captchaHarness[captchaProvider.name];
const log = { warn: () => undefined };

const verify = (token: unknown, ip: string | undefined = '203.0.113.7') =>
  captchaProvider.verify({ token, ip, log });

describe(`the captcha ${captchaProvider.name}`, () => {
  it('takes an answer of its widget, with the address of the visitor', async () => {
    const ips = harness.watchIps();

    await expect(verify(harness.token)).resolves.toBeUndefined();
    expect(ips()).toEqual(['203.0.113.7']);
  });

  it.each([[''], ['   '], [undefined], [42]])(
    'refuses no answer (%j) as CAPTCHA_INVALID without asking',
    async (token) => {
      const ips = harness.watchIps();

      expect(await rejectedBy(() => verify(token))).toMatchObject({
        statusCode: 400,
        errorCode: 'CAPTCHA_INVALID',
      });
      expect(ips()).toEqual([]);
    },
  );

  it('refuses an answer it does not take, or one used before, as CAPTCHA_INVALID', async () => {
    harness.refuse();
    const wrong = await rejectedBy(() => verify(harness.token));
    harness.spend();
    const spent = await rejectedBy(() => verify(harness.token));

    expect(wrong).toMatchObject({ statusCode: 400, errorCode: 'CAPTCHA_INVALID' });
    expect(spent).toMatchObject({ statusCode: 400, errorCode: 'CAPTCHA_INVALID' });
  });

  it('lets nothing through when it cannot say: CAPTCHA_UNAVAILABLE', async () => {
    harness.breakDown();

    expect(await rejectedBy(() => verify(harness.token))).toMatchObject({
      statusCode: 503,
      errorCode: 'CAPTCHA_UNAVAILABLE',
    });
  });

  it('tells a secret of the shop it does not know as its own fault, not the visitor', async () => {
    harness.wrongSecret();

    expect(await rejectedBy(() => verify(harness.token))).toMatchObject({
      statusCode: 503,
      errorCode: 'CAPTCHA_UNAVAILABLE',
    });
  });

  it('names the longest answer of its widget', () => {
    expect(captchaProvider.tokenMaxLength).toBeGreaterThan(0);
  });
});
