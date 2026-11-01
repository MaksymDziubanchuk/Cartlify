import type { Prisma, PrismaClient } from '@prisma/client';

type DbClient = Prisma.TransactionClient | PrismaClient;

// the units of each variant in batches whose last good day is behind the day of the shop
// (cartlify.variant_expired_units, db/05): they are not sold, so they are no free units. The day
// comes with the context of the transaction; a variant without such units is left out of the map
export async function expiredUnitsOf(
  db: DbClient,
  variantIds: readonly number[],
): Promise<Map<number, number>> {
  const ids = [...new Set(variantIds)];
  if (!ids.length) return new Map();

  const rows = await db.$queryRaw<{ id: number; n: number }[]>`
    select v.id, cartlify.variant_expired_units(v.id) as n
    from unnest(${ids}::int[]) as v(id)
  `;

  return new Map(rows.filter((row) => row.n > 0).map((row) => [row.id, row.n]));
}

// the units a buyer can take: the stock less what the waiting orders hold and what is over
export const freeUnits = (stock: number, reservedStock: number, expiredStock: number) =>
  Math.max(0, stock - reservedStock - expiredStock);
