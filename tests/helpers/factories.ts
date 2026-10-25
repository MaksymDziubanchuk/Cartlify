import { randomUUID } from 'node:crypto';
import type { AuthProvider, Role } from '@prisma/client';

import { prisma } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { createPlaceholder } from '@helpers/placeholder.js';
import { hashPass } from '@helpers/safePass.js';
import { hashToken } from '@helpers/tokenHash.js';

import { asAdmin } from './db.js';

let counter = 0;

// unique per run and per call, so tests never meet each other's rows
export const uniqueTag = () => `${Date.now()}-${process.pid}-${++counter}`;

export const uniqueEmail = (prefix: string) => `${prefix}-${uniqueTag()}@example.com`;

export type TestUser = { id: number; email: string; password: string; role: Role };

// a user the way the app keeps one; a local user gets a password, an oauth one gets a provider id.
// A user that has logged in cannot be deleted (the login log is append-only and only root
// deletes users), so these rows stay; their emails are unique to the run.
// Only root creates an admin and nobody creates a root through rls, so a user with such a role
// is made as a user and promoted the way the root route promotes one
export async function createUser(
  opts: {
    email?: string;
    password?: string;
    isVerified?: boolean;
    role?: Role;
    authProvider?: AuthProvider;
    providerSub?: string;
    name?: string;
    locale?: string;
    phone?: string;
    avatarUrl?: string;
    publicId?: string;
  } = {},
): Promise<TestUser> {
  const email = opts.email ?? uniqueEmail('user');
  const password = opts.password ?? 'password123';
  const authProvider = opts.authProvider ?? 'LOCAL';
  const role = opts.role ?? 'USER';
  const passwordHash = authProvider === 'LOCAL' ? await hashPass(password) : null;

  const { id } = await asAdmin((tx) =>
    tx.user.create({
      data: {
        email,
        passwordHash,
        isVerified: opts.isVerified ?? true,
        role: 'USER',
        authProvider,
        providerSub: opts.providerSub ?? null,
        name: opts.name ?? null,
        locale: opts.locale ?? null,
        phone: opts.phone ?? null,
        avatarUrl: opts.avatarUrl ?? null,
        publicId: opts.publicId ?? null,
      },
      select: { id: true },
    }),
  );

  if (role !== 'USER') {
    await prisma.$transaction(async (tx) => {
      await setUserContext(tx, { userId: id, role: 'ROOT' });
      await tx.user.update({ where: { id }, data: { role } });
    });
  }

  return { id, email, password, role };
}

export type TestReview = { id: number };

// a review the way a user writes one: under their own context, one per user and product.
// updatedAt is set by a test that needs reviews in a known order
export function createReview(
  userId: number,
  productId: number,
  opts: { rating?: number | null; comment?: string | null; updatedAt?: Date } = {},
): Promise<TestReview> {
  return prisma.$transaction(async (tx) => {
    await setUserContext(tx, { userId, role: 'USER' });

    return tx.review.create({
      data: {
        userId,
        productId,
        rating: opts.rating === undefined ? 5 : opts.rating,
        comment: opts.comment ?? null,
        ...(opts.updatedAt ? { updatedAt: opts.updatedAt } : {}),
      },
      select: { id: true },
    });
  });
}

// a vote of a user on a review; the database counts it into the review
export function createReviewVote(userId: number, reviewId: number, action: 'UP' | 'DOWN') {
  return prisma.$transaction(async (tx) => {
    await setUserContext(tx, { userId, role: 'USER' });
    await tx.reviewVote.create({ data: { userId, reviewId, action } });
  });
}

// a chat of the user with one message of theirs; an open admin chat waits for an admin.
// A user has one open chat at a time. A closed chat is made the way one gets closed: it is open
// while the user writes, then it closes (a closed chat takes no new message)
export function createChatThread(
  userId: number,
  opts: { type?: 'bot' | 'admin'; status?: 'open' | 'closed' } = {},
): Promise<{ id: string }> {
  const type = opts.type ?? 'admin';

  return prisma.$transaction(async (tx) => {
    await setUserContext(tx, { userId, role: 'USER' });

    const id = randomUUID();
    await tx.chatThread.create({
      data: {
        id,
        userId,
        type,
        status: 'open',
        ...(type === 'admin' ? { adminRequestedAt: new Date(), adminUnreadSince: new Date() } : {}),
        unreadCount: 1,
      },
    });
    await tx.chatMessage.create({
      data: { threadId: id, senderId: userId, senderType: 'user', content: 'Where is my order?' },
    });

    if (opts.status === 'closed') {
      await tx.chatThread.update({
        where: { id },
        data: { status: 'closed', unreadCount: 0, adminRequestedAt: null, adminUnreadSince: null },
      });
    }

    return { id };
  });
}

