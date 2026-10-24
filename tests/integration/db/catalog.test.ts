import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { prisma } from '@db/client.js';

import { inRolledBackTx, type Actor, type DbSession } from '../../helpers/db.js';
import { cartOf, changedRows, pay, waitingOrderOf } from '../../helpers/dbOrders.js';
import {
  closeSessions,
  createProduct,
  createUser,
  deleteProductFromCatalog,
  uniqueTag,
  type TestProduct,
  type TestUser,
} from '../../helpers/factories.js';

// the catalog under each role: categories, products, their images, the favorites and the log of
// prices. Everybody reads the catalog, only an admin changes it. The rating, the count of reviews,
// the popularity and the views of a product are counted by the database itself (triggers); an
// admin sets a popularity of their own through popularityOverride for a time

let user: TestUser;
let other: TestUser;
let admin: TestUser;
let otherAdmin: TestUser;
let product: TestProduct;
let removed: TestProduct;

beforeAll(async () => {
  user = await createUser();
  other = await createUser();
  admin = await createUser({ role: 'ADMIN' });
  otherAdmin = await createUser({ role: 'ADMIN' });
  product = await createProduct({ price: 10, stock: 5 });
  removed = await createProduct({ price: 7, stock: 5 });
  await deleteProductFromCatalog(removed.id);
});

afterAll(async () => {
  try {
    await closeSessions([user.id, other.id, admin.id, otherAdmin.id]);
  } finally {
    await prisma.$disconnect();
  }
});

const asUser = (who: TestUser = user): Actor => ({ role: 'USER', userId: who.id });
const asAdmin = (): Actor => ({ role: 'ADMIN', userId: admin.id });
const asGuest = (guestId: string = randomUUID()): Actor => ({ role: 'GUEST', guestId });

// a product of its own in a category of its own, with nothing done to it yet
async function freshProduct(db: DbSession, price = 10) {
  await db.as(asAdmin());
  const tag = uniqueTag();
  const [category] = await db.rows<{ id: number }>(
    'insert into cartlify.categories (name, slug) values ($1, $2) returning id',
    `Db category ${tag}`,
    `db-category-${tag}`,
  );
  const [row] = await db.rows<{ id: number }>(
    `insert into cartlify.products (name, price, "categoryId") values ($1, $2, $3) returning id`,
    `Db product ${tag}`,
    price,
    category!.id,
  );
  return { id: row!.id, categoryId: category!.id };
}

type Counters = { views: number; popularity: number; avgRating: number; reviewsCount: number };

const countersOf = async (db: DbSession, productId: number) => {
  await db.as(asAdmin());
  const [row] = await db.rows<Counters>(
    `select views, popularity, "avgRating"::float8 as "avgRating", "reviewsCount"
     from cartlify.products where id = $1`,
    productId,
  );
  return row!;
};

const updateProduct = (db: DbSession, set: string, productId: number, ...values: unknown[]) =>
  db.attempt(
    `update cartlify.products set ${set} where id = $1 returning id`,
    productId,
    ...values,
  );

