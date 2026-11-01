import { spawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie } from '../../helpers/actors.js';
import { startApp, stopApp } from '../../helpers/app.js';
import { removeUploads, uploadMark, uploadsSince } from '../../helpers/cloudinary.js';
import { getCsrf, withCsrf } from '../../helpers/csrf.js';
import { asAdmin } from '../../helpers/db.js';
import { createProduct, createUser, uniqueTag, type TestUser } from '../../helpers/factories.js';
import { mailedToken, watchMail, type SentMail } from '../../helpers/mail.js';

// the demo data of db/tools/demo_data.mjs: a catalog of products with one, two or three variants each,
// the stock of every variant and a few buyers made through the routes of the shop, by a process of its own against the app listening on a port, the way it runs
// against dev. Its requests pass the checks real ones pass, and every answer is held against the
// swagger document like any other of the tests. Root puts versions of the terms and of the contract
// in force before the runs, and a new contract before the run that gives the orders: the buyers
// accept them the way the form of the shop asks. A version in force is for the whole shop and
// cannot be taken back, so this file runs last and alone (.shopwide.test.ts)
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
let root: TestUser;
// the buyers of the demo get addresses of a domain of this run
let emailDomain: string;

// a version of the terms or of the contract root puts in force, its id
async function putInForce(kind: 'terms' | 'contract'): Promise<number> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/root/legal-documents',
    headers: withCsrf(await getCsrf(app), accessCookie(root)),
    payload: { kind, title: `The ${kind} of the demo`, content: `The ${kind}, ${uniqueTag()}.` },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id;
}

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
// the other: a transaction has one connection, and prisma reads the relations of one query at once.
// The article number of a variant of the demo is <code of the product>-<its place>
async function demoState() {
  return asAdmin(async (tx) => {
    const categories = await tx.category.findMany({
      where: { slug: { in: Object.keys(DEMO_CATEGORIES) } },
      select: { id: true, slug: true, parentId: true },
    });

    const variantRows = await tx.productVariant.findMany({
      where: { sku: { startsWith: 'DEMO-' } },
      select: {
        id: true,
        productId: true,
        position: true,
        sku: true,
        price: true,
        stock: true,
        salePrice: true,
        saleEndsAt: true,
        deletedAt: true,
      },
      orderBy: { sku: 'asc' },
    });
    const productIds = [...new Set(variantRows.map((v) => v.productId))];
    const productRows = await tx.product.findMany({
      where: { id: { in: productIds } },
      select: { id: true, name: true, categoryId: true, reviewsCount: true },
      orderBy: { id: 'asc' },
    });
    const gallery = byOwner(
      await tx.productImage.findMany({
        where: { productId: { in: productIds } },
        select: { id: true, productId: true },
      }),
      (row) => row.productId,
    );
    const variantIds = variantRows.map((v) => v.id);
    const shown = byOwner(
      await tx.variantImage.findMany({
        where: { variantId: { in: variantIds } },
        select: { variantId: true, imageId: true, position: true },
        orderBy: { position: 'asc' },
      }),
      (row) => row.variantId,
    );
    const batches = byOwner(
      await tx.productBatch.findMany({
        where: { variantId: { in: variantIds } },
        select: { variantId: true, quantity: true, unitCost: true, expiresAt: true },
      }),
      (row) => row.variantId,
    );
    const reviewCounts = await tx.review.groupBy({
      by: ['productId'],
      where: { productId: { in: productIds } },
      _count: { _all: true },
    });
    const variants = variantRows.map((v) => ({
      ...v,
      images: shown.get(v.id) ?? [],
      batches: batches.get(v.id) ?? [],
    }));
    const variantsOf = byOwner(variants, (v) => v.productId);
    const products = productRows.map((p) => ({
      ...p,
      _count: {
        reviews: reviewCounts.find((r) => r.productId === p.id)?._count._all ?? 0,
      },
      gallery: gallery.get(p.id) ?? [],
      variants: variantsOf.get(p.id) ?? [],
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
        select: {
          id: true,
          userId: true,
          status: true,
          confirmed: true,
          delivery: { select: { method: true, country: true, recipientLastName: true } },
        },
      }),
      (row) => row.userId,
    );
    const orderItems = byOwner(
      await tx.orderItem.findMany({
        where: { order: { userId: { in: buyerIds } } },
        select: { orderId: true, productId: true, variantId: true, quantity: true },
        orderBy: { id: 'asc' },
      }),
      (row) => row.orderId,
    );
    const consents = byOwner(
      await tx.legalAcceptance.findMany({
        where: { userId: { in: buyerIds } },
        select: { userId: true, documentId: true, orderId: true },
        orderBy: { id: 'asc' },
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
        select: { userId: true, productId: true, variantId: true },
      }),
      (row) => row.userId,
    );
    const buyers = buyerRows.map((b) => ({
      ...b,
      orders: (orders.get(b.id) ?? []).map((order) => ({
        ...order,
        items: orderItems.get(order.id) ?? [],
      })),
      reviews: reviews.get(b.id) ?? [],
      favorites: favorites.get(b.id) ?? [],
      consents: (consents.get(b.id) ?? []).map(({ documentId, orderId }) => ({
        documentId,
        orderId,
      })),
    }));

    return { categories, products, variants, buyers };
  });
}

