import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { encodeCursor } from '@helpers/codeCursor.js';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { asAdmin } from '../../../helpers/db.js';
import {
  createProduct,
  createUser,
  deleteProductFromCatalog,
  type TestUser,
} from '../../../helpers/factories.js';

// the favorites of a user: added, read page by page with the newest first, taken out again
let app: FastifyInstance;
let csrf: Csrf;

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
});

afterAll(stopApp);

const add = (user: TestUser, productId: number) =>
  app.inject({
    method: 'POST',
    url: `/api/favorites/${productId}`,
    headers: withCsrf(csrf, accessCookie(user)),
  });

const remove = (user: TestUser, productId: number) =>
  app.inject({
    method: 'DELETE',
    url: `/api/favorites/${productId}`,
    headers: withCsrf(csrf, accessCookie(user)),
  });

const list = (user: TestUser, query = '') =>
  app.inject({
    method: 'GET',
    url: `/api/favorites${query}`,
    headers: { cookie: accessCookie(user) },
  });

const favoritesOf = (userId: number) =>
  asAdmin((tx) => tx.favorite.findMany({ where: { userId }, select: { productId: true } }));

type Page = { items: Array<{ product: { id: number } }>; nextCursor: string | null };

describe('the favorites of a user', () => {
  it('adds products and lists them page by page, the one added last first', async () => {
    const user = await createUser();
    const products = [await createProduct(), await createProduct(), await createProduct()];
    for (const p of products) expect((await add(user, p.id)).statusCode).toBe(200);

    const first = await list(user, '?limit=2');
    const firstPage = first.json() as Page;
    expect(first.statusCode).toBe(200);
    expect(firstPage.items.map((i) => i.product.id)).toEqual([products[2]!.id, products[1]!.id]);
    expect(firstPage.nextCursor).toEqual(expect.any(String));

    const second = await list(user, `?limit=2&cursor=${firstPage.nextCursor}`);
    const secondPage = second.json() as Page;
    expect(secondPage.items.map((i) => i.product.id)).toEqual([products[0]!.id]);
    expect(secondPage.nextCursor).toBeNull();
  });

  it('answers the same when a product is added again, and keeps it once', async () => {
    const user = await createUser();
    const product = await createProduct();

    const once = await add(user, product.id);
    const again = await add(user, product.id);

    expect(once.json()).toEqual({ productId: product.id, isFavorite: true });
    expect({ status: again.statusCode, body: again.json() }).toEqual({
      status: 200,
      body: { productId: product.id, isFavorite: true },
    });
    expect(await favoritesOf(user.id)).toEqual([{ productId: product.id }]);
  });

  it('takes a product out, and answers the same for one that is not there', async () => {
    const user = await createUser();
    const product = await createProduct();
    await add(user, product.id);

    const out = await remove(user, product.id);
    const again = await remove(user, product.id);

    expect(out.json()).toEqual({ productId: product.id, isFavorite: false });
    expect({ status: again.statusCode, body: again.json() }).toEqual({
      status: 200,
      body: { productId: product.id, isFavorite: false },
    });
    expect(await favoritesOf(user.id)).toEqual([]);
  });

  it('refuses a product taken out of the catalog with 404', async () => {
    const user = await createUser();
    const product = await createProduct();
    await deleteProductFromCatalog(product.id);

    const res = await add(user, product.id);

    expect({ status: res.statusCode, code: res.json().errorCode }).toEqual({
      status: 404,
      code: 'PRODUCT_NOT_FOUND',
    });
    expect(await favoritesOf(user.id)).toEqual([]);
  });

  it('refuses a product that is not there with 404', async () => {
    const res = await add(await createUser(), 2_000_000_000);

    expect({ status: res.statusCode, code: res.json().errorCode }).toEqual({
      status: 404,
      code: 'PRODUCT_NOT_FOUND',
    });
  });

  it('refuses a cursor with no time in it', async () => {
    const res = await list(await createUser(), `?cursor=${encodeCursor({ id: 5 } as never)}`);

    expect({ status: res.statusCode, code: res.json().errorCode }).toEqual({
      status: 400,
      code: 'CURSOR_INVALID',
    });
  });

  it('refuses a cursor with a time that is no time', async () => {
    const res = await list(
      await createUser(),
      `?cursor=${encodeCursor({ id: 5, v: 'not a time' } as never)}`,
    );

    expect({ status: res.statusCode, code: res.json().errorCode }).toEqual({
      status: 400,
      code: 'CURSOR_INVALID',
    });
  });

  it('refuses an admin: the favorites are a list of a buyer', async () => {
    const res = await list(await createUser({ role: 'ADMIN' }));

    expect({ status: res.statusCode, code: res.json().errorCode }).toEqual({
      status: 403,
      code: 'INSUFFICIENT_ROLE',
    });
  });
});
