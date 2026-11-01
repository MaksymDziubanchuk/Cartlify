import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { shopToday } from '@helpers/shopDay.js';

import { asAdmin } from '../../../helpers/db.js';
import { dayAfter } from '../../../helpers/dbStock.js';
import {
  closeSessions,
  createProduct,
  createUser,
  createVariant,
  deleteProductFromCatalog,
  receiveBatch,
  stockOf,
  uniqueTag,
  type TestProduct,
  type TestUser,
} from '../../../helpers/factories.js';
import { placeOrder } from '../../../helpers/orders.js';
import {
  auditLinesOf,
  lockVariantRow,
  markVariantDeleted,
  uniqueBarcode,
  whileLocked,
} from '../../../helpers/variants.js';

// POST /api/products/stock/deliveries and /write-offs: the stock of a variant comes only with a
// delivery and goes out with a write-off (or a sale). A delivery takes in a batch of each of its
// items at its cost; a write-off takes free units from the batch named, or from the batches in the
// order a sale takes them (the one that ends first, then the oldest). An item names its variant by
// its id, its article number or its barcode. The database keeps the batches and a line of the
// admin log for each variant; a request changes all or nothing

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
let root: TestUser;
const userIds: number[] = [];
// a product with batches keeps them, an order keeps its product: these stay for the run
const products: TestProduct[] = [];

const newUser = async (opts: Parameters<typeof createUser>[0] = {}) => {
  const user = await createUser(opts);
  userIds.push(user.id);
  return user;
};

// a product without stock unless asked: the test takes in its own batches
const newProduct = async (opts: Parameters<typeof createProduct>[0] = {}) => {
  const product = await createProduct({ stock: 0, ...opts });
  products.push(product);
  return product;
};

const post = (path: string, payload: object, actor: TestUser = admin) =>
  app.inject({
    method: 'POST',
    url: `/api/products/stock/${path}`,
    headers: withCsrf(csrf, accessCookie(actor)),
    payload,
  });

const deliver = (payload: object, actor?: TestUser) => post('deliveries', payload, actor);
const writeOff = (payload: object, actor?: TestUser) => post('write-offs', payload, actor);

const batchesOf = (variantId: number) =>
  asAdmin((tx) =>
    tx.productBatch.findMany({
      where: { variantId },
      orderBy: { id: 'asc' },
      select: { id: true, remaining: true },
    }),
  );

// the lines of the stock log of a variant: one for each change of its stock
const linesOf = (variantId: number, event: 'stock.delivery' | 'stock.write_off') =>
  asAdmin((tx) =>
    tx.stockLog.findMany({
      where: { variantId, event },
      orderBy: { id: 'asc' },
      select: {
        actorId: true,
        actorRole: true,
        quantityChange: true,
        stockAfter: true,
        deliveryId: true,
        writeOffId: true,
        orderId: true,
        meta: true,
      },
    }),
  );

// the lines of the admin log that carry the id of an operation: one for a whole delivery or
// write-off, whatever the number of its variants
const operationLinesOf = (field: 'deliveryId' | 'writeOffId', id: string) =>
  asAdmin(
    (tx) => tx.$queryRaw<
      {
        entityType: string;
        entityId: number | null;
        action: string;
        event: string;
        actorId: number;
        actorRole: string;
        meta: { field: string; old: unknown; new: unknown }[];
      }[]
    >`
      select "entityType"::text as "entityType", "entityId", action::text as action, event,
             "actorId", "actorRole"::text as "actorRole", meta
      from cartlify.admin_audit_log
      where meta @> ${JSON.stringify([{ field, new: id }])}::jsonb
      order by id
    `,
  );

type Change = { field: string; new: unknown };
const fieldOf = (meta: unknown, field: string) =>
  (meta as Change[]).find((change) => change.field === field)?.new;

// a day by the calendar of utc, yyyy-mm-dd
const utcDay = (offsetDays = 0) =>
  new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const sku = () => `STK-${uniqueTag()}`;

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await newUser({ role: 'ADMIN' });
  root = await newUser({ role: 'ROOT' });
});

