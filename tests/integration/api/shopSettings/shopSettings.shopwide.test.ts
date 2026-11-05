import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import {
  brokenPng,
  gifImage,
  imageField,
  moveCallsSince,
  movesSince,
  pngImage,
  removeUploads,
  storedImage,
  uploadMark,
  waitingUploadsSince,
  withSilentCloudinaryMoves,
} from '../../../helpers/cloudinary.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { asAdmin } from '../../../helpers/db.js';
import { closeSessions, createUser, type TestUser } from '../../../helpers/factories.js';
import { multipartBody, type FormPart } from '../../../helpers/multipart.js';
import { takeLogs } from '../../../helpers/logs.js';

// PUT /api/root/shop-settings and GET /api/root/shop-settings/history: root writes a new version
// (every field named, not a partial change), nobody else may, a stale baseVersion is refused and
// the version root saw is still the current one. POST and DELETE /api/root/shop-settings/logo: the
// logo on its own, carried forward by PUT and by the other one of this pair.
// *.shopwide.test.ts: the table is one for every test file running next to it, this file runs
// alone while it runs (tests/setup/integration.shopState.ts)

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
let root: TestUser;

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await createUser({ role: 'ADMIN' });
  root = await createUser({ role: 'ROOT' });
});

afterAll(async () => {
  try {
    await removeUploads();
    await closeSessions([admin.id, root.id]);
  } finally {
    await stopApp();
  }
});

const currentValues = async () =>
  (
    await app.inject({
      method: 'GET',
      url: '/api/admin/shop-settings',
      headers: { cookie: accessCookie(root) },
    })
  ).json();

const currentVersion = async () => {
  const history = (
    await app.inject({
      method: 'GET',
      url: '/api/root/shop-settings/history?limit=1',
      headers: { cookie: accessCookie(root) },
    })
  ).json();
  return history.items[0]?.version ?? 0;
};

const put = (actor: TestUser, body: object) =>
  app.inject({
    method: 'PUT',
    url: '/api/root/shop-settings',
    headers: withCsrf(csrf, accessCookie(actor)),
    payload: body,
  });

const image = (data: Buffer, opts: Parameters<typeof imageField>[2] = {}) =>
  imageField('image', data, { filename: 'logo.png', ...opts });

const postLogo = (parts: FormPart[], actor: TestUser | null = root) => {
  const { payload, headers } = multipartBody(parts);
  return app.inject({
    method: 'POST',
    url: '/api/root/shop-settings/logo',
    headers: { ...(actor ? withCsrf(csrf, accessCookie(actor)) : withCsrf(csrf)), ...headers },
    payload,
  });
};

const deleteLogo = (actor: TestUser | null = root) =>
  app.inject({
    method: 'DELETE',
    url: '/api/root/shop-settings/logo',
    headers: actor ? withCsrf(csrf, accessCookie(actor)) : withCsrf(csrf),
  });

const currentLogoPublicId = () =>
  asAdmin(async (tx) => {
    const row = await tx.shopSetting.findFirst({
      orderBy: { version: 'desc' },
      select: { logoPublicId: true },
    });
    return row?.logoPublicId ?? null;
  });

