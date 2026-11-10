import { afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';

import { stubFetch, textResponse } from '../../../helpers/fetchStub.js';
import { importWithEnv } from '../../../helpers/freshImport.js';

type Module = typeof import('@services/email/clearSpamReport.js');

const SPECIFIER = '@services/email/clearSpamReport.js';

// the account of the newsletters holds the list of complaints; the key of the orders is another one
const CONFIG = {
  SENDGRID_API_KEY: 'SG.key-of-the-orders',
  SENDGRID_NEWSLETTER_API_KEY: 'SG.key-of-the-newsletters',
};

const ADDRESS = 'Anna.Person@Cartlify.test';

let clearer: Module;

beforeAll(async () => {
  clearer = await importWithEnv<Module>(SPECIFIER, CONFIG);
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const logger = () => {
  const warn = jest.fn<(obj: unknown, msg?: string) => void>();
  return { warn, log: { warn } };
};

describe('clearSpamReport', () => {
  it('deletes the address from the list of complaints of the newsletter account, with its key', async () => {
    const calls = stubFetch(() => new Response(null, { status: 204 }));
    const { log } = logger();

    expect(await clearer.clearSpamReport(ADDRESS, log)).toBe(true);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: 'https://api.sendgrid.com/v3/suppression/spam_reports/anna.person%40cartlify.test',
      method: 'DELETE',
      headers: { authorization: `Bearer ${CONFIG.SENDGRID_NEWSLETTER_API_KEY}` },
    });
  });

  it('never uses the key of the orders', async () => {
    const calls = stubFetch(() => new Response(null, { status: 204 }));

    await clearer.clearSpamReport(ADDRESS, logger().log);

    expect(JSON.stringify(calls[0]!.headers)).not.toContain(CONFIG.SENDGRID_API_KEY);
  });

  // the mails go to the address as the database writes it: lower case, no spaces around
  it('asks for the address as it was mailed to, lower case and trimmed', async () => {
    const calls = stubFetch(() => new Response(null, { status: 204 }));

    await clearer.clearSpamReport('  ANNA@Cartlify.TEST ', logger().log);

    expect(calls[0]!.url).toBe(
      'https://api.sendgrid.com/v3/suppression/spam_reports/anna%40cartlify.test',
    );
  });

  // the address is a segment of the path and nothing more
  it.each([
    ['a+news@cartlify.test', 'a%2Bnews%40cartlify.test'],
    ['a/b@cartlify.test', 'a%2Fb%40cartlify.test'],
    ['a?b=1@cartlify.test', 'a%3Fb%3D1%40cartlify.test'],
    ['a#b@cartlify.test', 'a%23b%40cartlify.test'],
    ['a%2e%2e@cartlify.test', 'a%252e%252e%40cartlify.test'],
  ])('puts %j into the path as one encoded segment', async (address, encoded) => {
    const calls = stubFetch(() => new Response(null, { status: 204 }));

    await clearer.clearSpamReport(address, logger().log);

    expect(calls[0]!.url).toBe(`https://api.sendgrid.com/v3/suppression/spam_reports/${encoded}`);
  });

  it('follows no redirect, the request holds the key', async () => {
    const calls = stubFetch(() => new Response(null, { status: 204 }));

    await clearer.clearSpamReport(ADDRESS, logger().log);

    expect(calls[0]!.redirect).toBe('error');
  });

  it.each([
    [204, 'removed'],
    [200, 'answered 200'],
    // not on the list: the address is clear all the same
    [404, 'was not on the list'],
  ])('counts %s (%s) as cleared and logs nothing', async (status) => {
    stubFetch(() => new Response(status === 204 ? null : '{}', { status }));
    const { warn, log } = logger();

    expect(await clearer.clearSpamReport(ADDRESS, log)).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  describe('when it does not work', () => {
    // a complaint that stays on the list only keeps the address from the mail: the person is not
    // refused, the warning tells the maintainer
    it.each([401, 403, 429, 500, 503])(
      'answers false for %s, warns once and does not throw',
      async (status) => {
        stubFetch(() => textResponse('{"errors":[{"message":"nope"}]}', status));
        const { warn, log } = logger();

        expect(await clearer.clearSpamReport(ADDRESS, log)).toBe(false);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0]![0]).toMatchObject({ status });
      },
    );

    it('answers false for a network failure, warns and does not throw', async () => {
      jest.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
      const { warn, log } = logger();

      expect(await clearer.clearSpamReport(ADDRESS, log)).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toMatchObject({ reason: 'REQUEST_FAILED' });
    });

    it('gives up after 7 seconds without an answer', async () => {
      jest.useFakeTimers();
      jest.spyOn(globalThis, 'fetch').mockImplementation(
        (_input, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(
                Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }),
              ),
            );
          }),
      );
      const { warn, log } = logger();

      let settled = false;
      const clearing = clearer.clearSpamReport(ADDRESS, log).finally(() => {
        settled = true;
      });

      await jest.advanceTimersByTimeAsync(6999);
      expect(settled).toBe(false);

      await jest.advanceTimersByTimeAsync(1);
      expect(await clearing).toBe(false);
      expect(warn.mock.calls[0]![0]).toMatchObject({ reason: 'TIMEOUT' });
    });

    it('leaves no timer behind', async () => {
      jest.useFakeTimers();
      stubFetch(() => new Response(null, { status: 204 }));

      await clearer.clearSpamReport(ADDRESS, logger().log);

      expect(jest.getTimerCount()).toBe(0);
    });

    it('calls nobody and warns when the newsletter key is not set', async () => {
      const unconfigured = await importWithEnv<Module>(SPECIFIER, {
        ...CONFIG,
        SENDGRID_NEWSLETTER_API_KEY: '',
      });
      const calls = stubFetch(() => new Response(null, { status: 204 }));
      const { warn, log } = logger();

      expect(await unconfigured.clearSpamReport(ADDRESS, log)).toBe(false);
      expect(calls).toHaveLength(0);
      expect(warn).toHaveBeenCalledTimes(1);
    });

    // the warnings are in the logs of the host: neither the key nor the address of a person, nor
    // the address of the request, which holds it
    it.each([
      ['a refusal', () => textResponse(`{"errors":[{"message":"${ADDRESS} is no good"}]}`, 403)],
      ['a failure of SendGrid', () => textResponse('SG.key-of-the-newsletters', 500)],
    ])('logs neither the key nor the address after %s', async (_case, answer) => {
      stubFetch(answer);
      const { warn, log } = logger();

      await clearer.clearSpamReport(ADDRESS, log);

      const logged = JSON.stringify(warn.mock.calls).toLowerCase();
      expect(logged).not.toContain('anna');
      expect(logged).not.toContain('cartlify.test');
      expect(logged).not.toContain('key-of-the-newsletters');
      expect(logged).not.toContain('spam_reports/');
    });

    it('logs neither the key nor the address when the request fails', async () => {
      const failure = new TypeError(
        'fetch failed for anna.person@cartlify.test with SG.key-of-the-newsletters',
      );
      jest.spyOn(globalThis, 'fetch').mockRejectedValue(failure);
      const { warn, log } = logger();

      await clearer.clearSpamReport(ADDRESS, log);

      const logged = JSON.stringify(warn.mock.calls).toLowerCase();
      expect(logged).not.toContain('anna');
      expect(logged).not.toContain('key-of-the-newsletters');
    });
  });
});