afterAll(async () => {
  try {
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

describe('POST /api/products/stock/deliveries', () => {
  it('takes in the batches of a delivery of several variants and answers with them', async () => {
    const first = await newProduct({ name: `Delivered ${uniqueTag()}` });
    const secondSku = sku();
    const second = await newProduct({ name: `Delivered ${uniqueTag()}`, sku: secondSku });

    const res = await deliver({
      source: 'supplier',
      supplier: 'Acme',
      document: 'INV-1',
      note: 'Morning truck',
      items: [
        {
          variantId: first.variantId,
          quantity: 10,
          unitCost: 2.5,
          expiresAt: utcDay(90),
          supplierBatchNumber: 'LOT-A',
        },
        { variantId: second.variantId, quantity: 4, unitCost: 0 },
      ],
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.deliveryId).toMatch(UUID);
    const refOf = async (product: TestProduct, code: string | null) => {
      const { name } = await asAdmin((tx) =>
        tx.product.findUniqueOrThrow({ where: { id: product.id }, select: { name: true } }),
      );
      return {
        productId: product.id,
        variantId: product.variantId,
        product: { id: product.id, name },
        variant: { id: product.variantId, position: 1, name, sku: code },
      };
    };
    expect(body.batches).toEqual([
      {
        ...(await refOf(first, null)),
        id: expect.any(Number),
        source: 'supplier',
        supplierBatchNumber: 'LOT-A',
        unitCost: 2.5,
        quantity: 10,
        remaining: 10,
        expiresAt: utcDay(90),
        createdAt: expect.any(String),
      },
      {
        ...(await refOf(second, secondSku)),
        id: expect.any(Number),
        source: 'supplier',
        supplierBatchNumber: null,
        unitCost: 0,
        quantity: 4,
        remaining: 4,
        expiresAt: null,
        createdAt: expect.any(String),
      },
    ]);
    expect(body.variants).toEqual(
      [first, second]
        .map((product) => ({ variantId: product.variantId, productId: product.id }))
        .sort((a, b) => a.variantId - b.variantId)
        .map((ref) => ({
          ...ref,
          stock: ref.variantId === first.variantId ? 10 : 4,
          totalStock: ref.variantId === first.variantId ? 10 : 4,
          reservedStock: 0,
          expiredStock: 0,
        })),
    );
    expect(await stockOf(first.id)).toEqual({ stock: 10, reservedStock: 0 });

    // a line of the stock log for each item, in the name of the admin, the same delivery in each
    const [line] = await linesOf(first.variantId, 'stock.delivery');
    expect(line).toMatchObject({
      actorId: admin.id,
      actorRole: 'ADMIN',
      quantityChange: 10,
      stockAfter: 10,
      deliveryId: body.deliveryId,
      writeOffId: null,
      orderId: null,
    });
    expect(fieldOf(line!.meta, 'supplier')).toBe('Acme');
    expect(fieldOf(line!.meta, 'document')).toBe('INV-1');
    expect(fieldOf(line!.meta, 'note')).toBe('Morning truck');
    expect((await linesOf(second.variantId, 'stock.delivery'))[0]).toMatchObject({
      quantityChange: 4,
      stockAfter: 4,
      deliveryId: body.deliveryId,
    });
    // one line of the admin log for the whole delivery, with the same id; the delivery touched two
    // variants, so the line is about no thing
    expect(await operationLinesOf('deliveryId', body.deliveryId)).toEqual([
      {
        entityType: 'other',
        entityId: null,
        action: 'STOCK_DELIVERY',
        event: 'stock.delivery',
        actorId: admin.id,
        actorRole: 'ADMIN',
        meta: [
          { field: 'deliveryId', old: null, new: body.deliveryId },
          { field: 'source', old: null, new: 'supplier' },
          { field: 'supplier', old: null, new: 'Acme' },
          { field: 'document', old: null, new: 'INV-1' },
          { field: 'note', old: null, new: 'Morning truck' },
          { field: 'variants', old: null, new: 2 },
          { field: 'quantity', old: null, new: 14 },
        ],
      },
    ]);
    // the admin log has no line of a variant or of the product for it
    expect(await auditLinesOf('variant', first.variantId, ['stock.delivery'])).toEqual([]);
    expect(await auditLinesOf('product', first.id, ['stock.delivery'])).toEqual([]);
  });

  it('keeps one line of the admin log about the variant when a delivery touches one variant only', async () => {
    const product = await newProduct();

    const res = await deliver({
      source: 'surplus',
      supplier: 'Found',
      items: [
        { variantId: product.variantId, quantity: 2, unitCost: 1 },
        { variantId: product.variantId, quantity: 3, unitCost: 1 },
      ],
    });

    expect(res.statusCode).toBe(201);
    // two batches, two lines of the stock log, one line of the admin log
    expect(await linesOf(product.variantId, 'stock.delivery')).toEqual([
      expect.objectContaining({
        quantityChange: 2,
        stockAfter: 2,
        deliveryId: res.json().deliveryId,
      }),
      expect.objectContaining({
        quantityChange: 3,
        stockAfter: 5,
        deliveryId: res.json().deliveryId,
      }),
    ]);
    expect(await operationLinesOf('deliveryId', res.json().deliveryId)).toEqual([
      expect.objectContaining({
        entityType: 'variant',
        entityId: product.variantId,
        action: 'STOCK_DELIVERY',
        meta: [
          { field: 'deliveryId', old: null, new: res.json().deliveryId },
          { field: 'source', old: null, new: 'surplus' },
          { field: 'supplier', old: null, new: 'Found' },
          { field: 'variants', old: null, new: 1 },
          { field: 'quantity', old: null, new: 5 },
        ],
      }),
    ]);
  });

  it('leaves no line of the stock log nor of the admin log when a later item of the delivery fails', async () => {
    const product = await newProduct();
    const gone = await newProduct();
    await markVariantDeleted(gone.variantId);

    const res = await deliver({
      source: 'supplier',
      items: [
        { variantId: product.variantId, quantity: 2, unitCost: 1 },
        { variantId: gone.variantId, quantity: 1, unitCost: 1 },
      ],
    });

    expect(res.statusCode).toBe(404);
    expect(await linesOf(product.variantId, 'stock.delivery')).toEqual([]);
    expect(await auditLinesOf('variant', product.variantId, ['stock.delivery'])).toEqual([]);
  });

  it('takes in the variants of one product apart: each has its stock, the answer names each once', async () => {
    const product = await newProduct();
    const second = await createVariant(product.id, { stock: 0 });

    const res = await deliver({
      source: 'supplier',
      items: [
        { variantId: second.id, quantity: 3, unitCost: 1 },
        { variantId: product.variantId, quantity: 5, unitCost: 2 },
      ],
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.batches.map((batch: { variantId: number }) => batch.variantId)).toEqual([
      second.id,
      product.variantId,
    ]);
    expect(
      body.batches.map((batch: { variant: { position: number } }) => batch.variant.position),
    ).toEqual([2, 1]);
    expect(body.variants).toEqual([
      expect.objectContaining({ variantId: product.variantId, productId: product.id, stock: 5 }),
      expect.objectContaining({ variantId: second.id, productId: product.id, stock: 3 }),
    ]);
    expect(await stockOf({ variantId: second.id })).toEqual({ stock: 3, reservedStock: 0 });
    expect(await stockOf(product.id)).toEqual({ stock: 5, reservedStock: 0 });
  });

  it('takes in two batches of one variant in one delivery, the variant answers once', async () => {
    const product = await newProduct();

    const res = await deliver({
      source: 'supplier',
      items: [
        { variantId: product.variantId, quantity: 3, unitCost: 1, expiresAt: utcDay(10) },
        { variantId: product.variantId, quantity: 2, unitCost: 1.2, expiresAt: utcDay(40) },
      ],
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().batches).toHaveLength(2);
    expect(res.json().variants).toEqual([
      {
        variantId: product.variantId,
        productId: product.id,
        stock: 5,
        totalStock: 5,
        reservedStock: 0,
        expiredStock: 0,
      },
    ]);
    // a line of the stock log for each batch
    expect(await linesOf(product.variantId, 'stock.delivery')).toHaveLength(2);
  });

  describe('the ways to name a variant', () => {
    it('takes the article number whatever its case, the barcode and the id in one delivery', async () => {
      const code = sku();
      const barcode = uniqueBarcode();
      const byId = await newProduct();
      const byBarcode = await newProduct({ barcode });
      const bySku = await newProduct({ sku: code });

      const res = await deliver({
        source: 'supplier',
        items: [
          { variantId: byId.variantId, quantity: 1, unitCost: 1 },
          { sku: ` ${code.toLowerCase()} `, quantity: 2, unitCost: 1 },
          { barcode, quantity: 3, unitCost: 1 },
        ],
      });

      expect(res.statusCode).toBe(201);
      expect(
        res
          .json()
          .batches.map((batch: { variantId: number; quantity: number }) => [
            batch.variantId,
            batch.quantity,
          ]),
      ).toEqual([
        [byId.variantId, 1],
        [bySku.variantId, 2],
        [byBarcode.variantId, 3],
      ]);
      expect(await stockOf(bySku.id)).toEqual({ stock: 2, reservedStock: 0 });
      expect(await stockOf(byBarcode.id)).toEqual({ stock: 3, reservedStock: 0 });
    });

    it('takes one variant named twice, by its id and by its barcode, as two batches', async () => {
      const barcode = uniqueBarcode();
      const code = sku();
      const product = await newProduct({ barcode, sku: code });

      const res = await deliver({
        source: 'supplier',
        items: [
          { variantId: product.variantId, quantity: 2, unitCost: 1 },
          { barcode, quantity: 3, unitCost: 2 },
          { sku: code, quantity: 4, unitCost: 3 },
        ],
      });

      expect(res.statusCode).toBe(201);
      expect(res.json().batches).toHaveLength(3);
      expect(res.json().variants).toEqual([
        expect.objectContaining({ variantId: product.variantId, stock: 9, totalStock: 9 }),
      ]);
      expect((await batchesOf(product.variantId)).map((batch) => batch.remaining)).toEqual([
        2, 3, 4,
      ]);
    });

    it('finds the live variant that took the number of one taken out of sale', async () => {
      const code = sku();
      const old = await newProduct({ sku: code });
      await markVariantDeleted(old.variantId);
      const fresh = await newProduct({ sku: code });

      const res = await deliver({
        source: 'supplier',
        items: [{ sku: code, quantity: 1, unitCost: 1 }],
      });

      expect(res.statusCode).toBe(201);
      expect(res.json().batches[0]).toMatchObject({ variantId: fresh.variantId });
      expect(await batchesOf(old.variantId)).toEqual([]);
    });
  });

  describe('the cost and the last good day of the delivery', () => {
    it('stand in for the items that have none of their own and give way to the ones they have', async () => {
      const product = await newProduct();
      const day = utcDay(60);

      const res = await deliver({
        source: 'supplier',
        unitCost: 3,
        expiresAt: day,
        items: [
          { variantId: product.variantId, quantity: 1 },
          { variantId: product.variantId, quantity: 1, unitCost: 1.5 },
          { variantId: product.variantId, quantity: 1, expiresAt: utcDay(70) },
          { variantId: product.variantId, quantity: 1, expiresAt: null },
          { variantId: product.variantId, quantity: 1, unitCost: 0 },
        ],
      });

      expect(res.statusCode).toBe(201);
      expect(
        res
          .json()
          .batches.map((batch: { unitCost: number; expiresAt: string | null }) => [
            batch.unitCost,
            batch.expiresAt,
          ]),
      ).toEqual([
        [3, day],
        [1.5, day],
        [3, utcDay(70)],
        [3, null],
        [0, day],
      ]);
    });

    it('take the cost of the delivery for every item when no item has one', async () => {
      const first = await newProduct();
      const second = await newProduct();

      const res = await deliver({
        source: 'surplus',
        unitCost: 4.25,
        items: [
          { variantId: first.variantId, quantity: 1 },
          { variantId: second.variantId, quantity: 2 },
        ],
      });

      expect(res.statusCode).toBe(201);
      expect(res.json().batches.map((batch: { unitCost: number }) => batch.unitCost)).toEqual([
        4.25, 4.25,
      ]);
    });

    it('name every item with a cost of neither its own nor the delivery, and take in nothing', async () => {
      const first = await newProduct();
      const secondSku = sku();
      const thirdBarcode = uniqueBarcode();
      const second = await newProduct({ sku: secondSku });
      await newProduct({ barcode: thirdBarcode });

      const res = await deliver({
        source: 'supplier',
        items: [
          { variantId: first.variantId, quantity: 1, unitCost: 1 },
          { sku: secondSku, quantity: 1 },
          { barcode: thirdBarcode, quantity: 1 },
          { variantId: first.variantId, quantity: 1 },
        ],
      });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({
        errorCode: 'BATCH_UNIT_COST_REQUIRED',
        details: {
          items: [
            { index: 1, sku: secondSku },
            { index: 2, barcode: thirdBarcode },
            { index: 3, variantId: first.variantId },
          ],
        },
      });
      expect(await batchesOf(first.variantId)).toEqual([]);
      expect(await stockOf(second.id)).toEqual({ stock: 0, reservedStock: 0 });
    });

    it('refuse a cost of the delivery finer than a cent or below zero', async () => {
      const product = await newProduct();
      const item = { variantId: product.variantId, quantity: 1, unitCost: 1 };

      const fine = await deliver({ source: 'supplier', unitCost: 1.005, items: [item] });
      const negative = await deliver({ source: 'supplier', unitCost: -1, items: [item] });

      expect(fine.statusCode).toBe(400);
      expect(fine.json()).toMatchObject({ errorCode: 'BATCH_UNIT_COST_INVALID' });
      expect(negative.statusCode).toBe(400);
      expect(negative.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
      expect(await batchesOf(product.variantId)).toEqual([]);
    });

    it('refuse a last good day of the delivery that is over, even when every item has its own', async () => {
      const product = await newProduct();

      const res = await deliver({
        source: 'supplier',
        expiresAt: dayAfter(shopToday(), -1),
        items: [{ variantId: product.variantId, quantity: 1, unitCost: 1, expiresAt: utcDay(30) }],
      });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode: 'BATCH_EXPIRES_AT_INVALID' });
      expect(await batchesOf(product.variantId)).toEqual([]);
    });
  });

  // an inventory finds more than the stock says, a buyer brings goods back: the admin gives the
  // cost they count at
  it.each(['surplus', 'customer_return'])('takes in a batch of %s', async (source) => {
    const product = await newProduct();

    const res = await deliver({
      source,
      items: [{ variantId: product.variantId, quantity: 1, unitCost: 4 }],
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().batches[0]).toMatchObject({ source, unitCost: 4 });
  });

  it('lets root take in a delivery', async () => {
    const product = await newProduct();

    const res = await deliver(
      {
        source: 'supplier',
        items: [{ variantId: product.variantId, quantity: 1, unitCost: 1 }],
      },
      root,
    );

    expect(res.statusCode).toBe(201);
    expect((await linesOf(product.variantId, 'stock.delivery'))[0]).toMatchObject({
      actorId: root.id,
      actorRole: 'ROOT',
    });
    expect(await operationLinesOf('deliveryId', res.json().deliveryId)).toEqual([
      expect.objectContaining({ actorId: root.id, actorRole: 'ROOT' }),
    ]);
  });

  describe('a variant the shop cannot take goods in for', () => {
    it('takes in nothing when one variant of the delivery is out of sale', async () => {
      const kept = await newProduct();
      const removed = await newProduct();
      await markVariantDeleted(removed.variantId);

      const res = await deliver({
        source: 'supplier',
        items: [
          { variantId: kept.variantId, quantity: 5, unitCost: 1 },
          { variantId: removed.variantId, quantity: 5, unitCost: 1 },
        ],
      });

      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({
        errorCode: 'VARIANT_NOT_FOUND',
        details: { variantIds: [removed.variantId] },
      });
      expect(await batchesOf(kept.variantId)).toEqual([]);
      expect(await stockOf(kept.id)).toEqual({ stock: 0, reservedStock: 0 });
    });

    it('refuses the variants of a product removed from the catalog, by id, article number and barcode', async () => {
      const code = sku();
      const barcode = uniqueBarcode();
      const product = await newProduct({ sku: code, barcode });
      await deleteProductFromCatalog(product.id);

      const byId = await deliver({
        source: 'supplier',
        items: [{ variantId: product.variantId, quantity: 1, unitCost: 1 }],
      });
      const bySku = await deliver({
        source: 'supplier',
        items: [{ sku: code, quantity: 1, unitCost: 1 }],
      });
      const byBarcode = await deliver({
        source: 'supplier',
        items: [{ barcode, quantity: 1, unitCost: 1 }],
      });

      expect(byId.statusCode).toBe(404);
      expect(byId.json()).toMatchObject({
        errorCode: 'VARIANT_NOT_FOUND',
        details: { variantIds: [product.variantId] },
      });
      expect(bySku.statusCode).toBe(404);
      expect(bySku.json()).toMatchObject({ details: { skus: [code] } });
      expect(byBarcode.statusCode).toBe(404);
      expect(byBarcode.json()).toMatchObject({ details: { barcodes: [barcode] } });
      expect(await batchesOf(product.variantId)).toEqual([]);
    });

    it('refuses a variant that does not exist', async () => {
      const res = await deliver({
        source: 'supplier',
        items: [{ variantId: 2_000_000_000, quantity: 1, unitCost: 1 }],
      });

      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({
        errorCode: 'VARIANT_NOT_FOUND',
        details: { variantIds: [2_000_000_000] },
      });
    });

    it('lists every id, article number and barcode nothing answers to, once each', async () => {
      const good = await newProduct();
      const missingSku = sku();
      const missingBarcode = uniqueBarcode();

      const res = await deliver({
        source: 'supplier',
        items: [
          { variantId: 2_000_000_001, quantity: 1, unitCost: 1 },
          { sku: ` ${missingSku} `, quantity: 1, unitCost: 1 },
          { variantId: good.variantId, quantity: 1, unitCost: 1 },
          { barcode: missingBarcode, quantity: 1, unitCost: 1 },
          { sku: missingSku.toLowerCase(), quantity: 1, unitCost: 1 },
          { variantId: 2_000_000_001, quantity: 2, unitCost: 1 },
        ],
      });

      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({
        errorCode: 'VARIANT_NOT_FOUND',
        details: {
          variantIds: [2_000_000_001],
          skus: [missingSku, missingSku.toLowerCase()],
          barcodes: [missingBarcode],
        },
      });
      expect(await batchesOf(good.variantId)).toEqual([]);
    });

    it('does not find by number or barcode a variant that is out of sale', async () => {
      const code = sku();
      const barcode = uniqueBarcode();
      const product = await newProduct({ sku: code, barcode });
      await markVariantDeleted(product.variantId);

      const res = await deliver({
        source: 'supplier',
        items: [
          { sku: code, quantity: 1, unitCost: 1 },
          { barcode, quantity: 1, unitCost: 1 },
        ],
      });

      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ details: { skus: [code], barcodes: [barcode] } });
    });

    // the variant goes out of sale while the delivery waits for its row: the database refuses it
    it('answers 404 for a variant that went out of sale after the request looked at it', async () => {
      const product = await newProduct();

      const res = await whileLocked(
        (tx) => lockVariantRow(tx, product.variantId),
        () =>
          deliver({
            source: 'supplier',
            items: [{ variantId: product.variantId, quantity: 1, unitCost: 1 }],
          }),
        {
          waiters: 1,
          beforeRelease: async (tx) => {
            await tx.productVariant.update({
              where: { id: product.variantId },
              data: { deletedAt: new Date() },
            });
          },
        },
      );

      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({
        errorCode: 'VARIANT_NOT_FOUND',
        details: { variantIds: [product.variantId] },
      });
      expect(await batchesOf(product.variantId)).toEqual([]);
    });
  });

  // the rows of the variants are locked in the order of their ids: deliveries sent at once wait for
  // one another, none is lost
  it('takes in deliveries of one variant sent at once without losing a unit', async () => {
    const product = await newProduct();
    const second = await createVariant(product.id, { stock: 0 });

    const results = await Promise.all(
      Array.from({ length: 4 }, (_, n) =>
        deliver({
          source: 'supplier',
          // the variants in opposite orders: the same order of the locks makes no deadlock
          items:
            n % 2 === 0
              ? [
                  { variantId: product.variantId, quantity: 1, unitCost: 1 },
                  { variantId: second.id, quantity: 2, unitCost: 1 },
                ]
              : [
                  { variantId: second.id, quantity: 2, unitCost: 1 },
                  { variantId: product.variantId, quantity: 1, unitCost: 1 },
                ],
        }),
      ),
    );

    expect(results.map((res) => res.statusCode)).toEqual([201, 201, 201, 201]);
    expect(await stockOf(product.id)).toEqual({ stock: 4, reservedStock: 0 });
    expect(await stockOf({ variantId: second.id })).toEqual({ stock: 8, reservedStock: 0 });
    expect(await batchesOf(product.variantId)).toHaveLength(4);
  });

  it('refuses a cost finer than a cent', async () => {
    const product = await newProduct();

    const res = await deliver({
      source: 'supplier',
      items: [{ variantId: product.variantId, quantity: 1, unitCost: 1.555 }],
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'BATCH_UNIT_COST_INVALID' });
    expect(await batchesOf(product.variantId)).toEqual([]);
  });

  // today is the day of the shop (SHOP_TIME_ZONE): late in the evening of utc it is already the
  // next day in Madrid, and the day of utc is over there
  it('refuses a batch whose last good day is over and takes one good until today', async () => {
    const product = await newProduct();
    const item = (expiresAt: string) => ({
      variantId: product.variantId,
      quantity: 1,
      unitCost: 1,
      expiresAt,
    });

    const over = await deliver({ source: 'supplier', items: [item(dayAfter(shopToday(), -1))] });
    const today = await deliver({ source: 'supplier', items: [item(shopToday())] });

    expect(over.statusCode).toBe(400);
    expect(over.json()).toMatchObject({ errorCode: 'BATCH_EXPIRES_AT_INVALID' });
    expect(today.statusCode).toBe(201);
  });

  it.each([
    ['no items', { items: [] }],
    ['no source', { source: undefined }],
    ['an unknown source', { source: 'gift' }],
    ['no units', { items: [{ quantity: 0 }] }],
    ['a part of a unit', { items: [{ quantity: 1.5 }] }],
    ['a cost below zero', { items: [{ unitCost: -1 }] }],
    ['a cost that is not a number', { items: [{ unitCost: 'cheap' }] }],
    ['a cost of the delivery that is not a number', { unitCost: 'cheap' }],
    ['an end that is not a day', { items: [{ expiresAt: '2026-13-01' }] }],
    ['an end of the delivery that is not a day', { expiresAt: '2026-13-01' }],
    ['a supplier name over 200 characters', { supplier: 'x'.repeat(201) }],
    ['an invoice over 100 characters', { document: 'x'.repeat(101) }],
    ['a note over 500 characters', { note: 'x'.repeat(501) }],
    [
      'a number of the supplier over 100 characters',
      { items: [{ supplierBatchNumber: 'x'.repeat(101) }] },
    ],
    ['an item that names no variant', { items: [{ variantId: undefined }] }],
    ['an item that names its variant twice', { items: [{ sku: 'ABC' }] }],
    [
      'an item that names its variant by all three ways',
      { items: [{ sku: 'ABC', barcode: '4006381333931' }] },
    ],
    [
      'an item that names a product, not a variant',
      { items: [{ variantId: undefined, productId: 1 }] },
    ],
    ['a variant id of 0', { items: [{ variantId: 0 }] }],
    ['an empty article number', { items: [{ variantId: undefined, sku: '' }] }],
    [
      'an article number over 64 characters',
      { items: [{ variantId: undefined, sku: 'x'.repeat(65) }] },
    ],
    ['a barcode with letters', { items: [{ variantId: undefined, barcode: '40063813A3931' }] }],
    ['a barcode of 7 digits', { items: [{ variantId: undefined, barcode: '4006381' }] }],
    ['a barcode of 15 digits', { items: [{ variantId: undefined, barcode: '400638133393100' }] }],
  ])('refuses a delivery with %s', async (_case, patch) => {
    const product = await newProduct();
    const base = {
      source: 'supplier',
      items: [{ variantId: product.variantId, quantity: 1, unitCost: 1 }],
    };
    const { items, ...rest } = patch as { items?: object[] };
    const payload = {
      ...base,
      ...rest,
      items: items ? items.map((item) => ({ ...base.items[0], ...item })) : base.items,
    };

    const res = await deliver(payload);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
    expect(await batchesOf(product.variantId)).toEqual([]);
  });

  it('refuses more than 100 items in a delivery', async () => {
    const product = await newProduct();
    const items = Array.from({ length: 101 }, () => ({
      variantId: product.variantId,
      quantity: 1,
      unitCost: 1,
    }));

    const res = await deliver({ source: 'supplier', items });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
  });

  it('takes in 100 items of one delivery', async () => {
    const product = await newProduct();
    const items = Array.from({ length: 100 }, () => ({
      variantId: product.variantId,
      quantity: 1,
      unitCost: 1,
    }));

    const res = await deliver({ source: 'supplier', items });

    expect(res.statusCode).toBe(201);
    expect(res.json().batches).toHaveLength(100);
    expect(await stockOf(product.id)).toEqual({ stock: 100, reservedStock: 0 });
  });

  it('refuses a user', async () => {
    const product = await newProduct();

    const res = await deliver(
      {
        source: 'supplier',
        items: [{ variantId: product.variantId, quantity: 1, unitCost: 1 }],
      },
      await newUser(),
    );

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ errorCode: 'INSUFFICIENT_ROLE' });
  });

  it('refuses a visitor who is not signed in (a guest has no role of the shop)', async () => {
    const product = await newProduct();

    const res = await app.inject({
      method: 'POST',
      url: '/api/products/stock/deliveries',
      headers: withCsrf(csrf),
      payload: {
        source: 'supplier',
        items: [{ variantId: product.variantId, quantity: 1, unitCost: 1 }],
      },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ errorCode: 'INSUFFICIENT_ROLE' });
    expect(await batchesOf(product.variantId)).toEqual([]);
  });

  it('refuses a request without the csrf token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/products/stock/deliveries',
      headers: { cookie: accessCookie(admin) },
      payload: { source: 'supplier', items: [{ variantId: 1, quantity: 1, unitCost: 1 }] },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ errorCode: 'CSRF_TOKEN_INVALID' });
  });
});