describe('categories', () => {
  it('let a guest read them', async () => {
    const seen = await inRolledBackTx(async (db) => {
      await db.as(asGuest());
      return db.rows('select id from cartlify.categories where id = $1', product.categoryId);
    });

    expect(seen).toEqual([{ id: product.categoryId }]);
  });

  it('let an admin create, change and delete one', async () => {
    const outcomes = await inRolledBackTx(async (db) => {
      await db.as(asAdmin());
      const tag = uniqueTag();
      const created = await db.attempt<{ id: number }>(
        'insert into cartlify.categories (name, slug) values ($1, $2) returning id',
        `Db category ${tag}`,
        `db-category-${tag}`,
      );
      const id = created.ok ? created.rows[0]!.id : 0;
      return [
        created,
        await db.attempt(
          `update cartlify.categories set name = 'Renamed' where id = $1 returning id`,
          id,
        ),
        await db.attempt('delete from cartlify.categories where id = $1 returning id', id),
      ];
    });

    expect(outcomes.map(changedRows)).toEqual([true, true, true]);
  });

  it.each([
    ['a user', () => asUser()],
    ['a guest', () => asGuest()],
  ])('let %s create, change or delete none', async (_who, actor) => {
    const outcomes = await inRolledBackTx(async (db) => {
      await db.as(actor());
      const tag = uniqueTag();
      return [
        await db.attempt(
          'insert into cartlify.categories (name, slug) values ($1, $2) returning id',
          `Db category ${tag}`,
          `db-category-${tag}`,
        ),
        await db.attempt(
          `update cartlify.categories set name = 'Renamed' where id = $1 returning id`,
          product.categoryId,
        ),
        await db.attempt(
          'delete from cartlify.categories where id = $1 returning id',
          product.categoryId,
        ),
      ];
    });

    expect(outcomes.map(changedRows)).toEqual([false, false, false]);
  });

  it('keep a category that has products', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      await db.as(asAdmin());
      return db.attempt(
        'delete from cartlify.categories where id = $1 returning id',
        product.categoryId,
      );
    });

    expect(outcome.ok).toBe(false);
  });
});

describe('products', () => {
  it('let a guest read every product, a removed one as well (orders show it)', async () => {
    const seen = await inRolledBackTx(async (db) => {
      await db.as(asGuest());
      return db.rows<{ id: number }>(
        'select id from cartlify.products where id = any($1::int[]) order by id',
        [product.id, removed.id],
      );
    });

    expect(seen.map((row) => row.id)).toEqual([product.id, removed.id].sort((a, b) => a - b));
  });

  it.each([
    ['a user', () => asUser()],
    ['a guest', () => asGuest()],
  ])('let %s create, change or delete none', async (_who, actor) => {
    const outcomes = await inRolledBackTx(async (db) => {
      await db.as(actor());
      return [
        await db.attempt(
          `insert into cartlify.products (name, price, "categoryId") values ('Forged', 1, $1) returning id`,
          product.categoryId,
        ),
        await updateProduct(db, 'price = 0.01', product.id),
        await updateProduct(db, `name = 'Renamed'`, product.id),
        await updateProduct(db, '"deletedAt" = now()', product.id),
        await db.attempt('delete from cartlify.products where id = $1 returning id', product.id),
      ];
    });

    expect(outcomes.map(changedRows)).toEqual([false, false, false, false, false]);
  });

  // the stock comes with the batches (stock.test.ts)
  it('let an admin create a product and change its price and description', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      const fresh = await freshProduct(db);
      return updateProduct(db, `price = 12, description = 'New'`, fresh.id);
    });

    expect(changedRows(outcome)).toBe(true);
  });

  // the rating and the count of reviews come from the reviews, the popularity from what people do,
  // the views from the visits; an admin who sets them writes numbers nobody earned
  it.each([
    ['the rating', '"avgRating" = 5'],
    ['the count of reviews', '"reviewsCount" = 100'],
    ['the popularity', 'popularity = 1000'],
    ['the views', 'views = 100000'],
  ])('does not let an admin set %s of a product', async (_what, set) => {
    const outcome = await inRolledBackTx(async (db) => {
      const fresh = await freshProduct(db);
      await db.as(asAdmin());
      return updateProduct(db, set, fresh.id);
    });

    expect(changedRows(outcome)).toBe(false);
  });

  it.each([
    ['a rating', '"avgRating"', 5],
    ['a count of reviews', '"reviewsCount"', 100],
    ['a popularity', 'popularity', 1000],
    ['views', 'views', 100000],
    ['a reserve', '"reservedStock"', 3],
  ])('does not let an admin create a product that has %s already', async (_what, column, value) => {
    const outcome = await inRolledBackTx(async (db) => {
      await db.as(asAdmin());
      return db.attempt(
        `insert into cartlify.products (name, price, stock, "categoryId", ${column})
         values ('Forged', 1, 0, $1, $2) returning id`,
        product.categoryId,
        value,
      );
    });

    expect(outcome.ok).toBe(false);
  });

  it('refuses a negative price', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      await db.as(asAdmin());
      return updateProduct(db, 'price = -1', product.id);
    });

    expect(outcome).toMatchObject({ ok: false, code: '23514' });
  });
});

