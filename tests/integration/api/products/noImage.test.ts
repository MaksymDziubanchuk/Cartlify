import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { closeChatSockets, openChatSocket } from '../../../helpers/chatSocket.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { asAdmin } from '../../../helpers/db.js';
import {
  closeSessions,
  createCategory,
  createProduct,
  createUser,
  deleteProductFromCatalog,
  type TestProduct,
  type TestUser,
} from '../../../helpers/factories.js';
import { answerAsModel, stopModel } from '../../../helpers/openai.js';

// a product none of whose variants shows a picture (a variant without one is hidden from buyers):
// the lists of a buyer leave it out (the catalog, the suggestions, the favorites, the counts of the
// tree, the products the bot recommends) and so does its card, while an admin opens the card and
// lists the product, with no pictures
let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
let buyer: TestUser;
let categoryId: number;
let pictured: TestProduct;
let bare: TestProduct;
// a word of the names of the two products alone, of letters: words of digits look alike
const word = Array.from(
  { length: 9 },
  () => 'bcdfghjklmnpqrstvwxz'[Math.floor(Math.random() * 20)],
).join('');
const PICTURED_NAME = `${word} lamp with a picture`;
const BARE_NAME = `${word} lamp without a picture`;
const userIds: number[] = [];

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await createUser({ role: 'ADMIN' });
  buyer = await createUser();
  userIds.push(admin.id, buyer.id);
  ({ id: categoryId } = await createCategory());
  pictured = await createProduct({ categoryId, name: PICTURED_NAME, stock: 5 });
  bare = await createProduct({ categoryId, name: BARE_NAME, stock: 5 });
  await asAdmin((tx) => tx.productImage.deleteMany({ where: { productId: bare.id } }));
});

afterEach(stopModel);

