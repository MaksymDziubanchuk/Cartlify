import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { asAdmin } from '../../../helpers/db.js';
import {
  closeSessions,
  createAttribute,
  createCategory,
  createProduct,
  createUser,
  createVariant,
  deleteProductFromCatalog,
  type TestUser,
} from '../../../helpers/factories.js';
import { markVariantDeleted, stripVariantImages } from '../../../helpers/variants.js';

// The alerts of the gaps of the catalog count what the list they name shows: the alert
// `variants_missing_required` the variants of the list with missingRequired, and
// `products_hidden_from_buyers` the products of the list with hiddenFromBuyers. The count is of the
// whole shop, so this file runs alone (shopwide) and reads the numbers before and after each step

let app: FastifyInstance;
let admin: TestUser;
const userIds: number[] = [];

beforeAll(async () => {
  app = await startApp();
  admin = await createUser({ role: 'ADMIN' });
  userIds.push(admin.id);
});

afterAll(async () => {
  try {
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

const get = (url: string) =>
  app.inject({ method: 'GET', url, headers: { cookie: accessCookie(admin) } });

type Alert = {
  kind: string;
  count: number;
  list: { path: string; query: Record<string, string> };
};

// the alert of a kind and the total of the list it names, read one after the other
async function alertAndList(kind: string) {
  const res = await get('/api/admin/alerts');
  expect(res.statusCode).toBe(200);
  const alert = (res.json().alerts as Alert[]).find((item) => item.kind === kind)!;

  const list = await get(
    `${alert.list.path}?${new URLSearchParams({ ...alert.list.query, limit: '1' })}`,
  );
  expect(list.statusCode).toBe(200);

  return { count: alert.count, total: list.json().total as number };
}

const requiredIn = async (categoryId: number) => {
  const attribute = await createAttribute({ type: 'text' });
  await asAdmin((tx) =>
    tx.categoryAttribute.create({
      data: { categoryId, attributeId: attribute.id, required: true },
    }),
  );
};

describe('the alert of the variants that lack a required characteristic', () => {
  it('counts the variants its list shows, before and after the variants come and go', async () => {
    const before = await alertAndList('variants_missing_required');
    expect(before.count).toBe(before.total);

    const { id: categoryId } = await createCategory();
    await requiredIn(categoryId);
    const product = await createProduct({ categoryId, stock: 1 });
    await createVariant(product.id, { stock: 1 });
    const gone = await createVariant(product.id, { stock: 1 });
    await markVariantDeleted(gone.id);
    const removed = await createProduct({ categoryId, stock: 1 });
    await deleteProductFromCatalog(removed.id);

    const after = await alertAndList('variants_missing_required');

    // the two live variants of the product are the new cases; the variant taken out of sale and the
    // variant of the removed product are none
    expect(after.count).toBe(before.count + 2);
    expect(after.total).toBe(after.count);
  });
});

describe('the alert of the products hidden from buyers', () => {
  it('counts the products its list shows, before and after the products come and go', async () => {
    const before = await alertAndList('products_hidden_from_buyers');
    expect(before.count).toBe(before.total);

    const noPicture = await createProduct({ stock: 1 });
    await stripVariantImages(noPicture.variantId);
    const allRemoved = await createProduct({ stock: 1 });
    await markVariantDeleted(allRemoved.variantId);
    const removed = await createProduct({ stock: 1 });
    await deleteProductFromCatalog(removed.id);
    await createProduct({ stock: 1 });

    const after = await alertAndList('products_hidden_from_buyers');

    // the product without a picture and the product none of whose variants is alive are new cases;
    // the product removed on purpose and the product that is seen are none
    expect(after.count).toBe(before.count + 2);
    expect(after.total).toBe(after.count);
  });
});
