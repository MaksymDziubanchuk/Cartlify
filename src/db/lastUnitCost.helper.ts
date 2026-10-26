import type { Prisma, PrismaClient } from '@prisma/client';

import { prisma } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';

import type { Role } from 'types/user.js';
import type { UserId } from 'types/ids.js';

type DbClient = Prisma.TransactionClient | PrismaClient;

// the cost of a unit in the latest delivery of a supplier of each product: what an admin sets a
// price or a sale against. A surplus an inventory found or goods a buyer brought back are no
// purchase. The batches are read by admin and root only (product_batches_select), so the
// transaction carries the context of one; a product no supplier delivered is left out of the map
export async function lastUnitCostsOf(
  db: DbClient,
  productIds: readonly number[],
): Promise<Map<number, Prisma.Decimal>> {
  const ids = [...new Set(productIds)];
  if (!ids.length) return new Map();

  const rows = await db.$queryRaw<{ productId: number; unitCost: Prisma.Decimal }[]>`
    select distinct on (b."productId") b."productId", b."unitCost"
    from cartlify.product_batches b
    where b."productId" = any(${ids}::int[]) and b.source = 'supplier'::cartlify."StockSource"
    order by b."productId", b."createdAt" desc, b.id desc
  `;

  return new Map(rows.map((row) => [row.productId, row.unitCost]));
}

// the same in a transaction of its own, under the context of the admin: for an answer read after
// its transaction is over
export async function lastUnitCostsNow(
  actor: { actorId: UserId; actorRole: Role },
  productIds: readonly number[],
): Promise<Map<number, Prisma.Decimal>> {
  if (!productIds.length) return new Map();

  return prisma.$transaction(async (tx) => {
    await setUserContext(tx, { userId: actor.actorId, role: actor.actorRole });
    return lastUnitCostsOf(tx, productIds);
  });
}
