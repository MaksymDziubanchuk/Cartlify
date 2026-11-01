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
  createVariant,
  deleteProductFromCatalog,
  type TestUser,
} from '../../../helpers/factories.js';

// the favorites of a user: a variant added, read page by page with the newest first, taken out
// again. A variant that is not there, or that a buyer does not see, cannot be added
let app: FastifyInstance;
let csrf: Csrf;

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
});

afterAll(stopApp);

const add = (user: TestUser, variantId: number) =>
  app.inject({
    method: 'POST',
    url: `/api/favorites/${variantId}`,
    headers: withCsrf(csrf, accessCookie(user)),
  });

const remove = (user: TestUser, variantId: number) =>
  app.inject({
    method: 'DELETE',
    url: `/api/favorites/${variantId}`,
    headers: withCsrf(csrf, accessCookie(user)),
  });

const list = (user: TestUser, query = '') =>
  app.inject({
    method: 'GET',
    url: `/api/favorites${query}`,
    headers: { cookie: accessCookie(user) },
  });

const favoritesOf = (userId: number) =>
  asAdmin((tx) =>
    tx.favorite.findMany({
      where: { userId },
      orderBy: { id: 'asc' },
      select: { productId: true, variantId: true },
    }),
  );

type Page = {
  items: Array<{ product: { id: number }; variant: { id: number } }>;
  nextCursor: string | null;
};

const refusal = (res: { statusCode: number; json: () => { errorCode?: string } }) => ({
  status: res.statusCode,
  code: res.json().errorCode,
});

