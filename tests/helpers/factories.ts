import { randomUUID } from 'node:crypto';
import type { AuthProvider, Role } from '@prisma/client';

import { setUserContext } from '@db/dbContext.service.js';
import { createPlaceholder } from '@helpers/placeholder.js';
import { hashPass } from '@helpers/safePass.js';
import { hashToken } from '@helpers/tokenHash.js';

import { asAdmin, testTx } from './db.js';

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
    await testTx(async (tx) => {
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
  return testTx(async (tx) => {
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
  return testTx(async (tx) => {
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

  return testTx(async (tx) => {
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

// a favorite of the user, added the way the user adds one: of a variant (a product id means its
// first variant)
export const createFavorite = async (userId: number, product: number | VariantRef) => {
  const variant = await variantOf(product);

  await testTx(async (tx) => {
    await setUserContext(tx, { userId, role: 'USER' });
    await tx.favorite.create({
      data: { userId, productId: variant.productId, variantId: variant.id },
    });
  });
};

// a line of the login log the way a login writes it, at the given time
export function createLoginLog(user: { id: number; email: string }, createdAt: Date) {
  return testTx(async (tx) => {
    await setUserContext(tx, { userId: user.id, role: 'USER' });
    await tx.loginLog.create({
      data: {
        userId: user.id,
        email: user.email,
        role: 'USER',
        event: 'login.password',
        createdAt,
      },
    });
  });
}

// closes every session of the users, the part of a user a test can clean up
export const closeSessions = (userIds: number[]) =>
  asAdmin((tx) => tx.userToken.deleteMany({ where: { userId: { in: userIds } } }));

// a product made by createProduct: its first (and often only) variant is named too
export type TestProduct = { id: number; categoryId: number; variantId: number };

// names a variant: { variantId }, or a number, which is a product and means its first variant (by
// the place), so a test of a product with one variant needs no more than the id of the product
export type VariantRef = { variantId: number };

export async function variantOf(
  ref: number | VariantRef,
): Promise<{ id: number; productId: number }> {
  const row = await asAdmin((tx) =>
    typeof ref === 'number'
      ? tx.productVariant.findFirst({
          where: { productId: ref },
          orderBy: { position: 'asc' },
          select: { id: true, productId: true },
        })
      : tx.productVariant.findUnique({
          where: { id: ref.variantId },
          select: { id: true, productId: true },
        }),
  );
  if (!row) throw new Error(`no variant for ${JSON.stringify(ref)}`);

  return row;
}

export type TestParty = {
  id: number;
  name: string;
  address: string;
  email: string;
  country: string;
};

// a manufacturer or a person responsible in the EU of the directory, the country Spain unless the
// test says another
export async function createParty(
  opts: { name?: string; address?: string; email?: string; country?: string } = {},
): Promise<TestParty> {
  const tag = uniqueTag();

  return asAdmin((tx) =>
    tx.party.create({
      data: {
        name: opts.name ?? `Test party ${tag}`,
        address: opts.address ?? `${tag} Test Street 1, 28001 Madrid`,
        email: opts.email ?? `party-${tag}@shop.example.com`,
        country: opts.country ?? 'ES',
      },
      select: { id: true, name: true, address: true, email: true, country: true },
    }),
  );
}

export type TestDocument = {
  id: number;
  title: string;
  kind: 'instruction' | 'certificate' | 'declaration' | 'other';
  url: string;
  publicId: string;
  sizeBytes: number;
};

// a document of the directory as a row, with no file behind it: the id of its file is a pdf of the
// test folder that was never uploaded. With a productId the product names it at the place given
export async function createDocument(
  opts: {
    title?: string;
    kind?: TestDocument['kind'];
    productId?: number;
    position?: number;
  } = {},
): Promise<TestDocument> {
  const tag = uniqueTag();
  const publicId = `test/documents/${randomUUID()}`;

  return asAdmin(async (tx) => {
    const document = await tx.document.create({
      data: {
        title: opts.title ?? `Test document ${tag}`,
        kind: opts.kind ?? 'instruction',
        url: `https://res.cloudinary.com/demo/image/upload/v1/${publicId}.pdf`,
        publicId,
        sizeBytes: 2048,
      },
      select: { id: true, title: true, kind: true, url: true, publicId: true, sizeBytes: true },
    });

    if (opts.productId !== undefined) {
      await tx.productDocument.create({
        data: {
          productId: opts.productId,
          documentId: document.id,
          position: opts.position ?? 1,
        },
      });
    }

    return document;
  });
}

export type TestAttributeGroup = { id: number; name: string; position: number };

// the next free place in a scope: one more than the last, the way the API puts a new row at the end
const nextPlace = (last: { position: number } | null) => (last?.position ?? 0) + 1;

// test files run side by side on one database: two rows that take the same next place meet at the
// commit (the keys of the places are deferred), and the one that lost takes the next place again
async function atFreePlace<T>(make: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await make();
    } catch (err) {
      const taken = /UniqueConstraintViolation|P2002|23505/.test(String(err));
      if (!taken || attempt >= 5) throw err;

      await new Promise((resolve) => setTimeout(resolve, 15 * (attempt + 1)));
    }
  }
}

// a group of the directory of characteristics, at the end of the others
export async function createAttributeGroup(
  opts: { name?: string } = {},
): Promise<TestAttributeGroup> {
  const tag = uniqueTag();

  return atFreePlace(() =>
    asAdmin(async (tx) => {
      const last = await tx.attributeGroup.findFirst({
        orderBy: { position: 'desc' },
        select: { position: true },
      });

      return tx.attributeGroup.create({
        data: { name: opts.name ?? `Test group ${tag}`, position: nextPlace(last) },
        select: { id: true, name: true, position: true },
      });
    }),
  );
}

export type TestAttribute = {
  id: number;
  name: string;
  type: 'text' | 'number' | 'boolean' | 'option' | 'options';
  groupId: number;
  position: number;
};

// a characteristic at the end of its group; a number gets 0 digits after the point unless the test
// says more, a group of its own unless the test names one
export async function createAttribute(
  opts: {
    name?: string;
    type?: TestAttribute['type'];
    groupId?: number;
    unit?: string;
    isMain?: boolean;
    inFilters?: boolean;
    decimals?: number;
    minValue?: number;
    maxValue?: number;
  } = {},
): Promise<TestAttribute> {
  const tag = uniqueTag();
  const type = opts.type ?? 'text';
  const groupId = opts.groupId ?? (await createAttributeGroup()).id;

  return atFreePlace(() =>
    asAdmin(async (tx) => {
      const last = await tx.attribute.findFirst({
        where: { groupId },
        orderBy: { position: 'desc' },
        select: { position: true },
      });

      return tx.attribute.create({
        data: {
          name: opts.name ?? `Test attribute ${tag}`,
          type,
          groupId,
          position: nextPlace(last),
          ...(opts.unit !== undefined ? { unit: opts.unit } : {}),
          ...(opts.isMain !== undefined ? { isMain: opts.isMain } : {}),
          ...(opts.inFilters !== undefined ? { inFilters: opts.inFilters } : {}),
          ...(type === 'number' ? { decimals: opts.decimals ?? 0 } : {}),
          ...(type === 'number' && opts.minValue !== undefined ? { minValue: opts.minValue } : {}),
          ...(type === 'number' && opts.maxValue !== undefined ? { maxValue: opts.maxValue } : {}),
        },
        select: { id: true, name: true, type: true, groupId: true, position: true },
      });
    }),
  );
}

export type TestAttributeOption = { id: number; name: string; position: number };

// a value of a choice, at the end of the others of its characteristic
export async function createAttributeOption(
  attributeId: number,
  opts: { name?: string; colorCode?: string } = {},
): Promise<TestAttributeOption> {
  const tag = uniqueTag();

  return atFreePlace(() =>
    asAdmin(async (tx) => {
      const last = await tx.attributeOption.findFirst({
        where: { attributeId },
        orderBy: { position: 'desc' },
        select: { position: true },
      });

      return tx.attributeOption.create({
        data: {
          attributeId,
          name: opts.name ?? `Test value ${tag}`,
          position: nextPlace(last),
          ...(opts.colorCode !== undefined ? { colorCode: opts.colorCode } : {}),
        },
        select: { id: true, name: true, position: true },
      });
    }),
  );
}

// what a variant holds of a characteristic, as the row keeps it: one column of the four is set (a
// value of a list is its id)
export type TestValue = {
  text?: string;
  number?: number;
  bool?: boolean;
  optionId?: number;
};

// a value of a characteristic for a variant, written the way the API writes it
export const createVariantValue = (variantId: number, attributeId: number, value: TestValue) =>
  asAdmin((tx) =>
    tx.variantAttributeValue.create({
      data: {
        variantId,
        attributeId,
        ...(value.text !== undefined ? { textValue: value.text } : {}),
        ...(value.number !== undefined ? { numberValue: value.number } : {}),
        ...(value.bool !== undefined ? { boolValue: value.bool } : {}),
        ...(value.optionId !== undefined ? { optionId: value.optionId } : {}),
      },
      select: { id: true },
    }),
  );

// the one manufacturer the products of a test file name when a test names none: made on the first
// ask, a file has its own copy of the module and so its own party
let defaultParty: Promise<number> | undefined;

export function defaultPartyId(): Promise<number> {
  defaultParty ??= createParty().then((party) => party.id);
  return defaultParty;
}

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

// a batch of the variant (a product id means its first variant) taken in the way the delivery
// route takes one in; returns its id
export async function receiveBatch(ref: number | VariantRef, opts: BatchOpts): Promise<number> {
  const keeper = await stockKeeperOf();
  const variant = await variantOf(ref);

  return testTx(async (tx) => {
    await setUserContext(tx, { userId: keeper.id, role: 'ADMIN' });
    const [row] = await tx.$queryRaw<{ id: number }[]>`
      select cartlify.receive_variant_batch(
        ${opts.deliveryId ?? randomUUID()}::uuid,
        ${variant.id}::int,
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

// units of the variant (a product id means its first variant) written off the way the write-off
// route writes them off: from the batch named, or from the batches in the order a sale takes them
export async function writeOffStock(
  ref: number | VariantRef,
  quantity: number,
  opts: { batchId?: number; reason?: string } = {},
): Promise<void> {
  const keeper = await stockKeeperOf();
  const variant = await variantOf(ref);

  await testTx(async (tx) => {
    await setUserContext(tx, { userId: keeper.id, role: 'ADMIN' });
    await tx.$queryRaw`
      select cartlify.write_off_variant_stock(
        ${randomUUID()}::uuid, ${variant.id}::int, ${opts.batchId ?? null}::int, ${quantity}::int,
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

// the picture of the gallery every test product has
const TEST_IMAGE_URL = 'https://res.cloudinary.com/demo/image/upload/v1/products/test/0.jpg';

// what a variant of a test product is made of
export type VariantOpts = {
  stock?: number;
  price?: number;
  sku?: string;
  barcode?: string;
  // what it weighs and measures packed; a variant made without them is one from before they were asked
  weightGrams?: number;
  sizesMm?: { length: number; width: number; height: number };
  // the pictures of the gallery it shows (by the id of the picture); without any it shows the
  // first picture of the gallery, since a variant without a picture is hidden from buyers
  imageIds?: number[];
  // the place among the variants of the product; without one it is the last
  position?: number;
};

// a product in a category of its own, or in the category named, with one variant that has the stock
// in one batch of a supplier at a cost of 1; removeProducts deletes both, the batches and
// favorites go with them, unless the stock log holds lines of the product
export async function createProduct(
  opts: VariantOpts & {
    categoryId?: number;
    // the manufacturer the product names; without one it names the one party of the test file
    manufacturerId?: number;
    name?: string;
  } = {},
): Promise<TestProduct> {
  const tag = uniqueTag();
  const manufacturerId = opts.manufacturerId ?? (await defaultPartyId());

  const product = await asAdmin(async (tx) => {
    const category = opts.categoryId
      ? { id: opts.categoryId }
      : await tx.category.create({
          data: { name: `Test category ${tag}`, slug: `test-category-${tag}` },
        });

    const created = await tx.product.create({
      data: {
        name: opts.name ?? `Test product ${tag}`,
        categoryId: category.id,
        manufacturerId,
        images: { create: { url: TEST_IMAGE_URL, position: 0 } },
      },
      select: { id: true, categoryId: true, images: { select: { id: true } } },
    });

    // a variant is shown to buyers only with a picture of the gallery
    const variant = await tx.productVariant.create({
      data: variantData(
        created.id,
        created.images.map((image) => image.id),
        1,
        opts,
      ),
      select: { id: true },
    });

    return { id: created.id, categoryId: created.categoryId, variantId: variant.id };
  });

  const stock = opts.stock ?? 5;
  if (stock > 0) await receiveBatch({ variantId: product.variantId }, { quantity: stock });

  return product;
}

// the row of a new variant: a new variant has no stock, it comes with a batch
function variantData(productId: number, galleryIds: number[], position: number, opts: VariantOpts) {
  const imageIds = opts.imageIds ?? galleryIds.slice(0, 1);

  return {
    productId,
    position: opts.position ?? position,
    price: opts.price ?? 10,
    ...(opts.sku !== undefined ? { sku: opts.sku } : {}),
    ...(opts.barcode !== undefined ? { barcode: opts.barcode } : {}),
    ...(opts.weightGrams !== undefined ? { weightGrams: opts.weightGrams } : {}),
    ...(opts.sizesMm
      ? {
          lengthMm: opts.sizesMm.length,
          widthMm: opts.sizesMm.width,
          heightMm: opts.sizesMm.height,
        }
      : {}),
    images: {
      create: imageIds.map((imageId, index) => ({ imageId, position: index + 1 })),
    },
  };
}

// one more variant of a product, the last by its place unless one is given; the stock comes in
// one batch at a cost of 1. Returns its id and the product's
export async function createVariant(
  productId: number,
  opts: VariantOpts = {},
): Promise<{ id: number; productId: number }> {
  const variant = await asAdmin(async (tx) => {
    const gallery = await tx.productImage.findMany({
      where: { productId },
      orderBy: { position: 'asc' },
      select: { id: true },
    });
    const last = await tx.productVariant.aggregate({
      where: { productId },
      _max: { position: true },
    });

    return tx.productVariant.create({
      data: variantData(
        productId,
        gallery.map((image) => image.id),
        (last._max.position ?? 0) + 1,
        opts,
      ),
      select: { id: true, productId: true },
    });
  });

  const stock = opts.stock ?? 5;
  if (stock > 0) await receiveBatch({ variantId: variant.id }, { quantity: stock });

  return variant;
}

// what an admin does to a product of the catalog: a delete only marks it, orders keep their items
export const deleteProductFromCatalog = (productId: number) =>
  asAdmin((tx) => tx.product.update({ where: { id: productId }, data: { deletedAt: new Date() } }));

// the price of a variant (a product id means all its variants)
export const setProductPrice = (ref: number | VariantRef, price: number) =>
  asAdmin(async (tx) => {
    await tx.productVariant.updateMany({
      where: typeof ref === 'number' ? { productId: ref } : { id: ref.variantId },
      data: { price },
    });
  });

// a sale of the variant (a product id means all its variants) that ends endsInMs after now by the
// clock of the database (utc, the way prisma keeps dates), with no line in the log of prices: the
// sale route writes that one
export const putOnSale = (ref: number | VariantRef, salePrice: number, endsInMs = 86_400_000) =>
  asAdmin((tx) =>
    typeof ref === 'number'
      ? tx.$executeRaw`
          update cartlify.product_variants
          set "salePrice" = ${salePrice}::numeric,
              "saleEndsAt" = (now() at time zone 'utc') + make_interval(secs => ${endsInMs / 1000}::float8)
          where "productId" = ${ref}
        `
      : tx.$executeRaw`
          update cartlify.product_variants
          set "salePrice" = ${salePrice}::numeric,
              "saleEndsAt" = (now() at time zone 'utc') + make_interval(secs => ${endsInMs / 1000}::float8)
          where id = ${ref.variantId}
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
        from cartlify.product_variants where "productId" = any(${productIds}::int[]) and "saleEndsAt" is not null
      `,
    );
    if (row?.over && Date.now() > row.endsAtMs) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

// the stock and the reserve of a variant (a product id means its first variant)
export const stockOf = async (ref: number | VariantRef) => {
  const variant = await variantOf(ref);

  return asAdmin((tx) =>
    tx.productVariant.findUniqueOrThrow({
      where: { id: variant.id },
      select: { stock: true, reservedStock: true },
    }),
  );
};

// the lines of the stock log of a variant or of an order, the oldest first
export const stockLogOf = (where: { variantId?: number; orderId?: number }) =>
  asAdmin((tx) =>
    tx.stockLog.findMany({
      where,
      orderBy: { id: 'asc' },
      select: {
        actorId: true,
        actorRole: true,
        variantId: true,
        event: true,
        quantityChange: true,
        stockAfter: true,
        deliveryId: true,
        writeOffId: true,
        orderId: true,
        meta: true,
      },
    }),
  );

// deletes the products of a test and their categories. A product whose stock ever moved keeps its
// lines in the stock log, which is only added to and whose keys restrict the delete (the app never
// deletes a product for good, it sets deletedAt), so it stays with its category; the rest of the
// products go, and so does a category with no product left
export const removeProducts = (products: TestProduct[]) =>
  asAdmin(async (tx) => {
    await tx.$executeRaw`
      delete from cartlify.products as p
      where p.id = any(${products.map((p) => p.id)}::int[])
        and not exists (select 1 from cartlify.stock_log as l where l."productId" = p.id)
    `;
    await tx.$executeRaw`
      delete from cartlify.categories as c
      where c.id = any(${products.map((p) => p.categoryId)}::int[])
        and not exists (select 1 from cartlify.products as p where p."categoryId" = c.id)
        and not exists (select 1 from cartlify.categories as child where child."parentId" = c.id)
    `;
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
