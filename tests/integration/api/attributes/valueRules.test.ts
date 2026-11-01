import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { asAdmin } from '../../../helpers/db.js';
import {
  closeSessions,
  createAttribute,
  createAttributeOption,
  createProduct,
  createUser,
  createVariant,
  createVariantValue,
  removeProducts,
  type TestProduct,
  type TestUser,
} from '../../../helpers/factories.js';
import { markVariantDeleted } from '../../../helpers/variants.js';

// What the directory of characteristics may do once variants hold values of it: the type of a
// characteristic and a delete of it, a delete of a value of a list, and the replace of a value by
// another in every variant that has it (a rename needs no rule: the names are computed)

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
let user: TestUser;
const products: TestProduct[] = [];

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await createUser({ role: 'ADMIN' });
  user = await createUser();
});

afterAll(async () => {
  try {
    await removeProducts(products);
    await closeSessions([admin.id, user.id]);
  } finally {
    await stopApp();
  }
});

const newProduct = async (name?: string) => {
  const product = await createProduct(name ? { name } : {});
  products.push(product);
  return product;
};

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

const send = (who: TestUser | null, method: Method, url: string, payload?: object) =>
  app.inject({
    method,
    url,
    headers: who
      ? method === 'GET'
        ? { cookie: accessCookie(who) }
        : withCsrf(csrf, accessCookie(who))
      : withCsrf(csrf),
    ...(payload ? { payload } : {}),
  });

const asAdminUser = (method: Method, url: string, payload?: object) =>
  send(admin, method, url, payload);

const errorOf = (res: { statusCode: number; json: () => { errorCode?: string } }) => ({
  status: res.statusCode,
  code: res.json().errorCode,
});

const replaceUrl = (attributeId: number, optionId: number) =>
  `/api/admin/attributes/${attributeId}/options/${optionId}/replace`;

const auditOf = (entityId: number, event: string) =>
  asAdmin((tx) =>
    tx.adminAuditLog.findMany({
      where: { entityType: 'attribute', entityId, event },
      select: { actorId: true, action: true, meta: true },
    }),
  );

// what a variant holds of a characteristic of a list: the ids of the values, in the order of the ids
const optionsOf = async (variantId: number, attributeId: number) =>
  (
    await asAdmin((tx) =>
      tx.variantAttributeValue.findMany({
        where: { variantId, attributeId },
        orderBy: { optionId: 'asc' },
        select: { optionId: true },
      }),
    )
  ).map((row) => row.optionId);

