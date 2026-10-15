import type { FastifyInstance } from 'fastify';
import type { Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { prisma } from '@db/client.js';
import { setAdminContext } from '@db/dbContext.service.js';

import { startApp, stopApp } from '../../../helpers/app.js';

let app: FastifyInstance;
let productId: number;
let categoryId: number;

// rows of products and categories are admin-only under rls, the test creates its own as admin
const asAdmin = <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) =>
  prisma.$transaction(async (tx) => {
    await setAdminContext(tx);
    return fn(tx);
  });

// the cookies a response sets, ready to send back
const cookiesOf = (res: { headers: Record<string, unknown> }) =>
  [res.headers['set-cookie']]
    .flat()
    .filter(Boolean)
    .map((cookie) => String(cookie).split(';')[0])
    .join('; ');

beforeAll(async () => {
  app = await startApp();

  const tag = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;

  ({ id: productId, categoryId } = await asAdmin(async (tx) => {
    const category = await tx.category.create({
      data: { name: `Favorites test ${tag}`, slug: `favorites-test-${tag}` },
    });

    // 5 in stock, 2 of them reserved by confirmed orders: 3 are free
    return tx.product.create({
      data: {
        name: `Favorites test lamp ${tag}`,
        price: 25.5,
        stock: 5,
        reservedStock: 2,
        categoryId: category.id,
        images: {
          create: {
            url: 'https://res.cloudinary.com/demo/image/upload/v1/products/test/0.jpg',
            position: 0,
            isPrimary: true,
          },
        },
      },
      select: { id: true, categoryId: true },
    });
  }));
});

afterAll(async () => {
  // images and favorites of the product go with it (on delete cascade)
  await asAdmin(async (tx) => {
    await tx.product.delete({ where: { id: productId } });
    await tx.category.delete({ where: { id: categoryId } });
  });

  await stopApp();
});

describe('GET /api/favorites', () => {
  it('returns an empty list to a new guest', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/favorites' });

    expect(res.statusCode).toBe(200);
    expect(res.json().items).toEqual([]);
  });

  // the list used to fail with 500: its query left out reservedStock and the card stock was NaN
  it('lists a favorite product with its free units, not the raw stock', async () => {
    const first = await app.inject({ method: 'GET', url: '/api/favorites' });
    const cookie = cookiesOf(first);

    const add = await app.inject({
      method: 'POST',
      url: `/api/favorites/${productId}`,
      headers: { cookie },
    });
    expect(add.statusCode).toBe(200);

    const res = await app.inject({ method: 'GET', url: '/api/favorites', headers: { cookie } });

    expect(res.statusCode).toBe(200);
    expect(res.json().items).toHaveLength(1);
    expect(res.json().items[0].product).toMatchObject({ id: productId, stock: 3 });
  });
});
