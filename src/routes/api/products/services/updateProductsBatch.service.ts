import { Prisma } from '@prisma/client';

import { isRetryableTxError, tx } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { assertAdminActor } from '@helpers/roleGuard.js';
import { BadRequestError, InternalError, ResourceBusyError, isAppError } from '@utils/errors.js';

import {
  checkProductUpdate,
  planProductUpdate,
  productBeforeUpdateSelect,
  readAdminCards,
  refuseTogether,
  repeatedProductIds,
  writeProductUpdate,
} from './helpers/index.js';

import type {
  UpdateProductsBatchDto,
  UpdateProductsBatchItemDto,
  UpdateProductsBatchResponseDto,
} from 'types/dto/products.dto.js';

const idOf = (item: UpdateProductsBatchItemDto) => item.productId;

// PATCH /api/products/batch: many products, each with fields of its own, all of them or none. The
// fields are the ones a product has (name, description, category, the manufacturer and the person in
// the EU, the warnings, the rule of withdrawal, the documents, the override of the popularity); the
// price, the sale, the article number and the weight are the variants', PATCH
// /api/products/variants/batch. The change of
// each is the one of PATCH /api/products/:productId (productUpdate.helper): the fields of every
// product are checked first, then every product as it is under the lock of its row (by id, so two
// such requests wait for each other); only then anything is written. The answer has the cards of an
// admin in the order of the items
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
    await tx(
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

        // the writes go by id, the order the rows were locked in
        const byId = [...items.keys()].sort((a, b) => items[a]!.productId - items[b]!.productId);
        for (const index of byId) {
          await writeProductUpdate(
            { db, actorId, actorRole, batch: true },
            plans[index]!,
            befores[index]!,
          );
        }
      },
      {
        // keep default isolation and retry only transient lock/conflict errors
        maxRetries: 3,
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        maxWait: 1500,
        timeout: 30_000,
      },
    );

    return { products: await readAdminCards({ actorId, actorRole }, items.map(idOf)) };
  } catch (err) {
    if (isAppError(err)) throw err;

    // map lock/tx contention errors to a stable 409 for clients
    if (isRetryableTxError(err)) throw new ResourceBusyError();

    throw new InternalError({ reason: 'PRODUCTS_BATCH_UNEXPECTED' }, err);
  }
}
