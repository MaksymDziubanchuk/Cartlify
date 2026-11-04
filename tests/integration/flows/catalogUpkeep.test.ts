import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { startApp, stopApp } from '../../helpers/app.js';
import { imageField, pngImage } from '../../helpers/cloudinary.js';
import { accessCookie } from '../../helpers/actors.js';
import { getCsrf, withCsrf, type Csrf } from '../../helpers/csrf.js';
import {
  closeSessions,
  createAttribute,
  createProduct,
  createUser,
  createVariantValue,
  uniqueTag,
  type TestUser,
} from '../../helpers/factories.js';
import { multipartBody } from '../../helpers/multipart.js';
import { journeyOf } from '../../helpers/returnJourney.js';

// The upkeep of the catalog, each step with what its actor sees: an admin keeps the tree of the
// categories (a picture, a new name, a move of a product, an empty category taken away) and the
// directory of the makers, and a guest sees each change on the list and the card; an admin changes
// the prices of a product (the log of prices keeps it), adds a variant the guest sees once it has a
// picture, takes a variant and the product out of sale and brings them back. The refusals of each
// step are the tests of api/categories, api/parties and api/products.
let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
const j = journeyOf(
  () => app,
  () => csrf,
);

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await createUser({ role: 'ADMIN' });
});

afterAll(async () => {
  try {
    await closeSessions([admin.id]);
  } finally {
    await stopApp();
  }
});

type Listed = { product: { id: number; name: string } };
const listed = async (query: string) =>
  ((await j.get(null, `/api/products?${query}`)).json().items as Listed[]).map(
    ({ product }) => product.id,
  );
const cardOf = async (productId: number) =>
  (await j.get(null, `/api/products/${productId}`)).json();

