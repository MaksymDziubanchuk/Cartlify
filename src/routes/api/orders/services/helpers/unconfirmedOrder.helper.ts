import { Prisma } from '@prisma/client';

type Db = Prisma.TransactionClient;

// the order an item route works on, as a condition on the orders row o: the cart (pending), or,
// with orderId, that order when it lost its reservation (unconfirmed)
export const orderTargetSql = (orderId?: number): Prisma.Sql =>
  orderId === undefined
    ? Prisma.sql`o.status = 'pending'`
    : Prisma.sql`o.id = ${orderId} AND o.status = 'unconfirmed'`;

// an unconfirmed order loses the items of products deleted from the catalog: they can never be
// confirmed again. Runs under the user context, rls lets the owner change only own unconfirmed
// orders; totals follow by the items trigger
export async function dropDeletedProductItems(
  db: Db,
  userId: number,
  orderIds?: number[],
): Promise<void> {
  await db.orderItem.deleteMany({
    where: {
      ...(orderIds ? { orderId: { in: orderIds } } : {}),
      order: { userId, confirmed: false, status: 'unconfirmed' },
      product: { deletedAt: { not: null } },
    },
  });
}

// every unconfirmed order of the user as confirming it again would take it: without items of
// deleted products and at current prices. Items that are out of stock stay, the order answer
// shows the free stock of each product and the confirmation names them
export async function freshenUnconfirmedOrders(db: Db, userId: number): Promise<void> {
  const orders = await db.order.findMany({
    where: { userId, confirmed: false, status: 'unconfirmed' },
    select: { id: true },
  });
  if (!orders.length) return;

  const orderIds = orders.map((order) => order.id);
  await dropDeletedProductItems(db, userId, orderIds);

  for (const orderId of orderIds) {
    await db.$executeRaw`select cartlify.refresh_order_prices(${orderId}::int)`;
  }
}
