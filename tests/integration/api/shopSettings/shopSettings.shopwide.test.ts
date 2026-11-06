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

// PUT /api/root/shop-settings, PUT /api/root/shop-settings/:key and GET
// /api/root/shop-settings/history: root sets every setting or one, a row for each that changes,
// nobody else may; the history lists the rows. POST and DELETE /api/root/shop-settings/logo: the
// logo on its own, a row of its key; PUT leaves it as it is.
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

// the values root sets with PUT: every current one but the logo
const writableValues = async () => {
  const { logoUrl: _logoUrl, ...rest } = await currentValues();
  return rest;
};

const rowCount = () => asAdmin((tx) => tx.shopSetting.count());

const history = async (query = '') =>
  app.inject({
    method: 'GET',
    url: `/api/root/shop-settings/history${query}`,
    headers: { cookie: accessCookie(root) },
  });

const put = (actor: TestUser, body: object) =>
  app.inject({
    method: 'PUT',
    url: '/api/root/shop-settings',
    headers: withCsrf(csrf, accessCookie(actor)),
    payload: body,
  });

const putOne = (actor: TestUser, key: string, body: object) =>
  app.inject({
    method: 'PUT',
    url: `/api/root/shop-settings/${key}`,
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

// the id on Cloudinary of the logo the shop has: the value of the latest row of its key
const currentLogoPublicId = () =>
  asAdmin(async (tx) => {
    const row = await tx.shopSetting.findFirst({
      where: { key: 'logoPublicId' },
      orderBy: { id: 'desc' },
      select: { value: true },
    });
    return (row?.value as string | null | undefined) ?? null;
  });

describe('PUT /api/root/shop-settings', () => {
  it('refuses a signed-in admin', async () => {
    const res = await put(admin, await writableValues());
    expect(res.statusCode).toBe(403);
  });

  it('writes a row for the one setting that changed, and root reads the value right after', async () => {
    const values = await writableValues();
    // the rows hold what this file sees (the baseline of the tests is in its memory only)
    await put(root, values);
    const total = await rowCount();
    const shopName = `Shop ${Date.now()}`;

    const written = await put(root, { ...values, shopName });

    expect(written.statusCode).toBe(200);
    expect(written.json()).toMatchObject({ shopName });
    expect((await currentValues()).shopName).toBe(shopName);
    expect(await rowCount()).toBe(total + 1);

    // this file is the only one allowed to change the data of the whole shop; it leaves the name
    // as it found it, so a mail test elsewhere that names the shop by its default is not fooled by
    // a name this test made up just to prove the write
    expect((await put(root, values)).statusCode).toBe(200);
  });

  it('writes no row when every setting is as it already was', async () => {
    const values = await writableValues();
    await put(root, values);
    const total = await rowCount();

    const res = await put(root, values);

    expect(res.statusCode).toBe(200);
    expect(await rowCount()).toBe(total);
  });

  // the rules the env variables these settings replace were held to at start (a price above zero
  // to the cent, a free-from needs a price, a pickup needs its address and hours, the reservation
  // with the page at most a day, the shop's own language among the ones turned on, each list
  // without repeats, a reply-to that is an address), and the lists of the app (the countries a
  // postal code is known of, the languages with a dictionary). A write that breaks one is refused
  // with a code naming it, and nothing is written. Every row has its details (null for none): a
  // test function with more parameters than its row is taken by jest for one that waits for done()
  it.each<[string, Record<string, unknown>, string, Record<string, unknown> | null]>([
    ['a price of zero', { deliveryFlatPrice: 0 }, 'VALIDATION_ERROR', null],
    ['a price over the most an amount holds', { deliveryFlatPrice: 1e9 }, 'VALIDATION_ERROR', null],
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
      {
        deliveryMethods: ['manual', 'pickup'],
        pickupAddress: '  ',
        pickupHours: 'Mon-Fri 09:00-18:00',
      },
      'PICKUP_DETAILS_REQUIRED',
      { fields: ['pickupAddress'] },
    ],
    [
      'a pickup with no address and no hours',
      { deliveryMethods: ['pickup'], pickupAddress: '', pickupHours: '' },
      'PICKUP_DETAILS_REQUIRED',
      { fields: ['pickupAddress', 'pickupHours'] },
    ],
    // the one format the frontend parses and a mail translates (src/helpers/pickupHours.ts)
    [
      'pickup hours not in their format',
      { deliveryMethods: ['pickup'], pickupAddress: 'Main St 1', pickupHours: 'Пн-Пт 9-18' },
      'PICKUP_HOURS_INVALID',
      null,
    ],
    [
      'pickup hours not in their format while the pickup is off',
      { deliveryMethods: ['manual'], pickupHours: 'weekdays' },
      'PICKUP_HOURS_INVALID',
      null,
    ],
    ['a method named twice', { deliveryMethods: ['manual', 'manual'] }, 'VALIDATION_ERROR', null],
    ['a country named twice', { deliveryCountries: ['UA', 'UA'] }, 'VALIDATION_ERROR', null],
    [
      'a country the app does not know how to take a postal code of',
      { deliveryCountries: ['UA', 'ZZ'] },
      'DELIVERY_COUNTRY_NOT_SUPPORTED',
      { countries: ['ZZ'] },
    ],
    ['a language named twice', { enabledLocales: ['en', 'en'] }, 'VALIDATION_ERROR', null],
    // "xx" is never a real one; the shop's own language stays on, the refusal is for "xx" alone
    [
      'a language with no dictionary',
      { shopLocale: 'en', enabledLocales: ['en', 'xx'] },
      'LOCALE_NOT_SUPPORTED',
      { locales: ['xx'] },
    ],
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
    ['a body without a setting', { shopName: undefined }, 'VALIDATION_ERROR', null],
  ])('refuses %s', async (_case, change, errorCode, details) => {
    const values = await writableValues();
    const total = await rowCount();

    const res = await put(root, { ...values, ...change });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode, ...(details ? { details } : {}) });
    // the refusal wrote nothing
    expect(await rowCount()).toBe(total);
  });
});

