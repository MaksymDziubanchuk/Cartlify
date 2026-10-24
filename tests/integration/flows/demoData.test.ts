import { spawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { startApp, stopApp } from '../../helpers/app.js';
import { removeUploads, uploadMark, uploadsSince } from '../../helpers/cloudinary.js';
import { getCsrf, withCsrf } from '../../helpers/csrf.js';
import { asAdmin } from '../../helpers/db.js';
import { createProduct, createUser, uniqueTag, type TestUser } from '../../helpers/factories.js';
import { mailedToken, watchMail, type SentMail } from '../../helpers/mail.js';

// the demo data of db/tools/demo_data.mjs: a catalog, its stock and a few buyers made through the
// routes of the shop, by a process of its own against the app listening on a port, the way it runs
// against dev. Its requests pass the checks real ones pass, and every answer is held against the
// swagger document like any other of the tests
const ADMIN_PASSWORD = 'demo-admin-password-1';
const USERS_PASSWORD = 'demo-users-password-1';
const DEMO_CATEGORIES: Record<string, string | null> = {
  electronics: null,
  phones: 'electronics',
  laptops: 'electronics',
  headphones: 'electronics',
  home: null,
  kitchen: 'home',
  lighting: 'home',
  books: null,
};
const DEMO_PRODUCTS = 16;
const DEMO_BUYERS = 3;

let app: FastifyInstance;
let baseUrl: string;
let admin: TestUser;
// the buyers of the demo get addresses of a domain of this run
let emailDomain: string;

type Run = { code: number | null; output: string };

// the script in a process of its own, with only what it is given: the event loop of the tests
// stays free to answer it
function runDemo(env: Record<string, string> = {}): Promise<Run> {
  const childEnv: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    DEMO_API_URL: baseUrl,
    DEMO_ADMIN_EMAIL: admin.email,
    DEMO_ADMIN_PASSWORD: ADMIN_PASSWORD,
    DEMO_USERS_PASSWORD: USERS_PASSWORD,
    DEMO_EMAIL_DOMAIN: emailDomain,
    ...env,
  };

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['db/tools/demo_data.mjs'], {
      env: childEnv as NodeJS.ProcessEnv,
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, output }));
  });
}

// rows of each owner by its id, in the order they came
const byOwner = <T, K>(rows: T[], keyOf: (row: T) => K): Map<K, T[]> => {
  const out = new Map<K, T[]>();
  for (const row of rows) out.set(keyOf(row), [...(out.get(keyOf(row)) ?? []), row]);
  return out;
};

// what the demo made, read under the admin context. Each table is a query of its own, one after
// the other: a transaction has one connection, and prisma reads the relations of one query at once
async function demoState() {
  return asAdmin(async (tx) => {
    const categories = await tx.category.findMany({
      where: { slug: { in: Object.keys(DEMO_CATEGORIES) } },
      select: { id: true, slug: true, parentId: true },
    });

    const productRows = await tx.product.findMany({
      where: { sku: { startsWith: 'DEMO-' } },
      select: {
        id: true,
        sku: true,
        categoryId: true,
        stock: true,
        salePrice: true,
        saleEndsAt: true,
        reviewsCount: true,
      },
      orderBy: { sku: 'asc' },
    });
    const productIds = productRows.map((p) => p.id);
    const images = byOwner(
      await tx.productImage.findMany({
        where: { productId: { in: productIds } },
        select: { productId: true, isPrimary: true },
      }),
      (row) => row.productId,
    );
    const batches = byOwner(
      await tx.productBatch.findMany({
        where: { productId: { in: productIds } },
        select: { productId: true, quantity: true, unitCost: true, expiresAt: true },
      }),
      (row) => row.productId,
    );
    const reviewCounts = await tx.review.groupBy({
      by: ['productId'],
      where: { productId: { in: productIds } },
      _count: { _all: true },
    });
    const products = productRows.map((p) => ({
      ...p,
      _count: {
        reviews: reviewCounts.find((r) => r.productId === p.id)?._count._all ?? 0,
      },
      images: images.get(p.id) ?? [],
      batches: batches.get(p.id) ?? [],
    }));

    const buyerRows = await tx.user.findMany({
      where: { email: { endsWith: `@${emailDomain}` } },
      select: { id: true, role: true },
      orderBy: { id: 'asc' },
    });
    const buyerIds = buyerRows.map((b) => b.id);
    const orders = byOwner(
      await tx.order.findMany({
        where: { userId: { in: buyerIds } },
        select: { userId: true, status: true, confirmed: true, shippingAddress: true },
      }),
      (row) => row.userId,
    );
    const reviews = byOwner(
      await tx.review.findMany({
        where: { userId: { in: buyerIds } },
        select: { userId: true, productId: true, rating: true },
      }),
      (row) => row.userId,
    );
    const favorites = byOwner(
      await tx.favorite.findMany({
        where: { userId: { in: buyerIds } },
        select: { userId: true, productId: true },
      }),
      (row) => row.userId,
    );
    const buyers = buyerRows.map((b) => ({
      ...b,
      orders: orders.get(b.id) ?? [],
      reviews: reviews.get(b.id) ?? [],
      favorites: favorites.get(b.id) ?? [],
    }));

    return { categories, products, buyers };
  });
}