// a favorite of the user, added the way the user adds one
export const createFavorite = (userId: number, productId: number) =>
  prisma.$transaction(async (tx) => {
    await setUserContext(tx, { userId, role: 'USER' });
    await tx.favorite.create({ data: { userId, productId } });
  });

// a line of the login log the way a login writes it, at the given time
export function createLoginLog(user: { id: number; email: string }, createdAt: Date) {
  return prisma.$transaction(async (tx) => {
    await setUserContext(tx, { userId: user.id, role: 'USER' });
    await tx.loginLog.create({
      data: { userId: user.id, email: user.email, role: 'USER', createdAt },
    });
  });
}

// closes every session of the users, the part of a user a test can clean up
export const closeSessions = (userIds: number[]) =>
  asAdmin((tx) => tx.userToken.deleteMany({ where: { userId: { in: userIds } } }));

export type TestProduct = { id: number; categoryId: number };

// the admin who takes in and writes off the stock of the products the tests make: the database
// keeps every such step in the admin log in the name of a signed-in admin. One per test file,
// made the first time a product needs stock
let stockKeeper: Promise<TestUser> | undefined;
const stockKeeperOf = () => (stockKeeper ??= createUser({ role: 'ADMIN' }));

export type BatchOpts = {
  quantity: number;
  unitCost?: number | string;
  // the last good day, yyyy-mm-dd
  expiresAt?: string | null;
  source?: 'supplier' | 'surplus' | 'customer_return';
  supplierBatchNumber?: string | null;
  deliveryId?: string;
};

// a batch of the product taken in the way the delivery route takes one in; returns its id
export async function receiveBatch(productId: number, opts: BatchOpts): Promise<number> {
  const keeper = await stockKeeperOf();

  return prisma.$transaction(async (tx) => {
    await setUserContext(tx, { userId: keeper.id, role: 'ADMIN' });
    const [row] = await tx.$queryRaw<{ id: number }[]>`
      select cartlify.receive_product_batch(
        ${opts.deliveryId ?? randomUUID()}::uuid,
        ${productId}::int,
        ${opts.source ?? 'supplier'}::cartlify."StockSource",
        ${opts.quantity}::int,
        ${String(opts.unitCost ?? 1)}::numeric,
        ${opts.expiresAt ?? null}::date,
        ${opts.supplierBatchNumber ?? null}::text,
        null, null, null
      ) as id
    `;
    return row!.id;
  });
}

// units of the product written off the way the write-off route writes them off: from the batch
// named, or from the batches in the order a sale takes them
export async function writeOffStock(
  productId: number,
  quantity: number,
  opts: { batchId?: number; reason?: string } = {},
): Promise<void> {
  const keeper = await stockKeeperOf();

  await prisma.$transaction(async (tx) => {
    await setUserContext(tx, { userId: keeper.id, role: 'ADMIN' });
    await tx.$queryRaw`
      select cartlify.write_off_product_stock(
        ${randomUUID()}::uuid, ${productId}::int, ${opts.batchId ?? null}::int, ${quantity}::int,
        ${opts.reason ?? 'damaged'}::text, null
      )
    `;
  });
}

// a category of its own, under a parent when one is named
export const createCategory = (opts: { parentId?: number; name?: string } = {}) => {
  const tag = uniqueTag();

  return asAdmin((tx) =>
    tx.category.create({
      data: {
        name: opts.name ?? `Test category ${tag}`,
        slug: `test-category-${tag}`,
        ...(opts.parentId ? { parentId: opts.parentId } : {}),
      },
      select: { id: true, name: true },
    }),
  );
};

