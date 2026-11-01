import type { Prisma } from '@prisma/client';

import { prisma } from '@db/client.js';
import { setAdminContext } from '@db/dbContext.service.js';

import { asAdmin, testTx } from './db.js';
import { createAttribute, createVariantValue, uniqueTag, type TestAttribute } from './factories.js';

// helpers of the tests of the variants of a product and of its gallery

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// the sessions of the database that wait for a lock now
async function lockWaiters(): Promise<number> {
  const rows = await prisma.$queryRaw<{ n: number }[]>`
    select count(*)::int as n from pg_stat_activity
    where datname = current_database() and wait_event_type = 'Lock' and pid <> pg_backend_pid()
  `;

  return rows[0]!.n;
}

// Runs requests into locks a transaction of the test holds, so that a race the requests could lose
// by luck is lost the same way every time. `lock` takes the locks; `fire` starts the requests, which
// meet them and wait; once `waiters` sessions wait for a lock (or after 4 s, so that a request that
// never waits does not hang the test) `beforeRelease` writes what a request that came first would
// have written, and the transaction commits. The answer is what `fire` gave. A request that was
// fast or slow enough to miss the window finds the rows already as they are after the commit: the
// check holds for the code that is right and may let a wrong one pass, never the other way round
export async function whileLocked<T>(
  lock: (tx: Prisma.TransactionClient) => Promise<void>,
  fire: () => Promise<T>,
  opts: { waiters: number; beforeRelease?: (tx: Prisma.TransactionClient) => Promise<void> },
): Promise<T> {
  let outcome!: Promise<T>;

  await testTx(async (tx) => {
    await setAdminContext(tx);
    await lock(tx);

    outcome = fire();
    // the answer is awaited after the commit: a failure before that is not unhandled
    outcome.catch(() => undefined);

    const until = Date.now() + 4_000;
    while (Date.now() < until && (await lockWaiters()) < opts.waiters) await sleep(25);
    await sleep(100);

    await opts.beforeRelease?.(tx);
  });

  return outcome;
}

// the row of a product locked the way a write to it locks it
export const lockProductRow = async (tx: Prisma.TransactionClient, productId: number) => {
  await tx.$queryRaw`select id from cartlify.products where id = ${productId}::int for update`;
};

// the row of a variant locked the way a write to it locks it
export const lockVariantRow = async (tx: Prisma.TransactionClient, variantId: number) => {
  await tx.$queryRaw`select id from cartlify.product_variants where id = ${variantId}::int for update`;
};

// the row of a picture of the gallery locked the way a delete of it locks it
export const lockImageRow = async (tx: Prisma.TransactionClient, imageId: number) => {
  await tx.$queryRaw`select id from cartlify.product_images where id = ${imageId}::int for update`;
};

// one more picture in the gallery of a product, shown by no variant; returns its id
export async function addGalleryImage(productId: number): Promise<number> {
  const tag = uniqueTag();
  const last = await asAdmin((tx) =>
    tx.productImage.aggregate({ where: { productId }, _max: { position: true } }),
  );

  const image = await asAdmin((tx) =>
    tx.productImage.create({
      data: {
        productId,
        url: `https://res.cloudinary.com/demo/image/upload/v1/products/test/${tag}.jpg`,
        position: (last._max.position ?? -1) + 1,
      },
      select: { id: true },
    }),
  );

  return image.id;
}

export const galleryIdsOf = async (productId: number): Promise<number[]> =>
  (
    await asAdmin((tx) =>
      tx.productImage.findMany({
        where: { productId },
        orderBy: [{ position: 'asc' }, { id: 'asc' }],
        select: { id: true },
      }),
    )
  ).map((image) => image.id);

// the rows of the variants of a product, by their places
export const variantRowsOf = (productId: number) =>
  asAdmin((tx) =>
    tx.productVariant.findMany({
      where: { productId },
      orderBy: { position: 'asc' },
      select: {
        id: true,
        position: true,
        price: true,
        sku: true,
        barcode: true,
        weightGrams: true,
        lengthMm: true,
        widthMm: true,
        heightMm: true,
        stock: true,
        deletedAt: true,
        images: { select: { imageId: true, position: true }, orderBy: { position: 'asc' } },
      },
    }),
  );

// the pictures a variant shows, as [imageId, position] by position
export const imagesOfVariant = async (variantId: number): Promise<[number, number][]> =>
  (
    await asAdmin((tx) =>
      tx.variantImage.findMany({
        where: { variantId },
        orderBy: { position: 'asc' },
        select: { imageId: true, position: true },
      }),
    )
  ).map((row) => [row.imageId, row.position]);