describe('the upkeep of the catalog', () => {
  it('keeps the tree and the makers, and a guest sees every change', async () => {
    const tag = uniqueTag();

    // the tree: lamps, desk lamps under them with a picture and a better name
    const lamps = await j.post(admin, '/api/categories', {
      name: `Lamps ${tag}`,
      slug: `lamps-${tag}`,
    });
    expect(lamps.statusCode).toBe(201);
    const desk = await j.post(admin, '/api/categories', {
      name: `Desk ${tag}`,
      slug: `desk-${tag}`,
      parentId: lamps.json().id,
    });
    expect(desk.statusCode).toBe(201);
    const deskId = desk.json().id as number;
    const form = multipartBody([imageField('image', pngImage(120, 120))]);
    const pictured = await app.inject({
      method: 'PUT',
      url: `/api/categories/${deskId}/image`,
      headers: { ...withCsrf(csrf, accessCookie(admin)), ...form.headers },
      payload: form.payload,
    });
    expect(pictured.statusCode).toBe(200);
    expect(pictured.json().imageUrls).not.toBeNull();
    const unpictured = await j.del(admin, `/api/categories/${deskId}/image`);
    expect(unpictured.json().imageUrls).toBeNull();
    const renamed = await j.patch(admin, `/api/categories/${deskId}`, {
      name: `Desk lamps ${tag}`,
    });
    expect(renamed.statusCode).toBe(200);

    // the maker of the directory, its address put right
    const maker = await j.post(admin, '/api/admin/parties', {
      name: `Lampwerk ${tag}`,
      address: 'Lichtstrasse 4, Berlin',
      email: `safety-${tag}@lampwerk.example.com`,
      country: 'DE',
    });
    expect(maker.statusCode).toBe(201);
    const makerId = maker.json().id as number;
    expect(
      (await j.patch(admin, `/api/admin/parties/${makerId}`, { address: 'Neue Strasse 9, Berlin' }))
        .statusCode,
    ).toBe(200);
    expect((await j.get(admin, `/api/admin/parties/${makerId}`)).json()).toMatchObject({
      address: 'Neue Strasse 9, Berlin',
    });

    // a product of the desk lamps gets the maker and a warning; the guest reads them on the card
    const product = await createProduct({ categoryId: deskId, name: `Reading lamp ${tag}` });
    const edited = await j.patch(admin, `/api/products/${product.id}`, {
      manufacturerId: makerId,
      warnings: 'Keep dry.',
    });
    expect(edited.statusCode).toBe(200);
    expect(await listed(`categoryIds=${lamps.json().id}&branch=true`)).toEqual([product.id]);
    expect((await cardOf(product.id)).product).toMatchObject({
      category: { id: deskId, name: `Desk lamps ${tag}` },
      manufacturer: { name: `Lampwerk ${tag}`, address: 'Neue Strasse 9, Berlin' },
      warnings: 'Keep dry.',
    });

    // the product moves to floor lamps; the empty desk lamps go away
    const floor = await j.post(admin, '/api/categories', {
      name: `Floor ${tag}`,
      slug: `floor-${tag}`,
      parentId: lamps.json().id,
    });
    const moved = await j.patch(admin, '/api/products/batch', {
      items: [{ productId: product.id, categoryId: floor.json().id }],
    });
    expect(moved.statusCode).toBe(200);
    expect(await listed(`categoryIds=${floor.json().id}`)).toEqual([product.id]);
    expect((await j.del(admin, `/api/categories/${deskId}`)).statusCode).toBe(200);
    const tree = await j.get(admin, `/api/categories?search=${encodeURIComponent(tag)}`);
    expect((tree.json().items as { name: string }[]).map(({ name }) => name).sort()).toEqual([
      `Floor ${tag}`,
      `Lamps ${tag}`,
    ]);

    // a maker entered by mistake is taken out of the directory
    const mistake = await j.post(admin, '/api/admin/parties', {
      name: `Mistake ${tag}`,
      address: 'Nowhere 1',
      email: `mistake-${tag}@example.com`,
      country: 'DE',
    });
    expect((await j.del(admin, `/api/admin/parties/${mistake.json().id}`)).statusCode).toBe(200);
    const makers = await j.get(admin, `/api/admin/parties?q=${encodeURIComponent(tag)}`);
    expect((makers.json().items as { id: number }[]).map(({ id }) => id)).toEqual([makerId]);
  });

  it('changes the prices and the variants, and takes a product out of sale and back', async () => {
    const tag = uniqueTag();
    const product = await createProduct({ name: `Kettle ${tag}`, price: 20, stock: 3 });
    // the material tells the variants apart; the steel one is there from the start
    const material = await createAttribute({ name: `Material ${tag}`, type: 'text' });
    await createVariantValue(product.variantId, material.id, { text: 'Steel' });

    // ten percent more, kept in the log of prices
    const raised = await j.patch(admin, '/api/products', {
      mode: 'percent',
      value: 10,
      scope: { productIds: [product.id] },
      reason: 'Autumn prices',
    });
    expect(raised.statusCode).toBe(200);
    expect(raised.json().updatedCount).toBe(1);
    expect((await cardOf(product.id)).variant.price).toBe(22);
    const log = await j.get(admin, `/api/admin/price-log?productId=${product.id}`);
    expect(log.json().items).toEqual([expect.objectContaining({ oldPrice: 20, newPrice: 22 })]);

    // a second variant with a picture of its own; without it the guest does not see the variant,
    // with a picture of the gallery it is back
    const form = multipartBody([
      imageField('images', pngImage(200, 200, [30, 90, 200]), { filename: 'blue.png' }),
    ]);
    const uploaded = await app.inject({
      method: 'POST',
      url: `/api/products/${product.id}/images`,
      headers: { ...withCsrf(csrf, accessCookie(admin)), ...form.headers },
      payload: form.payload,
    });
    expect(uploaded.statusCode).toBe(201);
    const images = uploaded.json().images as { id: number; variantIds: number[] }[];
    const blue = images.find(({ variantIds }) => variantIds.length === 0)!;
    const first = images.find(({ variantIds }) => variantIds.includes(product.variantId))!;
    const added = await j.post(admin, `/api/products/${product.id}/variants`, {
      variants: [
        {
          price: 30,
          sku: `KT-${tag}`,
          withoutShippingData: true,
          images: [{ imageId: blue.id, position: 1 }],
          attributes: [{ attributeId: material.id, value: 'Glass' }],
        },
      ],
    });
    expect(added.statusCode).toBe(201);
    const second = added.json().variants[0] as { id: number };
    const variantsOnCard = async () =>
      ((await cardOf(product.id)).variants as { id: number }[]).map(({ id }) => id);
    expect(await variantsOnCard()).toEqual([product.variantId, second.id]);
    const unpictured = await j.del(admin, `/api/products/${product.id}/images/${blue.id}`);
    expect(unpictured.json().variantsWithoutImages).toEqual([second.id]);
    expect(await variantsOnCard()).toEqual([product.variantId]);
    const pictured = await j.patch(admin, '/api/products/variants/batch', {
      items: [{ variantId: second.id, images: [{ imageId: first.id, position: 1 }] }],
    });
    expect(pictured.statusCode).toBe(200);
    expect(await variantsOnCard()).toEqual([product.variantId, second.id]);

    // one price for both variants at once
    const priced = await j.patch(admin, `/api/products/${product.id}/variants`, {
      variantIds: [product.variantId, second.id],
      price: 35,
    });
    expect(priced.statusCode).toBe(200);
    const prices = ((await cardOf(product.id)).variants as { price: number }[]).map(
      ({ price }) => price,
    );
    expect(prices).toEqual([35, 35]);

    // the second variant out of sale and back
    expect(
      (await j.del(admin, `/api/products/${product.id}/variants/${second.id}`)).statusCode,
    ).toBe(200);
    expect(await variantsOnCard()).toEqual([product.variantId]);
    expect(
      (await j.post(admin, `/api/products/${product.id}/variants/${second.id}/restore`)).statusCode,
    ).toBe(200);
    expect(await variantsOnCard()).toEqual([product.variantId, second.id]);

    // the whole product out of the catalog and back
    expect((await j.del(admin, `/api/products/${product.id}`)).statusCode).toBe(200);
    // the search of the catalog is fuzzy: other products of the run may come too
    expect(await listed(`search=${encodeURIComponent(`Kettle ${tag}`)}`)).not.toContain(product.id);
    expect((await j.post(admin, `/api/products/${product.id}/restore`)).statusCode).toBe(200);
    expect(await listed(`search=${encodeURIComponent(`Kettle ${tag}`)}`)).toContain(product.id);
  });
});