describe('the views of a product', () => {
  it.each([
    ['a guest', () => asGuest()],
    ['a user', () => asUser()],
  ])('let %s add one view', async (_who, actor) => {
    const { outcome, views } = await inRolledBackTx(async (db) => {
      const fresh = await freshProduct(db);
      await db.as(actor());
      const outcome = await updateProduct(db, 'views = views + 1', fresh.id);
      return { outcome, views: (await countersOf(db, fresh.id)).views };
    });

    expect(changedRows(outcome)).toBe(true);
    expect(views).toBe(1);
  });

  it.each([
    ['more than one', 'views = views + 2'],
    ['one less', 'views = views - 1'],
  ])('let no guest add %s', async (_case, set) => {
    const outcome = await inRolledBackTx(async (db) => {
      const fresh = await freshProduct(db);
      await db.as(asUser());
      await updateProduct(db, 'views = views + 1', fresh.id);
      await db.as(asGuest());
      return updateProduct(db, set, fresh.id);
    });

    expect(changedRows(outcome)).toBe(false);
  });

  // the product page counts the visit of whoever opens it, an admin as well
  it('let an admin add one view, the way a visit of the product page does', async () => {
    const { outcome, views } = await inRolledBackTx(async (db) => {
      const fresh = await freshProduct(db);
      await db.as(asAdmin());
      const outcome = await updateProduct(db, 'views = views + 1', fresh.id);
      return { outcome, views: (await countersOf(db, fresh.id)).views };
    });

    expect(changedRows(outcome)).toBe(true);
    expect(views).toBe(1);
  });

  it('let a view change nothing else of the product', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      const fresh = await freshProduct(db);
      await db.as(asGuest());
      return updateProduct(db, 'views = views + 1, price = 0.01', fresh.id);
    });

    expect(changedRows(outcome)).toBe(false);
  });
});