describe('the type of a characteristic that a variant has a value of', () => {
  it('stays: 409 says how many variants hold a value and names the first products', async () => {
    const attribute = await createAttribute({ type: 'text' });
    const one = await newProduct();
    const two = await newProduct();
    const twoSecond = await createVariant(two.id);
    await createVariantValue(one.variantId, attribute.id, { text: 'a' });
    await createVariantValue(two.variantId, attribute.id, { text: 'b' });
    await createVariantValue(twoSecond.id, attribute.id, { text: 'c' });

    const res = await asAdminUser('PATCH', `/api/admin/attributes/${attribute.id}`, {
      type: 'boolean',
    });

    expect(errorOf(res)).toEqual({ status: 409, code: 'ATTRIBUTE_TYPE_LOCKED' });
    expect(res.json().details).toEqual({
      reason: 'variants',
      variantsCount: 3,
      productsTotal: 2,
      productIds: [one.id, two.id].sort((a, b) => a - b),
    });
    const kept = await asAdmin((tx) =>
      tx.attribute.findUniqueOrThrow({ where: { id: attribute.id } }),
    );
    expect(kept.type).toBe('text');
  });

  it('stays for a change between a choice and a set as well, which would keep the values', async () => {
    const attribute = await createAttribute({ type: 'option' });
    const option = await createAttributeOption(attribute.id);
    const product = await newProduct();
    await createVariantValue(product.variantId, attribute.id, { optionId: option.id });

    const res = await asAdminUser('PATCH', `/api/admin/attributes/${attribute.id}`, {
      type: 'options',
    });

    expect(errorOf(res)).toEqual({ status: 409, code: 'ATTRIBUTE_TYPE_LOCKED' });
  });

  it('changes once no variant holds a value, and a request that keeps the type is no business of the lock', async () => {
    const attribute = await createAttribute({ type: 'text' });
    const product = await newProduct();
    await createVariantValue(product.variantId, attribute.id, { text: 'a' });

    const renamed = await asAdminUser('PATCH', `/api/admin/attributes/${attribute.id}`, {
      name: `Renamed ${attribute.name}`,
      unit: 'mm',
    });
    await asAdmin((tx) =>
      tx.variantAttributeValue.deleteMany({ where: { attributeId: attribute.id } }),
    );
    const changed = await asAdminUser('PATCH', `/api/admin/attributes/${attribute.id}`, {
      type: 'boolean',
    });

    expect(renamed.statusCode).toBe(200);
    expect(changed.statusCode).toBe(200);
    expect(changed.json().type).toBe('boolean');
  });

  it('counts the variants taken out of sale too', async () => {
    const attribute = await createAttribute({ type: 'text' });
    const product = await newProduct();
    await createVariantValue(product.variantId, attribute.id, { text: 'a' });
    await markVariantDeleted(product.variantId);

    const res = await asAdminUser('PATCH', `/api/admin/attributes/${attribute.id}`, {
      type: 'boolean',
    });

    expect(errorOf(res)).toEqual({ status: 409, code: 'ATTRIBUTE_TYPE_LOCKED' });
  });
});

describe('DELETE /api/admin/attributes/:attributeId for a characteristic that a variant has a value of', () => {
  it('is refused: 409 names the products and counts the variants', async () => {
    const attribute = await createAttribute({ type: 'text' });
    const one = await newProduct();
    const two = await newProduct();
    await createVariantValue(one.variantId, attribute.id, { text: 'a' });
    await createVariantValue(two.variantId, attribute.id, { text: 'a' });

    const res = await asAdminUser('DELETE', `/api/admin/attributes/${attribute.id}`);

    expect(errorOf(res)).toEqual({ status: 409, code: 'ATTRIBUTE_IN_USE' });
    expect(res.json().details).toEqual({
      productIds: [one.id, two.id].sort((a, b) => a - b),
      productsTotal: 2,
      variantsCount: 2,
    });
    expect(await asAdmin((tx) => tx.attribute.count({ where: { id: attribute.id } }))).toBe(1);
  });

  it('names the categories that ask for it too, when both are so', async () => {
    const attribute = await createAttribute({ type: 'text' });
    const product = await newProduct();
    await createVariantValue(product.variantId, attribute.id, { text: 'a' });
    await asAdmin((tx) =>
      tx.categoryAttribute.create({
        data: { categoryId: product.categoryId, attributeId: attribute.id },
      }),
    );

    const res = await asAdminUser('DELETE', `/api/admin/attributes/${attribute.id}`);

    expect(errorOf(res)).toEqual({ status: 409, code: 'ATTRIBUTE_IN_USE' });
    expect(res.json().details).toEqual({
      categoryIds: [product.categoryId],
      total: 1,
      productIds: [product.id],
      productsTotal: 1,
      variantsCount: 1,
    });
  });

  it('goes once the values are taken away', async () => {
    const attribute = await createAttribute({ type: 'text' });
    const product = await newProduct();
    await createVariantValue(product.variantId, attribute.id, { text: 'a' });
    await asAdmin((tx) =>
      tx.variantAttributeValue.deleteMany({ where: { attributeId: attribute.id } }),
    );

    const res = await asAdminUser('DELETE', `/api/admin/attributes/${attribute.id}`);

    expect(res.statusCode).toBe(200);
  });
});

