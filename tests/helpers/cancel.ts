import { setUserContext } from '@db/dbContext.service.js';

import { testTx, type DbSession } from './db.js';

// The cancel of a paid order for the tests that need a cancelled order as their data: in the
// database a cancel is a statement of return of an admin with the reason shop_cancel for the whole
// order (create_return), which puts the units back on the shelf at once and cancels the order. The
// money is a step of the server and is not part of it, as the cancel never was. The statement is
// made in the name of the admin given: a statement has an author.

// the statement for every item of the order, with every unit of it
export const SHOP_CANCEL_SQL = `
  select cartlify.create_return(
    o.id,
    (
      select jsonb_agg(jsonb_build_object('orderItemId', i.id, 'quantity', i.quantity) order by i.id)
      from cartlify.order_items as i
      where i."orderId" = o.id
    ),
    'admin'::cartlify."ReturnSource",
    'other'::cartlify."ReturnBasis",
    'shop_cancel'::cartlify."ReturnReason",
    null, 'Test Buyer', 'buyer@example.com', null, null, 4, 'Europe/Madrid'
  ) as id
  from cartlify.orders as o
  where o.id = $1::int
`;

// in a session of a database test: the admin is set as the actor, a refusal comes back as the outcome
export async function shopCancelIn(db: DbSession, adminId: number, orderId: number) {
  await db.as({ role: 'ADMIN', userId: adminId });
  return db.attempt<{ id: number }>(SHOP_CANCEL_SQL, orderId);
}

// the same, and a refusal is an error
export async function cancelPaidOrderIn(db: DbSession, adminId: number, orderId: number) {
  const outcome = await shopCancelIn(db, adminId, orderId);
  if (!outcome.ok) throw new Error(`the cancel was refused: ${outcome.message}`);
  return outcome.rows[0]!.id;
}

// in a transaction of its own, for the tests of the routes: the cancel is committed
export async function cancelPaidOrder(adminId: number, orderId: number): Promise<number> {
  return testTx(async (tx) => {
    await setUserContext(tx, { userId: adminId, role: 'ADMIN' });
    const rows = await tx.$queryRawUnsafe<{ id: number }[]>(SHOP_CANCEL_SQL, orderId);
    return rows[0]!.id;
  });
}