const countsOf = (state: Awaited<ReturnType<typeof demoState>>) => ({
  categories: state.categories.length,
  products: state.products.length,
  images: state.products.reduce((sum, p) => sum + p.images.length, 0),
  batches: state.products.reduce((sum, p) => sum + p.batches.length, 0),
  buyers: state.buyers.length,
  orders: state.buyers.reduce((sum, b) => sum + b.orders.length, 0),
  reviews: state.buyers.reduce((sum, b) => sum + b.reviews.length, 0),
  favorites: state.buyers.reduce((sum, b) => sum + b.favorites.length, 0),
});

beforeAll(async () => {
  app = await startApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  admin = await createUser({ role: 'ADMIN', password: ADMIN_PASSWORD });
  emailDomain = `demo-${uniqueTag()}.example.com`;

  // a product of the shop with no image, the way an import may leave one: the catalog of a guest
  // leaves it out, and the demo reads the catalog of its own categories only
  const other = await createProduct();
  await asAdmin((tx) => tx.productImage.deleteMany({ where: { productId: other.id } }));
});

afterAll(async () => {
  try {
    await removeUploads();
  } finally {
    await stopApp();
  }
});

describe('db/tools/demo_data.mjs', () => {
  let first: Run;
  let waiting: Run;
  let second: Run;
  let afterFirst: Awaited<ReturnType<typeof demoState>>;
  let afterWaiting: Awaited<ReturnType<typeof demoState>>;
  let state: Awaited<ReturnType<typeof demoState>>;
  let mails: SentMail[];
  let mailsAfterFirst: number;
  let mailsAfterWaiting: number;

  // the first run makes the catalog and registers the buyers, a run before they confirm their
  // email changes nothing; the buyers confirm it by the link of the mail, the way a person does,
  // and the next run gives them their orders
  beforeAll(async () => {
    mails = watchMail();
    first = await runDemo();
    afterFirst = await demoState();
    mailsAfterFirst = mails.length;

    waiting = await runDemo();
    afterWaiting = await demoState();
    mailsAfterWaiting = mails.length;

    for (const mail of mails) {
      const verify = await app.inject({
        method: 'GET',
        url: `/api/auth/verify?token=${encodeURIComponent(mailedToken([mail], '/web/login'))}`,
      });
      expect(verify.statusCode).toBe(200);
    }

    second = await runDemo();
    state = await demoState();
  }, 180_000);

  // the output of a run that failed shows in the failure of the test
  it('ends well and names none of what it was given', () => {
    for (const run of [first, waiting, second]) {
      expect({ code: run.code, output: run.code === 0 ? 'ended well' : run.output }).toEqual({
        code: 0,
        output: 'ended well',
      });
      for (const secret of [admin.email, ADMIN_PASSWORD, USERS_PASSWORD, baseUrl, emailDomain]) {
        expect(run.output).not.toContain(secret);
      }
    }
  });

  it('registers the buyers and leaves them to confirm their email', () => {
    expect(afterFirst.buyers).toHaveLength(DEMO_BUYERS);
    expect(countsOf(afterFirst)).toMatchObject({ orders: 0, reviews: 0, favorites: 0 });
    expect(mailsAfterFirst).toBe(DEMO_BUYERS);
    expect(first.output).toContain(`${DEMO_BUYERS} registered now`);
  });

  // registering again would send a new link and close the one in the mail
  it('sends no new mail to a buyer who has not confirmed yet, and changes nothing', () => {
    expect(mailsAfterWaiting).toBe(mailsAfterFirst);
    expect(countsOf(afterWaiting)).toEqual(countsOf(afterFirst));
    expect(waiting.output).toContain(`${DEMO_BUYERS} wait for the confirmation of their email`);
  });

  it('makes the tree of the categories of the demo', () => {
    const idOf = new Map(state.categories.map((c) => [c.slug, c.id]));
    expect([...idOf.keys()].sort()).toEqual(Object.keys(DEMO_CATEGORIES).sort());

    for (const c of state.categories) {
      const parent = DEMO_CATEGORIES[c.slug];
      expect({ slug: c.slug, parentId: c.parentId }).toEqual({
        slug: c.slug,
        parentId: parent ? idOf.get(parent) : null,
      });
    }
  });

  it('makes the products with images, each in a category of the demo that has no categories below', () => {
    const leafIds = new Set(
      state.categories
        .filter((c) => !state.categories.some((child) => child.parentId === c.id))
        .map((c) => c.id),
    );

    expect(state.products).toHaveLength(DEMO_PRODUCTS);
    for (const p of state.products) {
      expect(leafIds.has(p.categoryId)).toBe(true);
      expect(p.images.length).toBeGreaterThanOrEqual(1);
      expect(p.images.filter((i) => i.isPrimary)).toHaveLength(1);
    }
    // every category with no categories below has products
    for (const id of leafIds) expect(state.products.some((p) => p.categoryId === id)).toBe(true);
  });

  it('brings the stock of every product with a delivery in batches', () => {
    for (const p of state.products) {
      const delivered = p.batches.reduce((sum, b) => sum + b.quantity, 0);
      expect(p.batches.length).toBeGreaterThanOrEqual(1);
      expect(p.stock).toBe(delivered);
      expect(p.stock).toBeGreaterThan(0);
    }
    // a batch with a last good day, for the expiry alerts and the selling order
    expect(state.products.some((p) => p.batches.some((b) => b.expiresAt !== null))).toBe(true);
  });

  it('keeps the data of safety of every product in its description', async () => {
    for (const p of state.products.slice(0, 3)) {
      const res = await app.inject({ method: 'GET', url: `/api/products/${p.id}` });
      const body = res.json();
      expect(res.statusCode).toBe(200);
      expect(body.safety.manufacturer).toEqual({
        name: expect.any(String),
        address: expect.any(String),
        email: expect.any(String),
        country: expect.stringMatching(/^[A-Z]{2}$/),
      });
    }
  });

  it('puts some of the products on a sale that lasts', () => {
    const onSale = state.products.filter(
      (p) => p.salePrice !== null && p.saleEndsAt !== null && p.saleEndsAt > new Date(),
    );
    expect(onSale.length).toBeGreaterThanOrEqual(3);
    expect(onSale.length).toBeLessThan(DEMO_PRODUCTS);
  });

  it('lets the buyers who confirmed their email in with the password of the demo', async () => {
    expect(second.output).toContain(`${DEMO_BUYERS} logged in`);
    expect(state.buyers).toHaveLength(DEMO_BUYERS);
    expect(state.buyers.every((b) => b.role === 'USER')).toBe(true);

    const email = (
      await asAdmin((tx) =>
        tx.user.findUniqueOrThrow({ where: { id: state.buyers[0]!.id }, select: { email: true } }),
      )
    ).email;
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email, password: USERS_PASSWORD },
      headers: withCsrf(await getCsrf(app)),
    });
    expect(res.statusCode).toBe(200);
  });

  it('gives the buyers carts and confirmed orders with their shipping', () => {
    const statuses = state.buyers.map((b) => b.orders.map((o) => o.status).sort());
    expect(statuses).toEqual([['waiting'], ['pending', 'waiting'], ['pending']]);

    for (const order of state.buyers.flatMap((b) => b.orders)) {
      expect(order.confirmed).toBe(order.status === 'waiting');
      if (order.confirmed) expect(order.shippingAddress).toEqual(expect.any(String));
    }
  });

  it('gives the products reviews and the buyers favorites', () => {
    const productIds = new Set(state.products.map((p) => p.id));
    const reviews = state.buyers.flatMap((b) => b.reviews);

    expect(reviews.length).toBeGreaterThanOrEqual(6);
    expect(reviews.every((r) => productIds.has(r.productId) && r.rating !== null)).toBe(true);
    // a product counts every review it has, of this run and of a run before on the same database
    for (const p of state.products) {
      expect(p.reviewsCount).toBe(p._count.reviews);
      if (reviews.some((r) => r.productId === p.id)) expect(p.reviewsCount).toBeGreaterThan(0);
    }
    for (const b of state.buyers) {
      expect(b.favorites.length).toBeGreaterThanOrEqual(2);
      expect(b.favorites.every((f) => productIds.has(f.productId))).toBe(true);
    }
  });

  it('adds nothing when it runs again', async () => {
    const mark = uploadMark();
    const again = await runDemo();

    expect(again.code).toBe(0);
    expect(countsOf(await demoState())).toEqual(countsOf(state));
    expect(uploadsSince(mark)).toEqual([]);
  }, 120_000);

  it('stops with no admin to log in as, and makes nothing', async () => {
    const before = countsOf(await demoState());
    const run = await runDemo({ DEMO_ADMIN_PASSWORD: 'not-the-password-1' });

    expect(run.code).not.toBe(0);
    expect(run.output).not.toContain('not-the-password-1');
    expect(countsOf(await demoState())).toEqual(before);
  }, 60_000);
});