describe('PUT /api/root/shop-settings', () => {
  it('refuses a signed-in admin', async () => {
    const baseVersion = await currentVersion();
    const values = await currentValues();
    const { logoUrl: _logoUrl, deliveryCountries, ...rest } = values;

    const res = await put(admin, { baseVersion, deliveryCountries, ...rest });
    expect(res.statusCode).toBe(403);
  });

  it('writes a new version root can read right after, and refuses a stale baseVersion', async () => {
    const baseVersion = await currentVersion();
    const values = await currentValues();
    const { logoUrl: _logoUrl, ...rest } = values;

    const shopName = `Shop ${Date.now()}`;
    const written = await put(root, { baseVersion, ...rest, shopName });
    expect(written.statusCode).toBe(200);
    expect(written.json()).toMatchObject({ shopName });

    const after = await currentValues();
    expect(after.shopName).toBe(shopName);

    const stale = await put(root, { baseVersion, ...rest, shopName: 'stale write' });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().errorCode).toBe('SHOP_SETTINGS_OUTDATED');

    // the stale write changed nothing
    expect((await currentValues()).shopName).toBe(shopName);

    // this file is the only one allowed to change the data of the whole shop; it leaves the name
    // as it found it, so a mail test elsewhere that names the shop by its default is not fooled by
    // a name this test made up just to prove the write
    await put(root, { baseVersion: await currentVersion(), ...rest, shopName: values.shopName });
  });

  it('refuses a country the app does not know how to take a postal code of', async () => {
    const baseVersion = await currentVersion();
    const values = await currentValues();
    const { logoUrl: _logoUrl, ...rest } = values;

    const res = await put(root, { baseVersion, ...rest, deliveryCountries: ['UA', 'ZZ'] });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      errorCode: 'DELIVERY_COUNTRY_NOT_SUPPORTED',
      details: { countries: ['ZZ'] },
    });

    // the refusal wrote no version
    expect(await currentVersion()).toBe(baseVersion);
  });

  // a language with no dictionary (src/locales) cannot be enabled; "xx" is never a real one
  it('refuses a language of enabledLocales with no dictionary', async () => {
    const baseVersion = await currentVersion();
    const values = await currentValues();
    const { logoUrl: _logoUrl, ...rest } = values;

    // the shop's own language stays on, the refusal is for "xx" alone
    const res = await put(root, {
      baseVersion,
      ...rest,
      enabledLocales: [values.shopLocale, 'xx'],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      errorCode: 'LOCALE_NOT_SUPPORTED',
      details: { locales: ['xx'] },
    });
    expect(res.json().details.supported).toContain('en');

    // the refusal wrote no version
    expect(await currentVersion()).toBe(baseVersion);
  });

  // the rules the env variables these fields replace were held to at start (a price above zero to
  // the cent, a free-from needs a price, a pickup needs its address and hours, the reservation
  // with the page at most a day, the shop's own language among the ones turned on, each list
  // without repeats, a reply-to that is an address). A version that breaks one is refused with a
  // code naming it, and nothing is written; the database keeps the same rules (db/06,
  // shop_settings_*_chk), but its refusal reached root as a 500, and an empty text passed it.
  // Every row has its details (null for none): a test function with more parameters than its row
  // is taken by jest for one that waits for done()
  it.each<[string, Record<string, unknown>, string, Record<string, unknown> | null]>([
    ['a price of zero', { deliveryFlatPrice: 0 }, 'VALIDATION_ERROR', null],
    [
      'a price over the most the column holds',
      { deliveryFlatPrice: 1e9 },
      'VALIDATION_ERROR',
      null,
    ],
    ['a price below the cent', { deliveryFlatPrice: 4.995 }, 'VALIDATION_ERROR', null],
    [
      'a free-from below the cent',
      { deliveryFlatPrice: 5, deliveryFreeFrom: 100.001 },
      'VALIDATION_ERROR',
      null,
    ],
    [
      'a free-from with no price',
      { deliveryFlatPrice: null, deliveryFreeFrom: 100 },
      'DELIVERY_FREE_FROM_WITHOUT_PRICE',
      null,
    ],
    [
      'a pickup with no address',
      { deliveryMethods: ['manual', 'pickup'], pickupAddress: '  ', pickupHours: 'Mon-Fri 9-18' },
      'PICKUP_DETAILS_REQUIRED',
      { fields: ['pickupAddress'] },
    ],
    [
      'a pickup with no address and no hours',
      { deliveryMethods: ['pickup'], pickupAddress: '', pickupHours: '' },
      'PICKUP_DETAILS_REQUIRED',
      { fields: ['pickupAddress', 'pickupHours'] },
    ],
    ['a method named twice', { deliveryMethods: ['manual', 'manual'] }, 'VALIDATION_ERROR', null],
    ['a country named twice', { deliveryCountries: ['UA', 'UA'] }, 'VALIDATION_ERROR', null],
    ['a language named twice', { enabledLocales: ['en', 'en'] }, 'VALIDATION_ERROR', null],
    [
      'a reservation and a page longer than a day',
      { reservationMinutes: 1411, stripePageMinutes: 30 },
      'RESERVATION_MINUTES_TOO_LONG',
      { max: 1440 },
    ],
    [
      'a language of the shop that is not turned on',
      { shopLocale: 'uk', enabledLocales: ['en'] },
      'SHOP_LOCALE_NOT_ENABLED',
      { shopLocale: 'uk', enabledLocales: ['en'] },
    ],
    ['a reply-to that is not an address', { emailReplyTo: 'support' }, 'VALIDATION_ERROR', null],
    ['an empty reply-to', { emailReplyTo: '' }, 'VALIDATION_ERROR', null],
    ['a seller email that is not an address', { sellerEmail: 'seller' }, 'VALIDATION_ERROR', null],
  ])('refuses %s', async (_case, change, errorCode, details) => {
    const baseVersion = await currentVersion();
    const values = await currentValues();
    const { logoUrl: _logoUrl, ...rest } = values;

    const res = await put(root, { baseVersion, ...rest, ...change });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode, ...(details ? { details } : {}) });

    // the refusal wrote no version
    expect(await currentVersion()).toBe(baseVersion);
  });

  it('carries the logo forward, and the history shows who wrote each version', async () => {
    const beforeVersion = await currentVersion();
    const beforeValues = await currentValues();
    const { logoUrl: logoBefore, ...rest } = beforeValues;

    const written = await put(root, {
      baseVersion: beforeVersion,
      ...rest,
      emailFromName: `From ${Date.now()}`,
    });
    expect(written.statusCode).toBe(200);
    expect(written.json().logoUrl).toBe(logoBefore);

    // leaves emailFromName as it found it, for the same reason as the shopName test above
    await put(root, {
      baseVersion: await currentVersion(),
      ...rest,
      emailFromName: beforeValues.emailFromName,
    });

    const history = await app.inject({
      method: 'GET',
      url: '/api/root/shop-settings/history?limit=5',
      headers: { cookie: accessCookie(root) },
    });
    expect(history.statusCode).toBe(200);
    const items = history.json().items;
    expect(items.length).toBeGreaterThan(0);
    expect(items[0]).toMatchObject({ setBy: { id: root.id, email: root.email } });
    // the versions come down from the newest
    expect(items.map((item: { version: number }) => item.version)).toEqual(
      [...items].map((item: { version: number }) => item.version).sort((a, b) => b - a),
    );
  });
});

