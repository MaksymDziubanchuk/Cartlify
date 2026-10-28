import type { DbSession, Outcome } from './db.js';

// orders made straight in the database for the tests of its rules (tests/integration/db), each one
// inside the rolled-back transaction of inRolledBackTx, the way the app makes them: the user opens
// a cart and adds items (the database takes the prices), writes the shipping data and confirms
// through cartlify.confirm_order; the payment goes through cartlify.pay_order as the webhook does

export type Items = [productId: number, quantity: number][];

// where and to whom an order goes, the way a buyer writes it (order_deliveries)
export type DeliveryData = {
  method: 'manual' | 'pickup';
  recipientFirstName: string;
  recipientLastName: string;
  recipientPhone: string;
  country: string | null;
  postalCode: string | null;
  city: string | null;
  street: string | null;
  house: string | null;
  apartment: string | null;
  note: string | null;
};

export const DELIVERY: DeliveryData = {
  method: 'manual',
  recipientFirstName: 'Anna',
  recipientLastName: 'Koval',
  recipientPhone: '+380501234567',
  country: 'UA',
  postalCode: '01001',
  city: 'Kyiv',
  street: 'Test street',
  house: '1',
  apartment: null,
  note: null,
};

// a pickup has no address
export const PICKUP: DeliveryData = {
  ...DELIVERY,
  method: 'pickup',
  country: null,
  postalCode: null,
  city: null,
  street: null,
  house: null,
};

// the price the shop asks for a manual delivery, the sum of the items from which it is free and the
// price the buyer saw: what the server gives confirm_order from its settings
export type DeliveryRule = {
  flat?: number | null;
  freeFrom?: number | null;
  expected?: number | null;
};

// a statement the database let through and that touched a row
export const changedRows = (outcome: Outcome) => outcome.ok && outcome.rows.length > 0;

// the buyer writes where the order goes: the row is made or replaced, as the confirmation of an
// order does
export async function writeDelivery(
  db: DbSession,
  userId: number,
  orderId: number,
  data: Partial<DeliveryData> = {},
) {
  const row = { ...DELIVERY, ...data };
  await db.as({ role: 'USER', userId });
  await db.rows(
    `insert into cartlify.order_deliveries
       ("orderId", method, "recipientFirstName", "recipientLastName", "recipientPhone", country,
        "postalCode", city, street, house, apartment, note)
     values ($1, $2::cartlify."DeliveryMethod", $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     on conflict ("orderId") do update set
       method = excluded.method, "recipientFirstName" = excluded."recipientFirstName",
       "recipientLastName" = excluded."recipientLastName",
       "recipientPhone" = excluded."recipientPhone", country = excluded.country,
       "postalCode" = excluded."postalCode", city = excluded.city, street = excluded.street,
       house = excluded.house, apartment = excluded.apartment, note = excluded.note
     returning "orderId"`,
    orderId,
    row.method,
    row.recipientFirstName,
    row.recipientLastName,
    row.recipientPhone,
    row.country,
    row.postalCode,
    row.city,
    row.street,
    row.house,
    row.apartment,
    row.note,
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

// a cart of the user with the items, with where it goes unless asked not to
export async function cartOf(
  db: DbSession,
  userId: number,
  items: Items,
  opts: { delivery?: false | Partial<DeliveryData> } = {},
): Promise<number> {
  await db.as({ role: 'USER', userId });
  const [order] = await db.rows<{ id: number }>(
    'insert into cartlify.orders ("userId", total) values ($1, 0) returning id',
    userId,
  );

  for (const item of items) await addItem(db, userId, order!.id, item);
  if (opts.delivery !== false) await writeDelivery(db, userId, order!.id, opts.delivery);

  return order!.id;
}

export async function confirm(
  db: DbSession,
  userId: number,
  orderId: number,
  reserveFor = '15 minutes',
  rule: DeliveryRule = {},
) {
  await db.as({ role: 'USER', userId });
  return db.attempt(
    `select 1 as done from cartlify.confirm_order(
       $1::int, $2::interval, $3::numeric, $4::numeric, $5::numeric
     )`,
    orderId,
    reserveFor,
    rule.flat ?? null,
    rule.freeFrom ?? null,
    rule.expected ?? null,
  );
}

// an order of the user that waits for its payment, its stock reserved
export async function waitingOrderOf(
  db: DbSession,
  userId: number,
  items: Items,
  rule: DeliveryRule = {},
  delivery: Partial<DeliveryData> = {},
) {
  const orderId = await cartOf(db, userId, items, { delivery });
  const confirmed = await confirm(db, userId, orderId, '15 minutes', rule);
  if (!confirmed.ok) throw new Error(`confirm_order refused: ${confirmed.message}`);
  return orderId;
}

// what the items of the order cost
export async function itemsTotalOf(db: DbSession, adminId: number, orderId: number) {
  await db.as({ role: 'ADMIN', userId: adminId });
  const [row] = await db.rows<{ total: string }>(
    `select coalesce(sum("totalPrice"), 0)::text as total
     from cartlify.order_items where "orderId" = $1`,
    orderId,
  );
  return row!.total;
}

// what a payment of the order brings: the items and the price of the delivery fixed at the
// confirmation
export async function payableOf(db: DbSession, adminId: number, orderId: number) {
  await db.as({ role: 'ADMIN', userId: adminId });
  const [row] = await db.rows<{ total: string }>(
    `select (
       coalesce((select sum("totalPrice") from cartlify.order_items where "orderId" = $1), 0)
       + coalesce((select price from cartlify.order_deliveries where "orderId" = $1), 0)
     )::text as total`,
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
  const amount = opts.amount ?? (await payableOf(db, adminId, orderId));
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

export async function paidOrderOf(
  db: DbSession,
  userId: number,
  adminId: number,
  items: Items,
  rule: DeliveryRule = {},
  delivery: Partial<DeliveryData> = {},
) {
  const orderId = await waitingOrderOf(db, userId, items, rule, delivery);
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
