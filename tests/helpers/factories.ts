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
// A user has one open chat at a time
export function createChatThread(
  userId: number,
  opts: { type?: 'bot' | 'admin'; status?: 'open' | 'closed' } = {},
): Promise<{ id: string }> {
  const type = opts.type ?? 'admin';
  const status = opts.status ?? 'open';

  return prisma.$transaction(async (tx) => {
    await setUserContext(tx, { userId, role: 'USER' });

    const id = randomUUID();
    await tx.chatThread.create({
      data: {
        id,
        userId,
        type,
        status,
        ...(type === 'admin' && status === 'open'
          ? { adminRequestedAt: new Date(), adminUnreadSince: new Date() }
          : {}),
        unreadCount: 1,
      },
    });
    await tx.chatMessage.create({
      data: { threadId: id, senderId: userId, senderType: 'user', content: 'Where is my order?' },
    });

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

// a product in a category of its own; removeProducts deletes both, favorites go with them
export async function createProduct(opts: { stock?: number; price?: number } = {}) {
  const tag = uniqueTag();

  return asAdmin(async (tx): Promise<TestProduct> => {
    const category = await tx.category.create({
      data: { name: `Test category ${tag}`, slug: `test-category-${tag}` },
    });

    // a product of the catalog always has a primary image, the order views show it
    return tx.product.create({
      data: {
        name: `Test product ${tag}`,
        price: opts.price ?? 10,
        stock: opts.stock ?? 5,
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
}

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
