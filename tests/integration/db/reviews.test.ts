import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { prisma } from '@db/client.js';

import { inRolledBackTx, type Actor, type DbSession } from '../../helpers/db.js';
import { changedRows } from '../../helpers/dbOrders.js';
import {
  closeSessions,
  createProduct,
  createUser,
  deleteProductFromCatalog,
  uniqueTag,
  type TestProduct,
  type TestUser,
} from '../../helpers/factories.js';

// the reviews of the products: everybody reads them, a user writes one per product, a rating, a
// comment or both, and later adds the part that is missing; what is written stays as it is. The
// author or an admin deletes a review. The product counts the rating from the ratings and the
// count of reviews from the comments; the votes of a review are counted from review_votes

let author: TestUser;
let other: TestUser;
let admin: TestUser;
let product: TestProduct;
let removed: TestProduct;

beforeAll(async () => {
  author = await createUser();
  other = await createUser();
  admin = await createUser({ role: 'ADMIN' });
  product = await createProduct();
  removed = await createProduct();
  await deleteProductFromCatalog(removed.id);
});

afterAll(async () => {
  try {
    await closeSessions([author.id, other.id, admin.id]);
  } finally {
    await prisma.$disconnect();
  }
});

const asUser = (who: TestUser = author): Actor => ({ role: 'USER', userId: who.id });
const asAdmin = (): Actor => ({ role: 'ADMIN', userId: admin.id });

// a product of its own with no review yet
async function freshProduct(db: DbSession) {
  await db.as(asAdmin());
  const tag = uniqueTag();
  const [category] = await db.rows<{ id: number }>(
    'insert into cartlify.categories (name, slug) values ($1, $2) returning id',
    `Db category ${tag}`,
    `db-category-${tag}`,
  );
  const [row] = await db.rows<{ id: number }>(
    `insert into cartlify.products (name, price, "categoryId") values ($1, 10, $2) returning id`,
    `Db product ${tag}`,
    category!.id,
  );
  return row!.id;
}

const writeReview = (
  db: DbSession,
  userId: number,
  productId: number,
  rating: number | null,
  comment: string | null,
) =>
  db.attempt<{ id: number }>(
    `insert into cartlify.reviews ("userId", "productId", rating, comment) values ($1, $2, $3, $4) returning id`,
    userId,
    productId,
    rating,
    comment,
  );

// a review of the author, written the way the app writes one
async function reviewOf(
  db: DbSession,
  productId: number,
  rating: number | null,
  comment: string | null,
) {
  await db.as(asUser());
  const outcome = await writeReview(db, author.id, productId, rating, comment);
  if (!outcome.ok) throw new Error(`the review was refused: ${outcome.message}`);
  return outcome.rows[0]!.id;
}

const updateReview = (db: DbSession, set: string, reviewId: number) =>
  db.attempt(`update cartlify.reviews set ${set} where id = $1 returning id`, reviewId);

const ratingOf = async (db: DbSession, productId: number) => {
  await db.as(asAdmin());
  const [row] = await db.rows<{ avgRating: number; reviewsCount: number }>(
    `select "avgRating"::float8 as "avgRating", "reviewsCount" from cartlify.products where id = $1`,
    productId,
  );
  return row!;
};

describe('reviews: writing one', () => {
  it('lets a guest read the reviews', async () => {
    const seen = await inRolledBackTx(async (db) => {
      const productId = await freshProduct(db);
      const id = await reviewOf(db, productId, 5, 'Good');
      await db.as({ role: 'GUEST', guestId: randomUUID() });
      return db.rows('select id from cartlify.reviews where id = $1', id);
    });

    expect(seen).toHaveLength(1);
  });

  it.each([
    ['a rating', 4, null],
    ['a comment', null, 'Good'],
    ['a rating and a comment', 5, 'Good'],
  ])('lets a user write %s', async (_case, rating, comment) => {
    const outcome = await inRolledBackTx(async (db) => {
      const productId = await freshProduct(db);
      await db.as(asUser());
      return writeReview(db, author.id, productId, rating, comment);
    });

    expect(changedRows(outcome)).toBe(true);
  });

  it.each([
    ['in the name of another user', () => asUser(), () => other.id, 5, 'Good'],
    ['as an admin', () => asAdmin(), () => admin.id, 5, 'Good'],
    [
      'as a guest',
      (): Actor => ({ role: 'GUEST', guestId: randomUUID() }),
      () => author.id,
      5,
      'Good',
    ],
    ['without a rating and a comment', () => asUser(), () => author.id, null, '   '],
    ['with a rating of 0', () => asUser(), () => author.id, 0, null],
    ['with a rating of 6', () => asUser(), () => author.id, 6, null],
  ])('refuses a review %s', async (_case, actor, userIdOf, rating, comment) => {
    const outcome = await inRolledBackTx(async (db) => {
      const productId = await freshProduct(db);
      await db.as(actor());
      return writeReview(db, userIdOf(), productId, rating, comment);
    });

    expect(outcome.ok).toBe(false);
  });

  it('keeps one review of a user per product', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      const productId = await freshProduct(db);
      await reviewOf(db, productId, 5, null);
      return writeReview(db, author.id, productId, null, 'Second');
    });

    expect(outcome.ok).toBe(false);
  });

  // the app does not offer it, the database is the last line that holds
  it('refuses a review of a product removed from the catalog', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      await db.as(asUser());
      return writeReview(db, author.id, removed.id, 5, 'Good');
    });

    expect(outcome.ok).toBe(false);
  });
});