describe('the popularity of a product', () => {
  // 4 * ln(1 + favorites of 30 days), rounded: one favorite is 3
  it('grows with a favorite and falls back when it goes', async () => {
    const { before, added, taken } = await inRolledBackTx(async (db) => {
      const fresh = await freshProduct(db);
      const before = (await countersOf(db, fresh.id)).popularity;
      await db.as(asUser());
      await db.rows(
        'insert into cartlify.favorites ("userId", "productId") values ($1, $2) returning id',
        user.id,
        fresh.id,
      );
      const added = (await countersOf(db, fresh.id)).popularity;
      await db.as(asUser());
      await db.rows(
        'delete from cartlify.favorites where "userId" = $1 and "productId" = $2 returning id',
        user.id,
        fresh.id,
      );
      return { before, added, taken: (await countersOf(db, fresh.id)).popularity };
    });

    expect({ before, added, taken }).toEqual({ before: 0, added: 3, taken: 0 });
  });

  // a known finding, put off by the owner of the project (20.10.2026): nothing counts the
  // popularity again when an admin sets one, a periodic recount on Railway comes later. it.failing
  // keeps the right expectation and turns red once the recount is there, then it becomes a plain it
  it.failing('shows the popularity an admin sets while its time lasts', async () => {
    const popularity = await inRolledBackTx(async (db) => {
      const fresh = await freshProduct(db);
      await db.as(asAdmin());
      await updateProduct(
        db,
        `"popularityOverride" = 500, "popularityOverrideUntil" = now() + interval '1 day'`,
        fresh.id,
      );
      return (await countersOf(db, fresh.id)).popularity;
    });

    expect(popularity).toBe(500);
  });

  // the row of a product is written, and stays locked to the end of the transaction, only when its
  // popularity has something to count again; every write of a row gives it a new ctid
  const rowVersionOf = async (db: DbSession, productId: number) => {
    await db.as(asAdmin());
    const [row] = await db.rows<{ ctid: string }>(
      'select ctid::text as ctid from cartlify.products where id = $1',
      productId,
    );
    return row!.ctid;
  };

  // the popularity counts the items in carts, not their quantity
  it('leaves the product row alone when the quantity of an item in a cart changes', async () => {
    const versions = await inRolledBackTx(async (db) => {
      const fresh = await freshProduct(db);
      const orderId = await cartOf(db, user.id, [[fresh.id, 1]]);
      const before = await rowVersionOf(db, fresh.id);
      await db.as(asUser());
      await db.rows(
        'update cartlify.order_items set quantity = 3 where "orderId" = $1 returning id',
        orderId,
      );
      return { before, after: await rowVersionOf(db, fresh.id) };
    });

    expect(versions.after).toBe(versions.before);
  });

  // the popularity counts the reviews, not the votes on them
  it('leaves the product row alone when somebody votes on one of its reviews', async () => {
    const versions = await inRolledBackTx(async (db) => {
      const fresh = await freshProduct(db);
      await db.as(asUser(other));
      const [review] = await db.rows<{ id: number }>(
        'insert into cartlify.reviews ("userId", "productId", rating) values ($1, $2, 5) returning id',
        other.id,
        fresh.id,
      );
      const before = await rowVersionOf(db, fresh.id);
      await db.as(asUser());
      await db.rows(
        `insert into cartlify.review_votes ("userId", "reviewId", action) values ($1, $2, 'UP') returning id`,
        user.id,
        review!.id,
      );
      return { before, after: await rowVersionOf(db, fresh.id) };
    });

    expect(versions.after).toBe(versions.before);
  });

  // a purchase counts once the order is confirmed; shipping it changes nothing the score counts
  it('leaves the product row alone when a paid order is shipped', async () => {
    const versions = await inRolledBackTx(async (db) => {
      const orderId = await waitingOrderOf(db, user.id, [[product.id, 1]]);
      const result = await pay(db, admin.id, orderId);
      if (result !== 'PAID') throw new Error(`pay_order answered ${result}`);
      const before = await rowVersionOf(db, product.id);
      await db.as(asAdmin());
      await db.rows(
        `update cartlify.orders set status = 'shipped' where id = $1 returning id`,
        orderId,
      );
      return { before, after: await rowVersionOf(db, product.id) };
    });

    expect(versions.after).toBe(versions.before);
  });

  it('keeps the popularity an admin set when people act meanwhile', async () => {
    const popularity = await inRolledBackTx(async (db) => {
      const fresh = await freshProduct(db);
      await db.as(asAdmin());
      await updateProduct(
        db,
        `"popularityOverride" = 500, "popularityOverrideUntil" = now() + interval '1 day'`,
        fresh.id,
      );
      await db.as(asUser());
      await db.rows(
        'insert into cartlify.favorites ("userId", "productId") values ($1, $2) returning id',
        user.id,
        fresh.id,
      );
      return (await countersOf(db, fresh.id)).popularity;
    });

    expect(popularity).toBe(500);
  });
});