describe('POST /api/products/stock/write-offs', () => {
  it('writes off units of the batch an admin names and answers with what it took', async () => {
    const product = await newProduct({ name: `Written off ${uniqueTag()}` });
    const first = await receiveBatch(product.id, { quantity: 4, unitCost: 2 });
    const second = await receiveBatch(product.id, { quantity: 5, unitCost: 3 });

    const res = await writeOff({
      reason: 'damaged',
      note: 'Wet box',
      items: [{ variantId: product.variantId, batchId: second, quantity: 2 }],
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    const { name } = await asAdmin((tx) =>
      tx.product.findUniqueOrThrow({ where: { id: product.id }, select: { name: true } }),
    );
    expect(body.writeOffId).toMatch(UUID);
    expect(body.items).toEqual([
      {
        productId: product.id,
        variantId: product.variantId,
        product: { id: product.id, name },
        variant: { id: product.variantId, position: 1, name, sku: null },
        quantity: 2,
        batches: [{ batchId: second, quantity: 2, unitCost: 3 }],
      },
    ]);
    expect(body.variants).toEqual([
      {
        variantId: product.variantId,
        productId: product.id,
        stock: 7,
        totalStock: 7,
        reservedStock: 0,
        expiredStock: 0,
      },
    ]);
    expect(await batchesOf(product.variantId)).toEqual([
      { id: first, remaining: 4 },
      { id: second, remaining: 3 },
    ]);

    // the line of the stock log of the variant, in the name of the admin, with the id of the write-off
    const [line] = await linesOf(product.variantId, 'stock.write_off');
    expect(line).toMatchObject({
      actorId: admin.id,
      actorRole: 'ADMIN',
      quantityChange: -2,
      stockAfter: 7,
      deliveryId: null,
      writeOffId: body.writeOffId,
      orderId: null,
    });
    expect(fieldOf(line!.meta, 'reason')).toBe('damaged');
    expect(fieldOf(line!.meta, 'batches')).toEqual([
      { batchId: second, quantity: 2, unitCost: '3' },
    ]);
    expect(fieldOf(line!.meta, 'note')).toBe('Wet box');
    // one line of the admin log for the write-off, about the variant it touched, with the same id
    expect(await operationLinesOf('writeOffId', body.writeOffId)).toEqual([
      {
        entityType: 'variant',
        entityId: product.variantId,
        action: 'STOCK_WRITE_OFF',
        event: 'stock.write_off',
        actorId: admin.id,
        actorRole: 'ADMIN',
        meta: [
          { field: 'writeOffId', old: null, new: body.writeOffId },
          { field: 'reason', old: null, new: 'damaged' },
          { field: 'note', old: null, new: 'Wet box' },
          { field: 'variants', old: null, new: 1 },
          { field: 'quantity', old: null, new: 2 },
        ],
      },
    ]);
  });

  it('writes off from the batches in the order a sale takes them when no batch is named', async () => {
    const product = await newProduct();
    const noEnd = await receiveBatch(product.id, { quantity: 3, unitCost: 1 });
    const soon = await receiveBatch(product.id, { quantity: 2, unitCost: 2, expiresAt: utcDay(5) });

    const res = await writeOff({
      reason: 'shortage',
      items: [{ variantId: product.variantId, quantity: 3 }],
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().items[0].batches).toEqual([
      { batchId: soon, quantity: 2, unitCost: 2 },
      { batchId: noEnd, quantity: 1, unitCost: 1 },
    ]);
  });

  // the batch named gives its units first, the rest of the variant follows the order of a sale
  it('takes the units of a batch named before the units of the same variant without one', async () => {
    const product = await newProduct();
    const older = await receiveBatch(product.id, { quantity: 3, unitCost: 1 });
    const named = await receiveBatch(product.id, {
      quantity: 2,
      unitCost: 2,
      expiresAt: utcDay(5),
    });

    const res = await writeOff({
      reason: 'expired',
      items: [
        { variantId: product.variantId, quantity: 3 },
        { variantId: product.variantId, batchId: named, quantity: 2 },
      ],
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().items).toEqual([
      expect.objectContaining({
        variantId: product.variantId,
        quantity: 3,
        batches: [{ batchId: older, quantity: 3, unitCost: 1 }],
      }),
      expect.objectContaining({
        variantId: product.variantId,
        quantity: 2,
        batches: [{ batchId: named, quantity: 2, unitCost: 2 }],
      }),
    ]);
    expect(await stockOf(product.id)).toEqual({ stock: 0, reservedStock: 0 });
  });

  describe('the ways to name a variant', () => {
    it('takes the article number and the barcode as well as the id, each variant answers once', async () => {
      const code = sku();
      const barcode = uniqueBarcode();
      const bySku = await newProduct({ sku: code });
      const byBarcode = await newProduct({ barcode });
      const byId = await newProduct();
      for (const product of [bySku, byBarcode, byId])
        await receiveBatch(product.id, { quantity: 5 });

      const res = await writeOff({
        reason: 'damaged',
        items: [
          { sku: code.toLowerCase(), quantity: 1 },
          { barcode, quantity: 2 },
          { variantId: byId.variantId, quantity: 3 },
          { variantId: bySku.variantId, quantity: 1 },
        ],
      });

      expect(res.statusCode).toBe(201);
      expect(
        res
          .json()
          .items.map((item: { variantId: number; quantity: number }) => [
            item.variantId,
            item.quantity,
          ]),
      ).toEqual([
        [bySku.variantId, 1],
        [byBarcode.variantId, 2],
        [byId.variantId, 3],
        [bySku.variantId, 1],
      ]);
      expect(res.json().variants).toHaveLength(3);
      expect(await stockOf(bySku.id)).toEqual({ stock: 3, reservedStock: 0 });
      expect(await stockOf(byBarcode.id)).toEqual({ stock: 3, reservedStock: 0 });
      expect(await stockOf(byId.id)).toEqual({ stock: 2, reservedStock: 0 });
    });

    it('counts the lines that name one variant in different ways together', async () => {
      const code = sku();
      const barcode = uniqueBarcode();
      const product = await newProduct({ sku: code, barcode, stock: 3 });

      const res = await writeOff({
        reason: 'damaged',
        items: [
          { sku: code, quantity: 2 },
          { barcode, quantity: 2 },
        ],
      });

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({
        errorCode: 'INSUFFICIENT_AVAILABLE_STOCK',
        details: { variants: [{ variantId: product.variantId, available: 3, requested: 4 }] },
      });
      expect(await stockOf(product.id)).toEqual({ stock: 3, reservedStock: 0 });
    });

    it('does not find by number or barcode a variant that is out of sale, and lists them', async () => {
      const code = sku();
      const barcode = uniqueBarcode();
      const product = await newProduct({ sku: code, barcode, stock: 2 });
      await markVariantDeleted(product.variantId);

      const res = await writeOff({
        reason: 'damaged',
        items: [
          { sku: code, quantity: 1 },
          { barcode, quantity: 1 },
        ],
      });

      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({
        errorCode: 'VARIANT_NOT_FOUND',
        details: { skus: [code], barcodes: [barcode] },
      });
      expect(await stockOf(product.id)).toEqual({ stock: 2, reservedStock: 0 });
    });
  });

  it('writes off nothing when one variant has not enough free units, and names each of them', async () => {
    const plenty = await newProduct({ stock: 5 });
    const scarce = await newProduct({ stock: 1 });
    const alsoScarce = await newProduct({ stock: 0 });

    const res = await writeOff({
      reason: 'damaged',
      items: [
        { variantId: plenty.variantId, quantity: 2 },
        { variantId: scarce.variantId, quantity: 3 },
        { variantId: alsoScarce.variantId, quantity: 1 },
      ],
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      errorCode: 'INSUFFICIENT_AVAILABLE_STOCK',
      details: {
        variants: [
          { variantId: scarce.variantId, available: 1, requested: 3 },
          { variantId: alsoScarce.variantId, available: 0, requested: 1 },
        ].sort((a, b) => a.variantId - b.variantId),
      },
    });
    expect(await stockOf(plenty.id)).toEqual({ stock: 5, reservedStock: 0 });
  });

  // the stock is the stock of a variant: another variant of the product cannot lend its units
  it('counts the free units of a variant apart from the other variants of its product', async () => {
    const product = await newProduct({ stock: 5 });
    const second = await createVariant(product.id, { stock: 1 });

    const res = await writeOff({
      reason: 'damaged',
      items: [{ variantId: second.id, quantity: 3 }],
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      errorCode: 'INSUFFICIENT_AVAILABLE_STOCK',
      details: { variants: [{ variantId: second.id, available: 1, requested: 3 }] },
    });
    expect(await stockOf(product.id)).toEqual({ stock: 5, reservedStock: 0 });
    expect(await stockOf({ variantId: second.id })).toEqual({ stock: 1, reservedStock: 0 });
  });

  it('writes off the variants of one product in one request, each from its own batches', async () => {
    const product = await newProduct({ stock: 4 });
    const second = await createVariant(product.id, { stock: 6 });

    const res = await writeOff({
      reason: 'defective',
      items: [
        { variantId: second.id, quantity: 2 },
        { variantId: product.variantId, quantity: 1 },
      ],
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().items.map((item: { variantId: number }) => item.variantId)).toEqual([
      second.id,
      product.variantId,
    ]);
    expect(res.json().variants).toEqual([
      expect.objectContaining({ variantId: product.variantId, stock: 3 }),
      expect.objectContaining({ variantId: second.id, stock: 4 }),
    ]);
    // a line of the stock log for each variant, all of them with the id of the write-off
    const lines = [
      ...(await linesOf(second.id, 'stock.write_off')),
      ...(await linesOf(product.variantId, 'stock.write_off')),
    ];
    expect(lines.map((line) => [line.quantityChange, line.stockAfter])).toEqual([
      [-2, 4],
      [-1, 3],
    ]);
    expect(lines.every((line) => line.writeOffId === res.json().writeOffId)).toBe(true);
    // one line of the admin log for the whole write-off, about no thing: it touched two variants
    expect(await operationLinesOf('writeOffId', res.json().writeOffId)).toEqual([
      expect.objectContaining({
        entityType: 'other',
        entityId: null,
        action: 'STOCK_WRITE_OFF',
        meta: [
          { field: 'writeOffId', old: null, new: res.json().writeOffId },
          { field: 'reason', old: null, new: 'defective' },
          { field: 'variants', old: null, new: 2 },
          { field: 'quantity', old: null, new: 3 },
        ],
      }),
    ]);
  });

  it('leaves no line when a later item of the write-off is refused', async () => {
    const product = await newProduct({ stock: 4 });
    const second = await createVariant(product.id, { stock: 1 });

    const res = await writeOff({
      reason: 'damaged',
      items: [
        { variantId: product.variantId, quantity: 1 },
        { variantId: second.id, quantity: 3 },
      ],
    });

    expect(res.statusCode).toBe(409);
    expect(await linesOf(product.variantId, 'stock.write_off')).toEqual([]);
    expect(await linesOf(second.id, 'stock.write_off')).toEqual([]);
    expect(await auditLinesOf('variant', product.variantId, ['stock.write_off'])).toEqual([]);
  });

  it('counts the lines of one variant together against its free units', async () => {
    const product = await newProduct({ stock: 3 });

    const res = await writeOff({
      reason: 'damaged',
      items: [
        { variantId: product.variantId, quantity: 2 },
        { variantId: product.variantId, quantity: 2 },
      ],
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      details: { variants: [{ variantId: product.variantId, available: 3, requested: 4 }] },
    });
  });

  it('keeps the units the waiting orders hold', async () => {
    const product = await newProduct({ stock: 5 });
    await placeOrder(app, csrf, await newUser(), product, 'waiting', 4);

    const res = await writeOff({
      reason: 'damaged',
      items: [{ variantId: product.variantId, quantity: 2 }],
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      errorCode: 'INSUFFICIENT_AVAILABLE_STOCK',
      details: { variants: [{ variantId: product.variantId, available: 1, requested: 2 }] },
    });
    expect(await stockOf(product.id)).toEqual({ stock: 5, reservedStock: 4 });
  });

  it('lets only one of two write-offs of the last unit sent at once through', async () => {
    const product = await newProduct({ stock: 1 });
    const payload = {
      reason: 'damaged',
      items: [{ variantId: product.variantId, quantity: 1 }],
    };

    const results = await Promise.all([writeOff(payload), writeOff(payload)]);

    expect(results.map((res) => res.statusCode).sort()).toEqual([201, 409]);
    const refused = results.find((res) => res.statusCode === 409)!;
    expect(refused.json()).toMatchObject({
      errorCode: 'INSUFFICIENT_AVAILABLE_STOCK',
      details: { variants: [{ variantId: product.variantId, available: 0, requested: 1 }] },
    });
    expect(await stockOf(product.id)).toEqual({ stock: 0, reservedStock: 0 });
  });

  it('refuses more than the batch named has left', async () => {
    const product = await newProduct();
    const small = await receiveBatch(product.id, { quantity: 1 });
    await receiveBatch(product.id, { quantity: 5 });

    const res = await writeOff({
      reason: 'damaged',
      items: [{ variantId: product.variantId, batchId: small, quantity: 2 }],
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      errorCode: 'BATCH_INSUFFICIENT',
      details: { batches: [{ batchId: small, remaining: 1, requested: 2 }] },
    });
  });

  it('refuses a batch of another product', async () => {
    const product = await newProduct({ stock: 2 });
    const foreign = await receiveBatch((await newProduct()).id, { quantity: 2 });

    const res = await writeOff({
      reason: 'damaged',
      items: [{ variantId: product.variantId, batchId: foreign, quantity: 1 }],
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({
      errorCode: 'BATCH_NOT_FOUND',
      details: { batchId: foreign },
    });
  });

  it('refuses a batch of another variant of the same product', async () => {
    const product = await newProduct({ stock: 2 });
    const second = await createVariant(product.id, { stock: 0 });
    const ofSecond = await receiveBatch({ variantId: second.id }, { quantity: 2 });

    const res = await writeOff({
      reason: 'damaged',
      items: [{ variantId: product.variantId, batchId: ofSecond, quantity: 1 }],
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({
      errorCode: 'BATCH_NOT_FOUND',
      details: { batchId: ofSecond },
    });
    expect(await stockOf({ variantId: second.id })).toEqual({ stock: 2, reservedStock: 0 });
  });

  it('writes off what a variant taken out of sale has left, named by its id', async () => {
    const product = await newProduct({ stock: 2 });
    await markVariantDeleted(product.variantId);

    const res = await writeOff({
      reason: 'defective',
      items: [{ variantId: product.variantId, quantity: 2 }],
    });

    expect(res.statusCode).toBe(201);
    expect(await stockOf(product.id)).toEqual({ stock: 0, reservedStock: 0 });
  });

  it('writes off what a product removed from the catalog has left', async () => {
    const product = await newProduct({ stock: 2 });
    await deleteProductFromCatalog(product.id);

    const res = await writeOff({
      reason: 'defective',
      items: [{ variantId: product.variantId, quantity: 2 }],
    });

    expect(res.statusCode).toBe(201);
    expect(await stockOf(product.id)).toEqual({ stock: 0, reservedStock: 0 });
  });

  it('refuses a variant that does not exist', async () => {
    const res = await writeOff({
      reason: 'damaged',
      items: [{ variantId: 2_000_000_000, quantity: 1 }],
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({
      errorCode: 'VARIANT_NOT_FOUND',
      details: { variantIds: [2_000_000_000] },
    });
  });

  it('lists every id, article number and barcode nothing answers to', async () => {
    const good = await newProduct({ stock: 1 });
    const missingSku = sku();
    const missingBarcode = uniqueBarcode();

    const res = await writeOff({
      reason: 'damaged',
      items: [
        { variantId: good.variantId, quantity: 1 },
        { variantId: 2_000_000_002, quantity: 1 },
        { sku: missingSku, quantity: 1 },
        { barcode: missingBarcode, quantity: 1 },
      ],
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({
      errorCode: 'VARIANT_NOT_FOUND',
      details: { variantIds: [2_000_000_002], skus: [missingSku], barcodes: [missingBarcode] },
    });
    expect(await stockOf(good.id)).toEqual({ stock: 1, reservedStock: 0 });
  });

  it('asks the reason other for a note that says what it is', async () => {
    const product = await newProduct({ stock: 2 });
    const item = { variantId: product.variantId, quantity: 1 };

    const bare = await writeOff({ reason: 'other', note: '  ', items: [item] });
    const told = await writeOff({ reason: 'other', note: 'Sample for a blogger', items: [item] });

    expect(bare.statusCode).toBe(400);
    expect(bare.json()).toMatchObject({ errorCode: 'WRITE_OFF_NOTE_REQUIRED' });
    expect(told.statusCode).toBe(201);
    expect(await stockOf(product.id)).toEqual({ stock: 1, reservedStock: 0 });
  });

  it.each(['returned_to_supplier', 'shortage'])('writes off with the reason %s', async (reason) => {
    const product = await newProduct({ stock: 1 });

    const res = await writeOff({ reason, items: [{ variantId: product.variantId, quantity: 1 }] });

    expect(res.statusCode).toBe(201);
  });

  it.each([
    ['no items', { items: [] }],
    ['no reason', { reason: undefined }],
    ['an unknown reason', { reason: 'stolen' }],
    ['no units', { items: [{ quantity: 0 }] }],
    ['a note over 500 characters', { note: 'x'.repeat(501) }],
    ['an item that names no variant', { items: [{ variantId: undefined }] }],
    ['an item that names its variant twice', { items: [{ sku: 'ABC' }] }],
    [
      'an item that names a product, not a variant',
      { items: [{ variantId: undefined, productId: 1 }] },
    ],
    ['a barcode with letters', { items: [{ variantId: undefined, barcode: '40063813A3931' }] }],
    ['a barcode of 7 digits', { items: [{ variantId: undefined, barcode: '4006381' }] }],
    ['a batch id of 0', { items: [{ batchId: 0 }] }],
  ])('refuses a write-off with %s', async (_case, patch) => {
    const product = await newProduct({ stock: 2 });
    const base = { reason: 'damaged', items: [{ variantId: product.variantId, quantity: 1 }] };
    const { items, ...rest } = patch as { items?: object[] };
    const payload = {
      ...base,
      ...rest,
      items: items ? items.map((item) => ({ ...base.items[0], ...item })) : base.items,
    };

    const res = await writeOff(payload);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
    expect(await stockOf(product.id)).toEqual({ stock: 2, reservedStock: 0 });
  });

  it('refuses a user', async () => {
    const product = await newProduct({ stock: 1 });

    const res = await writeOff(
      { reason: 'damaged', items: [{ variantId: product.variantId, quantity: 1 }] },
      await newUser(),
    );

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ errorCode: 'INSUFFICIENT_ROLE' });
  });

  it('refuses a visitor who is not signed in, and lets root write off', async () => {
    const product = await newProduct({ stock: 2 });
    const payload = { reason: 'damaged', items: [{ variantId: product.variantId, quantity: 1 }] };

    const visitor = await app.inject({
      method: 'POST',
      url: '/api/products/stock/write-offs',
      headers: withCsrf(csrf),
      payload,
    });
    const byRoot = await writeOff(payload, root);

    expect(visitor.statusCode).toBe(403);
    expect(visitor.json()).toMatchObject({ errorCode: 'INSUFFICIENT_ROLE' });
    expect(byRoot.statusCode).toBe(201);
    expect(await stockOf(product.id)).toEqual({ stock: 1, reservedStock: 0 });
  });
});

describe('PATCH /api/products/:productId', () => {
  // the stock changes only with a delivery or a write-off, each with its line and reason
  it('refuses a stock and changes nothing', async () => {
    const product = await newProduct({ stock: 4 });

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/products/${product.id}`,
      headers: withCsrf(csrf, accessCookie(admin)),
      payload: { name: 'Renamed', stock: 3 },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'PRODUCT_STOCK_NOT_ALLOWED' });
    expect(await stockOf(product.id)).toEqual({ stock: 4, reservedStock: 0 });
    const { name } = await asAdmin((tx) =>
      tx.product.findUniqueOrThrow({ where: { id: product.id }, select: { name: true } }),
    );
    expect(name).not.toBe('Renamed');
  });
});
