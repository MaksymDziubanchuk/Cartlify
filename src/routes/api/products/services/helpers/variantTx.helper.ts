import { Prisma } from '@prisma/client';

import { tx } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { assertAdminActor } from '@helpers/roleGuard.js';
import { InternalError, isAppError } from '@utils/errors.js';

import { knownVariantDbError } from './variantWrite.helper.js';

import type { VariantActorDto } from 'types/dto/variants.dto.js';

// the transaction of a route that changes the price or the sale of variants: in the context of an
// admin or root (RLS), a bounded wait for a row another request holds, a run again on a conflict or
// a deadlock of the database (tx() answers 409 RESOURCE_BUSY when it does not go through), and a
// failure the routes of the variants know turned into its answer (knownVariantDbError)
export async function inVariantTx<T>(
  actor: VariantActorDto,
  reason: string,
  fn: (db: Prisma.TransactionClient) => Promise<T>,
  opts: { timeout?: number } = {},
): Promise<T> {
  assertAdminActor(actor.actorId, actor.actorRole);

  try {
    return await tx(
      async (db) => {
        await setUserContext(db, { userId: actor.actorId, role: actor.actorRole });
        await db.$executeRawUnsafe(`SET LOCAL lock_timeout = '1500ms'`);

        return fn(db);
      },
      {
        maxRetries: 3,
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        maxWait: 1500,
        timeout: opts.timeout ?? 10_000,
      },
    );
  } catch (err) {
    if (isAppError(err)) throw err;

    const known = await knownVariantDbError(err);
    if (known) throw known;

    throw new InternalError({ reason }, err);
  }
}

// Locks the rows of the variants until the end of the transaction, by id: two requests over the same
// variants wait for each other in one order and meet no deadlock. Gives the ids that were there
export async function lockVariants(
  db: Prisma.TransactionClient,
  ids: readonly number[],
): Promise<number[]> {
  if (!ids.length) return [];

  const rows = await db.$queryRaw<{ id: number }[]>`
    select id from cartlify.product_variants
    where id = any(${[...ids]}::int[])
    order by id
    for update
  `;

  return rows.map((row) => row.id);
}
