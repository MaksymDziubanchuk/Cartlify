import { Prisma } from '@prisma/client';
import { isRetryableTxError, tx } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { assertAdminActor } from '@helpers/roleGuard.js';

import { InternalError, isAppError, ResourceBusyError } from '@utils/errors.js';

import {
  checkProductUpdate,
  normalizeFindProductByIdInput,
  planProductUpdate,
  productBeforeUpdateSelect,
  readAdminCard,
  writeProductUpdate,
} from './helpers/index.js';

import type { UpdateProductDto, UpdateProductResponseDto } from 'types/dto/products.dto.js';

// PATCH /api/products/:productId: the fields of the product itself (the name, the description, the
// category, the manufacturer and the person responsible in the EU, the warnings, the rule of
// withdrawal, the documents, the override of the popularity). The price, the sale, the article number, the weight and the
// sizes are changed on the variant (PATCH .../variants/:variantId), the pictures in the gallery
// (POST and DELETE .../images). The answer is the card of an admin
export async function updateProduct({
  productId,
  actorId,
  actorRole,
  name,
  description,
  manufacturerId,
  euResponsibleId,
  warnings,
  withdrawal,
  documentIds,
  stock,
  categoryId,
  popularityOverride,
  popularityOverrideUntil,
}: UpdateProductDto): Promise<UpdateProductResponseDto> {
  // validate actor context for rls and admin-only update
  assertAdminActor(actorId, actorRole);

  // normalize and validate id
  const { productId: productIdRaw } = normalizeFindProductByIdInput({ productId });

  // the fields sent, normalized and checked before the transaction
  const plan = planProductUpdate({
    name,
    description,
    manufacturerId,
    euResponsibleId,
    warnings,
    withdrawal,
    documentIds,
    stock,
    categoryId,
    popularityOverride,
    popularityOverrideUntil,
  });

  try {
    await tx(
      async (db) => {
        // set db session context for rls policies
        await setUserContext(db, { userId: actorId, role: actorRole });

        // bound lock wait to avoid hanging on concurrent updates
        await db.$executeRawUnsafe(`SET LOCAL lock_timeout = '1500ms'`);

        // lock product row to serialize concurrent patches
        await db.$queryRaw`SELECT id FROM cartlify.products WHERE id = ${productIdRaw} FOR UPDATE`;

        // load previous state for the checks and the audit
        const found = await db.product.findUnique({
          where: { id: productIdRaw },
          select: productBeforeUpdateSelect,
        });
        const before = await checkProductUpdate(db, plan, found);

        await writeProductUpdate({ db, actorId, actorRole }, plan, before);
      },
      {
        // keep default isolation and retry only transient lock/conflict errors
        maxRetries: 3,
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        maxWait: 1500,
      },
    );
  } catch (err) {
    // preserve known app errors and map everything else to a generic 500
    if (isAppError(err)) throw err;

    // map lock/tx contention errors to a stable 409 for clients
    if (isRetryableTxError(err)) {
      throw new ResourceBusyError();
    }
    throw new InternalError({ reason: 'PRODUCTS_UPDATE_UNEXPECTED' }, err);
  }

  return readAdminCard({ actorId, actorRole }, productIdRaw);
}
