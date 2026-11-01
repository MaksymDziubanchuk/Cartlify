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
  uniqueTag,
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
  uniqueBarcode,
  variantRowsOf,
} from '../../../helpers/variants.js';

// PATCH /api/products/variants/batch changes many variants at once, of any products, each with the
// fields of its own, all of them or none: the change of each is the one of PATCH of one variant (the
// price with the word on its sale, the article number, the barcode, the weight and the sizes, the
// place, the pictures), with its checks and every line of the logs. A refusal is VARIANTS_INVALID
// and names every variant refused with its own error; nothing is changed. The codes are checked as
// a whole (a code any other live variant holds now, or two items ask for, is taken: no swaps), the
// places move in the order of the items. The rows are locked by id, so two such requests over the
// same variants wait for each other. The products of the file stay (a product with a log of prices
// cannot be deleted)

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
let buyer: TestUser;

const DAY = 86_400_000;
const MISSING = 2_000_000_000;
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

const newProduct = (price = 20): Promise<TestProduct> => createProduct({ price, stock: 3 });

const newProductWith = (opts: Parameters<typeof createProduct>[0]): Promise<TestProduct> =>
  createProduct({ price: 20, stock: 3, ...opts });

const patchBatch = (payload: Record<string, unknown>, actor: TestUser | null = admin) =>
  app.inject({
    method: 'PATCH',
    url: '/api/products/variants/batch',
    headers: withCsrf(csrf, actor ? accessCookie(actor) : ''),
    payload,
  });

const saleRoute = (productId: number, variantId: number, percent = 25) =>
  app.inject({
    method: 'PATCH',
    url: `/api/products/${productId}/sale`,
    headers: withCsrf(csrf, accessCookie(admin)),
    payload: { variantIds: [variantId], sale: { percent, endsAt: inMs(DAY) } },
  });

const priceOf = async (variantId: number) => (await priceRowOf(variantId)).price;

const refusedOf = (res: { json: () => { details: { variants: unknown[] } } }) =>
  res.json().details.variants;

