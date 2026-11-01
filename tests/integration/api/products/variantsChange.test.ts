import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from '@jest/globals';

import { MAX_VARIANT_IMAGES } from '@config/limits.js';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import {
  closeSessions,
  createProduct,
  createUser,
  createVariant,
  deleteProductFromCatalog,
  type TestProduct,
  type TestUser,
} from '../../../helpers/factories.js';
import { moveClock } from '../../../helpers/payments.js';
import {
  addGalleryImage,
  auditLinesOf,
  galleryIdsOf,
  imagesOfVariant,
  markVariantDeleted,
  priceLinesOf,
  priceRowOf,
  variantRowsOf,
} from '../../../helpers/variants.js';

// PATCH /api/products/:productId/variants changes several variants of a product the same way: the
// price with the word on the sale, the weight and the sizes, the pictures (one list of the gallery
// for every variant). The variants are the ones named, or every variant for sale. All of them or
// none: a refusal names every variant refused. The article number, the barcode and the place are
// one variant's and are not read here. The products of the file stay (a product with a log of
// prices cannot be deleted)

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
let buyer: TestUser;

const DAY = 86_400_000;
const inMs = (ms: number) => new Date(Date.now() + ms).toISOString();

let clock: { restore: () => void } | undefined;

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await createUser({ role: 'ADMIN' });
  buyer = await createUser();
});

afterEach(() => {
  clock?.restore();
  clock = undefined;
});

afterAll(async () => {
  try {
    await closeSessions([admin.id, buyer.id]);
  } finally {
    await stopApp();
  }
});

// a product with three variants at the prices given, the first one the product came with
async function threeVariants(prices: [number, number, number] = [20, 40, 10]) {
  const product: TestProduct = await createProduct({ price: prices[0], stock: 5 });
  const second = await createVariant(product.id, { price: prices[1], stock: 5 });
  const third = await createVariant(product.id, { price: prices[2], stock: 5 });
  return { product, ids: [product.variantId, second.id, third.id] as const };
}

const changeMany = (
  productId: number | string,
  payload: Record<string, unknown>,
  actor: TestUser | null = admin,
) =>
  app.inject({
    method: 'PATCH',
    url: `/api/products/${productId}/variants`,
    headers: withCsrf(csrf, actor ? accessCookie(actor) : ''),
    payload,
  });

const saleRoute = (productId: number, payload: Record<string, unknown>) =>
  app.inject({
    method: 'PATCH',
    url: `/api/products/${productId}/sale`,
    headers: withCsrf(csrf, accessCookie(admin)),
    payload,
  });

const pricesOf = async (ids: readonly number[]) =>
  Promise.all(ids.map(async (id) => (await priceRowOf(id)).price));

const idsOf = (res: { json: () => { variants: Array<{ id: number }> } }) =>
  res.json().variants.map((variant) => variant.id);