describe('product images', () => {
  const insertImage = (db: DbSession, productId: number, isPrimary: boolean, position: number) =>
    db.attempt(
      `insert into cartlify.product_images ("productId", url, position, "isPrimary")
       values ($1, 'https://res.cloudinary.com/demo/image/upload/v1/test/p.jpg', $2, $3) returning id`,
      productId,
      position,
      isPrimary,
    );

  it('let a guest read them and only an admin add one', async () => {
    const { seen, byUser, byAdmin } = await inRolledBackTx(async (db) => {
      await db.as(asGuest());
      const seen = await db.rows(
        'select id from cartlify.product_images where "productId" = $1',
        product.id,
      );
      await db.as(asUser());
      const byUser = await insertImage(db, product.id, false, 5);
      await db.as(asAdmin());
      const byAdmin = await insertImage(db, product.id, false, 5);
      return { seen, byUser, byAdmin };
    });

    expect(seen.length).toBeGreaterThan(0);
    expect(byUser.ok).toBe(false);
    expect(changedRows(byAdmin)).toBe(true);
  });

  it('let a user change or delete no image', async () => {
    const outcomes = await inRolledBackTx(async (db) => {
      await db.as(asUser());
      return [
        await db.attempt(
          `update cartlify.product_images set url = 'https://example.com/x.jpg' where "productId" = $1 returning id`,
          product.id,
        ),
        await db.attempt(
          'delete from cartlify.product_images where "productId" = $1 returning id',
          product.id,
        ),
      ];
    });

    expect(outcomes.map(changedRows)).toEqual([false, false]);
  });

  // the cart, the orders and the lists show the primary image of a product: one per product
  it('keep one primary image per product', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      const fresh = await freshProduct(db);
      await db.as(asAdmin());
      await insertImage(db, fresh.id, true, 0);
      return insertImage(db, fresh.id, true, 1);
    });

    expect(outcome.ok).toBe(false);
  });
});

describe('favorites', () => {
  const insertFavorite = (
    db: DbSession,
    owner: { userId?: number; guestId?: string },
    productId: number,
  ) =>
    db.attempt(
      `insert into cartlify.favorites ("userId", "guestId", "productId") values ($1, $2::uuid, $3) returning id`,
      owner.userId ?? null,
      owner.guestId ?? null,
      productId,
    );

  it('let a user and a guest keep their own, each sees only their own', async () => {
    const guestId = randomUUID();

    const seen = await inRolledBackTx(async (db) => {
      await db.as(asUser());
      await insertFavorite(db, { userId: user.id }, product.id);
      await db.as(asUser(other));
      await insertFavorite(db, { userId: other.id }, product.id);
      await db.as(asGuest(guestId));
      await insertFavorite(db, { guestId }, product.id);

      const result: Record<string, number> = {};
      for (const [who, actor] of [
        ['user', asUser()],
        ['guest', asGuest(guestId)],
        ['another guest', asGuest()],
        ['admin', asAdmin()],
      ] as const) {
        await db.as(actor);
        const [row] = await db.rows<{ n: number }>(
          'select count(*)::int as n from cartlify.favorites where "productId" = $1',
          product.id,
        );
        result[who] = row!.n;
      }
      return result;
    });

    expect(seen).toMatchObject({ user: 1, guest: 1, 'another guest': 0 });
    expect(seen.admin).toBeGreaterThanOrEqual(3);
  });

  it.each([
    ['a user a favorite of another user', () => asUser(), () => ({ userId: other.id })],
    ['a guest a favorite of another guest', () => asGuest(), () => ({ guestId: randomUUID() })],
  ])('refuse %s', async (_case, actor, owner) => {
    const outcome = await inRolledBackTx(async (db) => {
      await db.as(actor());
      return insertFavorite(db, owner(), product.id);
    });

    expect(outcome.ok).toBe(false);
  });

  it('keep a product once in the favorites of a user', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      await db.as(asUser());
      await insertFavorite(db, { userId: user.id }, product.id);
      return insertFavorite(db, { userId: user.id }, product.id);
    });

    expect(outcome.ok).toBe(false);
  });

  it('let nobody change a favorite, and only its owner delete it', async () => {
    const { change, byAdmin, byOther, byOwner } = await inRolledBackTx(async (db) => {
      await db.as(asUser());
      await insertFavorite(db, { userId: user.id }, product.id);
      const where = `"userId" = ${user.id} and "productId" = ${product.id}`;

      const change = await db.attempt(
        `update cartlify.favorites set "productId" = $1 where ${where} returning id`,
        removed.id,
      );
      await db.as(asAdmin());
      const byAdmin = await db.attempt(
        `delete from cartlify.favorites where ${where} returning id`,
      );
      await db.as(asUser(other));
      const byOther = await db.attempt(
        `delete from cartlify.favorites where ${where} returning id`,
      );
      await db.as(asUser());
      const byOwner = await db.attempt(
        `delete from cartlify.favorites where ${where} returning id`,
      );
      return { change, byAdmin, byOther, byOwner };
    });

    expect(changedRows(change)).toBe(false);
    expect(changedRows(byAdmin)).toBe(false);
    expect(changedRows(byOther)).toBe(false);
    expect(changedRows(byOwner)).toBe(true);
  });

  // the app does not offer it, the database is the last line that holds
  it.each([
    ['a user', () => asUser(), () => ({ userId: user.id })],
    ['a guest', (guestId: string) => asGuest(guestId), (guestId: string) => ({ guestId })],
  ])('let %s add no product removed from the catalog', async (_who, actor, owner) => {
    const guestId = randomUUID();

    const outcome = await inRolledBackTx(async (db) => {
      await db.as(actor(guestId));
      return insertFavorite(db, owner(guestId), removed.id);
    });

    expect(outcome.ok).toBe(false);
  });
});

