import { afterAll, describe, expect, it } from '@jest/globals';

import { prisma, tx } from '@db/client.js';
import { setAdminContext } from '@db/dbContext.service.js';
import { InternalError, NotFoundError } from '@utils/errors.js';

import { asAdmin } from '../../helpers/db.js';
import { rejectedBy } from '../../helpers/errors.js';
import { uniqueTag } from '../../helpers/factories.js';

// every transaction of the app has a time, 5 s unless the call names one. When it runs out, prisma
// rolls the transaction back, and a nested write still on its way runs the rest of its statements
// outside it, with no context: rls refuses them (42501), or prisma says the transaction expired
// (P2028). Either way the database was too busy for the request: 409 RESOURCE_BUSY, the client
// repeats it. src/db/client.ts holds this for every transaction, the ones of tx() too

const tag = uniqueTag();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const slugOf = (name: string) => `tx-time-${tag}-${name}`;

const categoriesFrom = (prefix: string) =>
  asAdmin((db) => db.category.count({ where: { slug: { startsWith: prefix } } }));

const busy = { statusCode: 409, errorCode: 'RESOURCE_BUSY' };

afterAll(async () => {
  try {
    await asAdmin(async (db) => {
      await db.product.deleteMany({ where: { name: { startsWith: `Tx time ${tag}` } } });
      await db.category.deleteMany({ where: { slug: { startsWith: `tx-time-${tag}` } } });
    });
  } finally {
    await prisma.$disconnect();
  }
});

describe('a transaction of the app', () => {
  it('gives its value and keeps its rows when it ends in time', async () => {
    const slug = slugOf('in-time');

    const made = await prisma.$transaction(
      async (db) => {
        await setAdminContext(db);
        return db.category.create({
          data: { name: `Tx time ${tag} in time`, slug },
          select: { slug: true },
        });
      },
      { timeout: 10_000 },
    );

    expect(made).toEqual({ slug });
    expect(await categoriesFrom(slug)).toBe(1);
  });

  it('is the busy database when a statement comes after its time ran out, and keeps nothing', async () => {
    const slug = slugOf('late');

    const err = await rejectedBy(() =>
      prisma.$transaction(
        async (db) => {
          await setAdminContext(db);
          await db.category.create({ data: { name: `Tx time ${tag} late`, slug } });
          await sleep(400);
          await db.category.count();
        },
        { timeout: 150 },
      ),
    );

    expect(err).toMatchObject(busy);
    expect(await categoriesFrom(slug)).toBe(0);
  });

  // a product with many images is one statement of the app and many of prisma: the time runs out
  // somewhere in it, and the rest runs after the rollback, outside the transaction
  it('is the busy database when its time runs out inside a nested write, never a refusal of the database', async () => {
    const prefix = slugOf('nested-');
    const failures: unknown[] = [];

    for (let i = 0; i < 40; i += 1) {
      try {
        await prisma.$transaction(
          async (db) => {
            await setAdminContext(db);
            const category = await db.category.create({
              data: { name: `Tx time ${tag} nested ${i}`, slug: `${prefix}${i}` },
            });
            return db.product.create({
              data: {
                name: `Tx time ${tag} ${i}`,
                price: 10,
                categoryId: category.id,
                images: {
                  create: Array.from({ length: 40 }, (_, n) => ({
                    url: `https://res.cloudinary.com/demo/image/upload/v1/tx/${tag}/${i}/${n}.jpg`,
                    position: n,
                    isPrimary: n === 0,
                  })),
                },
              },
              select: { id: true },
            });
          },
          { timeout: 2 + i },
        );
      } catch (err) {
        failures.push(err);
      }
    }

    expect(failures.length).toBeGreaterThan(0);
    for (const err of failures) expect(err).toMatchObject(busy);
    // a transaction that failed keeps nothing: one category for each that ended
    expect(await categoriesFrom(prefix)).toBe(40 - failures.length);
  });

  it('keeps an error of the app it throws after its time ran out', async () => {
    const err = await rejectedBy(() =>
      prisma.$transaction(
        async (db) => {
          await setAdminContext(db);
          await sleep(300);
          throw new NotFoundError('CATEGORY_NOT_FOUND');
        },
        { timeout: 100 },
      ),
    );

    expect(err).toMatchObject({ statusCode: 404, errorCode: 'CATEGORY_NOT_FOUND' });
  });

  // a service that wraps the failure of a statement into a failure of the server
  it('is the busy database when the app makes a failure of the server of a statement after its time ran out', async () => {
    const err = await rejectedBy(() =>
      prisma.$transaction(
        async (db) => {
          await setAdminContext(db);
          await sleep(300);
          try {
            await db.category.count();
          } catch (cause) {
            throw new InternalError({ reason: 'CATEGORIES_COUNT_UNEXPECTED' }, cause);
          }
        },
        { timeout: 100 },
      ),
    );

    expect(err).toMatchObject(busy);
  });

  it('keeps a refusal of the database that comes in time', async () => {
    const slug = slugOf('taken');
    await asAdmin((db) => db.category.create({ data: { name: `Tx time ${tag} taken`, slug } }));

    const err = await rejectedBy(() =>
      prisma.$transaction(
        async (db) => {
          await setAdminContext(db);
          await db.category.create({ data: { name: `Tx time ${tag} taken again`, slug } });
        },
        { timeout: 10_000 },
      ),
    );

    expect(err).toMatchObject({ code: 'P2002' });
  });

  // tx() tries a transaction again when the database refused it for a lock; one whose time ran out
  // would only run out again
  it('runs once in tx() when its time runs out', async () => {
    let runs = 0;

    const err = await rejectedBy(() =>
      tx(
        async (db) => {
          runs += 1;
          await setAdminContext(db);
          await sleep(300);
          await db.category.count();
        },
        { timeout: 100 },
      ),
    );

    expect(err).toMatchObject(busy);
    expect(runs).toBe(1);
  });
});