describe('PATCH /api/products/variants/batch', () => {
  it('changes each variant with fields of its own and writes the logs of each', async () => {
    const first = await newProduct(20);
    const second = await newProduct(30);
    const secondTwo = await createVariant(second.id, { price: 40 });

    // the order of the request is no order of ids: the answer keeps the one of the request
    const res = await patchBatch({
      items: [
        { variantId: secondTwo.id, price: 35, weightGrams: 120 },
        { variantId: first.variantId, price: 25 },
        { variantId: second.variantId, weightGrams: 300, lengthMm: 10, widthMm: 20, heightMm: 30 },
      ],
    });

    expect(res.statusCode).toBe(200);
    const items = res.json().items as Array<{
      product: { id: number };
      variant: Record<string, unknown>;
    }>;
    expect(Object.keys(res.json())).toEqual(['items']);
    expect(items.map((item) => item.variant.id)).toEqual([
      secondTwo.id,
      first.variantId,
      second.variantId,
    ]);
    expect(items.map((item) => item.product.id)).toEqual([second.id, first.id, second.id]);
    expect(items[0]!.variant).toMatchObject({ price: 35, weightGrams: 120, visible: true });
    expect(items[1]!.variant).toMatchObject({ price: 25, weightGrams: null });
    expect(items[2]!.variant).toMatchObject({ price: 30, weightGrams: 300, lengthMm: 10 });

    expect(await priceOf(first.variantId)).toBe(25);
    expect(await priceOf(second.variantId)).toBe(30);
    expect(await priceOf(secondTwo.id)).toBe(35);
    expect(await priceLinesOf(first.variantId)).toEqual([
      expect.objectContaining({
        mode: 'fixed',
        oldPrice: 20,
        newPrice: 25,
        value: 5,
        event: 'price.set_batch',
        actorId: admin.id,
        productId: first.id,
      }),
    ]);
    expect(await priceLinesOf(second.variantId)).toEqual([]);

    const [line] = await auditLinesOf('variant', secondTwo.id, ['variant.update_batch']);
    expect(line).toMatchObject({ actorId: admin.id, action: 'OTHER' });
    expect(line!.meta).toEqual([
      { field: 'weightGrams', old: null, new: 120 },
      { field: 'price', old: '40', new: '35' },
    ]);
  });

  it('changes the weight and the sizes of many variants at once', async () => {
    const first = await newProduct();
    const second = await newProduct();

    const res = await patchBatch({
      items: [
        { variantId: first.variantId, weightGrams: 100, lengthMm: 10, widthMm: 10, heightMm: 10 },
        { variantId: second.variantId, weightGrams: 200 },
      ],
    });

    expect(res.statusCode).toBe(200);
    const rows = [...(await variantRowsOf(first.id)), ...(await variantRowsOf(second.id))];
    expect(rows).toEqual([
      expect.objectContaining({ weightGrams: 100, lengthMm: 10 }),
      expect.objectContaining({ weightGrams: 200, lengthMm: null }),
    ]);
  });

  it('takes a word on the sale of each variant on sale: keep, off, or a new sale', async () => {
    const kept = await newProduct(20);
    const off = await newProduct(20);
    const renewed = await newProduct(20);
    for (const product of [kept, off, renewed]) await saleRoute(product.id, product.variantId);
    const newEnd = inMs(2 * DAY);

    const res = await patchBatch({
      items: [
        { variantId: kept.variantId, price: 25, sale: 'keep' },
        { variantId: off.variantId, price: 25, sale: 'remove' },
        { variantId: renewed.variantId, price: 40, sale: { percent: 10, endsAt: newEnd } },
      ],
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().items.map((item: { variant: object }) => item.variant)).toEqual([
      expect.objectContaining({ id: kept.variantId, price: 25, salePrice: 15 }),
      expect.objectContaining({ id: off.variantId, price: 25, salePrice: null }),
      expect.objectContaining({
        id: renewed.variantId,
        price: 40,
        salePrice: 36,
        saleEndsAt: newEnd,
      }),
    ]);

    const trail = async (variantId: number) =>
      (await priceLinesOf(variantId)).map((line) => [line.event, line.oldPrice, line.newPrice]);
    expect(await trail(kept.variantId)).toEqual([
      ['price.sale_start', 20, 15],
      ['price.set_batch', 20, 25],
    ]);
    expect(await trail(off.variantId)).toEqual([
      ['price.sale_start', 20, 15],
      ['price.sale_end', 15, 20],
      ['price.set_batch', 20, 25],
    ]);
    expect(await trail(renewed.variantId)).toEqual([
      ['price.sale_start', 20, 15],
      ['price.sale_end', 15, 20],
      ['price.set_batch', 20, 40],
      ['price.sale_start', 40, 36],
    ]);
  });

  it('names every variant on sale that got a price without a word, and changes nothing', async () => {
    const plain = await newProduct(20);
    const first = await newProduct(20);
    const second = await newProduct(20);
    await saleRoute(first.id, first.variantId);
    await saleRoute(second.id, second.variantId);

    const res = await patchBatch({
      items: [
        { variantId: plain.variantId, price: 21 },
        { variantId: first.variantId, price: 25 },
        { variantId: second.variantId, price: 26 },
      ],
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      errorCode: 'VARIANTS_INVALID',
      details: {
        variants: [
          {
            variantId: first.variantId,
            errorCode: 'PRODUCT_SALE_DECISION_REQUIRED',
            details: { salePrice: 15, saleEndsAt: expect.any(String) },
          },
          { variantId: second.variantId, errorCode: 'PRODUCT_SALE_DECISION_REQUIRED' },
        ],
      },
    });
    expect(await priceOf(plain.variantId)).toBe(20);
    expect(await priceOf(first.variantId)).toBe(20);
    expect(await priceLinesOf(plain.variantId)).toEqual([]);
  });

  it('refuses keep for a price down to the sale price', async () => {
    const product = await newProduct(20);
    await saleRoute(product.id, product.variantId);
    const other = await newProduct(20);

    const res = await patchBatch({
      items: [
        { variantId: other.variantId, price: 21 },
        { variantId: product.variantId, price: 15, sale: 'keep' },
      ],
    });

    expect(res.statusCode).toBe(409);
    expect(refusedOf(res)).toEqual([
      {
        variantId: product.variantId,
        errorCode: 'PRODUCT_SALE_NOT_BELOW_PRICE',
        details: { salePrice: 15, price: 15 },
      },
    ]);
    expect(await priceLinesOf(other.variantId)).toEqual([]);
  });

  it('puts nothing on when a new sale does not fit the new price', async () => {
    const product = await newProduct(20);
    const other = await newProduct(20);

    const res = await patchBatch({
      items: [
        { variantId: other.variantId, price: 30 },
        { variantId: product.variantId, price: 4, sale: { amount: 5, endsAt: inMs(DAY) } },
      ],
    });

    expect(res.statusCode).toBe(400);
    expect(refusedOf(res)).toEqual([
      {
        variantId: product.variantId,
        errorCode: 'PRODUCT_SALE_AMOUNT_TOO_HIGH',
        details: { price: 4 },
      },
    ]);
    expect(await priceOf(product.variantId)).toBe(20);
    expect(await priceOf(other.variantId)).toBe(20);
    expect(await priceLinesOf(product.variantId)).toEqual([]);
  });

  // the fields of every variant are read first: what is wrong with the request alone shows before
  // any variant is looked at
  it('names every variant whose fields are wrong, before it looks at the variants', async () => {
    const onSale = await newProduct(20);
    await saleRoute(onSale.id, onSale.variantId);
    const fine = await newProduct(20);

    const res = await patchBatch({
      items: [
        { variantId: onSale.variantId, price: 25 },
        { variantId: fine.variantId, price: 1.001 },
        { variantId: MISSING, sale: 'keep' },
        { variantId: fine.variantId + 1_000_000, weightGrams: 0 },
        { variantId: fine.variantId + 2_000_000, price: 5, stock: 1 },
      ],
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VARIANTS_INVALID' });
    expect(refusedOf(res)).toEqual([
      { variantId: fine.variantId, errorCode: 'PRODUCT_PRICE_INVALID' },
      { variantId: MISSING, errorCode: 'PRODUCT_SALE_REQUIRES_PRICE' },
      { variantId: fine.variantId + 1_000_000, errorCode: 'PRODUCT_WEIGHT_INVALID' },
      { variantId: fine.variantId + 2_000_000, errorCode: 'PRODUCT_STOCK_NOT_ALLOWED' },
    ]);
    expect(await priceOf(onSale.variantId)).toBe(20);
  });

  // an end just ahead by the clock of the server and already behind by the one of the database:
  // the trigger refuses it when it is written, and the refusal names the variant
  it('names the variant a sale the database refuses was written for, and changes none', async () => {
    const product = await newProduct();
    const other = await newProduct();
    clock = moveClock(-60_000);

    const res = await patchBatch({
      items: [
        { variantId: other.variantId, price: 21 },
        {
          variantId: product.variantId,
          price: 30,
          sale: { percent: 10, endsAt: new Date(Date.now() + 30_000).toISOString() },
        },
      ],
    });
    clock.restore();
    clock = undefined;

    expect(res.statusCode).toBe(400);
    expect(refusedOf(res)).toEqual([
      { variantId: product.variantId, errorCode: 'PRODUCT_SALE_ENDS_AT_INVALID' },
    ]);
    expect(await priceOf(product.variantId)).toBe(20);
    expect(await priceOf(other.variantId)).toBe(20);
  });

  it('names the variant whose price is null: a null is no price of 0', async () => {
    const product = await newProduct();

    const res = await patchBatch({ items: [{ variantId: product.variantId, price: null }] });

    expect(res.statusCode).toBe(400);
    expect(refusedOf(res)).toEqual([
      { variantId: product.variantId, errorCode: 'PRODUCT_PRICE_INVALID' },
    ]);
    expect(await priceOf(product.variantId)).toBe(20);
  });

  it('names a variant with nothing to change', async () => {
    const product = await newProduct();

    const res = await patchBatch({
      items: [{ variantId: product.variantId, price: 21 }, { variantId: MISSING }],
    });

    expect(res.statusCode).toBe(400);
    expect(refusedOf(res)).toEqual([{ variantId: MISSING, errorCode: 'NO_FIELDS_TO_UPDATE' }]);
    expect(await priceOf(product.variantId)).toBe(20);
  });

  it('names the variants that are not there with the status 404 and changes nothing', async () => {
    const product = await newProduct();

    const res = await patchBatch({
      items: [
        { variantId: product.variantId, price: 21 },
        { variantId: MISSING, price: 5 },
      ],
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ errorCode: 'VARIANTS_INVALID' });
    expect(refusedOf(res)).toEqual([{ variantId: MISSING, errorCode: 'VARIANT_NOT_FOUND' }]);
    expect(await priceOf(product.variantId)).toBe(20);
  });

  it('refuses a new sale on a variant taken out of sale and on a product that is deleted', async () => {
    const out = await newProduct();
    await markVariantDeleted(out.variantId);
    const gone = await newProduct();
    await deleteProductFromCatalog(gone.id);
    const sale = { percent: 10, endsAt: inMs(DAY) };

    const res = await patchBatch({
      items: [
        { variantId: out.variantId, price: 30, sale },
        { variantId: gone.variantId, price: 30, sale },
      ],
    });

    expect(res.statusCode).toBe(404);
    expect(refusedOf(res)).toEqual([
      { variantId: out.variantId, errorCode: 'VARIANT_NOT_FOUND' },
      { variantId: gone.variantId, errorCode: 'PRODUCT_NOT_FOUND' },
    ]);
  });

  it('changes the price of a variant taken out of sale', async () => {
    const out = await newProduct();
    await markVariantDeleted(out.variantId);

    const res = await patchBatch({ items: [{ variantId: out.variantId, price: 33 }] });

    expect(res.statusCode).toBe(200);
    expect(res.json().items[0].variant).toMatchObject({ price: 33, visible: false });
  });

  it('clears the weight and the sizes of a variant only when the item says so', async () => {
    const product = await createProduct({
      price: 10,
      weightGrams: 300,
      sizesMm: { length: 1, width: 1, height: 1 },
    });

    const refused = await patchBatch({
      items: [{ variantId: product.variantId, weightGrams: null }],
    });
    const cleared = await patchBatch({
      items: [
        {
          variantId: product.variantId,
          weightGrams: null,
          lengthMm: null,
          widthMm: null,
          heightMm: null,
          withoutShippingData: true,
        },
      ],
    });

    expect(refused.statusCode).toBe(400);
    expect(refusedOf(refused)).toEqual([
      {
        variantId: product.variantId,
        errorCode: 'PRODUCT_SHIPPING_DATA_REQUIRED',
        details: { fields: ['weightGrams'] },
      },
    ]);
    expect(cleared.statusCode).toBe(200);
    expect((await variantRowsOf(product.id))[0]).toMatchObject({
      weightGrams: null,
      lengthMm: null,
    });
  });

  it('refuses a variant named twice', async () => {
    const product = await newProduct();

    const res = await patchBatch({
      items: [
        { variantId: product.variantId, price: 21 },
        { variantId: product.variantId, price: 22 },
      ],
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      errorCode: 'VARIANTS_REPEATED',
      details: { variantIds: [product.variantId] },
    });
    expect(await priceOf(product.variantId)).toBe(20);
  });

  it('refuses an empty list and more than 100 variants', async () => {
    const many = Array.from({ length: 101 }, (_, index) => ({ variantId: index + 1, price: 1 }));

    for (const items of [[], many]) {
      const res = await patchBatch({ items });

      expect(res.statusCode).toBe(400);
      expect(res.json().errorCode).toBe('VALIDATION_ERROR');
    }
  });

  it.each([
    ['no variant', { price: 5 }],
    ['a variant id of 0', { variantId: 0, price: 5 }],
    ['a variant id that is no number', { variantId: 'x', price: 5 }],
  ])('refuses an item with %s', async (_case, item) => {
    const res = await patchBatch({ items: [item] });

    expect(res.statusCode).toBe(400);
    expect(res.json().errorCode).toBe('VALIDATION_ERROR');
  });

  // any field of one variant can be sent in an item: the same checks and writes as PATCH of one
  // variant
  describe('the article number and the barcode of each variant', () => {
    const codesOf = async (productId: number) =>
      (await variantRowsOf(productId)).map((row) => ({ sku: row.sku, barcode: row.barcode }));

    it('changes the codes of each variant and writes them to the admin log', async () => {
      const first = await newProduct();
      const second = await newProduct();
      const skuA = `Batch-A-${uniqueTag()}`;
      const skuB = `Batch-B-${uniqueTag()}`;
      const barcodeA = uniqueBarcode();

      const res = await patchBatch({
        items: [
          { variantId: first.variantId, sku: skuA, barcode: barcodeA },
          { variantId: second.variantId, sku: skuB, price: 21 },
        ],
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().items[0].variant).toMatchObject({ sku: skuA, barcode: barcodeA });
      expect(res.json().items[1].variant).toMatchObject({ sku: skuB, barcode: null, price: 21 });
      expect(await codesOf(first.id)).toEqual([{ sku: skuA, barcode: barcodeA }]);
      expect(await codesOf(second.id)).toEqual([{ sku: skuB, barcode: null }]);
      expect(await auditLinesOf('variant', first.variantId, ['variant.update_batch'])).toEqual([
        expect.objectContaining({
          meta: [
            { field: 'sku', old: null, new: skuA },
            { field: 'barcode', old: null, new: barcodeA },
          ],
        }),
      ]);
      expect(await auditLinesOf('variant', second.variantId, ['variant.update_batch'])).toEqual([
        expect.objectContaining({
          meta: [
            { field: 'sku', old: null, new: skuB },
            { field: 'price', old: '20', new: '21' },
          ],
        }),
      ]);
    });

    it('takes the codes away with null or an empty text', async () => {
      const product = await newProductWith({
        sku: `Away-${uniqueTag()}`,
        barcode: uniqueBarcode(),
      });

      const res = await patchBatch({
        items: [{ variantId: product.variantId, sku: null, barcode: '' }],
      });

      expect(res.statusCode).toBe(200);
      expect(await codesOf(product.id)).toEqual([{ sku: null, barcode: null }]);
    });

    it('lets a variant keep its own code, and change the case of its letters', async () => {
      const sku = `Own-${uniqueTag()}`;
      const barcode = uniqueBarcode();
      const product = await newProductWith({ sku, barcode });

      const res = await patchBatch({
        items: [{ variantId: product.variantId, sku: sku.toUpperCase(), barcode, price: 21 }],
      });

      expect(res.statusCode).toBe(200);
      expect(await codesOf(product.id)).toEqual([{ sku: sku.toUpperCase(), barcode }]);
      // the barcode was what the variant had: it is no change
      expect(
        (await auditLinesOf('variant', product.variantId, ['variant.update_batch']))[0]!.meta,
      ).toEqual([
        { field: 'sku', old: sku, new: sku.toUpperCase() },
        { field: 'price', old: '20', new: '21' },
      ]);
    });

    it('writes nothing for the codes a variant has already', async () => {
      const sku = `Same-${uniqueTag()}`;
      const product = await newProductWith({ sku });

      const res = await patchBatch({ items: [{ variantId: product.variantId, sku }] });

      expect(res.statusCode).toBe(200);
      expect(await auditLinesOf('variant', product.variantId, ['variant.update_batch'])).toEqual(
        [],
      );
    });

    it('answers 409 for an article number a live variant outside the batch has, whatever the case of its letters, naming the item', async () => {
      const sku = `Held-${uniqueTag()}`;
      await newProductWith({ sku });
      const taking = await newProduct();
      const fine = await newProduct();

      const res = await patchBatch({
        items: [
          { variantId: taking.variantId, sku: sku.toUpperCase(), price: 21 },
          { variantId: fine.variantId, price: 22 },
        ],
      });

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({
        errorCode: 'PRODUCT_SKU_TAKEN',
        details: { variants: [{ variantId: taking.variantId, sku: sku.toUpperCase() }] },
      });
      expect(await priceOf(taking.variantId)).toBe(20);
      expect(await priceOf(fine.variantId)).toBe(20);
      expect(await codesOf(taking.id)).toEqual([{ sku: null, barcode: null }]);
    });

    it('answers 409 for a barcode a live variant outside the batch has, naming the item', async () => {
      const barcode = uniqueBarcode();
      await newProductWith({ barcode });
      const taking = await newProduct();
      const fine = await newProduct();

      const res = await patchBatch({
        items: [
          { variantId: fine.variantId, barcode: uniqueBarcode() },
          { variantId: taking.variantId, barcode },
        ],
      });

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({
        errorCode: 'VARIANT_BARCODE_TAKEN',
        details: { variants: [{ variantId: taking.variantId, barcode }] },
      });
      expect(await codesOf(fine.id)).toEqual([{ sku: null, barcode: null }]);
    });

    it('names an article number before a barcode when both are taken', async () => {
      const sku = `Both-${uniqueTag()}`;
      const barcode = uniqueBarcode();
      await newProductWith({ sku, barcode });
      const taking = await newProduct();

      const res = await patchBatch({ items: [{ variantId: taking.variantId, sku, barcode }] });

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ errorCode: 'PRODUCT_SKU_TAKEN' });
    });

    // a code is unique and checked on every write, so two variants cannot swap their codes in one
    // request: the code a variant holds now is taken, even by one of the batch
    it('refuses codes swapped between two variants of the batch, naming both', async () => {
      const skuA = `Swap-A-${uniqueTag()}`;
      const skuB = `Swap-B-${uniqueTag()}`;
      const barcodeA = uniqueBarcode();
      const barcodeB = uniqueBarcode();
      const first = await newProductWith({ sku: skuA, barcode: barcodeA });
      const second = await newProductWith({ sku: skuB, barcode: barcodeB });

      const bySku = await patchBatch({
        items: [
          { variantId: first.variantId, sku: skuB },
          { variantId: second.variantId, sku: skuA },
        ],
      });
      const byBarcode = await patchBatch({
        items: [
          { variantId: first.variantId, barcode: barcodeB },
          { variantId: second.variantId, barcode: barcodeA },
        ],
      });

      expect(bySku.statusCode).toBe(409);
      expect(bySku.json()).toMatchObject({
        errorCode: 'PRODUCT_SKU_TAKEN',
        details: {
          variants: [
            { variantId: first.variantId, sku: skuB },
            { variantId: second.variantId, sku: skuA },
          ],
        },
      });
      expect(byBarcode.statusCode).toBe(409);
      expect(byBarcode.json()).toMatchObject({
        errorCode: 'VARIANT_BARCODE_TAKEN',
        details: {
          variants: [
            { variantId: first.variantId, barcode: barcodeB },
            { variantId: second.variantId, barcode: barcodeA },
          ],
        },
      });
      expect(await codesOf(first.id)).toEqual([{ sku: skuA, barcode: barcodeA }]);
      expect(await codesOf(second.id)).toEqual([{ sku: skuB, barcode: barcodeB }]);
    });

    it('refuses the code of a variant of the batch even when that variant gives it up in the same batch', async () => {
      const sku = `Give-${uniqueTag()}`;
      const holder = await newProductWith({ sku });
      const taking = await newProduct();

      const res = await patchBatch({
        items: [
          { variantId: holder.variantId, sku: `Given-${uniqueTag()}` },
          { variantId: taking.variantId, sku },
        ],
      });

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({
        errorCode: 'PRODUCT_SKU_TAKEN',
        details: { variants: [{ variantId: taking.variantId, sku }] },
      });
      expect(await codesOf(holder.id)).toEqual([{ sku, barcode: null }]);
    });

    it('refuses a new code that two items ask for, naming both, whatever the case of the letters', async () => {
      const first = await newProduct();
      const second = await newProduct();
      const other = await newProduct();
      const sku = `Twice-${uniqueTag()}`;
      const barcode = uniqueBarcode();

      const bySku = await patchBatch({
        items: [
          { variantId: first.variantId, sku },
          { variantId: other.variantId, price: 21 },
          { variantId: second.variantId, sku: sku.toUpperCase() },
        ],
      });
      const byBarcode = await patchBatch({
        items: [
          { variantId: first.variantId, barcode },
          { variantId: second.variantId, barcode },
        ],
      });

      expect(bySku.statusCode).toBe(409);
      expect(bySku.json()).toMatchObject({
        errorCode: 'PRODUCT_SKU_TAKEN',
        details: {
          variants: [
            { variantId: first.variantId, sku },
            { variantId: second.variantId, sku: sku.toUpperCase() },
          ],
        },
      });
      expect(byBarcode.statusCode).toBe(409);
      expect(byBarcode.json()).toMatchObject({
        errorCode: 'VARIANT_BARCODE_TAKEN',
        details: {
          variants: [
            { variantId: first.variantId, barcode },
            { variantId: second.variantId, barcode },
          ],
        },
      });
      expect(await priceOf(other.variantId)).toBe(20);
      expect(await codesOf(first.id)).toEqual([{ sku: null, barcode: null }]);
    });

    it('lets a variant take the code of a variant that is out of sale', async () => {
      const sku = `Free-${uniqueTag()}`;
      const gone = await newProductWith({ sku });
      await markVariantDeleted(gone.variantId);
      const taking = await newProduct();

      const res = await patchBatch({
        items: [
          { variantId: taking.variantId, sku },
          { variantId: gone.variantId, sku: null },
        ],
      });

      expect(res.statusCode).toBe(200);
      expect(await codesOf(taking.id)).toEqual([{ sku, barcode: null }]);
    });

    it('does not check the codes of a variant that is out of sale: it holds none', async () => {
      const sku = `Dead-${uniqueTag()}`;
      const barcode = uniqueBarcode();
      await newProductWith({ sku, barcode });
      const out = await newProduct();
      await markVariantDeleted(out.variantId);
      const alsoOut = await newProduct();
      await markVariantDeleted(alsoOut.variantId);

      const res = await patchBatch({
        items: [
          { variantId: out.variantId, sku, barcode },
          { variantId: alsoOut.variantId, sku, barcode },
        ],
      });

      expect(res.statusCode).toBe(200);
      expect(await codesOf(out.id)).toEqual([{ sku, barcode }]);
    });

    it('names the variant whose barcode is wrong, with the others of its request', async () => {
      const product = await newProduct();
      const other = await newProduct();

      const res = await patchBatch({
        items: [
          { variantId: other.variantId, price: 21 },
          { variantId: product.variantId, barcode: '4006381333930' },
        ],
      });

      expect(res.statusCode).toBe(400);
      expect(refusedOf(res)).toEqual([
        { variantId: product.variantId, errorCode: 'VARIANT_BARCODE_INVALID' },
      ]);
      expect(await priceOf(other.variantId)).toBe(20);
    });
  });

  describe('the place of each variant among the variants of its product', () => {
    // three variants A, B, C at the places 1, 2, 3
    async function three() {
      const product = await newProduct();
      const b = await createVariant(product.id);
      const c = await createVariant(product.id);
      return { product, a: product.variantId, b: b.id, c: c.id };
    }

    const placesOf = async (productId: number) =>
      (await variantRowsOf(productId)).map((row) => [row.id, row.position]);

    it('moves the variants in the order of the items, and the others move around them', async () => {
      const { product, a, b, c } = await three();

      // the order of the items is not the order of the ids: C goes to the front, then B in front of it
      const res = await patchBatch({
        items: [
          { variantId: c, position: 1 },
          { variantId: b, position: 1 },
        ],
      });

      expect(res.statusCode).toBe(200);
      expect(await placesOf(product.id)).toEqual([
        [b, 1],
        [c, 2],
        [a, 3],
      ]);
      expect(
        res
          .json()
          .items.map((item: { variant: { id: number; position: number } }) => [
            item.variant.id,
            item.variant.position,
          ]),
      ).toEqual([
        [c, 2],
        [b, 1],
      ]);
    });

    it('moves variants of several products, each among its own', async () => {
      const one = await three();
      const two = await three();

      const res = await patchBatch({
        items: [
          { variantId: two.c, position: 1 },
          { variantId: one.a, position: 3 },
          { variantId: two.a, position: 2 },
        ],
      });

      expect(res.statusCode).toBe(200);
      expect(await placesOf(one.product.id)).toEqual([
        [one.b, 1],
        [one.c, 2],
        [one.a, 3],
      ]);
      expect(await placesOf(two.product.id)).toEqual([
        [two.c, 1],
        [two.a, 2],
        [two.b, 3],
      ]);
    });

    it('puts a variant moved past the last place at the last place', async () => {
      const { product, a, b, c } = await three();

      const res = await patchBatch({ items: [{ variantId: a, position: 99 }] });

      expect(res.statusCode).toBe(200);
      expect(await placesOf(product.id)).toEqual([
        [b, 1],
        [c, 2],
        [a, 3],
      ]);
    });

    it('keeps the places of the variants taken out of sale: a moved variant goes around them', async () => {
      const { product, a, b, c } = await three();
      await markVariantDeleted(b);

      await patchBatch({ items: [{ variantId: c, position: 1 }] });

      expect(await placesOf(product.id)).toEqual([
        [c, 1],
        [a, 2],
        [b, 3],
      ]);
    });

    it('writes the place the variant ends at to the admin log, and nothing for one that stays', async () => {
      const { product, a, b, c } = await three();

      await patchBatch({
        items: [
          { variantId: c, position: 1 },
          { variantId: b, position: 1 },
          { variantId: a, price: 21, position: 3 },
        ],
      });

      // the places end as B 1, C 2, A 3
      expect(await placesOf(product.id)).toEqual([
        [b, 1],
        [c, 2],
        [a, 3],
      ]);
      expect((await auditLinesOf('variant', c, ['variant.update_batch']))[0]!.meta).toEqual([
        { field: 'position', old: 3, new: 2 },
      ]);
      expect((await auditLinesOf('variant', b, ['variant.update_batch']))[0]!.meta).toEqual([
        { field: 'position', old: 2, new: 1 },
      ]);
      // A was first and is last now
      expect((await auditLinesOf('variant', a, ['variant.update_batch']))[0]!.meta).toEqual([
        { field: 'price', old: '20', new: '21' },
        { field: 'position', old: 1, new: 3 },
      ]);
    });

    it('writes no line for a place the variant has already, and counts it a change all the same', async () => {
      const { product, a, b, c } = await three();

      const res = await patchBatch({ items: [{ variantId: a, position: 1 }] });

      expect(res.statusCode).toBe(200);
      expect(await placesOf(product.id)).toEqual([
        [a, 1],
        [b, 2],
        [c, 3],
      ]);
      expect(await auditLinesOf('variant', a, ['variant.update_batch'])).toEqual([]);
    });

    it('moves nothing when an item of the request is refused', async () => {
      const { product, a, b, c } = await three();
      const other = await newProduct();
      const taken = `Held-${uniqueTag()}`;
      await newProductWith({ sku: taken });

      const refused = await patchBatch({
        items: [
          { variantId: c, position: 1 },
          { variantId: other.variantId, sku: taken },
        ],
      });
      const invalid = await patchBatch({
        items: [
          { variantId: c, position: 1 },
          { variantId: b, price: 1.001 },
        ],
      });

      expect(refused.statusCode).toBe(409);
      expect(invalid.statusCode).toBe(400);
      expect(await placesOf(product.id)).toEqual([
        [a, 1],
        [b, 2],
        [c, 3],
      ]);
    });

    it('names the variant whose place is wrong', async () => {
      const { product, a, b } = await three();

      const res = await patchBatch({
        items: [
          { variantId: a, position: 0 },
          { variantId: b, position: 2 },
        ],
      });

      expect(res.statusCode).toBe(400);
      expect(refusedOf(res)).toEqual([{ variantId: a, errorCode: 'VARIANT_POSITION_INVALID' }]);
      expect((await variantRowsOf(product.id)).map((row) => row.position)).toEqual([1, 2, 3]);
    });

    it('lets requests that move variants of one product meet: every variant keeps a place of its own', async () => {
      const { product, a, b, c } = await three();

      const results = await Promise.all([
        patchBatch({ items: [{ variantId: c, position: 1 }] }),
        patchBatch({ items: [{ variantId: a, position: 3 }] }),
        patchBatch({ items: [{ variantId: b, position: 1 }] }),
      ]);

      expect(results.map((res) => res.statusCode)).toEqual([200, 200, 200]);
      const places = (await placesOf(product.id)).map(([, position]) => position);
      expect(places).toEqual([1, 2, 3]);
    });
  });

  describe('the pictures of each variant', () => {
    // a product with a variant and two more pictures in its gallery: [first, second, third]
    async function withGallery() {
      const product = await newProduct();
      const [first] = await galleryIdsOf(product.id);
      const second = await addGalleryImage(product.id);
      const third = await addGalleryImage(product.id);
      return { product, gallery: [first!, second, third] as const };
    }

    it('writes the pictures of each variant from the gallery of its own product, whole', async () => {
      const one = await withGallery();
      const two = await withGallery();

      const res = await patchBatch({
        items: [
          { variantId: one.product.variantId, images: [{ imageId: one.gallery[2], position: 2 }] },
          {
            variantId: two.product.variantId,
            images: [
              { imageId: two.gallery[1], position: 1 },
              { imageId: two.gallery[0], position: 5 },
            ],
          },
        ],
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().items[0].variant.images).toEqual([
        expect.objectContaining({ id: one.gallery[2], position: 2 }),
      ]);
      expect(await imagesOfVariant(one.product.variantId)).toEqual([[one.gallery[2], 2]]);
      expect(await imagesOfVariant(two.product.variantId)).toEqual([
        [two.gallery[1], 1],
        [two.gallery[0], 5],
      ]);
      expect(
        await auditLinesOf('variant', two.product.variantId, ['variant.update_batch']),
      ).toEqual([
        expect.objectContaining({
          meta: [
            {
              field: 'images',
              old: [{ imageId: two.gallery[0], position: 1 }],
              new: [
                { imageId: two.gallery[1], position: 1 },
                { imageId: two.gallery[0], position: 5 },
              ],
            },
          ],
        }),
      ]);
    });

    it('takes all the pictures away with an empty list, and a buyer no longer sees the variant', async () => {
      const { product, gallery } = await withGallery();

      const res = await patchBatch({ items: [{ variantId: product.variantId, images: [] }] });

      expect(res.statusCode).toBe(200);
      expect(res.json().items[0].variant).toMatchObject({
        visible: false,
        image: null,
        images: [],
      });
      expect(await imagesOfVariant(product.variantId)).toEqual([]);
      const card = await app.inject({ method: 'GET', url: `/api/products/${product.id}` });
      expect(card.statusCode).toBe(404);
      expect(
        (await auditLinesOf('variant', product.variantId, ['variant.update_batch']))[0]!.meta,
      ).toEqual([{ field: 'images', old: [{ imageId: gallery[0], position: 1 }], new: [] }]);
    });

    it('writes no line for the pictures a variant shows already', async () => {
      const { product, gallery } = await withGallery();

      const res = await patchBatch({
        items: [{ variantId: product.variantId, images: [{ imageId: gallery[0], position: 1 }] }],
      });

      expect(res.statusCode).toBe(200);
      expect(await auditLinesOf('variant', product.variantId, ['variant.update_batch'])).toEqual(
        [],
      );
    });

    it('lets two variants of one product show the same picture, each with the list of its own', async () => {
      const { product, gallery } = await withGallery();
      const second = await createVariant(product.id);

      const res = await patchBatch({
        items: [
          { variantId: product.variantId, images: [{ imageId: gallery[1], position: 1 }] },
          {
            variantId: second.id,
            images: [
              { imageId: gallery[1], position: 1 },
              { imageId: gallery[2], position: 2 },
            ],
          },
        ],
      });

      expect(res.statusCode).toBe(200);
      expect(await imagesOfVariant(product.variantId)).toEqual([[gallery[1], 1]]);
      expect(await imagesOfVariant(second.id)).toEqual([
        [gallery[1], 1],
        [gallery[2], 2],
      ]);
    });

    it('names the item whose picture is not in the gallery of its product, and writes nothing', async () => {
      const one = await withGallery();
      const two = await withGallery();

      const res = await patchBatch({
        items: [
          {
            variantId: one.product.variantId,
            price: 21,
            images: [{ imageId: one.gallery[1], position: 1 }],
          },
          // a picture of the gallery of the other product
          {
            variantId: two.product.variantId,
            images: [{ imageId: one.gallery[2], position: 1 }],
          },
        ],
      });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode: 'VARIANTS_INVALID' });
      expect(refusedOf(res)).toEqual([
        {
          variantId: two.product.variantId,
          errorCode: 'VARIANT_IMAGE_NOT_FOUND',
          details: { imageIds: [one.gallery[2]] },
        },
      ]);
      expect(await priceOf(one.product.variantId)).toBe(20);
      expect(await imagesOfVariant(one.product.variantId)).toEqual([[one.gallery[0], 1]]);
      expect(await imagesOfVariant(two.product.variantId)).toEqual([[two.gallery[0], 1]]);
    });

    it('names every item whose pictures are wrong by the request alone', async () => {
      const { product, gallery } = await withGallery();
      const other = await withGallery();

      const res = await patchBatch({
        items: [
          {
            variantId: product.variantId,
            images: [
              { imageId: gallery[1], position: 1 },
              { imageId: gallery[1], position: 2 },
            ],
          },
          {
            variantId: other.product.variantId,
            images: [
              { imageId: other.gallery[1], position: 1 },
              { imageId: other.gallery[2], position: 1 },
            ],
          },
          {
            variantId: MISSING,
            images: Array.from({ length: MAX_VARIANT_IMAGES + 1 }, (_, i) => ({
              imageId: 1,
              position: i + 1,
            })),
          },
        ],
      });

      expect(res.statusCode).toBe(400);
      expect(refusedOf(res)).toEqual([
        {
          variantId: product.variantId,
          errorCode: 'VARIANT_IMAGES_REPEATED',
          details: expect.anything(),
        },
        {
          variantId: other.product.variantId,
          errorCode: 'VARIANT_IMAGE_POSITION_INVALID',
          details: expect.anything(),
        },
        {
          variantId: MISSING,
          errorCode: 'VARIANT_IMAGES_TOO_MANY',
          details: { max: MAX_VARIANT_IMAGES },
        },
      ]);
      expect(await imagesOfVariant(product.variantId)).toEqual([[gallery[0], 1]]);
    });

    it.each([
      ['null', null],
      ['a number', 5],
      ['a text', 'first'],
      ['an object', { imageId: 1, position: 1 }],
    ])('refuses pictures that are %s', async (_case, images) => {
      const { product, gallery } = await withGallery();

      const res = await patchBatch({ items: [{ variantId: product.variantId, images }] });

      expect(res.statusCode).toBe(400);
      expect(res.json().errorCode).toBe('VALIDATION_ERROR');
      expect(await imagesOfVariant(product.variantId)).toEqual([[gallery[0], 1]]);
    });
  });

  // all of it or none, and the refusal names every item refused with its own error
  it('names every item refused, of any kind, and writes none of the items', async () => {
    const one = await newProduct();
    const [first] = await galleryIdsOf(one.id);
    const other = await newProduct();
    const [foreign] = await galleryIdsOf(other.id);
    const onSale = await newProduct();
    await saleRoute(onSale.id, onSale.variantId);
    const plain = await newProduct();
    const [plainFirst] = await galleryIdsOf(plain.id);
    const plainSecond = await addGalleryImage(plain.id);

    const res = await patchBatch({
      items: [
        { variantId: plain.variantId, price: 21, images: [{ imageId: plainSecond, position: 1 }] },
        { variantId: one.variantId, images: [{ imageId: foreign!, position: 1 }] },
        { variantId: onSale.variantId, price: 25 },
        { variantId: MISSING, images: [] },
        { variantId: other.variantId, position: 1, sku: `Fine-${uniqueTag()}` },
      ],
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VARIANTS_INVALID' });
    expect(refusedOf(res)).toEqual([
      {
        variantId: one.variantId,
        errorCode: 'VARIANT_IMAGE_NOT_FOUND',
        details: { imageIds: [foreign] },
      },
      {
        variantId: onSale.variantId,
        errorCode: 'PRODUCT_SALE_DECISION_REQUIRED',
        details: { salePrice: 15, saleEndsAt: expect.any(String) },
      },
      { variantId: MISSING, errorCode: 'VARIANT_NOT_FOUND' },
    ]);
    expect(await priceOf(plain.variantId)).toBe(20);
    expect(await imagesOfVariant(plain.variantId)).toEqual([[plainFirst, 1]]);
    expect(await imagesOfVariant(one.variantId)).toEqual([[first, 1]]);
    expect(await variantRowsOf(other.id)).toEqual([expect.objectContaining({ sku: null })]);
    expect(await auditLinesOf('variant', plain.variantId, ['variant.update_batch'])).toEqual([]);
  });

  it('refuses a stock in an item with the fields of one variant, as before', async () => {
    const product = await newProduct();

    const res = await patchBatch({
      items: [{ variantId: product.variantId, sku: `Stock-${uniqueTag()}`, stock: 5 }],
    });

    expect(res.statusCode).toBe(400);
    expect(refusedOf(res)).toEqual([
      { variantId: product.variantId, errorCode: 'PRODUCT_STOCK_NOT_ALLOWED' },
    ]);
  });

  it.each([
    ['a user', () => buyer],
    ['a guest', () => null],
  ])('refuses %s', async (_who, actorOf) => {
    const product = await newProduct();

    const res = await patchBatch(
      { items: [{ variantId: product.variantId, price: 21 }] },
      actorOf(),
    );

    expect(res.statusCode).toBe(403);
    expect(res.json().errorCode).toBe('INSUFFICIENT_ROLE');
    expect(await priceOf(product.variantId)).toBe(20);
  });

  it('lets two requests over the same variants in another order both go through', async () => {
    const first = await newProduct(20);
    const second = await newProduct(20);

    const [prices, weights] = await Promise.all([
      patchBatch({
        items: [
          { variantId: first.variantId, price: 21 },
          { variantId: second.variantId, price: 22 },
        ],
      }),
      patchBatch({
        items: [
          { variantId: second.variantId, weightGrams: 200 },
          { variantId: first.variantId, weightGrams: 100 },
        ],
      }),
    ]);

    expect([prices.statusCode, weights.statusCode]).toEqual([200, 200]);
    expect(await priceOf(first.variantId)).toBe(21);
    expect(await priceOf(second.variantId)).toBe(22);
    expect((await variantRowsOf(first.id))[0]!.weightGrams).toBe(100);
    expect((await variantRowsOf(second.id))[0]!.weightGrams).toBe(200);
  });
});
