import type { Prisma, PrismaClient } from '@prisma/client';

import { prisma } from '@db/client.js';
import { setShopDayContext } from '@db/dbContext.service.js';

type DbClient = Prisma.TransactionClient | PrismaClient;

// the units of each product in batches whose last good day is behind the day of the shop
// (cartlify.product_expired_units, db/05): they are not sold, so they are no free units. The day
// comes with the context of the transaction; a product without such units is left out of the map
export async function expiredUnitsOf(
  db: DbClient,
  productIds: readonly number[],
): Promise<Map<number, number>> {
  const ids = [...new Set(productIds)];
  if (!ids.length) return new Map();

  const rows = await db.$queryRaw<{ id: number; n: number }[]>`
    select p.id, cartlify.product_expired_units(p.id) as n
    from unnest(${ids}::int[]) as p(id)
  `;

  return new Map(rows.filter((row) => row.n > 0).map((row) => [row.id, row.n]));
}

// the units a buyer can take: the stock less what the waiting orders hold and what is over
export const freeUnits = (stock: number, reservedStock: number, expiredStock: number) =>
  Math.max(0, stock - reservedStock - expiredStock);

// the same in a transaction of its own, by the day of the shop: for an answer read after its
// transaction is over
export async function expiredUnitsNow(productIds: readonly number[]): Promise<Map<number, number>> {
  if (!productIds.length) return new Map();

  return prisma.$transaction(async (tx) => {
    await setShopDayContext(tx);
    return expiredUnitsOf(tx, productIds);
  });
}
