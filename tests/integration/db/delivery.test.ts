import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { prisma } from '@db/client.js';

import { inRolledBackTx, type DbSession, type Outcome } from '../../helpers/db.js';
import {
  DELIVERY,
  PICKUP,
  cartOf,
  confirm,
  orderStateOf,
  pay,
  paidOrderOf,
  waitingOrderOf,
  writeDelivery,
  type DeliveryData,
} from '../../helpers/dbOrders.js';
import {
  closeSessions,
  createProduct,
  createUser,
  type TestProduct,
  type TestUser,
} from '../../helpers/factories.js';

// where an order goes and what its delivery costs, in the database: the buyer writes the person and
// the address before the confirmation, confirm_order fixes the price by the rule the server gives
// it, the payment brings the items and that price, an admin corrects the data of a paid order until
// it is sent and takes the shipping steps (one on, one back), and a send is a row of its own

let owner: TestUser;
let other: TestUser;
let admin: TestUser;
let product: TestProduct;

beforeAll(async () => {
  owner = await createUser();
  other = await createUser();
  admin = await createUser({ role: 'ADMIN' });
  product = await createProduct({ price: 10, stock: 50 });
});

afterAll(async () => {
  try {
    await closeSessions([owner.id, other.id, admin.id]);
  } finally {
    await prisma.$disconnect();
  }
});

type Delivery = {
  method: string;
  price: number;
  recipientFirstName: string;
  country: string | null;
  postalCode: string | null;
  city: string | null;
  street: string | null;
  house: string | null;
  apartment: string | null;
  note: string | null;
};

const deliveryOf = async (db: DbSession, orderId: number) => {
  await db.as({ role: 'ADMIN', userId: admin.id });
  const [row] = await db.rows<Delivery>(
    `select method::text as method, price::float8 as price, "recipientFirstName", country,
            "postalCode", city, street, house, apartment, note
     from cartlify.order_deliveries where "orderId" = $1`,
    orderId,
  );
  return row;
};

const refused = (outcome: Outcome, text: string) =>
  expect(outcome).toMatchObject({ ok: false, message: expect.stringContaining(text) });