describe('DELETE /api/admin/attributes/:attributeId/options/:optionId for a value that a variant has', () => {
  it('is refused: 409 names the products with their variants', async () => {
    const attribute = await createAttribute({ type: 'option' });
    const option = await createAttributeOption(attribute.id);
    const free = await createAttributeOption(attribute.id);
    const one = await newProduct();
    const oneSecond = await createVariant(one.id);
    const two = await newProduct();
    await createVariantValue(one.variantId, attribute.id, { optionId: option.id });
    await createVariantValue(oneSecond.id, attribute.id, { optionId: option.id });
    await createVariantValue(two.variantId, attribute.id, { optionId: option.id });

    const res = await asAdminUser(
      'DELETE',
      `/api/admin/attributes/${attribute.id}/options/${option.id}`,
    );
    const unused = await asAdminUser(
      'DELETE',
      `/api/admin/attributes/${attribute.id}/options/${free.id}`,
    );

    expect(errorOf(res)).toEqual({ status: 409, code: 'ATTRIBUTE_OPTION_IN_USE' });
    expect(res.json().details).toEqual({
      variantsTotal: 3,
      productsTotal: 2,
      products: [
        { productId: one.id, variantIds: [one.variantId, oneSecond.id].sort((a, b) => a - b) },
        { productId: two.id, variantIds: [two.variantId] },
      ].sort((a, b) => a.productId - b.productId),
    });
    expect(unused.statusCode).toBe(200);
    expect(await asAdmin((tx) => tx.attributeOption.count({ where: { id: option.id } }))).toBe(1);
  });

  it('counts a value of a set, and goes when the variants hold other values', async () => {
    const attribute = await createAttribute({ type: 'options' });
    const a = await createAttributeOption(attribute.id);
    const b = await createAttributeOption(attribute.id);
    const product = await newProduct();
    await createVariantValue(product.variantId, attribute.id, { optionId: a.id });

    const held = await asAdminUser(
      'DELETE',
      `/api/admin/attributes/${attribute.id}/options/${a.id}`,
    );
    const other = await asAdminUser(
      'DELETE',
      `/api/admin/attributes/${attribute.id}/options/${b.id}`,
    );

    expect(errorOf(held)).toEqual({ status: 409, code: 'ATTRIBUTE_OPTION_IN_USE' });
    expect(other.statusCode).toBe(200);
  });
});