describe('reviews: changing one', () => {
  it.each([
    ['the comment to a rating', 4, null, `comment = 'Added later'`],
    ['the rating to a comment', null, 'Good', 'rating = 4'],
  ])('lets the author add %s', async (_case, rating, comment, set) => {
    const outcome = await inRolledBackTx(async (db) => {
      const id = await reviewOf(db, await freshProduct(db), rating, comment);
      return updateReview(db, set, id);
    });

    expect(changedRows(outcome)).toBe(true);
  });

  it.each([
    ['change a rating given', 4, null, 'rating = 1'],
    ['change a comment written', null, 'Good', `comment = 'Rewritten'`],
    ['move it to another product', 4, null, '"productId" = $PRODUCT'],
    ['give it to another user', 4, null, '"userId" = $OTHER'],
  ])('does not let the author %s', async (_case, rating, comment, set) => {
    const outcome = await inRolledBackTx(async (db) => {
      const id = await reviewOf(db, await freshProduct(db), rating, comment);
      return updateReview(
        db,
        set.replace('$PRODUCT', String(product.id)).replace('$OTHER', String(other.id)),
        id,
      );
    });

    expect(changedRows(outcome)).toBe(false);
  });

  // the votes of a review are counted from review_votes, never written by hand
  it('does not let the author set the votes of an own review', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      const id = await reviewOf(db, await freshProduct(db), 4, null);
      return updateReview(db, `"upVotes" = 1000`, id);
    });

    expect(changedRows(outcome)).toBe(false);
  });

  it.each([
    ['another user', () => asUser(other)],
    ['an admin', () => asAdmin()],
  ])('does not let %s change a review', async (_who, actor) => {
    const outcome = await inRolledBackTx(async (db) => {
      const id = await reviewOf(db, await freshProduct(db), 4, null);
      await db.as(actor());
      return updateReview(db, `comment = 'Taken over'`, id);
    });

    expect(changedRows(outcome)).toBe(false);
  });
});

describe('reviews: deleting one', () => {
  it.each([
    ['the author', () => asUser(), true],
    ['an admin', () => asAdmin(), true],
    ['another user', () => asUser(other), false],
  ])('%s deletes it: %s', async (_who, actor, deletes) => {
    const outcome = await inRolledBackTx(async (db) => {
      const id = await reviewOf(db, await freshProduct(db), 4, 'Good');
      await db.as(actor());
      return db.attempt('delete from cartlify.reviews where id = $1 returning id', id);
    });

    expect(changedRows(outcome)).toBe(deletes);
  });
});

describe('the rating of a product', () => {
  // avgRating is the average of the ratings, reviewsCount the number of comments
  it('follows the reviews as they are written, filled in and deleted', async () => {
    const steps = await inRolledBackTx(async (db) => {
      const productId = await freshProduct(db);
      const first = await reviewOf(db, productId, 4, null);
      const afterFirst = await ratingOf(db, productId);

      await db.as(asUser(other));
      await writeReview(db, other.id, productId, 2, 'Bad');
      const afterSecond = await ratingOf(db, productId);

      await db.as(asUser());
      await updateReview(db, `comment = 'Fine after all'`, first);
      const afterComment = await ratingOf(db, productId);

      await db.as(asAdmin());
      await db.rows('delete from cartlify.reviews where id = $1 returning id', first);
      const afterDelete = await ratingOf(db, productId);

      return { afterFirst, afterSecond, afterComment, afterDelete };
    });

    expect(steps).toEqual({
      afterFirst: { avgRating: 4, reviewsCount: 0 },
      afterSecond: { avgRating: 3, reviewsCount: 1 },
      afterComment: { avgRating: 3, reviewsCount: 2 },
      afterDelete: { avgRating: 2, reviewsCount: 1 },
    });
  });
});