const countsOf = (state: Awaited<ReturnType<typeof demoState>>) => ({
  categories: state.categories.length,
  products: state.products.length,
  variants: state.variants.length,
  gallery: state.products.reduce((sum, p) => sum + p.gallery.length, 0),
  pictures: state.variants.reduce((sum, v) => sum + v.images.length, 0),
  batches: state.variants.reduce((sum, v) => sum + v.batches.length, 0),
  buyers: state.buyers.length,
  orders: state.buyers.reduce((sum, b) => sum + b.orders.length, 0),
  reviews: state.buyers.reduce((sum, b) => sum + b.reviews.length, 0),
  favorites: state.buyers.reduce((sum, b) => sum + b.favorites.length, 0),
  consents: state.buyers.reduce((sum, b) => sum + b.consents.length, 0),
});

beforeAll(async () => {
  app = await startApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  admin = await createUser({ role: 'ADMIN', password: ADMIN_PASSWORD });
  root = await createUser({ role: 'ROOT' });
  emailDomain = `demo-${uniqueTag()}.example.com`;

  // a product of the shop whose variant shows no picture, the way an import may leave one: the
  // catalog of a guest leaves it out, and the demo reads the catalog of its own categories only
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
  let terms: number;
  let contract: number;
  let newContract: number;

  // the first run makes the catalog and registers the buyers, a run before they confirm their
  // email changes nothing; the buyers confirm it by the link of the mail, the way a person does,
  // and the next run gives them their orders, after a new contract came in force
  beforeAll(async () => {
    terms = await putInForce('terms');
    contract = await putInForce('contract');

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

    newContract = await putInForce('contract');
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

  it('registers the buyers with the consent to the versions of the terms and the contract in force', () => {
    expect(first.output).toContain('terms in force: 2');
    for (const b of afterFirst.buyers) {
      expect(b.consents).toEqual([
        { documentId: terms, orderId: null },
        { documentId: contract, orderId: null },
      ]);
    }
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
      // the gallery of the product: a picture the variants share and one of each variant
      expect(p.gallery).toHaveLength(p.variants.length + 1);
    }
    // every category with no categories below has products
    for (const id of leafIds) expect(state.products.some((p) => p.categoryId === id)).toBe(true);
  });

  // some have a choice, some none: a book is one variant
  it('gives the products one, two or three variants each', () => {
    const counts = state.products.map((p) => p.variants.length);

    expect(counts.every((n) => n >= 1 && n <= 3)).toBe(true);
    for (const n of [1, 2, 3]) expect(counts).toContain(n);
    expect(state.variants).toHaveLength(counts.reduce((sum, n) => sum + n, 0));
  });

  it('gives every variant a price, an article number of its place and pictures of the gallery of its product', () => {
    for (const p of state.products) {
      expect(p.variants.map((v) => v.position)).toEqual(p.variants.map((_, n) => n + 1));
      const galleryIds = new Set(p.gallery.map((image) => image.id));
      const shownIds = new Set<number>();

      for (const v of p.variants) {
        expect(v.deletedAt).toBeNull();
        expect(Number(v.price)).toBeGreaterThan(0);
        expect(v.sku).toMatch(/^DEMO-\d{3}-[123]$/);
        expect(v.sku!.endsWith(`-${v.position}`)).toBe(true);
        // the pictures it shows are the ones of its product's gallery, one place each, the main
        // one (the first) its own
        expect(v.images.length).toBeGreaterThanOrEqual(1);
        expect(v.images.map((image) => image.position)).toEqual(v.images.map((_, n) => n + 1));
        for (const image of v.images) {
          expect(galleryIds.has(image.imageId)).toBe(true);
          shownIds.add(image.imageId);
        }
      }
      // no picture of the gallery is left unshown
      expect([...shownIds].sort()).toEqual([...galleryIds].sort());
    }
    // the variants of a product do not all have the same main picture
    const multi = state.products.filter((p) => p.variants.length > 1);
    for (const p of multi) {
      expect(new Set(p.variants.map((v) => v.images[0]!.imageId)).size).toBe(p.variants.length);
    }
  });

  it('shows the guests every product with all its variants in its card', async () => {
    for (const p of state.products) {
      const res = await app.inject({ method: 'GET', url: `/api/products/${p.id}` });
      const body = res.json();

      expect(res.statusCode).toBe(200);
      expect(body.variants.map((v: { id: number }) => v.id)).toEqual(p.variants.map((v) => v.id));
    }
  });

  it('brings the stock of every variant with a delivery in batches', () => {
    for (const v of state.variants) {
      const delivered = v.batches.reduce((sum, b) => sum + b.quantity, 0);
      expect(v.batches.length).toBeGreaterThanOrEqual(1);
      expect(v.stock).toBe(delivered);
      expect(v.stock).toBeGreaterThan(0);
    }
    // a batch with a last good day, for the expiry alerts and the selling order
    expect(state.variants.some((v) => v.batches.some((b) => b.expiresAt !== null))).toBe(true);
  });

  it('names a manufacturer of the directory on every product', async () => {
    for (const p of state.products.slice(0, 3)) {
      const res = await app.inject({ method: 'GET', url: `/api/products/${p.id}` });
      const body = res.json();
      expect(res.statusCode).toBe(200);
      expect(body.product.manufacturer).toEqual({
        id: expect.any(Number),
        name: expect.any(String),
        address: expect.any(String),
        email: expect.any(String),
        country: expect.stringMatching(/^[A-Z]{2}$/),
      });
    }
  });

  it('puts some of the variants on a sale that lasts, each below its price', () => {
    const onSale = state.variants.filter(
      (v) => v.salePrice !== null && v.saleEndsAt !== null && v.saleEndsAt > new Date(),
    );
    expect(onSale.length).toBeGreaterThanOrEqual(3);
    expect(onSale.length).toBeLessThan(state.variants.length);
    for (const v of onSale) expect(Number(v.salePrice)).toBeLessThan(Number(v.price));
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

  // an item of an order is a variant of a product, both named
  it('gives the orders items that name a variant and its product', () => {
    const productOf = new Map(state.variants.map((v) => [v.id, v.productId]));
    const skuOf = new Map(state.variants.map((v) => [v.id, v.sku]));
    const items = state.buyers.flatMap((b) => b.orders.flatMap((o) => o.items));

    expect(items.length).toBeGreaterThanOrEqual(5);
    for (const item of items) expect(productOf.get(item.variantId)).toBe(item.productId);

    const first = state.buyers[0]!.orders[0]!;
    expect(first.items.map((i) => [skuOf.get(i.variantId), i.quantity])).toEqual([
      ['DEMO-001-2', 1],
      ['DEMO-006-1', 2],
    ]);
  });

  it('gives the buyers carts and confirmed orders with their shipping', () => {
    const statuses = state.buyers.map((b) => b.orders.map((o) => o.status).sort());
    expect(statuses).toEqual([['waiting'], ['pending', 'waiting'], ['pending']]);

    for (const order of state.buyers.flatMap((b) => b.orders)) {
      expect(order.confirmed).toBe(order.status === 'waiting');
      // the first country of the manual method of the tests, the address whole
      if (order.confirmed) {
        expect(order.delivery).toEqual({
          method: 'manual',
          country: 'UA',
          recipientLastName: 'Demo',
        });
      }
    }
  });

  // the shop confirms no order without the consent to the versions in force
  it('accepts a version put in force after the registration before the orders, and the orders keep the versions they were confirmed with', () => {
    expect(second.output).toContain(`consents to new ones: ${DEMO_BUYERS} given`);
    for (const b of state.buyers) {
      expect(b.consents.filter((c) => c.orderId === null).map((c) => c.documentId)).toEqual([
        terms,
        contract,
        newContract,
      ]);
      for (const order of b.orders) {
        const versions = b.consents
          .filter((c) => c.orderId === order.id)
          .map((c) => c.documentId)
          .sort((x, y) => x - y);
        expect({ order: order.id, versions }).toEqual({
          order: order.id,
          versions: order.confirmed ? [terms, newContract] : [],
        });
      }
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
    const productOf = new Map(state.variants.map((v) => [v.id, v.productId]));
    for (const b of state.buyers) {
      expect(b.favorites.length).toBeGreaterThanOrEqual(2);
      // a favorite is a variant, kept with its product
      expect(
        b.favorites.every(
          (f) => productIds.has(f.productId) && productOf.get(f.variantId) === f.productId,
        ),
      ).toBe(true);
    }
    // a buyer who likes two variants of one product has a favorite for each
    const first = state.buyers[0]!.favorites;
    expect(first.filter((f) => f.productId === first[0]!.productId).length).toBeGreaterThanOrEqual(
      2,
    );
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