describe('POST /api/admin/attributes/:attributeId/options/:optionId/replace', () => {
  it('puts the value in the place of another in every variant that has it, the ones out of sale too', async () => {
    const colour = await createAttribute({ type: 'option', name: `Colour ${Math.random()}` });
    const graphite = await createAttributeOption(colour.id, { name: 'graphite' });
    const black = await createAttributeOption(colour.id, { name: 'black' });
    const white = await createAttributeOption(colour.id, { name: 'white' });
    const one = await newProduct('Replace A');
    const oneSecond = await createVariant(one.id);
    const two = await newProduct('Replace B');
    const twoSecond = await createVariant(two.id);
    await createVariantValue(one.variantId, colour.id, { optionId: graphite.id });
    await createVariantValue(oneSecond.id, colour.id, { optionId: white.id });
    await createVariantValue(two.variantId, colour.id, { optionId: graphite.id });
    await createVariantValue(twoSecond.id, colour.id, { optionId: white.id });
    await markVariantDeleted(two.variantId);

    const res = await asAdminUser('POST', replaceUrl(colour.id, graphite.id), {
      withOptionId: black.id,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ updatedCount: 2 });
    expect(await optionsOf(one.variantId, colour.id)).toEqual([black.id]);
    expect(await optionsOf(two.variantId, colour.id)).toEqual([black.id]);
    expect(await optionsOf(oneSecond.id, colour.id)).toEqual([white.id]);
    // the old value stays in the directory, for its own delete
    expect(await asAdmin((tx) => tx.attributeOption.count({ where: { id: graphite.id } }))).toBe(1);
    expect(
      (await asAdminUser('DELETE', `/api/admin/attributes/${colour.id}/options/${graphite.id}`))
        .statusCode,
    ).toBe(200);
    // one line of the admin log says how many variants changed
    expect(await auditOf(graphite.id, 'attribute_option.replace')).toEqual([
      {
        actorId: admin.id,
        action: 'OTHER',
        meta: [
          { field: 'optionId', old: graphite.id, new: black.id },
          { field: 'variants', old: null, new: 2 },
          { field: 'products', old: null, new: 2 },
        ],
      },
    ]);
    // the names follow the values at once
    const card = await app.inject({
      method: 'GET',
      url: `/api/products/${one.id}`,
      headers: { cookie: accessCookie(user) },
    });
    expect(card.json().variants.map((variant: { name: string }) => variant.name)).toEqual([
      'Replace A — black',
      'Replace A — white',
    ]);
  });

  it('changes nothing and tells which variants are the trouble when two would be alike', async () => {
    const colour = await createAttribute({ type: 'option' });
    const graphite = await createAttributeOption(colour.id, { name: 'graphite' });
    const black = await createAttributeOption(colour.id, { name: 'black' });
    const fine = await newProduct();
    const clash = await newProduct();
    const clashSecond = await createVariant(clash.id);
    await createVariantValue(fine.variantId, colour.id, { optionId: graphite.id });
    await createVariantValue(clash.variantId, colour.id, { optionId: graphite.id });
    await createVariantValue(clashSecond.id, colour.id, { optionId: black.id });

    const res = await asAdminUser('POST', replaceUrl(colour.id, graphite.id), {
      withOptionId: black.id,
    });

    expect(errorOf(res)).toEqual({ status: 409, code: 'VARIANT_DUPLICATE' });
    expect(res.json().details.variants).toEqual([
      { variantId: clash.variantId, sameAs: [{ variantId: clashSecond.id }] },
    ]);
    // all or nothing: the product that would have been fine keeps its value too
    expect(await optionsOf(fine.variantId, colour.id)).toEqual([graphite.id]);
    expect(await optionsOf(clash.variantId, colour.id)).toEqual([graphite.id]);
    expect(await auditOf(graphite.id, 'attribute_option.replace')).toEqual([]);
  });

  it('lets a variant of a set that has both just lose the old one', async () => {
    const features = await createAttribute({ type: 'options' });
    const old = await createAttributeOption(features.id, { name: 'old' });
    const next = await createAttributeOption(features.id, { name: 'next' });
    const other = await createAttributeOption(features.id, { name: 'other' });
    const product = await newProduct();
    const second = await createVariant(product.id);
    const third = await createVariant(product.id);
    // the first has both, the second the old and another, the third only the new
    await createVariantValue(product.variantId, features.id, { optionId: old.id });
    await createVariantValue(product.variantId, features.id, { optionId: next.id });
    await createVariantValue(second.id, features.id, { optionId: old.id });
    await createVariantValue(second.id, features.id, { optionId: other.id });
    await createVariantValue(third.id, features.id, { optionId: next.id });

    const res = await asAdminUser('POST', replaceUrl(features.id, old.id), {
      withOptionId: next.id,
    });

    // the second becomes {next, other}; the first stays {next}, which the third has: alike
    expect(errorOf(res)).toEqual({ status: 409, code: 'VARIANT_DUPLICATE' });
    expect(await optionsOf(product.variantId, features.id)).toEqual([old.id, next.id]);

    await asAdmin((tx) => tx.variantAttributeValue.deleteMany({ where: { variantId: third.id } }));
    const again = await asAdminUser('POST', replaceUrl(features.id, old.id), {
      withOptionId: next.id,
    });

    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({ updatedCount: 2 });
    expect(await optionsOf(product.variantId, features.id)).toEqual([next.id]);
    expect(await optionsOf(second.id, features.id)).toEqual(
      [next.id, other.id].sort((a, b) => a - b),
    );
  });

  it('answers 200 with 0 and writes no line when no variant has the value', async () => {
    const colour = await createAttribute({ type: 'option' });
    const a = await createAttributeOption(colour.id);
    const b = await createAttributeOption(colour.id);

    const res = await asAdminUser('POST', replaceUrl(colour.id, a.id), { withOptionId: b.id });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ updatedCount: 0 });
    expect(await auditOf(a.id, 'attribute_option.replace')).toEqual([]);
  });

  it('refuses the value in its own place, a value of another characteristic and one that is not there', async () => {
    const colour = await createAttribute({ type: 'option' });
    const other = await createAttribute({ type: 'option' });
    const a = await createAttributeOption(colour.id);
    const foreign = await createAttributeOption(other.id);

    const same = await asAdminUser('POST', replaceUrl(colour.id, a.id), { withOptionId: a.id });
    const alien = await asAdminUser('POST', replaceUrl(colour.id, a.id), {
      withOptionId: foreign.id,
    });
    const gone = await asAdminUser('POST', replaceUrl(colour.id, a.id), {
      withOptionId: 2_000_000_000,
    });
    const noOption = await asAdminUser('POST', replaceUrl(colour.id, 2_000_000_000), {
      withOptionId: a.id,
    });
    const wrongOwner = await asAdminUser('POST', replaceUrl(other.id, a.id), {
      withOptionId: foreign.id,
    });

    expect(errorOf(same)).toEqual({ status: 400, code: 'ATTRIBUTE_OPTION_REPLACE_SAME' });
    for (const res of [alien, gone]) {
      expect(errorOf(res)).toEqual({ status: 404, code: 'ATTRIBUTE_OPTION_NOT_FOUND' });
    }
    expect(alien.json().details).toEqual({ withOptionId: foreign.id });
    expect(errorOf(noOption)).toEqual({ status: 404, code: 'ATTRIBUTE_OPTION_NOT_FOUND' });
    expect(errorOf(wrongOwner)).toEqual({ status: 404, code: 'ATTRIBUTE_OPTION_NOT_FOUND' });
  });

  it('refuses a characteristic that is no choice and one that is not there, and a body that is wrong', async () => {
    const text = await createAttribute({ type: 'text' });
    const colour = await createAttribute({ type: 'option' });
    const a = await createAttributeOption(colour.id);

    const notChoice = await asAdminUser('POST', replaceUrl(text.id, 1), { withOptionId: 2 });
    const missing = await asAdminUser('POST', replaceUrl(2_000_000_000, 1), { withOptionId: 2 });
    const noBody = await asAdminUser('POST', replaceUrl(colour.id, a.id), {});
    const word = await asAdminUser('POST', replaceUrl(colour.id, a.id), { withOptionId: 'x' });

    expect(errorOf(notChoice)).toEqual({ status: 400, code: 'ATTRIBUTE_OPTIONS_NOT_ALLOWED' });
    expect(errorOf(missing)).toEqual({ status: 404, code: 'ATTRIBUTE_NOT_FOUND' });
    expect(errorOf(noBody)).toEqual({ status: 400, code: 'VALIDATION_ERROR' });
    expect(errorOf(word)).toEqual({ status: 400, code: 'VALIDATION_ERROR' });
  });

  it('is for an admin and a root: a guest and a user get 403', async () => {
    const colour = await createAttribute({ type: 'option' });
    const a = await createAttributeOption(colour.id);
    const b = await createAttributeOption(colour.id);
    const root = await createUser({ role: 'ROOT' });

    const forbidden = await send(user, 'POST', replaceUrl(colour.id, a.id), { withOptionId: b.id });
    const anonymous = await send(null, 'POST', replaceUrl(colour.id, a.id), { withOptionId: b.id });
    const byRoot = await send(root, 'POST', replaceUrl(colour.id, a.id), { withOptionId: b.id });

    expect(errorOf(forbidden)).toEqual({ status: 403, code: 'INSUFFICIENT_ROLE' });
    expect(errorOf(anonymous)).toEqual({ status: 403, code: 'INSUFFICIENT_ROLE' });
    expect(byRoot.statusCode).toBe(200);
    await closeSessions([root.id]);
  });
});
