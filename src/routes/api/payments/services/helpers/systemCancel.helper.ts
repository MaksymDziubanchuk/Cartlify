import { Prisma } from '@prisma/client';

import env from '@config/env.js';
import { shopSettings } from '@config/shopSettings.js';

// The cancel of an order the system makes (the rule "an order is cancelled only by a statement of
// return" holds): a paid order that was not sent, whose money went back to the buyer another way,
// is cancelled by a statement of the system (create_return, db/05: source system, basis other,
// whatever is left of the order, the goods back to the stock at once, the order cancelled once all
// of it is back). stripe_refund: all of the payment went back by hand in the dashboard of the
// provider; dispute_lost: the bank decided a dispute of the payment for the buyer. The money the
// statement owes is then tied to it and its transfer uses that money first

export type SystemCancelReason = 'stripe_refund' | 'dispute_lost';

// whether units of the order are in no statement yet (a row whose money was refused gives its units
// back), the units a new statement takes
async function unitsLeftOf(db: Prisma.TransactionClient, orderId: number): Promise<boolean> {
  const [row] = await db.$queryRaw<{ left: boolean }[]>(Prisma.sql`
    select exists (
      select 1 from cartlify.order_items as oi
      where oi."orderId" = ${orderId}::int
        and oi.quantity > coalesce((
          select sum(i.quantity)
          from cartlify.return_items as i
          where i."orderItemId" = oi.id and i.money <> 'refused'::cartlify."ReturnMoney"
        ), 0)
    ) as left
  `);
  return row?.left === true;
}

// the statement of the system for what is left of the order, in the transaction of the caller (the
// context of the system set); none when the order is no longer a paid order not sent. A refund made
// by hand of all of it waits while a statement of it is open (a person handles it); a dispute lost
// takes what is left beside the open statements (the buyer has the money of the bank: nothing is to
// go), none when nothing is left. The lock of the payment is taken first, as every change of its
// money, then the one of the order, so two events of one payment make one statement
export async function cancelBySystem(
  db: Prisma.TransactionClient,
  orderId: number,
  reason: SystemCancelReason,
): Promise<number | null> {
  await db.$executeRaw(Prisma.sql`
    select cartlify.lock_money_payment(o."paymentId")
    from cartlify.orders as o
    where o.id = ${orderId}::int and o."paymentId" is not null
  `);

  const [order] = await db.$queryRaw<{ status: string; userId: number }[]>(Prisma.sql`
    select o.status::text as status, o."userId" as "userId"
    from cartlify.orders as o
    where o.id = ${orderId}::int
    for update
  `);
  if (!order || order.status !== 'paid') return null;

  if (reason === 'stripe_refund') {
    const open = await db.orderReturn.count({ where: { orderId, closedAt: null } });
    if (open > 0) return null;
  } else if (!(await unitsLeftOf(db, orderId))) {
    return null;
  }

  // the answers go to the buyer of the order: their name, or their email when they gave none
  const buyer = await db.user.findUniqueOrThrow({
    where: { id: order.userId },
    select: { name: true, email: true },
  });

  const [made] = await db.$queryRaw<{ id: number }[]>(Prisma.sql`
    select cartlify.create_return(
      ${orderId}::int,
      null::jsonb,
      'system'::cartlify."ReturnSource",
      'other'::cartlify."ReturnBasis",
      ${reason}::cartlify."ReturnReason",
      null::text,
      ${(buyer.name?.trim() || buyer.email).slice(0, 200)}::text,
      ${buyer.email}::text,
      null::timestamp,
      null::int,
      ${shopSettings().withdrawalGraceDays}::int,
      ${env.SHOP_TIME_ZONE}::text
    ) as id
  `);

  return made?.id ?? null;
}