describe('POST /api/root/shop-settings/logo and DELETE /api/root/shop-settings/logo', () => {
  it('answers 409 for DELETE while the shop has no logo yet', async () => {
    expect((await currentValues()).logoUrl).toBeNull();

    const res = await deleteLogo();

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ errorCode: 'SHOP_LOGO_NOT_SET' });
  });

  it('puts the logo on the shop, in the folder of the test, and shows it on the public route', async () => {
    const mark = uploadMark();

    const res = await postLogo([image(pngImage(40, 30))]);

    expect(res.statusCode).toBe(200);
    const logoUrl = res.json().logoUrl as string;
    expect(logoUrl).toMatch(/^https:\/\/res\.cloudinary\.com\//);
    expect(logoUrl).toContain('/test/shop/logo/');
    expect(movesSince(mark)).toHaveLength(1);
    expect(await waitingUploadsSince(mark)).toEqual([]);

    const publicId = await currentLogoPublicId();
    expect(publicId).toMatch(/^test\/shop\/logo\/[0-9a-f-]+$/);
    expect(await storedImage(publicId!)).toMatchObject({
      width: 40,
      height: 30,
      format: 'png',
      tags: expect.arrayContaining(['shop-logo']),
    });

    const pub = await app.inject({ method: 'GET', url: '/api/shop-settings' });
    expect(pub.json().logoUrl).toBe(logoUrl);
  });

  it('moves the logo to its new place without dropping cached copies, 8 s at most', async () => {
    const mark = uploadMark();

    const res = await postLogo([image(pngImage(13, 13))]);

    expect(res.statusCode).toBe(200);
    expect(moveCallsSince(mark)).toEqual([
      expect.objectContaining({
        to: expect.stringMatching(/^test\/shop\/logo\/[0-9a-f-]{36}$/),
        options: expect.objectContaining({ invalidate: false, timeout: 8_000 }),
      }),
    ]);
  });

  // Cloudinary takes the move and never answers: the move gives up after its 8 s, and the shop
  // keeps the logo it had
  it('keeps the logo of the shop when Cloudinary does not answer the move in 8 s', async () => {
    await postLogo([image(pngImage(10, 10))]);
    const before = await currentValues();
    const beforePublicId = await currentLogoPublicId();
    const mark = uploadMark();
    const startedAt = Date.now();

    const res = await withSilentCloudinaryMoves(() => postLogo([image(pngImage(14, 14))]));
    const took = Date.now() - startedAt;

    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ errorCode: 'IMAGE_STORAGE_UNAVAILABLE' });
    expect(took).toBeGreaterThanOrEqual(8_000);
    expect(took).toBeLessThan(20_000);
    expect((await currentValues()).logoUrl).toBe(before.logoUrl);
    expect(await currentLogoPublicId()).toBe(beforePublicId);
    expect(await storedImage(beforePublicId!)).not.toBeNull();
    expect(await waitingUploadsSince(mark)).toEqual([]);
    expect(
      takeLogs({ msg: 'request failed', errorCode: 'IMAGE_STORAGE_UNAVAILABLE' }),
    ).toHaveLength(1);
  });

  it('replaces the logo the shop has and deletes the old file', async () => {
    await postLogo([image(pngImage(10, 10))]);
    const first = await currentLogoPublicId();

    const res = await postLogo([image(pngImage(24, 12))]);

    expect(res.statusCode).toBe(200);
    const second = await currentLogoPublicId();
    expect(second).not.toBe(first);
    expect(await currentValues()).toMatchObject({ logoUrl: res.json().logoUrl });
    expect(await storedImage(first!)).toBeNull();
    expect(await storedImage(second!)).toMatchObject({ width: 24, height: 12 });
  });

  it.each([
    ['a form with no file', (): FormPart[] => [{ name: 'note', value: 'x' }], 'SHOP_LOGO_REQUIRED'],
    [
      'a file under another name',
      (): FormPart[] => [imageField('picture', pngImage(10, 10))],
      'SHOP_LOGO_REQUIRED',
    ],
    [
      'an empty file',
      (): FormPart[] => [imageField('image', Buffer.alloc(0))],
      'SHOP_LOGO_STREAM_ERROR',
    ],
  ])('refuses %s', async (_case, parts, errorCode) => {
    const before = await currentValues();

    const res = await postLogo(parts());

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode });
    expect((await currentValues()).logoUrl).toBe(before.logoUrl);
  });

  it('refuses two logos, keeps the one the shop has and leaves nothing waiting', async () => {
    const before = await currentValues();
    const mark = uploadMark();

    const res = await postLogo([image(pngImage(11, 11)), image(pngImage(12, 12))]);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'SHOP_LOGO_MULTIPLE' });
    expect(await currentValues()).toMatchObject({ logoUrl: before.logoUrl });
    expect(movesSince(mark)).toEqual([]);
    expect(await waitingUploadsSince(mark)).toEqual([]);
  });

  it('refuses a file that is not a jpeg, png or webp, and a png that cannot be read', async () => {
    const gif = await postLogo([
      image(gifImage(), { contentType: 'image/gif', filename: 'a.gif' }),
    ]);
    const broken = await postLogo([image(brokenPng())]);

    expect(gif.statusCode).toBe(400);
    expect(gif.json()).toMatchObject({ errorCode: 'IMAGE_TYPE_NOT_ALLOWED' });
    expect(broken.statusCode).toBe(400);
    expect(broken.json()).toMatchObject({ errorCode: 'IMAGE_INVALID' });
  });

  it('refuses a body that is not a form', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/root/shop-settings/logo',
      headers: withCsrf(csrf, accessCookie(root)),
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'MULTIPART_REQUIRED' });
  });

  it('is for root only: an admin and a visitor are refused', async () => {
    const refused = await postLogo([image(pngImage(10, 10))], admin);
    const visitor = await postLogo([image(pngImage(10, 10))], null);

    expect(refused.statusCode).toBe(403);
    expect([401, 403]).toContain(visitor.statusCode);
  });

  it('takes the logo off the shop and deletes its file', async () => {
    await postLogo([image(pngImage(10, 10))]);
    const publicId = await currentLogoPublicId();

    const res = await deleteLogo();

    expect(res.statusCode).toBe(200);
    expect(res.json().logoUrl).toBeNull();
    expect((await currentValues()).logoUrl).toBeNull();
    expect(await storedImage(publicId!)).toBeNull();
    const pub = await app.inject({ method: 'GET', url: '/api/shop-settings' });
    expect(pub.json().logoUrl).toBeNull();
  });

  it('is for root only: an admin is refused', async () => {
    await postLogo([image(pngImage(10, 10))]);

    const res = await deleteLogo(admin);

    expect(res.statusCode).toBe(403);

    await deleteLogo();
  });
});