describe('PATCH /api/products/:productId/variants', () => {
  it('changes the price of every variant for sale and answers with them in full by their place', async () => {
    const { product, ids } = await threeVariants();

    const res = await changeMany(product.id, { price: 25 });

    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.json())).toEqual(['variants']);
    expect(idsOf(res)).toEqual([...ids]);
    expect(res.json().variants[0]).toMatchObject({
      id: ids[0],
      price: 25,
      sku: null,
      images: [expect.objectContaining({ position: 1 })],
      totalStock: 5,
      visible: true,
    });
    expect(await pricesOf(ids)).toEqual([25, 25, 25]);
  });

  it('writes the lines of a request of many for each variant', async () => {
    const { product, ids } = await threeVariants([20, 40, 10]);

    await changeMany(product.id, { price: 25 });

    expect(await priceLinesOf(ids[1])).toEqual([
      {
        mode: 'fixed',
        oldPrice: 40,
        newPrice: 25,
        value: -15,
        endsAt: null,
        actorId: admin.id,
        event: 'price.set_batch',
        productId: product.id,
      },
    ]);
    expect(await auditLinesOf('variant', ids[2], ['variant.update_batch'])).toEqual([
      {
        actorId: admin.id,
        action: 'OTHER',
        event: 'variant.update_batch',
        meta: [{ field: 'price', old: '10', new: '25' }],
      },
    ]);
    expect(await auditLinesOf('variant', ids[2], ['variant.update'])).toEqual([]);
  });

  it('leaves out a variant that already has the price', async () => {
    const { product, ids } = await threeVariants([25, 40, 10]);

    const res = await changeMany(product.id, { price: 25 });

    expect(res.statusCode).toBe(200);
    expect(idsOf(res)).toEqual([...ids]);
    expect(await priceLinesOf(ids[0])).toEqual([]);
    expect(await priceLinesOf(ids[1])).toHaveLength(1);
  });

  it('leaves out the variants taken out of sale when none is named', async () => {
    const { product, ids } = await threeVariants();
    await markVariantDeleted(ids[1]);

    const res = await changeMany(product.id, { price: 25 });

    expect(idsOf(res)).toEqual([ids[0], ids[2]]);
    expect(await pricesOf(ids)).toEqual([25, 40, 25]);
  });

  it('changes only the variants named and answers in their order', async () => {
    const { product, ids } = await threeVariants();

    const res = await changeMany(product.id, { variantIds: [ids[2], ids[0]], price: 25 });

    expect(res.statusCode).toBe(200);
    expect(idsOf(res)).toEqual([ids[2], ids[0]]);
    expect(await pricesOf(ids)).toEqual([25, 40, 25]);
  });

  it('changes a variant taken out of sale when it is named', async () => {
    const { product, ids } = await threeVariants();
    await markVariantDeleted(ids[1]);

    const res = await changeMany(product.id, { variantIds: [ids[1]], price: 25 });

    expect(res.statusCode).toBe(200);
    expect(res.json().variants[0]).toMatchObject({ id: ids[1], price: 25, visible: false });
  });

  it('changes the weight and the sizes of the variants', async () => {
    const { product, ids } = await threeVariants();

    const res = await changeMany(product.id, {
      weightGrams: 400,
      lengthMm: 100,
      widthMm: 50,
      heightMm: 20,
    });

    expect(res.statusCode).toBe(200);
    for (const variant of res.json().variants) {
      expect(variant).toMatchObject({ weightGrams: 400, lengthMm: 100, widthMm: 50, heightMm: 20 });
    }
    expect((await variantRowsOf(product.id)).map((row) => row.weightGrams)).toEqual([
      400, 400, 400,
    ]);
    expect(await auditLinesOf('variant', ids[0], ['variant.update_batch'])).toEqual([
      expect.objectContaining({
        meta: [
          { field: 'weightGrams', old: null, new: 400 },
          { field: 'lengthMm', old: null, new: 100 },
          { field: 'widthMm', old: null, new: 50 },
          { field: 'heightMm', old: null, new: 20 },
        ],
      }),
    ]);
  });

  it('writes nothing for a weight a variant has already', async () => {
    const { product, ids } = await threeVariants();
    await changeMany(product.id, { variantIds: [ids[0]], weightGrams: 400 });

    const res = await changeMany(product.id, { weightGrams: 400 });

    expect(res.statusCode).toBe(200);
    // the first variant had it: one line, the others got theirs now
    expect(await auditLinesOf('variant', ids[0], ['variant.update_batch'])).toHaveLength(1);
    expect(await auditLinesOf('variant', ids[1], ['variant.update_batch'])).toHaveLength(1);
  });

  it('clears the weight and the sizes only when the admin says so', async () => {
    const { product, ids } = await threeVariants();
    await changeMany(product.id, { weightGrams: 400, lengthMm: 100, widthMm: 50, heightMm: 20 });

    const refused = await changeMany(product.id, { weightGrams: null });
    const cleared = await changeMany(product.id, {
      weightGrams: null,
      lengthMm: null,
      widthMm: null,
      heightMm: null,
      withoutShippingData: true,
    });

    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({
      errorCode: 'VARIANTS_INVALID',
      details: {
        variants: ids.map((variantId) => ({
          variantId,
          errorCode: 'PRODUCT_SHIPPING_DATA_REQUIRED',
          details: { fields: ['weightGrams'] },
        })),
      },
    });
    expect(cleared.statusCode).toBe(200);
    expect((await variantRowsOf(product.id)).map((row) => row.weightGrams)).toEqual([
      null,
      null,
      null,
    ]);
  });

  describe('with sales on', () => {
    it('names every variant on sale that gets a new price without a word, and changes none', async () => {
      const { product, ids } = await threeVariants();
      await saleRoute(product.id, {
        variantIds: [ids[0], ids[2]],
        sale: { percent: 50, endsAt: inMs(DAY) },
      });

      const res = await changeMany(product.id, { price: 30 });

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({
        errorCode: 'VARIANTS_INVALID',
        details: {
          variants: [
            {
              variantId: ids[0],
              errorCode: 'PRODUCT_SALE_DECISION_REQUIRED',
              details: { salePrice: 10, saleEndsAt: expect.any(String) },
            },
            {
              variantId: ids[2],
              errorCode: 'PRODUCT_SALE_DECISION_REQUIRED',
              details: { salePrice: 5, saleEndsAt: expect.any(String) },
            },
          ],
        },
      });
      expect(await pricesOf(ids)).toEqual([20, 40, 10]);
    });

    it('keeps the sales and changes the prices', async () => {
      const { product, ids } = await threeVariants();
      await saleRoute(product.id, { sale: { percent: 10, endsAt: inMs(DAY) } });

      const res = await changeMany(product.id, { price: 100, sale: 'keep' });

      expect(res.statusCode).toBe(200);
      expect(
        res.json().variants.map((variant: { salePrice: number }) => variant.salePrice),
      ).toEqual([18, 36, 9]);
      expect(await pricesOf(ids)).toEqual([100, 100, 100]);
    });

    it('names the variants a new price goes down to the sale price of, and changes none', async () => {
      const { product, ids } = await threeVariants();
      await saleRoute(product.id, { sale: { percent: 10, endsAt: inMs(DAY) } });

      const res = await changeMany(product.id, { price: 18, sale: 'keep' });

      // the sale prices are 18, 36 and 9: a price of 18 is down to the first two
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({
        errorCode: 'VARIANTS_INVALID',
        details: {
          variants: [
            {
              variantId: ids[0],
              errorCode: 'PRODUCT_SALE_NOT_BELOW_PRICE',
              details: { salePrice: 18, price: 18 },
            },
            {
              variantId: ids[1],
              errorCode: 'PRODUCT_SALE_NOT_BELOW_PRICE',
              details: { salePrice: 36, price: 18 },
            },
          ],
        },
      });
      expect(await pricesOf(ids)).toEqual([20, 40, 10]);
    });

    it('takes the sales off, then changes the prices', async () => {
      const { product, ids } = await threeVariants();
      await saleRoute(product.id, {
        variantIds: [ids[0], ids[1]],
        sale: { percent: 50, endsAt: inMs(DAY) },
      });

      const res = await changeMany(product.id, { price: 30, sale: 'remove' });

      expect(res.statusCode).toBe(200);
      for (const variant of res.json().variants) {
        expect(variant).toMatchObject({ price: 30, salePrice: null, saleEndsAt: null });
      }
      expect(
        (await priceLinesOf(ids[0])).map((line) => [line.event, line.oldPrice, line.newPrice]),
      ).toEqual([
        ['price.sale_start', 20, 10],
        ['price.sale_end', 10, 20],
        ['price.set_batch', 20, 30],
      ]);
      expect((await priceLinesOf(ids[2])).map((line) => line.event)).toEqual(['price.set_batch']);
    });

    it('puts a new sale on every variant from its new price', async () => {
      const { product, ids } = await threeVariants();
      const endsAt = inMs(DAY);

      const res = await changeMany(product.id, { price: 50, sale: { percent: 20, endsAt } });

      expect(res.statusCode).toBe(200);
      for (const variant of res.json().variants) {
        expect(variant).toMatchObject({
          price: 50,
          salePrice: 40,
          saleEndsAt: endsAt,
          salePriorPrice: expect.any(Number),
        });
      }
      expect((await priceLinesOf(ids[1])).map((line) => [line.event, line.newPrice])).toEqual([
        ['price.set_batch', 50],
        ['price.sale_start', 40],
      ]);
    });

    it('names the variants a new sale does not fit and changes none', async () => {
      const { product, ids } = await threeVariants();

      const res = await changeMany(product.id, {
        price: 4,
        sale: { amount: 5, endsAt: inMs(DAY) },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({
        errorCode: 'VARIANTS_INVALID',
        details: {
          variants: ids.map((variantId) => ({
            variantId,
            errorCode: 'PRODUCT_SALE_AMOUNT_TOO_HIGH',
            details: { price: 4 },
          })),
        },
      });
      expect(await pricesOf(ids)).toEqual([20, 40, 10]);
    });

    it('names the variants out of sale a new sale goes on, with the status of the first', async () => {
      const { product, ids } = await threeVariants();
      await markVariantDeleted(ids[1]);

      const res = await changeMany(product.id, {
        variantIds: [ids[0], ids[1]],
        price: 30,
        sale: { percent: 10, endsAt: inMs(DAY) },
      });

      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({
        errorCode: 'VARIANTS_INVALID',
        details: { variants: [{ variantId: ids[1], errorCode: 'VARIANT_NOT_FOUND' }] },
      });
      expect(await pricesOf(ids)).toEqual([20, 40, 10]);
    });

    // the status of the answer is the one of the first variant refused, each variant has its own code
    it.each([
      ['a variant the sale does not fit', 400, (live: number, out: number) => [live, out]],
      ['a variant out of sale', 404, (live: number, out: number) => [out, live]],
    ])('takes the status of the first variant refused: %s', async (_case, status, order) => {
      const { product, ids } = await threeVariants();
      await markVariantDeleted(ids[1]);

      const res = await changeMany(product.id, {
        variantIds: order(ids[0], ids[1]),
        price: 4,
        sale: { amount: 5, endsAt: inMs(DAY) },
      });

      expect(res.statusCode).toBe(status);
      expect(res.json()).toMatchObject({ errorCode: 'VARIANTS_INVALID' });
      expect(
        res.json().details.variants.map((entry: { variantId: number }) => entry.variantId),
      ).toEqual(order(ids[0], ids[1]));
      expect(
        Object.fromEntries(
          res
            .json()
            .details.variants.map((entry: { variantId: number; errorCode: string }) => [
              entry.variantId,
              entry.errorCode,
            ]),
        ),
      ).toEqual({
        [ids[0]]: 'PRODUCT_SALE_AMOUNT_TOO_HIGH',
        [ids[1]]: 'VARIANT_NOT_FOUND',
      });
      expect(await pricesOf(ids)).toEqual([20, 40, 10]);
    });

    // an end just ahead by the clock of the server and already behind by the one of the database:
    // the trigger refuses it when it is written, and the refusal names the variant
    it('names the variant a sale the database refuses was written for', async () => {
      const { product, ids } = await threeVariants();
      clock = moveClock(-60_000);

      const res = await changeMany(product.id, {
        variantIds: [ids[0]],
        price: 30,
        sale: { percent: 10, endsAt: new Date(Date.now() + 30_000).toISOString() },
      });
      clock.restore();
      clock = undefined;

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({
        errorCode: 'VARIANTS_INVALID',
        details: {
          variants: [{ variantId: ids[0], errorCode: 'PRODUCT_SALE_ENDS_AT_INVALID' }],
        },
      });
      expect(await pricesOf(ids)).toEqual([20, 40, 10]);
    });

    it('refuses a new sale on a deleted product when variants are named', async () => {
      const { product, ids } = await threeVariants();
      await deleteProductFromCatalog(product.id);

      const res = await changeMany(product.id, {
        variantIds: [ids[0]],
        price: 30,
        sale: { percent: 10, endsAt: inMs(DAY) },
      });

      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({
        errorCode: 'VARIANTS_INVALID',
        details: { variants: [{ variantId: ids[0], errorCode: 'PRODUCT_NOT_FOUND' }] },
      });
    });
  });

  describe('refuses the request', () => {
    it('answers 404 for a product that does not exist', async () => {
      const res = await changeMany(2_000_000_000, { price: 5 });

      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ errorCode: 'PRODUCT_NOT_FOUND' });
    });

    it('answers 404 for a deleted product when no variant is named', async () => {
      const { product } = await threeVariants();
      await deleteProductFromCatalog(product.id);

      const res = await changeMany(product.id, { price: 5 });

      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ errorCode: 'PRODUCT_NOT_FOUND' });
    });

    it('changes the variants of a deleted product when they are named', async () => {
      const { product, ids } = await threeVariants();
      await deleteProductFromCatalog(product.id);

      const res = await changeMany(product.id, { variantIds: [ids[0]], price: 5 });

      expect(res.statusCode).toBe(200);
      expect(await pricesOf([ids[0]])).toEqual([5]);
    });

    it('answers 404 for a variant of another product, naming it', async () => {
      const { product, ids } = await threeVariants();
      const other = await createProduct({ price: 20 });

      const res = await changeMany(product.id, {
        variantIds: [ids[0], other.variantId, 2_000_000_000],
        price: 5,
      });

      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({
        errorCode: 'VARIANT_NOT_FOUND',
        details: { variantIds: [other.variantId, 2_000_000_000] },
      });
      expect(await pricesOf(ids)).toEqual([20, 40, 10]);
    });

    it('answers 404 for a product none of whose variants is for sale', async () => {
      const product = await createProduct({ price: 20 });
      await markVariantDeleted(product.variantId);

      const res = await changeMany(product.id, { price: 5 });

      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ errorCode: 'VARIANT_NOT_FOUND' });
    });

    it.each([
      ['nothing to change', {}, 'NO_FIELDS_TO_UPDATE'],
      ['the names alone', { variantIds: [1] }, 'NO_FIELDS_TO_UPDATE'],
      ['the flag alone', { withoutShippingData: true }, 'NO_FIELDS_TO_UPDATE'],
      ['a price past the cent', { price: 1.005 }, 'PRODUCT_PRICE_INVALID'],
      ['a word on the sale without a price', { sale: 'keep' }, 'PRODUCT_SALE_REQUIRES_PRICE'],
      ['a stock', { price: 1, stock: 3 }, 'PRODUCT_STOCK_NOT_ALLOWED'],
      ['a weight of 0', { weightGrams: 0 }, 'PRODUCT_WEIGHT_INVALID'],
      ['a size of 0', { lengthMm: 0, widthMm: 1, heightMm: 1 }, 'PRODUCT_SIZES_INVALID'],
      [
        'an end that is behind',
        { price: 1, sale: { percent: 10, endsAt: inMs(-DAY) } },
        'PRODUCT_SALE_ENDS_AT_INVALID',
      ],
      [
        'a flag that is not true or false',
        { weightGrams: 5, withoutShippingData: 'yes' },
        'VALIDATION_ERROR',
      ],
    ])('refuses %s', async (_case, payload, code) => {
      const { product, ids } = await threeVariants();

      const res = await changeMany(product.id, payload);

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode: code });
      expect(await pricesOf(ids)).toEqual([20, 40, 10]);
    });

    it.each([
      ['an empty list of variants', { variantIds: [], price: 5 }],
      ['a variant named twice', { variantIds: [4, 4], price: 5 }],
      ['a variant id of 0', { variantIds: [0], price: 5 }],
      [
        'more variants than a product may have',
        { variantIds: Array.from({ length: 201 }, (_, i) => i + 1), price: 5 },
      ],
    ])('refuses %s', async (_case, payload) => {
      const { product } = await threeVariants();

      const res = await changeMany(product.id, payload);

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
    });

    // the article number, the barcode, the place and the pictures belong to one variant
    it('leaves out the fields of one variant alone', async () => {
      const { product, ids } = await threeVariants();

      const res = await changeMany(product.id, { sku: 'ONLY-ONE', position: 2, price: 5 });

      expect(res.statusCode).toBe(200);
      expect((await variantRowsOf(product.id)).map((row) => row.sku)).toEqual([null, null, null]);
      expect(await pricesOf(ids)).toEqual([5, 5, 5]);
    });

    it.each([
      ['a user', () => buyer],
      ['a guest', () => null],
    ])('refuses %s', async (_who, actorOf) => {
      const { product, ids } = await threeVariants();

      const res = await changeMany(product.id, { price: 5 }, actorOf());

      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ errorCode: 'INSUFFICIENT_ROLE' });
      expect(await pricesOf(ids)).toEqual([20, 40, 10]);
    });
  });

  // the pictures are chosen from the gallery of the product, the same list for every variant of the
  // change; the article number, the barcode and the place stay out (a code is unique, a place is one
  // variant's)
  describe('the pictures', () => {
    // a product with three variants and two more pictures in its gallery: [first, second, third]
    async function withGallery() {
      const data = await threeVariants();
      const [first] = await galleryIdsOf(data.product.id);
      const second = await addGalleryImage(data.product.id);
      const third = await addGalleryImage(data.product.id);
      return { ...data, gallery: [first!, second, third] as const };
    }

    const shownBy = (ids: readonly number[]) => Promise.all(ids.map((id) => imagesOfVariant(id)));

    it('writes the same list of pictures for every variant, whole, with the places it gives', async () => {
      const {
        product,
        ids,
        gallery: [, second, third],
      } = await withGallery();

      const res = await changeMany(product.id, {
        images: [
          { imageId: third, position: 1 },
          { imageId: second, position: 4 },
        ],
      });

      expect(res.statusCode).toBe(200);
      for (const variant of res.json().variants as Array<{
        images: Array<{ id: number; position: number }>;
      }>) {
        expect(variant.images.map((image) => [image.id, image.position])).toEqual([
          [third, 1],
          [second, 4],
        ]);
      }
      const list = [
        [third, 1],
        [second, 4],
      ];
      expect(await shownBy(ids)).toEqual([list, list, list]);
    });

    it('puts the change of the pictures in the line of the admin log of each variant', async () => {
      const {
        product,
        ids,
        gallery: [first, second],
      } = await withGallery();

      await changeMany(product.id, {
        price: 25,
        images: [
          { imageId: second, position: 1 },
          { imageId: first, position: 2 },
        ],
      });

      for (const id of ids) {
        const [line] = await auditLinesOf('variant', id, ['variant.update_batch']);
        expect(line!.meta).toEqual([
          { field: 'price', old: expect.any(String), new: '25' },
          {
            field: 'images',
            old: [{ imageId: first, position: 1 }],
            new: [
              { imageId: second, position: 1 },
              { imageId: first, position: 2 },
            ],
          },
        ]);
      }
    });

    it('takes the pictures of the variants named and leaves the others as they are', async () => {
      const {
        product,
        ids,
        gallery: [first, second],
      } = await withGallery();

      const res = await changeMany(product.id, {
        variantIds: [ids[2], ids[0]],
        images: [{ imageId: second, position: 1 }],
      });

      expect(res.statusCode).toBe(200);
      expect(await shownBy(ids)).toEqual([[[second, 1]], [[first, 1]], [[second, 1]]]);
    });

    it('takes all the pictures away with an empty list, and a buyer no longer sees those variants', async () => {
      const {
        product,
        ids,
        gallery: [first],
      } = await withGallery();

      const res = await changeMany(product.id, { variantIds: [ids[1], ids[2]], images: [] });

      expect(res.statusCode).toBe(200);
      for (const variant of res.json().variants) {
        expect(variant).toMatchObject({ visible: false, image: null, images: [] });
      }
      expect(await shownBy(ids)).toEqual([[[first, 1]], [], []]);

      // the one that still shows a picture is all the card has for a buyer
      const card = await app.inject({ method: 'GET', url: `/api/products/${product.id}` });
      expect(card.statusCode).toBe(200);
      expect(card.json().variants.map((variant: { id: number }) => variant.id)).toEqual([ids[0]]);
      expect(await auditLinesOf('variant', ids[1], ['variant.update_batch'])).toEqual([
        expect.objectContaining({
          meta: [{ field: 'images', old: [{ imageId: first, position: 1 }], new: [] }],
        }),
      ]);
    });

    it('is a change on its own, with or without the other fields', async () => {
      const { product, ids, gallery } = await withGallery();

      const alone = await changeMany(product.id, {
        images: [{ imageId: gallery[1], position: 1 }],
      });
      const withPrice = await changeMany(product.id, {
        price: 31,
        images: [{ imageId: gallery[2], position: 1 }],
      });

      expect(alone.statusCode).toBe(200);
      expect(withPrice.statusCode).toBe(200);
      expect(await pricesOf(ids)).toEqual([31, 31, 31]);
      const list = [[gallery[2], 1]];
      expect(await shownBy(ids)).toEqual([list, list, list]);
    });

    it('writes nothing for a variant that shows these pictures already', async () => {
      const { product, ids, gallery } = await withGallery();
      await changeMany(product.id, {
        variantIds: [ids[0]],
        images: [{ imageId: gallery[1], position: 1 }],
      });

      const res = await changeMany(product.id, { images: [{ imageId: gallery[1], position: 1 }] });

      expect(res.statusCode).toBe(200);
      // the first variant had them: the one line is from the first request; the others got theirs now
      for (const id of ids) {
        expect(await auditLinesOf('variant', id, ['variant.update_batch'])).toHaveLength(1);
      }
    });

    it('writes no line at all when every variant shows the list already', async () => {
      const { product, ids, gallery } = await withGallery();

      const res = await changeMany(product.id, { images: [{ imageId: gallery[0], position: 1 }] });

      expect(res.statusCode).toBe(200);
      for (const id of ids) {
        expect(await auditLinesOf('variant', id, ['variant.update_batch'])).toEqual([]);
      }
    });

    it('changes the pictures of a variant taken out of sale when it is named', async () => {
      const { product, ids, gallery } = await withGallery();
      await markVariantDeleted(ids[1]);

      const res = await changeMany(product.id, {
        variantIds: [ids[1]],
        images: [{ imageId: gallery[2], position: 1 }],
      });

      expect(res.statusCode).toBe(200);
      expect(await imagesOfVariant(ids[1])).toEqual([[gallery[2], 1]]);
    });

    it('refuses a picture of the gallery of another product, and changes none of the variants', async () => {
      const { product, ids } = await withGallery();
      const other = await createProduct();
      const [foreign] = await galleryIdsOf(other.id);
      const before = await shownBy(ids);

      for (const imageId of [foreign!, 2_000_000_000]) {
        const res = await changeMany(product.id, { price: 99, images: [{ imageId, position: 1 }] });

        expect(res.statusCode).toBe(400);
        expect(res.json()).toMatchObject({
          errorCode: 'VARIANT_IMAGE_NOT_FOUND',
          details: { imageIds: [imageId] },
        });
      }
      expect(await shownBy(ids)).toEqual(before);
      expect(await pricesOf(ids)).toEqual([20, 40, 10]);
      expect(await auditLinesOf('variant', ids[0], ['variant.update_batch'])).toEqual([]);
    });

    it('names the pictures that are not there even when the others of the list are', async () => {
      const { product, gallery } = await withGallery();
      const other = await createProduct();
      const [foreign] = await galleryIdsOf(other.id);

      const res = await changeMany(product.id, {
        images: [
          { imageId: gallery[1], position: 1 },
          { imageId: foreign!, position: 2 },
        ],
      });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({
        errorCode: 'VARIANT_IMAGE_NOT_FOUND',
        details: { imageIds: [foreign] },
      });
    });

    it('refuses more pictures than a variant shows, a picture twice, a place twice, and writes nothing', async () => {
      const { product, ids, gallery } = await withGallery();
      const cases: [Record<string, number>[], string][] = [
        [
          Array.from({ length: MAX_VARIANT_IMAGES + 1 }, (_, i) => ({
            imageId: gallery[1],
            position: i + 1,
          })),
          'VARIANT_IMAGES_TOO_MANY',
        ],
        [
          [
            { imageId: gallery[1], position: 1 },
            { imageId: gallery[1], position: 2 },
          ],
          'VARIANT_IMAGES_REPEATED',
        ],
        [
          [
            { imageId: gallery[1], position: 1 },
            { imageId: gallery[2], position: 1 },
          ],
          'VARIANT_IMAGE_POSITION_INVALID',
        ],
        [[{ imageId: gallery[1], position: 0 }], 'VARIANT_IMAGE_POSITION_INVALID'],
      ];

      for (const [images, errorCode] of cases) {
        const res = await changeMany(product.id, { images });

        expect(res.statusCode).toBe(400);
        expect(res.json()).toMatchObject({ errorCode });
      }
      const list = [[gallery[0], 1]];
      expect(await shownBy(ids)).toEqual([list, list, list]);
    });

    // the list is written whole: a value that is no list is no list of pictures, and it is not the
    // way to take them all away (that is an empty list)
    it.each([
      ['null', null],
      ['a number', 5],
      ['a text', 'first'],
      ['an object', { imageId: 1, position: 1 }],
    ])('refuses pictures that are %s, and keeps the pictures', async (_case, images) => {
      const { product, ids, gallery } = await withGallery();

      const res = await changeMany(product.id, { images });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({
        errorCode: 'VALIDATION_ERROR',
        details: [{ in: 'body', field: 'images', message: 'must be array' }],
      });
      const list = [[gallery[0], 1]];
      expect(await shownBy(ids)).toEqual([list, list, list]);
    });

    it('changes none of the variants when a variant of the change is refused for another reason', async () => {
      const { product, ids, gallery } = await withGallery();
      await saleRoute(product.id, {
        variantIds: [ids[1]],
        sale: { percent: 10, endsAt: inMs(DAY) },
      });

      const res = await changeMany(product.id, {
        price: 99,
        images: [{ imageId: gallery[1], position: 1 }],
      });

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ errorCode: 'VARIANTS_INVALID' });
      const list = [[gallery[0], 1]];
      expect(await shownBy(ids)).toEqual([list, list, list]);
    });
  });

  // a change that is refused for a variant leaves the others as they were
  it('changes none of the variants when one of them is refused', async () => {
    const { product, ids } = await threeVariants();
    await saleRoute(product.id, { variantIds: [ids[1]], sale: { percent: 10, endsAt: inMs(DAY) } });

    const res = await changeMany(product.id, { price: 99 });

    expect(res.statusCode).toBe(409);
    expect(await pricesOf(ids)).toEqual([20, 40, 10]);
    expect(await priceLinesOf(ids[0])).toEqual([]);
  });
});
