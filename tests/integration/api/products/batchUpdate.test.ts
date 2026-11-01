import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { asAdmin } from '../../../helpers/db.js';
import {
  closeSessions,
  createCategory,
  createParty,
  createProduct,
  createUser,
  createVariant,
  deleteProductFromCatalog,
  removeProducts,
  uniqueTag,
  type TestProduct,
  type TestUser,
} from '../../../helpers/factories.js';

// PATCH /api/products/batch changes many products at once, each with fields of its own, all of
// them or none: the change of each is the one of PATCH /api/products/:productId, with its checks
// and every line of the logs, without images. The fields are the ones a product has; the price, the
// sale, the article number and the weight are the variants' (PATCH /api/products/variants/batch).
// A refusal names in details.products every product refused the same way, and nothing is changed.
// The rows are locked by id, so two such requests over the same products wait for each other

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
let buyer: TestUser;
const products: TestProduct[] = [];

const MISSING_ID = 2_000_000_000;

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await createUser({ role: 'ADMIN' });
  buyer = await createUser();
});

afterAll(async () => {
  try {
    await removeProducts(products);
    await closeSessions([admin.id, buyer.id]);
  } finally {
    await stopApp();
  }
});

const newProduct = async (opts: Parameters<typeof createProduct>[0] = {}) => {
  const product = await createProduct(opts);
  products.push(product);
  return product;
};

const patchBatch = (payload: Record<string, unknown>, actor: TestUser = admin) =>
  app.inject({
    method: 'PATCH',
    url: '/api/products/batch',
    headers: withCsrf(csrf, accessCookie(actor)),
    payload,
  });

const rowsOf = async (ids: number[]) => {
  const rows = await asAdmin((tx) =>
    tx.product.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true, warnings: true, categoryId: true, manufacturerId: true },
    }),
  );
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.map((id) => byId.get(id)!);
};

const productUpdatesOf = (productId: number, event = 'product.update_batch') =>
  asAdmin((tx) =>
    tx.adminAuditLog.findMany({
      where: { entityType: 'product', entityId: productId, event },
      orderBy: { id: 'asc' },
      select: { actorId: true, action: true, meta: true },
    }),
  );

const fieldsOf = (meta: unknown) => (meta as Array<{ field: string }>).map((c) => c.field).sort();