// a product in a category of its own, or in the category named, its stock in one batch of a
// supplier at a cost of 1; removeProducts deletes both, the batches and favorites go with them
export async function createProduct(
  opts: { stock?: number; price?: number; categoryId?: number; name?: string } = {},
) {
  const tag = uniqueTag();

  const product = await asAdmin(async (tx): Promise<TestProduct> => {
    const category = opts.categoryId
      ? { id: opts.categoryId }
      : await tx.category.create({
          data: { name: `Test category ${tag}`, slug: `test-category-${tag}` },
        });

    // a product of the catalog always has a primary image, the order views show it; a new product
    // has no stock, it comes with a batch
    return tx.product.create({
      data: {
        name: opts.name ?? `Test product ${tag}`,
        price: opts.price ?? 10,
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
  });

  const stock = opts.stock ?? 5;
  if (stock > 0) await receiveBatch(product.id, { quantity: stock });

  return product;
}

// what an admin does to a product of the catalog: a delete only marks it, orders keep their items
export const deleteProductFromCatalog = (productId: number) =>
  asAdmin((tx) => tx.product.update({ where: { id: productId }, data: { deletedAt: new Date() } }));

export const setProductPrice = (productId: number, price: number) =>
  asAdmin((tx) => tx.product.update({ where: { id: productId }, data: { price } }));

// a sale of the product that ends endsInMs after now by the clock of the database (utc, the way
// prisma keeps dates), with no line in the log of prices: the sale route writes that one
export const putOnSale = (productId: number, salePrice: number, endsInMs = 86_400_000) =>
  asAdmin(
    (tx) => tx.$executeRaw`
      update cartlify.products
      set "salePrice" = ${salePrice}::numeric,
          "saleEndsAt" = (now() at time zone 'utc') + make_interval(secs => ${endsInMs / 1000}::float8)
      where id = ${productId}
    `,
  );

// waits until the sales of the products are over by the clock of the database, which prices the
// orders, and by the clock of the app, which leaves an ended sale out of its answers
export async function waitForSalesEnd(productIds: number[]): Promise<void> {
  for (;;) {
    const [row] = await asAdmin(
      (tx) => tx.$queryRaw<{ over: boolean; endsAtMs: number }[]>`
        select bool_and((now() at time zone 'utc') > "saleEndsAt") as over,
               (max(extract(epoch from ("saleEndsAt" at time zone 'utc'))) * 1000)::float8 as "endsAtMs"
        from cartlify.products where id = any(${productIds}::int[])
      `,
    );
    if (row?.over && Date.now() > row.endsAtMs) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export const stockOf = (productId: number) =>
  asAdmin((tx) =>
    tx.product.findUniqueOrThrow({
      where: { id: productId },
      select: { stock: true, reservedStock: true },
    }),
  );

export const removeProducts = (products: TestProduct[]) =>
  asAdmin(async (tx) => {
    await tx.product.deleteMany({ where: { id: { in: products.map((p) => p.id) } } });
    await tx.category.deleteMany({ where: { id: { in: products.map((p) => p.categoryId) } } });
  });

// a password reset link the way /password/forgot stores one: the database keeps only its hash,
// the raw token is what the mail would carry
export async function createResetToken(
  userId: number,
  opts: { createdAt?: Date; expiresAt?: Date } = {},
): Promise<string> {
  const token = createPlaceholder();

  await asAdmin((tx) =>
    tx.userToken.create({
      data: {
        userId,
        type: 'RESET_PASSWORD',
        token: hashToken(token),
        ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
        expiresAt: opts.expiresAt ?? new Date(Date.now() + 3_600_000),
      },
    }),
  );

  return token;
}

// an email verification link the way the registration and the resend store one: only its hash
// is in the database. stored: 'as-is' keeps the code itself, the way it was kept before
export async function createVerifyToken(
  userId: number,
  opts: { createdAt?: Date; expiresAt?: Date; stored?: 'hash' | 'as-is' } = {},
): Promise<string> {
  const token = createPlaceholder();

  await asAdmin((tx) =>
    tx.userToken.create({
      data: {
        userId,
        type: 'VERIFY_EMAIL',
        token: opts.stored === 'as-is' ? token : hashToken(token),
        ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
        expiresAt: opts.expiresAt ?? new Date(Date.now() + 86_400_000),
      },
    }),
  );

  return token;
}
