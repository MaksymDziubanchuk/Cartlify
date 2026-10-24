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
  type TestProduct,
  type TestUser,
} from '../../../helpers/factories.js';
import { answerAsModel, stopModel } from '../../../helpers/openai.js';

// a product without an image: the lists of a buyer leave it out (the catalog, the suggestions,
// the favorites, the counts of the tree, the products the bot recommends), its card opens by its
// id, a cart holds it without a picture, and an admin lists it with no images
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

type ListItem = { id: number; images: { url200: string } | null };

describe('a product without an image', () => {
  it('is no part of the catalog of a guest or a buyer', async () => {
    for (const cookie of [undefined, accessCookie(buyer)]) {
      const res = await listOf(cookie);

      expect(res.statusCode).toBe(200);
      expect((res.json().items as ListItem[]).map((item) => item.id)).toEqual([pictured.id]);
    }
  });

  it('opens by its id, with no images', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/products/${bare.id}` });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: bare.id, images: [] });
  });

  it('is listed to an admin with no images, the other with its picture', async () => {
    const res = await listOf(accessCookie(admin));
    const byId = new Map((res.json().items as ListItem[]).map((item) => [item.id, item]));

    expect(res.statusCode).toBe(200);
    expect(byId.get(bare.id)?.images).toBeNull();
    expect(byId.get(pictured.id)?.images?.url200).toEqual(expect.any(String));
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

  it('stays among the favorites of a buyer but out of the list of them', async () => {
    const fan = await createUser();
    userIds.push(fan.id);
    for (const product of [pictured, bare]) {
      const res = await app.inject({
        method: 'POST',
        url: `/api/favorites/${product.id}`,
        headers: withCsrf(csrf, accessCookie(fan)),
      });
      expect(res.statusCode).toBe(200);
    }

    const res = await app.inject({
      method: 'GET',
      url: '/api/favorites',
      headers: { cookie: accessCookie(fan) },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().items.map((i: { product: { id: number } }) => i.product.id)).toEqual([
      pictured.id,
    ]);
  });

  it('is not counted in the tree of the categories, the menu of the catalog', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/categories/tree' });
    type Node = { id: number; productCount: number; children: Node[] };
    const find = (nodes: Node[]): Node | undefined =>
      nodes.map((n) => (n.id === categoryId ? n : find(n.children))).find(Boolean);

    expect(find(res.json().items)?.productCount).toBe(1);
  });

  it('stays in the cart of a buyer who put it there by its id, with no images', async () => {
    const shopper = await createUser();
    userIds.push(shopper.id);

    const added = await app.inject({
      method: 'POST',
      url: '/api/orders/current/items',
      headers: withCsrf(csrf, accessCookie(shopper)),
      payload: { productId: bare.id, quantity: 1 },
    });
    const cart = await app.inject({
      method: 'GET',
      url: '/api/orders/current',
      headers: { cookie: accessCookie(shopper) },
    });

    expect(added.statusCode).toBe(200);
    expect(cart.statusCode).toBe(200);
    expect(cart.json().items).toEqual([
      expect.objectContaining({ product: expect.objectContaining({ id: bare.id, images: null }) }),
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