afterAll(async () => {
  closeChatSockets();
  try {
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

const listOf = (cookie?: string) =>
  app.inject({
    method: 'GET',
    url: `/api/products?categoryIds=${categoryId}&limit=100`,
    headers: cookie ? { cookie } : {},
  });

type ListItem = {
  product: { id: number };
  variant: { id: number; image: { url200: string } | null };
};

describe('a product without an image', () => {
  it('is no part of the catalog of a guest or a buyer', async () => {
    for (const cookie of [undefined, accessCookie(buyer)]) {
      const res = await listOf(cookie);

      expect(res.statusCode).toBe(200);
      expect((res.json().items as ListItem[]).map((item) => item.product.id)).toEqual([
        pictured.id,
      ]);
    }
  });

  it('has no card for a buyer or a guest, and opens for an admin with no pictures', async () => {
    for (const headers of [{}, { cookie: accessCookie(buyer) }]) {
      const res = await app.inject({ method: 'GET', url: `/api/products/${bare.id}`, headers });

      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ errorCode: 'PRODUCT_NOT_FOUND' });
    }

    const res = await app.inject({
      method: 'GET',
      url: `/api/products/${bare.id}`,
      headers: { cookie: accessCookie(admin) },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().product).toMatchObject({ id: bare.id, gallery: [] });
    expect(res.json().variant).toMatchObject({
      id: bare.variantId,
      image: null,
      images: [],
      visible: false,
    });
  });

  it('is listed to an admin with no picture, the other with its picture', async () => {
    const res = await listOf(accessCookie(admin));
    const byId = new Map((res.json().items as ListItem[]).map((item) => [item.product.id, item]));

    expect(res.statusCode).toBe(200);
    expect(byId.get(bare.id)?.variant.image).toBeNull();
    expect(byId.get(pictured.id)?.variant.image?.url200).toEqual(expect.any(String));
  });

  it('is no suggestion for a buyer, and one for an admin', async () => {
    const suggest = (cookie?: string) =>
      app.inject({
        method: 'GET',
        url: `/api/products/suggestions?q=${word}`,
        headers: cookie ? { cookie } : {},
      });

    expect(((await suggest()).json().items as { id: number }[]).map((i) => i.id)).toEqual([
      pictured.id,
    ]);
    expect(
      ((await suggest(accessCookie(admin))).json().items as { id: number }[])
        .map((i) => i.id)
        .sort(),
    ).toEqual([pictured.id, bare.id].sort());
  });

  // a buyer sees no variant without a picture, so there is no heart to click on it: by its id it is
  // not found, as in the cart and in the card
  it('cannot be added to the favorites by the id of its variant', async () => {
    const fan = await createUser();
    userIds.push(fan.id);

    const res = await app.inject({
      method: 'POST',
      url: `/api/favorites/${bare.variantId}`,
      headers: withCsrf(csrf, accessCookie(fan)),
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({
      errorCode: 'VARIANT_NOT_FOUND',
      details: { variantId: bare.variantId },
    });
    expect(await asAdmin((tx) => tx.favorite.count({ where: { variantId: bare.variantId } }))).toBe(
      0,
    );
  });

  // a favorite added while the product had its pictures stays when they are taken away, and is out
  // of the list until they are back
  it('stays among the favorites of a buyer but out of the list of them', async () => {
    const fan = await createUser();
    userIds.push(fan.id);
    const losing = await createProduct({
      categoryId,
      name: `${word} lamp that loses its picture`,
      stock: 5,
    });
    for (const product of [pictured, losing]) {
      const res = await app.inject({
        method: 'POST',
        url: `/api/favorites/${product.variantId}`,
        headers: withCsrf(csrf, accessCookie(fan)),
      });
      expect(res.statusCode).toBe(200);
    }
    await asAdmin((tx) => tx.productImage.deleteMany({ where: { productId: losing.id } }));

    const res = await app.inject({
      method: 'GET',
      url: '/api/favorites',
      headers: { cookie: accessCookie(fan) },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().items.map((i: { product: { id: number } }) => i.product.id)).toEqual([
      pictured.id,
    ]);
    // the favorite itself is still there
    expect(
      await asAdmin((tx) =>
        tx.favorite.count({ where: { userId: fan.id, variantId: losing.variantId } }),
      ),
    ).toBe(1);
  });

  it('is not counted in the tree of the categories, the menu of the catalog', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/categories/tree' });
    type Node = { id: number; productCount: number; children: Node[] };
    const find = (nodes: Node[]): Node | undefined =>
      nodes.map((n) => (n.id === categoryId ? n : find(n.children))).find(Boolean);

    expect(find(res.json().items)?.productCount).toBe(1);
  });

  // a variant with no picture is hidden from buyers everywhere (plan, step 1 portions 5 and 6): the
  // cart refuses it by its id too (the first version of this case let it in, which the plan does
  // not: the cart drops the positions of hidden variants)
  it('cannot be put in the cart by the id of its variant', async () => {
    const shopper = await createUser();
    userIds.push(shopper.id);

    const added = await app.inject({
      method: 'POST',
      url: '/api/orders/current/items',
      headers: withCsrf(csrf, accessCookie(shopper)),
      payload: { variantId: bare.variantId, quantity: 1 },
    });

    expect(added.statusCode).toBe(404);
    expect(added.json()).toMatchObject({
      errorCode: 'VARIANT_NOT_FOUND',
      details: { variantId: bare.variantId },
    });
  });

  it('leaves the cart of a buyer who had its variant before the pictures went', async () => {
    const shopper = await createUser();
    userIds.push(shopper.id);
    const lamp = await createProduct({
      categoryId,
      name: `${word} lamp that loses its picture`,
      stock: 5,
    });
    const kept = await createProduct({
      categoryId,
      name: `${word} lamp that keeps it`,
      stock: 5,
    });
    for (const variantId of [lamp.variantId, kept.variantId]) {
      const added = await app.inject({
        method: 'POST',
        url: '/api/orders/current/items',
        headers: withCsrf(csrf, accessCookie(shopper)),
        payload: { variantId, quantity: 1 },
      });
      expect(added.statusCode).toBe(200);
    }
    await asAdmin((tx) => tx.variantImage.deleteMany({ where: { variantId: lamp.variantId } }));

    const cart = await app.inject({
      method: 'GET',
      url: '/api/orders/current',
      headers: { cookie: accessCookie(shopper) },
    });

    expect(cart.statusCode).toBe(200);
    expect(cart.json().items).toEqual([
      expect.objectContaining({
        product: expect.objectContaining({ id: kept.id }),
        variant: expect.objectContaining({ id: kept.variantId, forSale: true }),
      }),
    ]);
  });

  it('is no product the bot recommends', async () => {
    const calls = answerAsModel();
    const customer = await createUser({ isVerified: true });
    userIds.push(customer.id);
    const cookie = accessCookie(customer);
    const current = await app.inject({
      method: 'GET',
      url: '/api/chat/thread/current',
      headers: { cookie },
    });
    const threadId = current.json().thread.id as string;
    const socket = await openChatSocket(app, { cookie });
    await socket.join(threadId);

    socket.send({ type: 'message:send', payload: { threadId, content: `Do you sell ${word}?` } });
    await socket.take('message:new', (e) => e.payload?.senderType === 'bot');

    const prompt = JSON.stringify(calls.find((call) => call.purpose === 'answer')?.request);
    expect(prompt).toContain(PICTURED_NAME);
    expect(prompt).not.toContain(BARE_NAME);
  });
});

describe('a change of a product without a picture', () => {
  const change = (method: 'PATCH' | 'POST', url: string, payload?: Record<string, unknown>) =>
    app.inject({
      method,
      url,
      headers: withCsrf(csrf, accessCookie(admin)),
      ...(payload ? { payload } : {}),
    });

  // an admin changes the product the way any other: the answer is its card, with no pictures
  it.each([
    [
      'a change of the product',
      (id: number) => change('PATCH', `/api/products/${id}`, { name: 'Renamed without a picture' }),
    ],
    [
      'a move to another category',
      async (id: number) =>
        change('PATCH', `/api/products/${id}/category`, {
          categoryId: (await createCategory()).id,
        }),
    ],
    [
      'a restore',
      async (id: number) => {
        await deleteProductFromCatalog(id);
        return change('POST', `/api/products/${id}/restore`);
      },
    ],
  ])('answers %s with the card and no pictures', async (_, send) => {
    // a category of its own: the lists of the file count the products of theirs
    const product = await createProduct({ stock: 0 });
    await asAdmin((tx) => tx.productImage.deleteMany({ where: { productId: product.id } }));

    const res = await send(product.id);

    expect(res.statusCode).toBe(200);
    expect(res.json().product).toMatchObject({ id: product.id, gallery: [] });
    expect(res.json().variant).toMatchObject({ id: product.variantId, image: null, images: [] });
  });
});
