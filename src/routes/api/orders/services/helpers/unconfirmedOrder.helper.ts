import { Prisma } from '@prisma/client';

type Db = Prisma.TransactionClient;

// the order an item route works on, as a condition on the orders row o: the cart (pending), or,
// with orderId, that order when it lost its reservation (unconfirmed)
export const orderTargetSql = (orderId?: number): Prisma.Sql =>
  orderId === undefined
    ? Prisma.sql`o.status = 'pending'`
    : Prisma.sql`o.id = ${orderId} AND o.status = 'unconfirmed'`;

// an order that is not confirmed, the cart or an order that lost its reservation, loses the items
// of variants a buyer does not see any more: a variant taken out of sale (the one of a product that
// is removed too) or one that shows no picture. They can never be confirmed. An order waiting for
// its payment keeps them, the payment page names the ones that are taken out of sale. Runs under
// the user context, rls lets the owner change only own orders that are not confirmed; totals
// follow by the items trigger
export async function dropHiddenVariantItems(
  db: Db,
  userId: number,
  orderIds?: number[],
): Promise<void> {
  await db.orderItem.deleteMany({
    where: {
      ...(orderIds ? { orderId: { in: orderIds } } : {}),
      order: { userId, confirmed: false, status: { in: ['pending', 'unconfirmed'] } },
      OR: [
        { variant: { OR: [{ deletedAt: { not: null } }, { images: { none: {} } }] } },
        { product: { deletedAt: { not: null } } },
      ],
    },
  });
}

// every unconfirmed order of the user as confirming it again would take it: without items of
// hidden variants and at current prices. Items that are out of stock stay, the order answer
// shows the free stock of each variant and the confirmation names them
export async function freshenUnconfirmedOrders(db: Db, userId: number): Promise<void> {
  const orders = await db.order.findMany({
    where: { userId, confirmed: false, status: 'unconfirmed' },
    select: { id: true },
  });
  if (!orders.length) return;

  const orderIds = orders.map((order) => order.id);
  await dropHiddenVariantItems(db, userId, orderIds);

  for (const orderId of orderIds) {
    await db.$executeRaw`select cartlify.refresh_order_prices(${orderId}::int)`;
  }
}