describe('PUT /api/root/shop-settings/:key', () => {
  it('sets the one setting: a row for it, every other setting as it was', async () => {
    // the rows hold what this file sees (the baseline of the tests is in its memory only)
    await put(root, await writableValues());
    const before = await currentValues();
    const total = await rowCount();
    const shopName = `One ${Date.now()}`;

    const res = await putOne(root, 'shopName', { value: shopName });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ...before, shopName });
    expect(await rowCount()).toBe(total + 1);

    // leaves the name as it found it, for the same reason as the PUT of every setting above
    expect((await putOne(root, 'shopName', { value: before.shopName })).statusCode).toBe(200);
  });

  it('writes no row for a value the setting already has', async () => {
    const { reservationMinutes } = await currentValues();
    const total = await rowCount();

    const res = await putOne(root, 'reservationMinutes', { value: reservationMinutes });

    expect(res.statusCode).toBe(200);
    expect(await rowCount()).toBe(total);
  });

  it('refuses a signed-in admin', async () => {
    const res = await putOne(admin, 'shopName', { value: 'By admin' });
    expect(res.statusCode).toBe(403);
  });

  // the value is held to the shape of its own field, the same as in the PUT of every setting
  it.each([
    ['a key that is no setting', 'shopColor', { value: 'violet' }],
    ['the logo, which has its own routes', 'logoUrl', { value: 'https://x.test/logo.png' }],
    ['a body without a value', 'shopName', {}],
    ['a value out of the shape of its field', 'reservationMinutes', { value: 0 }],
    ['a value of another type', 'reviewCheckEnabled', { value: 'yes' }],
    ['a reply-to that is not an address', 'emailReplyTo', { value: 'support' }],
    ['a list naming one value twice', 'enabledLocales', { value: ['en', 'en'] }],
  ])('refuses %s (VALIDATION_ERROR)', async (_case, key, body) => {
    const total = await rowCount();

    const res = await putOne(root, key, body);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
    expect(await rowCount()).toBe(total);
  });

  // the rules between settings run on the values with this one changed: a reservation that,
  // with the page minutes the shop has, lasts over a day
  it('refuses a value that breaks a rule together with the settings the shop has', async () => {
    const { stripePageMinutes } = await currentValues();
    const total = await rowCount();

    const res = await putOne(root, 'reservationMinutes', { value: 1441 - stripePageMinutes });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      errorCode: 'RESERVATION_MINUTES_TOO_LONG',
      details: { max: 1440 },
    });
    expect(await rowCount()).toBe(total);
  });
});

describe('GET /api/root/shop-settings/history', () => {
  it('lists the rows the latest first, each with its value and who set it', async () => {
    const { emailFromName } = await currentValues();
    const sender = `From ${Date.now()}`;
    await putOne(root, 'emailFromName', { value: sender });
    await putOne(root, 'emailFromName', { value: emailFromName });

    const res = await history('?limit=2');

    expect(res.statusCode).toBe(200);
    expect(res.json().items).toEqual([
      expect.objectContaining({
        key: 'emailFromName',
        value: emailFromName,
        setBy: expect.objectContaining({ id: root.id, email: root.email }),
      }),
      expect.objectContaining({ key: 'emailFromName', value: sender }),
    ]);
    expect(res.json().nextCursor).toEqual(expect.any(String));
  });

  it('lists the rows of one setting', async () => {
    const res = await history('?key=reservationMinutes&limit=100');

    expect(res.statusCode).toBe(200);
    const keys = res.json().items.map((item: { key: string }) => item.key);
    expect(keys.length).toBeGreaterThan(0);
    expect(new Set(keys)).toEqual(new Set(['reservationMinutes']));
  });

  // the id of the logo on Cloudinary is internal, no answer sends it out
  it('refuses a key that is no setting of the history', async () => {
    expect((await history('?key=logoPublicId')).statusCode).toBe(400);
    expect((await history('?key=shopColor')).statusCode).toBe(400);
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

    // the history names the logo by its address, never by its internal id on Cloudinary
    const items = (await history('?limit=5')).json().items as { key: string; value: unknown }[];
    expect(items).toContainEqual(expect.objectContaining({ key: 'logoUrl', value: logoUrl }));
    expect(items.map((item) => item.key)).not.toContain('logoPublicId');
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