describe('PATCH /api/products/batch', () => {
  it('changes each product with fields of its own and writes the logs of each', async () => {
    const first = await newProduct({ price: 20 });
    const second = await newProduct({ price: 30 });
    const category = await createCategory();
    const party = await createParty();
    const name = `Batch product ${uniqueTag()}`;

    // the order of the request is no order of ids: the answer keeps the one of the request
    const res = await patchBatch({
      items: [
        { productId: second.id, name, categoryId: category.id },
        { productId: first.id, warnings: 'Keep dry.', manufacturerId: party.id },
      ],
    });

    expect(res.statusCode).toBe(200);
    const cards = res.json().products as Array<{
      product: Record<string, unknown>;
      variant: Record<string, unknown>;
      variants: unknown[];
    }>;
    expect(cards).toHaveLength(2);
    // each answer is the card of an admin: the product, the variant it opens and the variants
    expect(cards[0]!.product).toMatchObject({
      id: second.id,
      name,
      category: { id: category.id, name: category.name },
    });
    expect(cards[0]!.variant).toMatchObject({ id: second.variantId, price: 30, lastUnitCost: 1 });
    expect(cards[0]!.variants).toHaveLength(1);
    expect(cards[0]!.variant).toHaveProperty('totalStock', 5);
    expect(cards[1]!.product).toMatchObject({
      id: first.id,
      warnings: 'Keep dry.',
      manufacturer: { id: party.id, name: party.name },
    });

    expect(await rowsOf([first.id, second.id])).toEqual([
      expect.objectContaining({ id: first.id, warnings: 'Keep dry.', manufacturerId: party.id }),
      expect.objectContaining({ id: second.id, name, categoryId: category.id }),
    ]);

    const [firstLine] = await productUpdatesOf(first.id);
    const [secondLine] = await productUpdatesOf(second.id);
    expect(firstLine!.actorId).toBe(admin.id);
    expect(firstLine!.action).toBe('PRODUCT_UPDATE');
    expect(fieldsOf(firstLine!.meta)).toEqual(['manufacturerId', 'warnings']);
    expect(fieldsOf(secondLine!.meta)).toEqual(['categoryId', 'name']);
  });

  it('opens the cards on the variant a buyer would get, with every variant of the product', async () => {
    const product = await newProduct({ price: 20 });
    const second = await createVariant(product.id, { price: 25 });

    const res = await patchBatch({
      items: [{ productId: product.id, name: `Two ${uniqueTag()}` }],
    });

    expect(res.statusCode).toBe(200);
    const [card] = res.json().products;
    expect(card.variant.id).toBe(product.variantId);
    expect(card.variants.map((variant: { id: number }) => variant.id)).toEqual([
      product.variantId,
      second.id,
    ]);
  });

  // the price, the sale, the article number and the weight are not fields of a product: the schema
  // drops them, as it does for PATCH of one product
  it('does not take the price, the sale, the article number or the weight: they belong to the variants', async () => {
    const product = await newProduct({ price: 20, weightGrams: 350 });
    const name = `Dropped ${uniqueTag()}`;

    const mixed = await patchBatch({
      items: [
        { productId: product.id, name, price: 99, sku: 'NOPE', weightGrams: 1, sale: 'keep' },
      ],
    });
    const alone = await patchBatch({ items: [{ productId: product.id, price: 99, sku: 'NOPE' }] });

    expect(mixed.statusCode).toBe(200);
    expect(mixed.json().products[0].variant).toMatchObject({
      price: 20,
      sku: null,
      weightGrams: 350,
    });
    expect((await rowsOf([product.id]))[0]!.name).toBe(name);
    expect(alone.statusCode).toBe(400);
    expect(alone.json()).toMatchObject({
      errorCode: 'NO_FIELDS_TO_UPDATE',
      details: { products: [{ productId: product.id }] },
    });
  });

  it('answers 404 with the products it cannot change', async () => {
    const product = await newProduct({ price: 20 });
    const gone = await newProduct({ price: 20 });
    await deleteProductFromCatalog(gone.id);
    const name = `Changed ${uniqueTag()}`;

    const res = await patchBatch({
      items: [
        { productId: product.id, name },
        { productId: MISSING_ID, name: 'Nobody' },
      ],
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({
      errorCode: 'PRODUCT_NOT_FOUND',
      details: { products: [{ productId: MISSING_ID }] },
    });
    expect((await rowsOf([product.id]))[0]!.name).not.toBe(name);
  });

  it('changes a product taken out of the catalog too', async () => {
    const gone = await newProduct({ price: 20 });
    await deleteProductFromCatalog(gone.id);
    const name = `Gone ${uniqueTag()}`;

    const res = await patchBatch({ items: [{ productId: gone.id, name }] });

    expect(res.statusCode).toBe(200);
    expect(res.json().products[0].product).toMatchObject({ id: gone.id, name });
    expect(res.json().products[0].product.deletedAt).not.toBeNull();
  });

  it('answers 404 for a category that is not there, naming the product', async () => {
    const product = await newProduct();
    const other = await newProduct({ price: 20 });
    const name = `Kept name ${uniqueTag()}`;

    const res = await patchBatch({
      items: [
        { productId: other.id, name },
        { productId: product.id, categoryId: MISSING_ID },
      ],
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({
      errorCode: 'CATEGORY_NOT_FOUND',
      details: { products: [{ productId: product.id }] },
    });
    expect((await rowsOf([other.id]))[0]!.name).not.toBe(name);
  });

  it('answers 404 for a manufacturer that is not in the directory', async () => {
    const product = await newProduct();

    const res = await patchBatch({
      items: [{ productId: product.id, manufacturerId: MISSING_ID }],
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({
      errorCode: 'MANUFACTURER_NOT_FOUND',
      details: { products: [{ productId: product.id }] },
    });
  });

  it.each([
    ['nothing to change', {}, 'NO_FIELDS_TO_UPDATE'],
    ['a stock', { stock: 5 }, 'PRODUCT_STOCK_NOT_ALLOWED'],
    ['a name of spaces', { name: '   ' }, 'PRODUCT_NAME_INVALID'],
    [
      'an override without its end',
      { popularityOverride: 5 },
      'POPULARITY_OVERRIDE_UNTIL_REQUIRED',
    ],
  ])('refuses %s with the product it holds for, and changes nothing', async (_, fields, code) => {
    const fine = await newProduct({ price: 20 });
    const refused = await newProduct({ price: 20 });
    const name = `Fine ${uniqueTag()}`;

    const res = await patchBatch({
      items: [
        { productId: fine.id, name },
        { productId: refused.id, ...fields },
      ],
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      errorCode: code,
      details: { products: [{ productId: refused.id }] },
    });
    expect((await rowsOf([fine.id]))[0]!.name).not.toBe(name);
  });

  it('names every product refused the same way', async () => {
    const first = await newProduct();
    const second = await newProduct();
    const fine = await newProduct();

    const res = await patchBatch({
      items: [
        { productId: first.id, name: ' ' },
        { productId: fine.id, name: 'Fine' },
        { productId: second.id, name: '  ' },
      ],
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      errorCode: 'PRODUCT_NAME_INVALID',
      details: { products: [{ productId: first.id }, { productId: second.id }] },
    });
  });

  it('refuses a product named twice', async () => {
    const product = await newProduct();

    const res = await patchBatch({
      items: [
        { productId: product.id, name: 'One' },
        { productId: product.id, name: 'Two' },
      ],
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      errorCode: 'PRODUCTS_REPEATED',
      details: { productIds: [product.id] },
    });
  });

  it('refuses an empty list and more than 100 products', async () => {
    const many = Array.from({ length: 101 }, (_, index) => ({ productId: index + 1, name: 'x' }));

    for (const items of [[], many]) {
      const res = await patchBatch({ items });

      expect(res.statusCode).toBe(400);
      expect(res.json().errorCode).toBe('VALIDATION_ERROR');
    }
  });

  it('lets only an admin or root change products', async () => {
    const product = await newProduct();

    const res = await patchBatch({ items: [{ productId: product.id, name: 'Mine' }] }, buyer);

    expect(res.statusCode).toBe(403);
    expect(res.json().errorCode).toBe('INSUFFICIENT_ROLE');
  });

  it('answers with the card of a product without a picture', async () => {
    const product = await newProduct();
    await asAdmin((tx) => tx.productImage.deleteMany({ where: { productId: product.id } }));
    const name = `Bare ${uniqueTag()}`;

    const res = await patchBatch({ items: [{ productId: product.id, name }] });

    expect(res.statusCode).toBe(200);
    const [card] = res.json().products;
    expect(card.product).toMatchObject({ id: product.id, name, gallery: [] });
    expect(card.variant).toMatchObject({ id: product.variantId, image: null, visible: false });
  });

  it('lets two requests over the same products in another order both go through', async () => {
    const first = await newProduct({ price: 20 });
    const second = await newProduct({ price: 20 });
    const [firstName, secondName] = [`First ${uniqueTag()}`, `Second ${uniqueTag()}`];

    const [warnings, names] = await Promise.all([
      patchBatch({
        items: [
          { productId: first.id, warnings: 'One.' },
          { productId: second.id, warnings: 'Two.' },
        ],
      }),
      patchBatch({
        items: [
          { productId: second.id, name: secondName },
          { productId: first.id, name: firstName },
        ],
      }),
    ]);

    expect([warnings.statusCode, names.statusCode]).toEqual([200, 200]);
    expect(await rowsOf([first.id, second.id])).toEqual([
      expect.objectContaining({ name: firstName, warnings: 'One.' }),
      expect.objectContaining({ name: secondName, warnings: 'Two.' }),
    ]);
  });
});