// the lines of the admin log of an entity, in the order they were written
export const auditLinesOf = (
  entityType: 'product' | 'variant',
  entityId: number,
  events?: string[],
) =>
  asAdmin((tx) =>
    tx.adminAuditLog.findMany({
      where: { entityType, entityId, ...(events ? { event: { in: events } } : {}) },
      orderBy: { id: 'asc' },
      select: { actorId: true, action: true, event: true, meta: true },
    }),
  );

// takes a variant out of sale the way the delete route does, at a given time
export const markVariantDeleted = (variantId: number, at = new Date()) =>
  asAdmin((tx) => tx.productVariant.update({ where: { id: variantId }, data: { deletedAt: at } }));

// takes every picture away from a variant: a buyer does not see it
export const stripVariantImages = (variantId: number) =>
  asAdmin((tx) => tx.variantImage.deleteMany({ where: { variantId } }));

// a barcode (an EAN-13 with a good check digit) no other variant of the catalog has: the barcode of
// a live variant is the catalog's, so every test makes its own
export function uniqueBarcode(): string {
  const body = `2${String(Math.floor(Math.random() * 1e11)).padStart(11, '0')}`;
  const sum = [...body]
    .reverse()
    .reduce((total, digit, index) => total + Number(digit) * (index % 2 === 0 ? 3 : 1), 0);

  return `${body}${(10 - (sum % 10)) % 10}`;
}

// the price and the sale of a variant as its row keeps them (prices as numbers, the end as iso)
export async function priceRowOf(variantId: number) {
  const row = await asAdmin((tx) =>
    tx.productVariant.findUniqueOrThrow({
      where: { id: variantId },
      select: { price: true, salePrice: true, saleEndsAt: true, salePriorPrice: true },
    }),
  );

  return {
    price: Number(row.price),
    salePrice: row.salePrice === null ? null : Number(row.salePrice),
    saleEndsAt: row.saleEndsAt?.toISOString() ?? null,
    salePriorPrice: row.salePriorPrice === null ? null : Number(row.salePriorPrice),
  };
}

// the lines of the log of prices of a variant, the oldest first (prices as numbers, the end as iso)
export async function priceLinesOf(variantId: number) {
  const lines = await asAdmin((tx) =>
    tx.productPriceChangeLog.findMany({
      where: { variantId },
      orderBy: { id: 'asc' },
      select: {
        mode: true,
        oldPrice: true,
        newPrice: true,
        value: true,
        endsAt: true,
        actorId: true,
        event: true,
        productId: true,
      },
    }),
  );

  return lines.map((line) => ({
    mode: line.mode,
    oldPrice: Number(line.oldPrice),
    newPrice: Number(line.newPrice),
    value: Number(line.value),
    endsAt: line.endsAt?.toISOString() ?? null,
    actorId: line.actorId,
    event: line.event,
    productId: line.productId,
  }));
}

// the lines of the admin log of a variant that are about its price or its sale (the sale lines and
// the lines of a change of the variant), the oldest first
export const saleAuditOf = (variantId: number) =>
  asAdmin((tx) =>
    tx.adminAuditLog.findMany({
      where: { entityType: 'variant', entityId: variantId, action: 'PRODUCT_SALE' },
      orderBy: { id: 'asc' },
      select: { action: true, event: true, actorId: true, meta: true },
    }),
  );

// ---- characteristics that tell the variants of a product apart ----
// Two variants of a product with the same values of all the characteristics are refused (409
// VARIANT_DUPLICATE), and a variant with none repeats another with none: a test that makes a product
// with several variants through the routes gives each a value of a characteristic of its own

let telling: Promise<TestAttribute> | undefined;

// a text characteristic made once for the test file, to tell variants apart
export const tellingAttribute = (): Promise<TestAttribute> =>
  (telling ??= createAttribute({ type: 'text', name: `Telling ${uniqueTag()}` }));

// the value of the telling characteristic as a variant of a request names it (`attributes`): "Kind n"
export async function distinct(
  n: number | string,
): Promise<{ attributeId: number; value: string }[]> {
  return [{ attributeId: (await tellingAttribute()).id, value: `Kind ${n}` }];
}

// gives variants that exist (made by the factory) values of the telling characteristic, so that no
// two are alike: the first gets "Kind 1", the next "Kind 2", and so on
export async function tellApart(variantIds: readonly number[]): Promise<void> {
  const attribute = await tellingAttribute();

  for (const [index, variantId] of variantIds.entries()) {
    await createVariantValue(variantId, attribute.id, { text: `Kind ${index + 1}` });
  }
}
