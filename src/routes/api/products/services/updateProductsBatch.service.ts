import { Prisma } from '@prisma/client';

import { getPgMessage, isRetryableTxError, prisma, tx } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { expiredUnitsNow } from '@db/expiredStock.helper.js';
import { lastUnitCostsNow } from '@db/lastUnitCost.helper.js';
import { assertAdminActor } from '@helpers/roleGuard.js';
import {
  BadRequestError,
  ConflictError,
  InternalError,
  ResourceBusyError,
  isAppError,
} from '@utils/errors.js';

import {
  checkProductUpdate,
  clashingSkus,
  isSkuTaken,
  mapProductRowToResponse,
  planProductUpdate,
  productBeforeUpdateSelect,
  readCategoryPath,
  refusalOfProduct,
  refuseTogether,
  repeatedProductIds,
  writeProductUpdate,
  type ProductBeforeUpdate,
  type ProductUpdatePlan,
} from './helpers/index.js';

import type {
  ProductCategoryDto,
  UpdateProductsBatchDto,
  UpdateProductsBatchItemDto,
  UpdateProductsBatchResponseDto,
} from 'types/dto/products.dto.js';
import type { UserId } from 'types/ids.js';
import type { Role } from 'types/user.js';

type Written = Awaited<ReturnType<typeof writeProductUpdate>>;

const idOf = (item: UpdateProductsBatchItemDto) => item.productId;

// PATCH /api/products/batch: many products, each with fields of its own, all of them or none.
// The change of each is the one of PATCH /api/products/:productId without images
// (productUpdate.helper): the fields of every product are checked first, then every product as
// it is under the lock of its row (by id, so two such requests wait for each other), then the
// article numbers of all of them; only then anything is written
export async function updateProductsBatch({
  actorId,
  actorRole,
  items,
}: UpdateProductsBatchDto): Promise<UpdateProductsBatchResponseDto> {
  assertAdminActor(actorId, actorRole);

  const repeated = repeatedProductIds(items.map(idOf));
  if (repeated.length) throw new BadRequestError('PRODUCTS_REPEATED', { productIds: repeated });

  // the plan reads the fields of a change, the id of the product is no field of it
  const plans = await refuseTogether(items, idOf, (item) =>
    planProductUpdate(item, { hasImages: false }),
  );

  try {
    const written = await tx(
      async (db) => {
        await setUserContext(db, { userId: actorId, role: actorRole });

        // bound lock wait to avoid hanging on concurrent updates
        await db.$executeRawUnsafe(`SET LOCAL lock_timeout = '1500ms'`);

        const ids = items.map(idOf).sort((a, b) => a - b);
        await db.$queryRaw`
          select id from cartlify.products where id = any(${ids}::int[]) order by id for update
        `;
        const rows = await db.product.findMany({
          where: { id: { in: ids } },
          select: productBeforeUpdateSelect,
        });
        const found = new Map(rows.map((row) => [row.id, row]));

        const befores = await refuseTogether(items, idOf, (item, index) =>
          checkProductUpdate(db, plans[index]!, found.get(item.productId) ?? null),
        );

        await freeArticleNumbers(db, items, plans, befores);

        // the writes go by id, the order the rows were locked in
        const after = new Map<number, Written>();
        const byId = [...items.keys()].sort((a, b) => items[a]!.productId - items[b]!.productId);
        for (const index of byId) {
          const { productId } = items[index]!;
          try {
            const row = await writeProductUpdate(
              { db, actorId, actorRole },
              plans[index]!,
              befores[index]!,
            );
            after.set(productId, row);
          } catch (err) {
            throw refusalOfWrite(productId, err);
          }
        }

        return items.map((item) => after.get(item.productId)!);
      },
      {
        // keep default isolation and retry only transient lock/conflict errors
        maxRetries: 3,
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        maxWait: 1500,
        timeout: 30_000,
      },
    );

    return { products: await cardsOf(written, { actorId, actorRole }) };
  } catch (err) {
    if (isAppError(err)) throw err;

    // map lock/tx contention errors to a stable 409 for clients
    if (isRetryableTxError(err)) throw new ResourceBusyError();

    throw new InternalError({ reason: 'PRODUCTS_BATCH_UNEXPECTED' }, err);
  }
}