describe('the favorites of a user', () => {
  it('adds variants and lists them page by page, the one added last first', async () => {
    const user = await createUser();
    const products = [await createProduct(), await createProduct(), await createProduct()];
    for (const p of products) expect((await add(user, p.variantId)).statusCode).toBe(200);

    const first = await list(user, '?limit=2');
    const firstPage = first.json() as Page;
    expect(first.statusCode).toBe(200);
    expect(firstPage.items.map((i) => i.variant.id)).toEqual([
      products[2]!.variantId,
      products[1]!.variantId,
    ]);
    expect(firstPage.items.map((i) => i.product.id)).toEqual([products[2]!.id, products[1]!.id]);
    expect(firstPage.nextCursor).toEqual(expect.any(String));

    const second = await list(user, `?limit=2&cursor=${firstPage.nextCursor}`);
    const secondPage = second.json() as Page;
    expect(secondPage.items.map((i) => i.variant.id)).toEqual([products[0]!.variantId]);
    expect(secondPage.nextCursor).toBeNull();
  });

  it('answers the same when a variant is added again, and keeps it once', async () => {
    const user = await createUser();
    const product = await createProduct();

    const once = await add(user, product.variantId);
    const again = await add(user, product.variantId);

    expect(once.json()).toEqual({ variantId: product.variantId, isFavorite: true });
    expect({ status: again.statusCode, body: again.json() }).toEqual({
      status: 200,
      body: { variantId: product.variantId, isFavorite: true },
    });
    expect(await favoritesOf(user.id)).toEqual([
      { productId: product.id, variantId: product.variantId },
    ]);
  });

  // a favorite is a variant: the variants of one product are favorites of their own
  it('keeps two variants of one product as two favorites, and takes out only the one named', async () => {
    const user = await createUser();
    const product = await createProduct();
    const second = await createVariant(product.id);
    await add(user, product.variantId);
    await add(user, second.id);

    expect(await favoritesOf(user.id)).toEqual([
      { productId: product.id, variantId: product.variantId },
      { productId: product.id, variantId: second.id },
    ]);
    expect(((await list(user)).json() as Page).items.map((i) => i.variant.id)).toEqual([
      second.id,
      product.variantId,
    ]);

    await remove(user, product.variantId);

    expect(await favoritesOf(user.id)).toEqual([{ productId: product.id, variantId: second.id }]);
  });

  // the popularity of a product counts people: a person with several of its variants among the
  // favorites is one person
  it('counts a person who likes two variants of a product once in its popularity', async () => {
    const popularityOf = async (productId: number) =>
      (
        await asAdmin((tx) =>
          tx.product.findUniqueOrThrow({ where: { id: productId }, select: { popularity: true } }),
        )
      ).popularity;
    const product = await createProduct();
    const second = await createVariant(product.id);
    const user = await createUser();
    const other = await createUser();
    const none = await popularityOf(product.id);

    await add(user, product.variantId);
    const once = await popularityOf(product.id);
    await add(user, second.id);
    const twice = await popularityOf(product.id);
    await add(other, second.id);
    const twoPeople = await popularityOf(product.id);
    await remove(user, product.variantId);
    const oneVariantLeft = await popularityOf(product.id);
    await remove(user, second.id);
    await remove(other, second.id);
    const noOne = await popularityOf(product.id);

    expect(once).toBeGreaterThan(none);
    expect(twice).toBe(once);
    expect(twoPeople).toBeGreaterThan(twice);
    // the person still likes the other variant
    expect(oneVariantLeft).toBe(twoPeople);
    expect(noOne).toBe(none);
  });

  it('takes a variant out, and answers the same for one that is not there', async () => {
    const user = await createUser();
    const product = await createProduct();
    await add(user, product.variantId);

    const out = await remove(user, product.variantId);
    const again = await remove(user, product.variantId);

    expect(out.json()).toEqual({ variantId: product.variantId, isFavorite: false });
    expect({ status: again.statusCode, body: again.json() }).toEqual({
      status: 200,
      body: { variantId: product.variantId, isFavorite: false },
    });
    expect(await favoritesOf(user.id)).toEqual([]);
  });

  it('refuses a variant of a product taken out of the catalog with 404', async () => {
    const user = await createUser();
    const product = await createProduct();
    await deleteProductFromCatalog(product.id);

    const res = await add(user, product.variantId);

    expect(refusal(res)).toEqual({ status: 404, code: 'VARIANT_NOT_FOUND' });
    expect(res.json().details).toEqual({ variantId: product.variantId });
    expect(await favoritesOf(user.id)).toEqual([]);
  });

  it('refuses a variant taken out of sale with 404, its product and the other variants stay', async () => {
    const user = await createUser();
    const product = await createProduct();
    const gone = await createVariant(product.id);
    await asAdmin((tx) =>
      tx.productVariant.update({ where: { id: gone.id }, data: { deletedAt: new Date() } }),
    );

    const refused = await add(user, gone.id);
    const accepted = await add(user, product.variantId);

    expect(refusal(refused)).toEqual({ status: 404, code: 'VARIANT_NOT_FOUND' });
    expect(accepted.statusCode).toBe(200);
    expect(await favoritesOf(user.id)).toEqual([
      { productId: product.id, variantId: product.variantId },
    ]);
  });

  // a buyer sees no variant without a picture, so it is not one to keep
  it('refuses a variant that shows no picture with 404', async () => {
    const user = await createUser();
    const product = await createProduct();
    await asAdmin((tx) => tx.variantImage.deleteMany({ where: { variantId: product.variantId } }));

    const res = await add(user, product.variantId);

    expect(refusal(res)).toEqual({ status: 404, code: 'VARIANT_NOT_FOUND' });
    expect(await favoritesOf(user.id)).toEqual([]);
  });

  it('refuses a variant that is not there with 404', async () => {
    const res = await add(await createUser(), 2_000_000_000);

    expect(refusal(res)).toEqual({ status: 404, code: 'VARIANT_NOT_FOUND' });
  });

  // the id of a product is not the id of a variant: the route takes variants only
  it.each(['0', '-3', 'abc', '1e3', '2147483648'])(
    'refuses the id %s of the path with 400',
    async (id) => {
      const user = await createUser();

      for (const method of ['POST', 'DELETE'] as const) {
        const res = await app.inject({
          method,
          url: `/api/favorites/${id}`,
          headers: withCsrf(csrf, accessCookie(user)),
        });

        expect(refusal(res)).toEqual({ status: 400, code: expect.stringMatching(/ID|VALIDATION/) });
      }
    },
  );

  it('refuses a cursor with no time in it', async () => {
    const res = await list(await createUser(), `?cursor=${encodeCursor({ id: 5 } as never)}`);

    expect(refusal(res)).toEqual({ status: 400, code: 'CURSOR_INVALID' });
  });

  it('refuses a cursor with a time that is no time', async () => {
    const res = await list(
      await createUser(),
      `?cursor=${encodeCursor({ id: 5, v: 'not a time' } as never)}`,
    );

    expect(refusal(res)).toEqual({ status: 400, code: 'CURSOR_INVALID' });
  });

  it('refuses an admin: the favorites are a list of a buyer', async () => {
    const res = await list(await createUser({ role: 'ADMIN' }));

    expect(refusal(res)).toEqual({ status: 403, code: 'INSUFFICIENT_ROLE' });
  });
});
