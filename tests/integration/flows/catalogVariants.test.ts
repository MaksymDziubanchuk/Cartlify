import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { startApp, stopApp } from '../../helpers/app.js';
import { getCsrf, type Csrf } from '../../helpers/csrf.js';
import { closeSessions, createUser, uniqueTag, type TestUser } from '../../helpers/factories.js';
import { deliveryBody, quotedDeliveryPrice } from '../../helpers/orders.js';
import { createProductForm, formVariant } from '../../helpers/productForm.js';
import { journeyOf } from '../../helpers/returnJourney.js';

// A product with variants from the directory of characteristics to the order (docs/variants.md),
// each step with what its actor sees: the admin builds the catalog through the routes only (the
// characteristic, its values, the category that asks for it, the product with its variants, the
// delivery of the stock), a buyer finds the colour by the panel and the filter of the category,
// chooses it on the card and orders it. The pictures go to Cloudinary (its mock, or the test
// folder with service:cloudinary)

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
let buyer: TestUser;
const j = journeyOf(
  () => app,
  () => csrf,
);

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await createUser({ role: 'ADMIN' });
  buyer = await createUser({ name: 'Anna Koval' });
});

afterAll(async () => {
  try {
    await closeSessions([admin.id, buyer.id]);
  } finally {
    await stopApp();
  }
});

describe('a product with variants, from the directory to the order', () => {
  it('is built by the admin through the routes, found by a buyer by its colour and bought as the variant chosen on the card', async () => {
    const tag = uniqueTag();

    // the directory: a group of the card and a main colour with two values
    const group = await j.post(admin, '/api/admin/attribute-groups', { name: `Look ${tag}` });
    expect(group.statusCode).toBe(201);
    const colour = await j.post(admin, '/api/admin/attributes', {
      name: `Colour ${tag}`,
      type: 'option',
      groupId: group.json().id,
      isMain: true,
    });
    expect(colour.statusCode).toBe(201);
    const colourId = colour.json().id as number;
    const valueOf = async (name: string, colorCode: string) => {
      const res = await j.post(admin, `/api/admin/attributes/${colourId}/options`, {
        name,
        colorCode,
      });
      expect(res.statusCode).toBe(201);
      return res.json().id as number;
    };
    const black = await valueOf('black', '#000000');
    const white = await valueOf('white', '#ffffff');

    // a category that asks for the colour
    const category = await j.post(admin, '/api/categories', {
      name: `Lamps ${tag}`,
      slug: `lamps-${tag}`,
    });
    expect(category.statusCode).toBe(201);
    const categoryId = category.json().id as number;
    const asked = await j.put(admin, `/api/categories/${categoryId}/attributes`, {
      items: [{ attributeId: colourId, required: true }],
    });
    expect(asked.statusCode).toBe(200);

    // a variant without the colour is refused; the product with a black and a white variant is made
    const bare = await createProductForm(app, csrf, admin, {
      categoryId,
      name: `Bare lamp ${tag}`,
    });
    expect(bare.statusCode).toBe(400);
    expect(bare.json()).toMatchObject({ errorCode: 'ATTRIBUTE_REQUIRED' });
    const made = await createProductForm(app, csrf, admin, {
      categoryId,
      name: `Desk lamp ${tag}`,
      files: 2,
      variants: [
        formVariant({
          price: 10,
          attributes: [{ attributeId: colourId, value: black }],
          images: [{ file: 0, position: 1 }],
        }),
        formVariant({
          price: 12,
          attributes: [{ attributeId: colourId, value: white }],
          images: [{ file: 1, position: 1 }],
        }),
      ],
    });
    expect(made.statusCode).toBe(201);
    const productId = made.json().product.id as number;
    const variants = made.json().variants as Array<{ id: number; name: string }>;
    expect(variants.map((variant) => variant.name)).toEqual([
      `Desk lamp ${tag} — black`,
      `Desk lamp ${tag} — white`,
    ]);

    // the stock comes with a delivery only
    const delivered = await j.post(admin, '/api/products/stock/deliveries', {
      source: 'supplier',
      unitCost: 4,
      items: variants.map((variant) => ({ variantId: variant.id, quantity: 5 })),
    });
    expect(delivered.statusCode).toBe(201);

    // the buyer: the panel of the category offers the colour with the values that are there
    const panel = (await j.get(null, `/api/products/filters?categoryId=${categoryId}`)).json()
      .items as Array<{
      id: number;
      values?: Array<{ id: number; name: string }>;
    }>;
    expect(panel).toEqual([
      expect.objectContaining({
        id: colourId,
        values: [
          expect.objectContaining({ id: black, name: 'black' }),
          expect.objectContaining({ id: white, name: 'white' }),
        ],
      }),
    ]);

    // the category lists the product once, from the lowest to the highest price; the filter of the
    // colour lists the white one
    const listed = (await j.get(null, `/api/products?categoryIds=${categoryId}`)).json().items;
    expect(listed).toEqual([expect.objectContaining({ minPrice: 10, maxPrice: 12, stock: 10 })]);
    const filtered = (
      await j.get(
        null,
        `/api/products?categoryIds=${categoryId}&f=${encodeURIComponent(`${colourId}:${white}`)}`,
      )
    ).json().items;
    expect(filtered).toHaveLength(1);
    expect(filtered[0].variant).toMatchObject({ name: `Desk lamp ${tag} — white`, price: 12 });

    // the card opens the white variant and names the variants to switch between
    const card = (
      await j.get(null, `/api/products/${productId}?variantId=${filtered[0].variant.id}`)
    ).json();
    expect(card.variant).toMatchObject({ id: filtered[0].variant.id, stock: 5 });
    expect(card.variants.map((variant: { name: string }) => variant.name)).toEqual([
      `Desk lamp ${tag} — black`,
      `Desk lamp ${tag} — white`,
    ]);

    // the buyer puts the variant of the card in the cart and confirms the order
    const added = await j.post(buyer, '/api/orders/current/items', {
      variantId: card.variant.id,
      quantity: 2,
    });
    expect(added.statusCode).toBe(200);
    const confirmed = await j.post(buyer, '/api/orders/current/confirm', {
      orderId: added.json().id,
      delivery: deliveryBody,
      expectedDeliveryPrice: quotedDeliveryPrice(added.json()),
    });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json()).toMatchObject({ total: 24 });
    expect(confirmed.json().items).toEqual([
      expect.objectContaining({
        quantity: 2,
        variant: expect.objectContaining({ name: `Desk lamp ${tag} — white` }),
      }),
    ]);

    // the reserve takes the units of the white variant only
    const after = (
      await j.get(null, `/api/products/${productId}?variantId=${card.variant.id}`)
    ).json();
    expect(after.variant.stock).toBe(3);
    expect(
      after.variants.find((variant: { id: number }) => variant.id !== card.variant.id).stock,
    ).toBe(5);
  });
});