const insertDelivery = (
  db: DbSession,
  orderId: number,
  set: Partial<DeliveryData> & { price?: number },
) => {
  const row = { ...DELIVERY, price: 0, ...set };
  return db.attempt(
    `insert into cartlify.order_deliveries
       ("orderId", method, "recipientFirstName", "recipientLastName", "recipientPhone", country,
        "postalCode", city, street, house, apartment, note, price)
     values ($1, $2::cartlify."DeliveryMethod", $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
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
    row.price,
  );
};

const updateDelivery = (db: DbSession, orderId: number, set: string, ...values: unknown[]) =>
  db.attempt(
    `update cartlify.order_deliveries set ${set} where "orderId" = $1 returning "orderId"`,
    orderId,
    ...values,
  );

// an admin moves the status with a plain update, the way the app takes the shipping steps
const moveTo = async (db: DbSession, orderId: number, status: string) => {
  await db.as({ role: 'ADMIN', userId: admin.id });
  return db.attempt(
    `update cartlify.orders set status = $2::cartlify."OrderStatus" where id = $1 returning id`,
    orderId,
    status,
  );
};

describe('order_deliveries: who writes where an order goes', () => {
  it('lets a buyer write the person and the address of an own cart, and nobody else read it', async () => {
    const { row, seenByOther } = await inRolledBackTx(async (db) => {
      const orderId = await cartOf(db, owner.id, [[product.id, 1]], { delivery: false });
      await writeDelivery(db, owner.id, orderId, { apartment: '12', note: 'ring twice' });
      const row = await deliveryOf(db, orderId);

      await db.as({ role: 'USER', userId: other.id });
      const seenByOther = await db.rows(
        'select 1 from cartlify.order_deliveries where "orderId" = $1',
        orderId,
      );

      return { row, seenByOther };
    });

    expect(row).toMatchObject({
      method: 'manual',
      price: 0,
      recipientFirstName: 'Anna',
      country: 'UA',
      postalCode: '01001',
      city: 'Kyiv',
      street: 'Test street',
      house: '1',
      apartment: '12',
      note: 'ring twice',
    });
    expect(seenByOther).toEqual([]);
  });

  it('refuses a buyer to write where the order of another user goes', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      const orderId = await cartOf(db, owner.id, [[product.id, 1]], { delivery: false });
      await db.as({ role: 'USER', userId: other.id });
      return insertDelivery(db, orderId, {});
    });

    refused(outcome, 'row-level security');
  });

  it('refuses a buyer to set the price of the delivery, on a new row and on a written one', async () => {
    const { inserted, updated, row } = await inRolledBackTx(async (db) => {
      const orderId = await cartOf(db, owner.id, [[product.id, 1]], { delivery: false });
      await db.as({ role: 'USER', userId: owner.id });
      const inserted = await insertDelivery(db, orderId, { price: 4.99 });
      await writeDelivery(db, owner.id, orderId);
      await db.as({ role: 'USER', userId: owner.id });
      const updated = await updateDelivery(db, orderId, 'price = 4.99');
      return { inserted, updated, row: await deliveryOf(db, orderId) };
    });

    refused(inserted, 'row-level security');
    refused(updated, 'ORDER_DELIVERY_UPDATE_FORBIDDEN');
    expect(row!.price).toBe(0);
  });

  it('keeps one row for an order', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      const orderId = await cartOf(db, owner.id, [[product.id, 1]]);
      await db.as({ role: 'USER', userId: owner.id });
      return insertDelivery(db, orderId, {});
    });

    refused(outcome, 'order_deliveries_pkey');
  });

  it('lets a buyer change the method and the address while the order is a cart, not once it is confirmed', async () => {
    const { before, after, confirmedChange } = await inRolledBackTx(async (db) => {
      const orderId = await cartOf(db, owner.id, [[product.id, 1]]);
      await writeDelivery(db, owner.id, orderId, PICKUP);
      const before = await deliveryOf(db, orderId);

      await confirm(db, owner.id, orderId);
      await db.as({ role: 'USER', userId: owner.id });
      const confirmedChange = await updateDelivery(db, orderId, `city = 'Lviv'`);
      return { before, after: await deliveryOf(db, orderId), confirmedChange };
    });

    expect(before).toMatchObject({ method: 'pickup', country: null, city: null });
    expect(after).toMatchObject({ method: 'pickup', city: null });
    expect(confirmedChange).toMatchObject({ ok: true, rows: [] });
  });
});

describe('order_deliveries: the form of the data', () => {
  const cases: Array<[string, Partial<DeliveryData>, string]> = [
    ['a manual delivery without a city', { city: null }, 'order_deliveries_address_chk'],
    ['a manual delivery without a street', { street: null }, 'order_deliveries_address_chk'],
    ['a manual delivery without a house', { house: null }, 'order_deliveries_address_chk'],
    ['a manual delivery without a country', { country: null }, 'order_deliveries_address_chk'],
    ['a country in small letters', { country: 'ua' }, 'order_deliveries_address_chk'],
    ['a country of three letters', { country: 'UKR' }, 'value too long'],
    ['a city with spaces around it', { city: ' Kyiv' }, 'order_deliveries_address_chk'],
    ['an empty postal code', { postalCode: '' }, 'order_deliveries_address_chk'],
    ['an empty apartment', { apartment: '' }, 'order_deliveries_address_chk'],
    ['a pickup with an address', { ...PICKUP, city: 'Kyiv' }, 'order_deliveries_address_chk'],
    [
      'a name with a digit',
      { recipientFirstName: 'Anna2' },
      'order_deliveries_recipient_first_name_chk',
    ],
    [
      'a surname with spaces around it',
      { recipientLastName: 'Koval ' },
      'order_deliveries_recipient_last_name_chk',
    ],
    [
      'a phone without the plus',
      { recipientPhone: '380501234567' },
      'order_deliveries_recipient_phone_chk',
    ],
    [
      'a phone that begins with a zero',
      { recipientPhone: '+0501234567' },
      'order_deliveries_recipient_phone_chk',
    ],
    ['an empty note', { note: '' }, 'order_deliveries_note_chk'],
  ];

  it.each(cases)('refuses %s', async (_name, data, constraint) => {
    const outcome = await inRolledBackTx(async (db) => {
      const orderId = await cartOf(db, owner.id, [[product.id, 1]], { delivery: false });
      await db.as({ role: 'USER', userId: owner.id });
      return insertDelivery(db, orderId, data);
    });

    refused(outcome, constraint);
  });

  it('takes a manual delivery without a postal code and without an apartment', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      const orderId = await cartOf(db, owner.id, [[product.id, 1]], { delivery: false });
      await db.as({ role: 'USER', userId: owner.id });
      return insertDelivery(db, orderId, { postalCode: null, apartment: null });
    });

    expect(outcome.ok).toBe(true);
  });
});

describe('cartlify.confirm_order: the price of the delivery', () => {
  const confirmedWith = async (
    rule: Parameters<typeof confirm>[4],
    delivery: Partial<DeliveryData> = {},
    quantity = 2,
  ) =>
    inRolledBackTx(async (db) => {
      const orderId = await cartOf(db, owner.id, [[product.id, quantity]], { delivery });
      const outcome = await confirm(db, owner.id, orderId, '15 minutes', rule);
      return {
        outcome,
        delivery: await deliveryOf(db, orderId),
        order: await orderStateOf(db, admin.id, orderId),
      };
    });

  it('refuses an order without where it goes, and reserves nothing', async () => {
    const { outcome, reserved } = await inRolledBackTx(async (db) => {
      const orderId = await cartOf(db, owner.id, [[product.id, 2]], { delivery: false });
      const outcome = await confirm(db, owner.id, orderId);
      await db.as({ role: 'ADMIN', userId: admin.id });
      const [row] = await db.rows<{ reserved: number }>(
        'select "reservedStock" as reserved from cartlify.products where id = $1',
        product.id,
      );
      return { outcome, reserved: row!.reserved };
    });

    refused(outcome, 'ORDER_DELIVERY_REQUIRED');
    expect(reserved).toBe(0);
  });

  it('adds the flat price of a manual delivery to the total', async () => {
    const { outcome, delivery, order } = await confirmedWith({ flat: 4.99 });

    expect(outcome.ok).toBe(true);
    expect(delivery).toMatchObject({ method: 'manual', price: 4.99 });
    expect(order).toMatchObject({ status: 'waiting', total: 24.99 });
  });

  it('makes a delivery free from the sum of the items on, the sum itself included', async () => {
    const atTheSum = await confirmedWith({ flat: 4.99, freeFrom: 20 });
    const aboveTheSum = await confirmedWith({ flat: 4.99, freeFrom: 20.01 });

    expect(atTheSum.delivery!.price).toBe(0);
    expect(atTheSum.order!.total).toBe(20);
    expect(aboveTheSum.delivery!.price).toBe(4.99);
    expect(aboveTheSum.order!.total).toBe(24.99);
  });

  it('asks nothing for a pickup, whatever the flat price is', async () => {
    const { delivery, order } = await confirmedWith({ flat: 4.99 }, PICKUP);

    expect(delivery).toMatchObject({ method: 'pickup', price: 0 });
    expect(order!.total).toBe(20);
  });

  it('asks nothing when the shop names no price', async () => {
    const { delivery, order } = await confirmedWith({});

    expect(delivery!.price).toBe(0);
    expect(order!.total).toBe(20);
  });

  it('takes a free-from sum without a flat price as no price', async () => {
    const { delivery } = await confirmedWith({ freeFrom: 5 });

    expect(delivery!.price).toBe(0);
  });

  it('confirms when the price the buyer saw is the one the rule gives', async () => {
    const { outcome, order } = await confirmedWith({ flat: 4.99, expected: 4.99 });

    expect(outcome.ok).toBe(true);
    expect(order!.total).toBe(24.99);
  });

  it('refuses when the price the buyer saw is not the one the rule gives, and reserves nothing', async () => {
    const { outcome, order, delivery } = await confirmedWith({ flat: 5.99, expected: 4.99 });

    refused(outcome, 'ORDER_DELIVERY_PRICE_CHANGED');
    expect(order).toMatchObject({ status: 'pending', confirmed: false });
    expect(delivery!.price).toBe(0);
  });

  it('refuses a free delivery the buyer saw when the order is not free any more', async () => {
    const { outcome } = await confirmedWith({ flat: 4.99, freeFrom: 30, expected: 0 }, {}, 2);

    refused(outcome, 'ORDER_DELIVERY_PRICE_CHANGED');
  });
});

describe('cartlify.pay_order: the delivery is paid with the items', () => {
  it('takes the items and the price of the delivery, and the total holds both', async () => {
    const { result, order } = await inRolledBackTx(async (db) => {
      const orderId = await waitingOrderOf(db, owner.id, [[product.id, 2]], { flat: 4.99 });
      const result = await pay(db, admin.id, orderId);
      return { result, order: await orderStateOf(db, admin.id, orderId) };
    });

    expect(result).toBe('PAID');
    expect(order).toMatchObject({ status: 'paid', total: 24.99 });
  });

  it('refuses the amount of the items alone while the delivery costs something', async () => {
    const { result, order } = await inRolledBackTx(async (db) => {
      const orderId = await waitingOrderOf(db, owner.id, [[product.id, 2]], { flat: 4.99 });
      const result = await pay(db, admin.id, orderId, { amount: '20.00' });
      return { result, order: await orderStateOf(db, admin.id, orderId) };
    });

    expect(result).toBe('AMOUNT_MISMATCH');
    expect(order!.status).toBe('waiting');
  });

  it('refuses the amount with the delivery when the delivery is free', async () => {
    const { result } = await inRolledBackTx(async (db) => {
      const orderId = await waitingOrderOf(db, owner.id, [[product.id, 2]], {
        flat: 4.99,
        freeFrom: 20,
      });
      return { result: await pay(db, admin.id, orderId, { amount: '24.99' }) };
    });

    expect(result).toBe('AMOUNT_MISMATCH');
  });
});

describe('an order that goes back to unconfirmed', () => {
  const cancelPayment = async (db: DbSession, orderId: number) => {
    await db.as({ role: 'USER', userId: owner.id });
    return db.attempt('select 1 as done from cartlify.cancel_order_payment($1::int)', orderId);
  };

  it('costs its items again, keeps where it goes, and is priced again at the next confirmation', async () => {
    const { total, delivery, again, afterAgain } = await inRolledBackTx(async (db) => {
      const orderId = await waitingOrderOf(db, owner.id, [[product.id, 2]], { flat: 4.99 });
      expect(await cancelPayment(db, orderId)).toMatchObject({ ok: true });
      const total = (await orderStateOf(db, admin.id, orderId))!.total;
      const delivery = await deliveryOf(db, orderId);

      const again = await confirm(db, owner.id, orderId, '15 minutes', { flat: 7 });
      return { total, delivery, again, afterAgain: await orderStateOf(db, admin.id, orderId) };
    });

    expect(total).toBe(20);
    expect(delivery).toMatchObject({ method: 'manual', city: 'Kyiv' });
    expect(again.ok).toBe(true);
    expect(afterAgain).toMatchObject({ status: 'waiting', total: 27 });
  });

  it('lets a buyer change the kept price delivery to a pickup, which costs nothing, and no price besides', async () => {
    const { toPickup, afterPickup, setPrice } = await inRolledBackTx(async (db) => {
      const orderId = await waitingOrderOf(db, owner.id, [[product.id, 2]], { flat: 4.99 });
      expect(await cancelPayment(db, orderId)).toMatchObject({ ok: true });
      expect((await deliveryOf(db, orderId))!.price).toBe(4.99);

      await db.as({ role: 'USER', userId: owner.id });
      // the price a buyer writes by itself is refused, the kept one stays
      const setPrice = await updateDelivery(db, orderId, 'price = 0');

      await db.as({ role: 'USER', userId: owner.id });
      const toPickup = await updateDelivery(
        db,
        orderId,
        'method = \'pickup\', country = null, "postalCode" = null, city = null, street = null, house = null, apartment = null',
      );
      return { toPickup, afterPickup: await deliveryOf(db, orderId), setPrice };
    });

    refused(setPrice, 'ORDER_DELIVERY_UPDATE_FORBIDDEN');
    expect(toPickup.ok).toBe(true);
    expect(afterPickup).toMatchObject({ method: 'pickup', price: 0 });
  });

  it('is paid by a late payment of the price it was confirmed with, and holds it in the total', async () => {
    const { result, order } = await inRolledBackTx(async (db) => {
      const orderId = await waitingOrderOf(db, owner.id, [[product.id, 2]], { flat: 4.99 });
      await db.as({ role: 'ADMIN' });
      await db.rows('select 1 as done from cartlify.unconfirm_order($1::int)', orderId);
      const result = await pay(db, admin.id, orderId, { amount: '24.99' });
      return { result, order: await orderStateOf(db, admin.id, orderId) };
    });

    expect(result).toBe('PAID');
    expect(order).toMatchObject({ status: 'paid', total: 24.99 });
  });

  it('is not payable when it was never confirmed: it has not where to go', async () => {
    const result = await inRolledBackTx(async (db) => {
      const orderId = await cartOf(db, owner.id, [[product.id, 1]], { delivery: false });
      return pay(db, admin.id, orderId);
    });

    expect(result).toBe('ORDER_NOT_PAYABLE');
  });
});

describe('the shipping steps of an admin', () => {
  const paid = (db: DbSession) => paidOrderOf(db, owner.id, admin.id, [[product.id, 1]]);

  it('goes one step on from paid to shipped and from shipped to delivered', async () => {
    const { shipped, delivered, state } = await inRolledBackTx(async (db) => {
      const orderId = await paid(db);
      const shipped = await moveTo(db, orderId, 'shipped');
      const delivered = await moveTo(db, orderId, 'delivered');
      return { shipped, delivered, state: await orderStateOf(db, admin.id, orderId) };
    });

    expect(shipped).toMatchObject({ ok: true, rows: [expect.anything()] });
    expect(delivered).toMatchObject({ ok: true, rows: [expect.anything()] });
    expect(state!.status).toBe('delivered');
  });

  it('does not step over shipped: paid to delivered is refused', async () => {
    const outcome = await inRolledBackTx(async (db) => moveTo(db, await paid(db), 'delivered'));

    refused(outcome, 'ORDER_UPDATE_FORBIDDEN');
  });

  it('goes one step back, from shipped to paid and from delivered to shipped', async () => {
    const { toPaid, toShipped, state } = await inRolledBackTx(async (db) => {
      const orderId = await paid(db);
      await moveTo(db, orderId, 'shipped');
      const toPaid = await moveTo(db, orderId, 'paid');
      await moveTo(db, orderId, 'shipped');
      await moveTo(db, orderId, 'delivered');
      const toShipped = await moveTo(db, orderId, 'shipped');
      return { toPaid, toShipped, state: await orderStateOf(db, admin.id, orderId) };
    });

    expect(toPaid).toMatchObject({ ok: true, rows: [expect.anything()] });
    expect(toShipped).toMatchObject({ ok: true, rows: [expect.anything()] });
    expect(state!.status).toBe('shipped');
  });

  it('does not step two back: delivered to paid is refused', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      const orderId = await paid(db);
      await moveTo(db, orderId, 'shipped');
      await moveTo(db, orderId, 'delivered');
      return moveTo(db, orderId, 'paid');
    });

    refused(outcome, 'ORDER_UPDATE_FORBIDDEN');
  });

  it('refuses a buyer to move the status of an own order', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      const orderId = await paid(db);
      await db.as({ role: 'USER', userId: owner.id });
      return db.attempt(
        `update cartlify.orders set status = 'shipped' where id = $1 returning id`,
        orderId,
      );
    });

    expect(outcome).toMatchObject({ ok: true, rows: [] });
  });
});

describe('an admin corrects where a paid order goes', () => {
  const correct = (db: DbSession, orderId: number) =>
    updateDelivery(
      db,
      orderId,
      `city = 'Lviv', street = 'New street', "recipientFirstName" = 'Olha', note = 'gate code 5'`,
    );

  it('changes the person and the address of a paid order', async () => {
    const { outcome, row } = await inRolledBackTx(async (db) => {
      const orderId = await paidOrderOf(db, owner.id, admin.id, [[product.id, 1]], { flat: 4.99 });
      await db.as({ role: 'ADMIN', userId: admin.id });
      return { outcome: await correct(db, orderId), row: await deliveryOf(db, orderId) };
    });

    expect(outcome).toMatchObject({ ok: true, rows: [expect.anything()] });
    expect(row).toMatchObject({
      city: 'Lviv',
      street: 'New street',
      recipientFirstName: 'Olha',
      note: 'gate code 5',
      price: 4.99,
    });
  });

  it('keeps the method and the price: those change only with a cancel', async () => {
    const { method, price } = await inRolledBackTx(async (db) => {
      const orderId = await paidOrderOf(db, owner.id, admin.id, [[product.id, 1]], { flat: 4.99 });
      await db.as({ role: 'ADMIN', userId: admin.id });
      return {
        method: await updateDelivery(db, orderId, `method = 'pickup'`),
        price: await updateDelivery(db, orderId, 'price = 0'),
      };
    });

    refused(method, 'ORDER_DELIVERY_UPDATE_FORBIDDEN');
    refused(price, 'ORDER_DELIVERY_UPDATE_FORBIDDEN');
  });

  it('leaves a sent order as it is', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      const orderId = await paidOrderOf(db, owner.id, admin.id, [[product.id, 1]]);
      await moveTo(db, orderId, 'shipped');
      await db.as({ role: 'ADMIN', userId: admin.id });
      return correct(db, orderId);
    });

    expect(outcome).toMatchObject({ ok: true, rows: [] });
  });

  it('leaves the order of a buyer who has paid to the buyer: the buyer changes nothing of it', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      const orderId = await paidOrderOf(db, owner.id, admin.id, [[product.id, 1]]);
      await db.as({ role: 'USER', userId: owner.id });
      return correct(db, orderId);
    });

    expect(outcome).toMatchObject({ ok: true, rows: [] });
  });
});

describe('order_shipments: the sends of an order', () => {
  const shippedOrder = async (db: DbSession) => {
    const orderId = await paidOrderOf(db, owner.id, admin.id, [[product.id, 1]]);
    await moveTo(db, orderId, 'shipped');
    return orderId;
  };

  const send = (
    db: DbSession,
    orderId: number,
    set: {
      carrier?: string | null;
      trackingNumber?: string | null;
      trackingUrl?: string | null;
      cost?: number | null;
    } = {},
  ) =>
    db.attempt<{ id: number }>(
      `insert into cartlify.order_shipments ("orderId", carrier, "trackingNumber", "trackingUrl", cost)
       values ($1, $2, $3, $4, $5) returning id`,
      orderId,
      set.carrier ?? null,
      set.trackingNumber ?? null,
      set.trackingUrl ?? null,
      set.cost ?? null,
    );

  // the id of a send that has to work
  const sendId = async (db: DbSession, orderId: number, set: Parameters<typeof send>[2] = {}) => {
    const outcome = await send(db, orderId, set);
    if (!outcome.ok) throw new Error(`the send was refused: ${outcome.message}`);
    return outcome.rows[0]!.id;
  };

  const shipmentOf = async (db: DbSession, id: number) => {
    await db.as({ role: 'ADMIN', userId: admin.id });
    const [row] = await db.rows<{
      carrier: string | null;
      trackingNumber: string | null;
      cost: number | null;
      expense: boolean;
      rolledBack: boolean;
    }>(
      `select carrier, "trackingNumber", cost::float8 as cost, expense, "rolledBackAt" is not null as "rolledBack"
       from cartlify.order_shipments where id = $1`,
      id,
    );
    return row;
  };

  it('lets an admin record a send of a shipped order, with or without the carrier and the cost', async () => {
    const { full, bare } = await inRolledBackTx(async (db) => {
      const orderId = await shippedOrder(db);
      await db.as({ role: 'ADMIN', userId: admin.id });
      const full = await send(db, orderId, {
        carrier: 'DHL',
        trackingNumber: 'JD0146',
        trackingUrl: 'https://track.example.com/JD0146',
        cost: 5.2,
      });
      const bare = await send(db, orderId, {});
      return { full, bare };
    });

    expect(full.ok).toBe(true);
    expect(bare.ok).toBe(true);
  });

  it('refuses a send of an order that is not shipped, and a send by a buyer', async () => {
    const { paidOrder, byBuyer } = await inRolledBackTx(async (db) => {
      const orderId = await paidOrderOf(db, owner.id, admin.id, [[product.id, 1]]);
      await db.as({ role: 'ADMIN', userId: admin.id });
      const paidOrder = await send(db, orderId, { carrier: 'DHL' });

      await moveTo(db, orderId, 'shipped');
      await db.as({ role: 'USER', userId: owner.id });
      return { paidOrder, byBuyer: await send(db, orderId, { carrier: 'DHL' }) };
    });

    refused(paidOrder, 'row-level security');
    refused(byBuyer, 'row-level security');
  });

  it('shows a send to the buyer of the order and to an admin, to nobody else', async () => {
    const { buyer, stranger, staff } = await inRolledBackTx(async (db) => {
      const orderId = await shippedOrder(db);
      await db.as({ role: 'ADMIN', userId: admin.id });
      await send(db, orderId, { carrier: 'DHL' });

      const read = () =>
        db.rows('select id from cartlify.order_shipments where "orderId" = $1', orderId);
      await db.as({ role: 'USER', userId: owner.id });
      const buyer = await read();
      await db.as({ role: 'USER', userId: other.id });
      const stranger = await read();
      await db.as({ role: 'ADMIN', userId: admin.id });
      return { buyer, stranger, staff: await read() };
    });

    expect(buyer).toHaveLength(1);
    expect(stranger).toEqual([]);
    expect(staff).toHaveLength(1);
  });

  it('keeps a number and a link each with its carrier, a link without a number, and a link is https', async () => {
    const { noCarrier, linkNoCarrier, noNumber, plainLink, spacedLink, negativeCost } =
      await inRolledBackTx(async (db) => {
        const orderId = await shippedOrder(db);
        await db.as({ role: 'ADMIN', userId: admin.id });
        return {
          noCarrier: await send(db, orderId, { trackingNumber: 'JD0146' }),
          linkNoCarrier: await send(db, orderId, { trackingUrl: 'https://track.example.com' }),
          noNumber: await send(db, orderId, {
            carrier: 'DHL',
            trackingUrl: 'https://track.example.com',
          }),
          plainLink: await send(db, orderId, {
            carrier: 'DHL',
            trackingNumber: '1',
            trackingUrl: 'http://track.example.com',
          }),
          spacedLink: await send(db, orderId, {
            carrier: 'DHL',
            trackingNumber: '1',
            trackingUrl: 'https://track.example.com/a b',
          }),
          negativeCost: await send(db, orderId, { cost: -1 }),
        };
      });

    refused(noCarrier, 'order_shipments_tracking_chk');
    refused(linkNoCarrier, 'order_shipments_tracking_chk');
    expect(noNumber.ok).toBe(true);
    refused(plainLink, 'order_shipments_tracking_chk');
    refused(spacedLink, 'order_shipments_tracking_chk');
    refused(negativeCost, 'order_shipments_cost_non_negative');
  });

  it('lets an admin write the cost later and correct the carrier and the number of a send on its way', async () => {
    const { before, after } = await inRolledBackTx(async (db) => {
      const orderId = await shippedOrder(db);
      await db.as({ role: 'ADMIN', userId: admin.id });
      const id = await sendId(db, orderId, { carrier: 'DHL' });
      const before = await shipmentOf(db, id);
      await db.attempt(
        `update cartlify.order_shipments set cost = 6.5, carrier = 'UPS', "trackingNumber" = 'Z1' where id = $1`,
        id,
      );
      return { before, after: await shipmentOf(db, id) };
    });

    expect(before).toMatchObject({ carrier: 'DHL', cost: null, expense: true, rolledBack: false });
    expect(after).toMatchObject({ carrier: 'UPS', trackingNumber: 'Z1', cost: 6.5 });
  });

  it('refuses to move a send to another order or to change the day it was sent', async () => {
    const { toOrder, day } = await inRolledBackTx(async (db) => {
      const orderId = await shippedOrder(db);
      const second = await shippedOrder(db);
      await db.as({ role: 'ADMIN', userId: admin.id });
      const id = await sendId(db, orderId, {});
      return {
        toOrder: await db.attempt(
          'update cartlify.order_shipments set "orderId" = $2 where id = $1',
          id,
          second,
        ),
        day: await db.attempt(
          `update cartlify.order_shipments set "shippedAt" = now() - interval '3 days' where id = $1`,
          id,
        ),
      };
    });

    refused(toOrder, 'ORDER_SHIPMENT_UPDATE_FORBIDDEN');
    refused(day, 'ORDER_SHIPMENT_UPDATE_FORBIDDEN');
  });

  it('keeps a rolled back send as history: it is rolled back once, its carrier stays, its cost can still be written', async () => {
    const { rolledBack, carrierAfter, again, costAfter, state } = await inRolledBackTx(
      async (db) => {
        const orderId = await shippedOrder(db);
        await db.as({ role: 'ADMIN', userId: admin.id });
        const id = await sendId(db, orderId, { carrier: 'DHL', trackingNumber: 'A1' });

        await moveTo(db, orderId, 'paid');
        await db.as({ role: 'ADMIN', userId: admin.id });
        const rolledBack = await db.attempt(
          `update cartlify.order_shipments set "rolledBackAt" = now() where id = $1 returning id`,
          id,
        );
        const carrierAfter = await db.attempt(
          `update cartlify.order_shipments set carrier = 'UPS' where id = $1`,
          id,
        );
        const again = await db.attempt(
          `update cartlify.order_shipments set "rolledBackAt" = null where id = $1`,
          id,
        );
        const costAfter = await db.attempt(
          `update cartlify.order_shipments set cost = 4, expense = false where id = $1 returning id`,
          id,
        );
        return { rolledBack, carrierAfter, again, costAfter, state: await shipmentOf(db, id) };
      },
    );

    expect(rolledBack).toMatchObject({ ok: true, rows: [expect.anything()] });
    refused(carrierAfter, 'ORDER_SHIPMENT_UPDATE_FORBIDDEN');
    refused(again, 'ORDER_SHIPMENT_UPDATE_FORBIDDEN');
    expect(costAfter).toMatchObject({ ok: true, rows: [expect.anything()] });
    expect(state).toMatchObject({ carrier: 'DHL', cost: 4, expense: false, rolledBack: true });
  });

  it('refuses a buyer to change a send', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      const orderId = await shippedOrder(db);
      await db.as({ role: 'ADMIN', userId: admin.id });
      const id = await sendId(db, orderId, { carrier: 'DHL' });
      await db.as({ role: 'USER', userId: owner.id });
      return db.attempt(
        `update cartlify.order_shipments set carrier = 'UPS' where id = $1 returning id`,
        id,
      );
    });

    expect(outcome).toMatchObject({ ok: true, rows: [] });
  });
});

describe('products: the weight and the sizes', () => {
  const write = async (set: string) =>
    inRolledBackTx(async (db) => {
      await db.as({ role: 'ADMIN', userId: admin.id });
      return db.attempt(
        `update cartlify.products set ${set} where id = $1 returning id`,
        product.id,
      );
    });

  it('takes a weight with the three sizes, a weight alone, and none of it', async () => {
    expect(
      (await write('"weightGrams" = 350, "lengthMm" = 200, "widthMm" = 100, "heightMm" = 50')).ok,
    ).toBe(true);
    expect((await write('"weightGrams" = 350')).ok).toBe(true);
    expect(
      (await write('"weightGrams" = null, "lengthMm" = null, "widthMm" = null, "heightMm" = null'))
        .ok,
    ).toBe(true);
  });

  it('refuses sizes that are not all three', async () => {
    refused(await write('"lengthMm" = 200'), 'products_shipping_data_chk');
    refused(await write('"lengthMm" = 200, "widthMm" = 100'), 'products_shipping_data_chk');
  });

  it.each([
    ['a weight of zero', '"weightGrams" = 0'],
    ['a weight over a ton', '"weightGrams" = 1000001'],
    ['a size of zero', '"lengthMm" = 0, "widthMm" = 10, "heightMm" = 10'],
    ['a size over ten metres', '"lengthMm" = 10001, "widthMm" = 10, "heightMm" = 10'],
  ])('refuses %s', async (_name, set) => {
    refused(await write(set), 'products_shipping_data_chk');
  });

  it('takes a ton and ten metres', async () => {
    const outcome = await write(
      '"weightGrams" = 1000000, "lengthMm" = 10000, "widthMm" = 10000, "heightMm" = 10000',
    );

    expect(outcome.ok).toBe(true);
  });
});
