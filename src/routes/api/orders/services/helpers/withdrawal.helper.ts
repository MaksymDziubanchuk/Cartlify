import { Prisma } from '@prisma/client';

import env from '@config/env.js';

// the period in which a buyer may withdraw from an order: it starts with the delivery and lasts the
// days of the contract the order kept, then the days of grace of the shop (WITHDRAWAL_GRACE_DAYS).
// The database counts the end (cartlify.withdrawal_ends_at, db/05), the one rule for every answer

// the days of an order that kept no contract (none was published at its confirmation): the least
// the law gives, which a contract may not go under (db/06)
export const WITHDRAWAL_DAYS_MINIMUM = 14;

type Delivered = { id: number; deliveredAt: Date | null; withdrawalDays: number | null };

// the end of the period of each delivered order of the rows, by its id; an order not delivered has
// none. One query for all the rows, under the context of the transaction. With the grace of the
// shop it is the end the server keeps (the button works until it); with a grace of 0 it is the end
// of the contract, the date a buyer is told
export async function withdrawalEndsOf(
  db: Prisma.TransactionClient,
  rows: readonly Delivered[],
  grace: number = env.WITHDRAWAL_GRACE_DAYS,
): Promise<Map<number, Date>> {
  const ids = rows.filter((row) => row.deliveredAt).map((row) => row.id);
  if (ids.length === 0) return new Map();

  const ends = await db.$queryRaw<{ id: number; endsAt: Date }[]>(Prisma.sql`
    select o.id,
           cartlify.withdrawal_ends_at(
             o."deliveredAt",
             coalesce(o."withdrawalDays", ${WITHDRAWAL_DAYS_MINIMUM}::int),
             ${grace}::int,
             ${env.SHOP_TIME_ZONE}::text
           ) as "endsAt"
    from cartlify.orders as o
    where o.id = any(${ids}::int[])
  `);

  return new Map(ends.map((row) => [row.id, row.endsAt]));
}

// the days a buyer has after the delivery, as the mails tell them: the days of the contract the
// order kept (the legal minimum when it kept none); the grace of the shop is not told, it only
// forgives a late statement
export const withdrawalPeriodDaysOf = (withdrawalDays: number | null): number =>
  withdrawalDays ?? WITHDRAWAL_DAYS_MINIMUM;

// whether a buyer may withdraw from the order now: a paid or shipped order always (the period has
// not started), a delivered one until the end of its period, the last millisecond included; no
// other order has anything to withdraw from
export function withdrawalOpenOf(status: string, endsAt: Date | undefined, nowMs: number): boolean {
  if (status === 'paid' || status === 'shipped') return true;

  return status === 'delivered' && endsAt !== undefined && nowMs <= endsAt.getTime();
}
