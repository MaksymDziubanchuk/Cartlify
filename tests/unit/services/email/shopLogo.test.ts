import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { stubFetch } from '../../../helpers/fetchStub.js';
import { importWithEnv } from '../../../helpers/freshImport.js';
import { pngImage } from '../../../helpers/cloudinary.js';

// the logo of the shop as an inline attachment of a mail: fetched from Cloudinary (logoUrl,
// @config/shopSettings.js) and kept in memory until the url changes; null while the shop has
// none, or when the fetch fails, so a mail still goes out without it (its callers only log it)

type Module = typeof import('@services/email/shopLogo.js');

const SPECIFIER = '@services/email/shopLogo.js';
const URL_A = 'https://res.cloudinary.com/cartlify-test/image/upload/v1/test/shop/logo/a.png';
const URL_B = 'https://res.cloudinary.com/cartlify-test/image/upload/v2/test/shop/logo/b.png';
const PNG = pngImage(5, 3);

const log = () => ({ warn: jest.fn() });

const freshModule = (logoUrl: string | null) =>
  importWithEnv<Module>(SPECIFIER, {}, { shopSettings: { logoUrl } });

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('shopLogoAttachment', () => {
  it('is null while the shop has no logo, and calls nobody', async () => {
    const { shopLogoAttachment } = await freshModule(null);
    const calls = stubFetch(() => new Response(null, { status: 200 }));

    expect(await shopLogoAttachment(log())).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('fetches the logo and gives it back as an inline attachment', async () => {
    const { shopLogoAttachment, SHOP_LOGO_CID } = await freshModule(URL_A);
    const calls = stubFetch(
      () => new Response(new Uint8Array(PNG), { headers: { 'content-type': 'image/png' } }),
    );

    expect(await shopLogoAttachment(log())).toEqual({
      content: PNG.toString('base64'),
      type: 'image/png',
      filename: 'logo.png',
      disposition: 'inline',
      content_id: SHOP_LOGO_CID,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(URL_A);
  });

  it.each([
    ['image/jpeg', 'logo.jpg'],
    ['image/webp', 'logo.webp'],
    ['image/png; charset=binary', 'logo.png'],
  ])('names the file by its content type (%s)', async (contentType, filename) => {
    const { shopLogoAttachment } = await freshModule(URL_A);
    stubFetch(
      () => new Response(new Uint8Array(PNG), { headers: { 'content-type': contentType } }),
    );

    expect(await shopLogoAttachment(log())).toMatchObject({ filename });
  });

  it('fetches the logo only once while the url stays the same', async () => {
    const { shopLogoAttachment } = await freshModule(URL_A);
    const calls = stubFetch(
      () => new Response(new Uint8Array(PNG), { headers: { 'content-type': 'image/png' } }),
    );

    await shopLogoAttachment(log());
    await shopLogoAttachment(log());
    await shopLogoAttachment(log());

    expect(calls).toHaveLength(1);
  });

  it('fetches again when the logo gets a new url', async () => {
    const { shopLogoAttachment } = await freshModule(URL_A);
    // the same copy of @config/shopSettings.js shopLogo.js just read (no resetModules since)
    const { setShopSettingsForTest } = await import('@config/shopSettings.js');
    const calls = stubFetch(
      () => new Response(new Uint8Array(PNG), { headers: { 'content-type': 'image/png' } }),
    );

    await shopLogoAttachment(log());
    setShopSettingsForTest({ logoUrl: URL_B });
    await shopLogoAttachment(log());

    expect(calls.map((call) => call.url)).toEqual([URL_A, URL_B]);
  });

  it('is null and only logs it when Cloudinary answers with a failure', async () => {
    const { shopLogoAttachment } = await freshModule(URL_A);
    stubFetch(() => new Response(null, { status: 404 }));
    const warnLog = log();

    expect(await shopLogoAttachment(warnLog)).toBeNull();
    expect(warnLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({ url: URL_A }),
      'logo of the shop was not fetched for a mail',
    );
  });

  it('is null and only logs it when the fetch itself fails', async () => {
    const { shopLogoAttachment } = await freshModule(URL_A);
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
    const warnLog = log();

    expect(await shopLogoAttachment(warnLog)).toBeNull();
    expect(warnLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({ url: URL_A }),
      'logo of the shop was not fetched for a mail',
    );
  });

  // while Cloudinary is out of reach each mail would wait the whole timeout first: after a failure
  // the next minute goes without the logo at once, then it is fetched again
  it('does not fetch again for a minute after a failure, then does', async () => {
    const { shopLogoAttachment } = await freshModule(URL_A);
    jest.useFakeTimers({ doNotFake: ['queueMicrotask', 'nextTick'] });
    let answer = 503;
    const calls = stubFetch(() =>
      answer === 200
        ? new Response(new Uint8Array(PNG), { headers: { 'content-type': 'image/png' } })
        : new Response(null, { status: answer }),
    );

    expect(await shopLogoAttachment(log())).toBeNull();
    jest.advanceTimersByTime(59_999);
    answer = 200;
    expect(await shopLogoAttachment(log())).toBeNull();
    expect(calls).toHaveLength(1);

    jest.advanceTimersByTime(1);
    expect(await shopLogoAttachment(log())).toMatchObject({ filename: 'logo.png' });
    expect(calls).toHaveLength(2);
  });

  it('gives up after 8 seconds without an answer, and is null', async () => {
    const { shopLogoAttachment } = await freshModule(URL_A);
    jest.useFakeTimers();
    jest.spyOn(globalThis, 'fetch').mockImplementation(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          (init as RequestInit)?.signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })),
          );
        }),
    );

    let settled = false;
    const fetching = shopLogoAttachment(log()).finally(() => {
      settled = true;
    });

    await jest.advanceTimersByTimeAsync(7_999);
    expect(settled).toBe(false);

    await jest.advanceTimersByTimeAsync(1);
    expect(await fetching).toBeNull();
  });

  it('leaves no timer behind after an answer', async () => {
    const { shopLogoAttachment } = await freshModule(URL_A);
    jest.useFakeTimers();
    stubFetch(
      () => new Response(new Uint8Array(PNG), { headers: { 'content-type': 'image/png' } }),
    );

    await shopLogoAttachment(log());

    expect(jest.getTimerCount()).toBe(0);
  });

  it('is the picture the html of a mail names', async () => {
    const { SHOP_LOGO_CID } = await freshModule(null);
    expect(SHOP_LOGO_CID).toBe('cartlify-logo');
  });
});
