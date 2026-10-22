import type { DbSession, Outcome } from './db.js';

// orders made straight in the database for the tests of its rules (tests/integration/db), each one
// inside the rolled-back transaction of inRolledBackTx, the way the app makes them: the user opens
// a cart and adds items (the database takes the prices), writes the shipping data and confirms
// through cartlify.confirm_order; the payment goes through cartlify.pay_order as the webhook does

export type Items = [productId: number, quantity: number][];

export const SHIPPING = {
  shippingAddress: 'Test street 1, Kyiv',
  recipientFirstName: 'Anna',
  recipientLastName: 'Koval',
  recipientPhone: '+380501234567',
};

// a statement the database let through and that touched a row
export const changedRows = (outcome: Outcome) => outcome.ok && outcome.rows.length > 0;

export async function writeShipping(db: DbSession, userId: number, orderId: number) {
  await db.as({ role: 'USER', userId });
  await db.rows(
    `update cartlify.orders
     set "shippingAddress" = $2, "recipientFirstName" = $3, "recipientLastName" = $4,
         "recipientPhone" = $5
     where id = $1 returning id`,
    orderId,
    SHIPPING.shippingAddress,
    SHIPPING.recipientFirstName,
    SHIPPING.recipientLastName,
    SHIPPING.recipientPhone,
  );
}

export async function addItem(db: DbSession, userId: number, orderId: number, item: Items[number]) {
  await db.as({ role: 'USER', userId });
  const [row] = await db.rows<{ id: number }>(
    `insert into cartlify.order_items ("orderId", "productId", quantity, "unitPrice", "totalPrice")
     values ($1, $2, $3, 0, 0) returning id`,
    orderId,
    item[0],
    item[1],
  );
  return row!.id;
}

// a cart of the user with the items, with the shipping data unless asked not to
export async function cartOf(
  db: DbSession,
  userId: number,
  items: Items,
  opts: { shipping?: boolean } = {},
): Promise<number> {
  await db.as({ role: 'USER', userId });
  const [order] = await db.rows<{ id: number }>(
    'insert into cartlify.orders ("userId", total) values ($1, 0) returning id',
    userId,
  );

  for (const item of items) await addItem(db, userId, order!.id, item);
  if (opts.shipping !== false) await writeShipping(db, userId, order!.id);

  return order!.id;
}

export async function confirm(
  db: DbSession,
  userId: number,
  orderId: number,
  reserveFor = '15 minutes',
) {
  await db.as({ role: 'USER', userId });
  return db.attempt(
    'select 1 as done from cartlify.confirm_order($1::int, $2::interval)',
    orderId,
    reserveFor,
  );
}

// an order of the user that waits for its payment, its stock reserved
export async function waitingOrderOf(db: DbSession, userId: number, items: Items) {
  const orderId = await cartOf(db, userId, items);
  const confirmed = await confirm(db, userId, orderId);
  if (!confirmed.ok) throw new Error(`confirm_order refused: ${confirmed.message}`);
  return orderId;
}

// what the items of the order cost, the amount a payment of it brings
export async function itemsTotalOf(db: DbSession, adminId: number, orderId: number) {
  await db.as({ role: 'ADMIN', userId: adminId });
  const [row] = await db.rows<{ total: string }>(
    `select coalesce(sum("totalPrice"), 0)::text as total
     from cartlify.order_items where "orderId" = $1`,
    orderId,
  );
  return row!.total;
}

// the payment the webhook records, by default the right amount of a stripe payment; the webhook
// acts as the system, the admin context without a user id
export async function pay(
  db: DbSession,
  adminId: number,
  orderId: number,
  opts: { provider?: string; paymentId?: string; amount?: string } = {},
) {
  const amount = opts.amount ?? (await itemsTotalOf(db, adminId, orderId));
  await db.as({ role: 'ADMIN' });
  const outcome = await db.attempt<{ result: string }>(
    `select cartlify.pay_order($1::int, $2::cartlify."PaymentProvider", $3, $4::numeric) as result`,
    orderId,
    opts.provider ?? 'stripe',
    opts.paymentId ?? `pi_db_${orderId}`,
    amount,
  );
  return outcome.ok ? outcome.rows[0]!.result : `ERROR ${outcome.message}`;
}

export async function paidOrderOf(db: DbSession, userId: number, adminId: number, items: Items) {
  const orderId = await waitingOrderOf(db, userId, items);
  const result = await pay(db, adminId, orderId);
  if (result !== 'PAID') throw new Error(`pay_order answered ${result}`);
  return orderId;
}

export type OrderState = {
  status: string;
  confirmed: boolean;
  reserved: boolean;
  total: number;
  paymentProvider: string | null;
  paymentId: string | null;
};

// the order as an admin reads it
export async function orderStateOf(db: DbSession, adminId: number, orderId: number) {
  await db.as({ role: 'ADMIN', userId: adminId });
  const [row] = await db.rows<OrderState>(
    `select status::text as status, confirmed, "reservationExpiresAt" is not null as reserved,
            total::float8 as total, "paymentProvider"::text as "paymentProvider", "paymentId"
     from cartlify.orders where id = $1`,
    orderId,
  );
  return row;
}

export type OrderDates = { paidAt: string | null; cancelledAt: string | null; now: string };

// when the order was paid and cancelled, as an admin reads it, next to the time of the
// transaction: utc without a zone and to the millisecond, the way the columns hold it
export async function orderDatesOf(db: DbSession, adminId: number, orderId: number) {
  await db.as({ role: 'ADMIN', userId: adminId });
  const [row] = await db.rows<OrderDates>(
    `select "paidAt"::text as "paidAt", "cancelledAt"::text as "cancelledAt",
            (now() at time zone 'UTC')::timestamp(3)::text as now
     from cartlify.orders where id = $1`,
    orderId,
  );
  return row!;
}

export async function stockOf(db: DbSession, adminId: number, productId: number) {
  await db.as({ role: 'ADMIN', userId: adminId });
  const [row] = await db.rows<{ stock: number; reserved: number }>(
    'select stock, "reservedStock" as reserved from cartlify.products where id = $1',
    productId,
  );
  return row;
}