// the article numbers after the change: a product of the catalog has one no other product of the
// catalog has, whatever the case of its letters (products_sku_catalog_uidx, db/06). The index
// checks each row at once, an index on lower(sku) cannot wait for the end of the transaction,
// so the products that change theirs give them up first and two products can swap theirs
async function freeArticleNumbers(
  db: Prisma.TransactionClient,
  items: readonly UpdateProductsBatchItemDto[],
  plans: readonly ProductUpdatePlan[],
  befores: readonly ProductBeforeUpdate[],
): Promise<void> {
  // a product removed from the catalog holds no number
  const changing = items
    .map((item, index) => ({
      productId: item.productId,
      sku: plans[index]!.skuNorm,
      before: befores[index]!,
    }))
    .filter(({ sku, before }) => sku !== undefined && before.deletedAt === null);
  if (!changing.length) return;

  // lowered the way the index lowers them
  const skus = changing.flatMap(({ sku }) => (sku ? [sku] : []));
  const lowered = new Map(
    skus.length
      ? (
          await db.$queryRaw<{ sku: string; lowered: string }[]>`
            select s as sku, lower(s) as lowered from unnest(${skus}::text[]) as s
          `
        ).map((row) => [row.sku, row.lowered])
      : [],
  );

  // the numbers the other products of the catalog hold; a product of the request that keeps its
  // number holds it too
  const held = lowered.size
    ? await db.$queryRaw<{ lowered: string }[]>`
        select lower(sku) as lowered from cartlify.products
        where "deletedAt" is null and sku is not null
          and not (id = any(${changing.map(({ productId }) => productId)}::int[]))
          and lower(sku) = any(${[...new Set(lowered.values())]}::text[])
      `
    : [];

  const clashes = clashingSkus(
    changing.map(({ productId, sku }) => ({ productId, lowered: sku ? lowered.get(sku)! : null })),
    new Set(held.map((row) => row.lowered)),
  );
  if (clashes.length) {
    throw new ConflictError('PRODUCT_SKU_TAKEN', {
      products: clashes.map((productId) => ({ productId })),
    });
  }

  // the writes put the new numbers on
  const giving = changing
    .filter(({ sku, before }) => (before.sku ?? null) !== (sku ?? null))
    .map(({ productId }) => productId);
  if (giving.length) {
    await db.$executeRaw`
      update cartlify.products set sku = null where id = any(${giving}::int[]) and sku is not null
    `;
  }
}

// a write the database refused names its product: the article number another request took a
// moment ago, an end of a new sale already behind by the clock of the database. Any other error
// goes on as it is, the transaction repeats on a busy row
function refusalOfWrite(productId: number, err: unknown): unknown {
  if (isAppError(err)) return refusalOfProduct(productId, err);
  if (isSkuTaken(err)) return refusalOfProduct(productId, new ConflictError('PRODUCT_SKU_TAKEN'));
  if (String(getPgMessage(err) ?? '').includes('PRODUCT_SALE_ENDS_AT_INVALID')) {
    return refusalOfProduct(productId, new BadRequestError('PRODUCT_SALE_ENDS_AT_INVALID'));
  }
  return err;
}

// the cards of an admin for the products written, read after the commit: the images (a product
// without one has none), the units that are over, the cost of the latest delivery and the way to
// the category
async function cardsOf(rows: Written[], actor: { actorId: UserId; actorRole: Role }) {
  const ids = rows.map((row) => row.id);
  const images = await prisma.productImage.findMany({
    where: { productId: { in: ids } },
    select: { productId: true, url: true, position: true },
    orderBy: [{ productId: 'asc' }, { position: 'asc' }],
  });
  const expired = await expiredUnitsNow(ids);
  const costs = await lastUnitCostsNow(actor, ids);

  const paths = new Map<number, ProductCategoryDto[]>();
  for (const { category } of rows) {
    if (!paths.has(category.id)) paths.set(category.id, await readCategoryPath(category.id));
  }

  return rows.map((row) =>
    mapProductRowToResponse({
      product: {
        ...row,
        expiredStock: expired.get(row.id) ?? 0,
        lastUnitCost: costs.get(row.id) ?? null,
      },
      images: images.filter((image) => image.productId === row.id),
      categoryPath: paths.get(row.category.id)!,
      view: 'admin',
    }),
  );
}