// a line of the log names who changed the price: the function takes the admin of the context,
// nobody passes a name, and the app writes no line straight into the table
describe('the log of prices', () => {
  const logPrice = (db: DbSession) =>
    db.attempt(
      `select 1 as done from cartlify.log_product_price_change($1::int, 10, 12, 'fixed', 2)`,
      product.id,
    );

  const insertLine = (db: DbSession, actorId: number) =>
    db.attempt(
      `insert into cartlify.product_price_change_logs ("productId", "actorId", "oldPrice", "newPrice", mode, value)
       values ($1, $2, 10, 12, 'fixed', 2) returning id`,
      product.id,
      actorId,
    );

  it('writes a line in the name of the admin of the context, and the admin reads the log', async () => {
    const { written, actors } = await inRolledBackTx(async (db) => {
      await db.as(asAdmin());
      const written = await logPrice(db);
      const actors = await db.rows<{ actorId: number }>(
        `select "actorId" from cartlify.product_price_change_logs
         where "productId" = $1 order by id desc limit 1`,
        product.id,
      );
      return { written, actors };
    });

    expect(written.ok).toBe(true);
    expect(actors).toEqual([{ actorId: admin.id }]);
  });

  it.each([
    ['in the name of another admin', () => otherAdmin.id],
    ['in their own name', () => admin.id],
  ])('does not let an admin write a line straight into the table %s', async (_case, actorOf) => {
    const outcome = await inRolledBackTx(async (db) => {
      await db.as(asAdmin());
      return insertLine(db, actorOf());
    });

    expect(outcome.ok).toBe(false);
  });

  // the system is no one, a line needs the id of the admin who changed the price
  it('refuses the system, it has no id', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      await db.as({ role: 'ADMIN' });
      return logPrice(db);
    });

    expect(outcome).toMatchObject({
      ok: false,
      message: expect.stringContaining('PRICE_LOG_ACTOR_REQUIRED'),
    });
  });

  it('lets a user neither read nor write the log', async () => {
    const { written, seen } = await inRolledBackTx(async (db) => {
      await db.as(asAdmin());
      await logPrice(db);
      await db.as(asUser());
      return {
        written: await logPrice(db),
        seen: await db.rows(
          'select id from cartlify.product_price_change_logs where "productId" = $1',
          product.id,
        ),
      };
    });

    expect(written).toMatchObject({
      ok: false,
      message: expect.stringContaining('PRICE_LOG_FORBIDDEN'),
    });
    expect(seen).toEqual([]);
  });
});
