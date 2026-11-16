import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { prisma } from '@db/client.js';

import { shopCancelIn } from '../../helpers/cancel.js';
import { inRolledBackTx, type DbSession, type Outcome } from '../../helpers/db.js';
import {
  CARRIER_DELIVERY,
  DELIVERY,
  confirm,
  cartOf,
  paidOrderOf,
  writeDelivery,
} from '../../helpers/dbOrders.js';
import {
  closeSessions,
  createProduct,
  createUser,
  type TestProduct,
  type TestUser,
} from '../../helpers/factories.js';

// The parcels of a delivery by a carrier of the delivery provider, in the database: the buyer picks
// the carrier with the address, its price is fixed like a manual one; an admin makes the parcels of
// a paid order before the carrier takes them (created, no time of the send yet), the cancel of the
// order sends them to be voided, a void closes one and takes its cost back; the boxes of a parcel
// hold the items of the order, never more units than were bought, and are written once

let owner: TestUser;
let admin: TestUser;
let product: TestProduct;

beforeAll(async () => {
  owner = await createUser();
  admin = await createUser({ role: 'ADMIN' });
  product = await createProduct({ price: 10, stock: 100 });
});

afterAll(async () => {
  try {
    await closeSessions([owner.id, admin.id]);
  } finally {
    await prisma.$disconnect();
  }
});

const refused = (outcome: Outcome, text: string) =>
  expect(outcome).toMatchObject({ ok: false, message: expect.stringContaining(text) });

const asAdmin = (db: DbSession) => db.as({ role: 'ADMIN', userId: admin.id });

// a paid order of the buyer: three units, by a carrier unless the delivery says otherwise
const paidCarrierOrder = (db: DbSession, delivery = CARRIER_DELIVERY, units = 3) =>
  paidOrderOf(db, owner.id, admin.id, [[product.variantId, units]], { flat: 6.5 }, delivery);

let parcelNumber = 0;

type Parcel = {
  state?: string;
  shippedAt?: string | null;
  providerParcelId?: string | null;
  labelUrl?: string | null;
};

// a parcel of the provider the way the app writes it: made, with its label, not sent yet
async function insertParcel(db: DbSession, orderId: number, parcel: Parcel = {}) {
  parcelNumber += 1;
  return db.attempt<{ id: number }>(
    `insert into cartlify.order_shipments
       ("orderId", carrier, "trackingNumber", "trackingUrl", "providerParcelId", "labelUrl", state,
        "shippedAt")
     values ($1, 'MockExpress', $2, $3, $4, $5, $6::cartlify."ParcelState", $7::timestamp)
     returning id`,
    orderId,
    `MX${process.pid}${parcelNumber}`,
    `https://track.example.com/MX${parcelNumber}`,
    parcel.providerParcelId === undefined
      ? `${process.pid}${parcelNumber}`
      : parcel.providerParcelId,
    parcel.labelUrl === undefined
      ? `https://cdn.example.com/labels/${parcelNumber}.pdf`
      : parcel.labelUrl,
    parcel.state ?? 'created',
    parcel.shippedAt ?? null,
  );
}

async function parcelOf(db: DbSession, orderId: number, parcel: Parcel = {}) {
  await asAdmin(db);
  const outcome = await insertParcel(db, orderId, parcel);
  if (!outcome.ok) throw new Error(`the parcel was refused: ${outcome.message}`);
  return outcome.rows[0]!.id;
}

const itemsOf = async (db: DbSession, orderId: number) => {
  await asAdmin(db);
  return db.rows<{ id: number; quantity: number }>(
    'select id, quantity from cartlify.order_items where "orderId" = $1 order by id',
    orderId,
  );
};

type Box = {
  number?: number;
  items: unknown;
  sizes?: [number | null, number | null, number | null, number | null];
};

const insertBox = (db: DbSession, shipmentId: number, box: Box) =>
  db.attempt<{ id: number }>(
    `insert into cartlify.shipment_boxes
       ("shipmentId", number, "weightGrams", "lengthMm", "widthMm", "heightMm", items)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb)
     returning id`,
    shipmentId,
    box.number ?? 1,
    ...(box.sizes ?? [1200, 300, 200, 100]),
    JSON.stringify(box.items),
  );

const stateOf = async (db: DbSession, shipmentId: number) => {
  await asAdmin(db);
  const [row] = await db.rows<{ state: string; expense: boolean; shippedAt: string | null }>(
    `select state::text as state, expense, "shippedAt"::text as "shippedAt"
     from cartlify.order_shipments where id = $1`,
    shipmentId,
  );
  return row!;
};

const costOf = async (db: DbSession, shipmentId: number) => {
  await asAdmin(db);
  const [row] = await db.rows<{ cost: string }>(
    `select coalesce(-sum(amount), 0)::text as cost from cartlify.money_log
     where "orderShipmentId" = $1 and purpose = 'shipping' and event <> 'money.received'`,
    shipmentId,
  );
  return row!.cost;
};

describe('a delivery by a carrier', () => {
  it('takes the address and the line of the prices the buyer picked, and no other method does', () =>
    inRolledBackTx(async (db) => {
      const orderId = await cartOf(db, owner.id, [[product.variantId, 1]], { delivery: false });

      const update = async (data: Record<string, unknown>) => {
        await db.as({ role: 'USER', userId: owner.id });
        const sets = Object.keys(data).map((key, i) => `"${key}" = $${i + 2}`);
        return db.attempt(
          `update cartlify.order_deliveries set ${sets.join(', ')} where "orderId" = $1 returning 1`,
          orderId,
          ...Object.values(data),
        );
      };

      await writeDelivery(db, owner.id, orderId, CARRIER_DELIVERY);
      refused(await update({ carrierConnection: null }), 'order_deliveries_carrier_chk');
      refused(await update({ carrierName: ' MockExpress' }), 'order_deliveries_carrier_chk');
      refused(await update({ city: null }), 'order_deliveries_address_chk');

      // the line of the prices goes with the method
      await writeDelivery(db, owner.id, orderId, DELIVERY);
      refused(await update({ carrierName: 'MockExpress' }), 'order_deliveries_carrier_chk');
    }));

  it('costs the price the server gives, and nothing from the free-from sum of the zone', () =>
    inRolledBackTx(async (db) => {
      const paid = await cartOf(db, owner.id, [[product.variantId, 2]], {
        delivery: CARRIER_DELIVERY,
      });
      expect(await confirm(db, owner.id, paid, '15 minutes', { flat: 6.5, freeFrom: 50 })).toEqual({
        ok: true,
        rows: expect.any(Array),
      });
      const free = await cartOf(db, owner.id, [[product.variantId, 5]], {
        delivery: CARRIER_DELIVERY,
      });
      await confirm(db, owner.id, free, '15 minutes', { flat: 6.5, freeFrom: 50 });
      // without a price of the provider nothing is confirmed: none would be a delivery for nothing
      const unpriced = await cartOf(db, owner.id, [[product.variantId, 1]], {
        delivery: CARRIER_DELIVERY,
      });
      refused(await confirm(db, owner.id, unpriced), 'ORDER_DELIVERY_PRICE_REQUIRED');

      await asAdmin(db);
      const rows = await db.rows<{ orderId: number; price: number }>(
        `select "orderId", price::float8 as price from cartlify.order_deliveries
         where "orderId" = any($1::int[]) order by "orderId"`,
        [paid, free],
      );
      expect(rows).toEqual([
        { orderId: paid, price: 6.5 },
        { orderId: free, price: 0 },
      ]);
    }));

  it('lets an admin change the carrier of a paid order, and its method to manual, never the price', () =>
    inRolledBackTx(async (db) => {
      const orderId = await paidCarrierOrder(db);
      await asAdmin(db);

      const changed = await db.attempt(
        `update cartlify.order_deliveries
         set "carrierName" = 'Generic', "carrierService" = 'Standard', "carrierConnection" = '6001'
         where "orderId" = $1 returning 1`,
        orderId,
      );
      expect(changed).toMatchObject({ ok: true, rows: [expect.anything()] });

      refused(
        await db.attempt(
          `update cartlify.order_deliveries set price = 1 where "orderId" = $1 returning 1`,
          orderId,
        ),
        'ORDER_DELIVERY_UPDATE_FORBIDDEN',
      );
      refused(
        await db.attempt(
          `update cartlify.order_deliveries set method = 'pickup' where "orderId" = $1 returning 1`,
          orderId,
        ),
        'ORDER_DELIVERY_UPDATE_FORBIDDEN',
      );

      const manual = await db.attempt(
        `update cartlify.order_deliveries
         set method = 'manual', "carrierName" = null, "carrierService" = null,
             "carrierConnection" = null
         where "orderId" = $1 returning price::float8 as price`,
        orderId,
      );
      expect(manual).toEqual({ ok: true, rows: [{ price: 6.5 }] });
    }));
});

describe('a parcel of the delivery provider', () => {
  it('is made by an admin for a paid order by a carrier, before the carrier takes it', () =>
    inRolledBackTx(async (db) => {
      const orderId = await paidCarrierOrder(db);
      const id = await parcelOf(db, orderId);

      expect(await stateOf(db, id)).toEqual({ state: 'created', expense: true, shippedAt: null });

      // the buyer sees the parcel of their order, not to write one
      await db.as({ role: 'USER', userId: owner.id });
      expect(
        await db.rows('select id from cartlify.order_shipments where id = $1', id),
      ).toHaveLength(1);
      refused(await insertParcel(db, orderId), 'row-level security');
    }));

  it('is no parcel of a manual order, nor of an order that is not paid', () =>
    inRolledBackTx(async (db) => {
      // a paid order by a carrier next to them: the rule reads the order of the parcel itself
      await paidCarrierOrder(db);
      const manual = await paidCarrierOrder(db, DELIVERY);
      const waiting = await cartOf(db, owner.id, [[product.variantId, 1]], {
        delivery: CARRIER_DELIVERY,
      });
      await confirm(db, owner.id, waiting, '15 minutes', { flat: 6.5 });

      await asAdmin(db);
      refused(await insertParcel(db, manual), 'row-level security');
      refused(await insertParcel(db, waiting), 'row-level security');
    }));

  it('has the time of its send exactly while the carrier has it, one id, and a label on https', () =>
    inRolledBackTx(async (db) => {
      const orderId = await paidCarrierOrder(db);
      const id = await parcelOf(db, orderId, { providerParcelId: `${process.pid}-twice` });
      await asAdmin(db);

      refused(
        await insertParcel(db, orderId, { shippedAt: '2026-11-10 10:00:00' }),
        'order_shipments_state_chk',
      );
      refused(
        await insertParcel(db, orderId, { labelUrl: 'http://x.example/l.pdf' }),
        'order_shipments_label_chk',
      );
      refused(
        await insertParcel(db, orderId, { providerParcelId: `${process.pid}-twice` }),
        'providerParcelId',
      );

      refused(
        await db.attempt(
          `update cartlify.order_shipments set state = 'sent' where id = $1 returning 1`,
          id,
        ),
        'order_shipments_state_chk',
      );
      const sent = await db.attempt(
        `update cartlify.order_shipments set state = 'sent', "shippedAt" = now() at time zone 'utc'
         where id = $1 returning 1`,
        id,
      );
      expect(sent).toMatchObject({ ok: true });
      // a parcel goes back to be made again only with no time of a send (a step back of the order)
      refused(
        await db.attempt(
          `update cartlify.order_shipments set state = 'created'
           where id = $1 returning 1`,
          id,
        ),
        'ORDER_SHIPMENT_UPDATE_FORBIDDEN',
      );
    }));

  it('waits for its void when the order is cancelled, unless the carrier has it', () =>
    inRolledBackTx(async (db) => {
      const orderId = await paidCarrierOrder(db);
      const made = await parcelOf(db, orderId);
      const voided = await parcelOf(db, orderId);
      await db.rows(`select cartlify.void_order_parcel($1) as result`, voided);

      const cancelled = await shopCancelIn(db, admin.id, orderId);
      expect(cancelled).toMatchObject({ ok: true });

      expect((await stateOf(db, made)).state).toBe('void_pending');
      expect((await stateOf(db, voided)).state).toBe('voided');
    }));

  it('voids only a parcel of the provider that is there', () =>
    inRolledBackTx(async (db) => {
      await asAdmin(db);
      refused(
        await db.attempt('select cartlify.void_order_parcel($1) as r', 2_000_000_000),
        'ORDER_PARCEL_NOT_FOUND',
      );
    }));

  it('is voided by an admin or the system: no expense, its cost taken back, and stays voided', () =>
    inRolledBackTx(async (db) => {
      const orderId = await paidCarrierOrder(db);
      const id = await parcelOf(db, orderId);
      await asAdmin(db);
      await db.rows('select cartlify.record_order_shipment_cost($1, 4.5) as r', id);
      expect(await costOf(db, id)).toBe('4.50');

      await db.as({ role: 'USER', userId: owner.id });
      refused(
        await db.attempt('select cartlify.void_order_parcel($1) as r', id),
        'ORDER_PARCEL_FORBIDDEN',
      );

      // the system: the worker of the voids
      await db.as({ role: 'ADMIN' });
      const [voided] = await db.rows<{ r: Record<string, unknown> }>(
        'select cartlify.void_order_parcel($1) as r',
        id,
      );
      expect(voided!.r).toEqual({ shipmentId: id, orderId, oldCost: '4.50', changed: true });
      expect(await stateOf(db, id)).toEqual({ state: 'voided', expense: true, shippedAt: null });
      expect(await costOf(db, id)).toBe('0.00');

      // voided is the end of it
      await asAdmin(db);
      refused(
        await db.attempt('select cartlify.void_order_parcel($1) as r', id),
        'ORDER_PARCEL_STATE_INVALID',
      );
      refused(
        await db.attempt(
          `update cartlify.order_shipments set state = 'void_pending' where id = $1 returning 1`,
          id,
        ),
        'ORDER_SHIPMENT_UPDATE_FORBIDDEN',
      );
    }));
});

describe('the boxes of a parcel', () => {
  it('hold the items of the order, read by the staff and the buyer of the order, and are written once', () =>
    inRolledBackTx(async (db) => {
      const orderId = await paidCarrierOrder(db);
      const [item] = await itemsOf(db, orderId);
      const id = await parcelOf(db, orderId);

      await asAdmin(db);
      const box = await insertBox(db, id, { items: [{ orderItemId: item!.id, quantity: 2 }] });
      expect(box).toMatchObject({ ok: true });
      const boxId = (box as { rows: { id: number }[] }).rows[0]!.id;

      expect(
        await db.rows(
          'update cartlify.shipment_boxes set "weightGrams" = 1 where id = $1 returning 1',
          boxId,
        ),
      ).toEqual([]);
      expect(
        await db.rows('delete from cartlify.shipment_boxes where id = $1 returning 1', boxId),
      ).toEqual([]);

      await db.as({ role: 'USER', userId: owner.id });
      expect(await db.rows('select id from cartlify.shipment_boxes where id = $1', boxId)).toEqual([
        { id: boxId },
      ]);
      refused(
        await insertBox(db, id, { number: 2, items: [{ orderItemId: item!.id, quantity: 1 }] }),
        'row-level security',
      );
    }));

  it('are boxes of a parcel to the buyer of an order only', () =>
    inRolledBackTx(async (db) => {
      const orderId = await paidCarrierOrder(db);
      const [item] = await itemsOf(db, orderId);
      await asAdmin(db);

      refused(
        await insertBox(db, 2_000_000_000, { items: [{ orderItemId: item!.id, quantity: 1 }] }),
        'SHIPMENT_BOX_SHIPMENT_INVALID',
      );
    }));

  it('take no item of another order, and no more units than the live parcels leave', () =>
    inRolledBackTx(async (db) => {
      const orderId = await paidCarrierOrder(db);
      const other = await paidCarrierOrder(db);
      const [item] = await itemsOf(db, orderId);
      const [otherItem] = await itemsOf(db, other);
      const first = await parcelOf(db, orderId);
      const second = await parcelOf(db, orderId);

      await asAdmin(db);
      refused(
        await insertBox(db, first, { items: [{ orderItemId: otherItem!.id, quantity: 1 }] }),
        'SHIPMENT_BOX_ITEM_INVALID',
      );

      expect(
        await insertBox(db, first, { items: [{ orderItemId: item!.id, quantity: 2 }] }),
      ).toMatchObject({ ok: true });
      refused(
        await insertBox(db, second, { items: [{ orderItemId: item!.id, quantity: 2 }] }),
        'SHIPMENT_BOX_ITEMS_EXCEED',
      );

      // a voided parcel holds nothing any more
      await db.rows('select cartlify.void_order_parcel($1) as r', first);
      expect(
        await insertBox(db, second, { items: [{ orderItemId: item!.id, quantity: 3 }] }),
      ).toMatchObject({ ok: true });
    }));

  it('list each item once with a whole number of units, and give all four sizes or none', () =>
    inRolledBackTx(async (db) => {
      const orderId = await paidCarrierOrder(db);
      const [item] = await itemsOf(db, orderId);
      const id = await parcelOf(db, orderId);
      await asAdmin(db);

      for (const items of [
        [],
        [{ orderItemId: item!.id, quantity: 0 }],
        [{ orderItemId: item!.id, quantity: 1.5 }],
        [{ orderItemId: item!.id }],
        [
          { orderItemId: item!.id, quantity: 1 },
          { orderItemId: item!.id, quantity: 1 },
        ],
        [{ orderItemId: item!.id, quantity: 1, extra: true }],
        { orderItemId: item!.id, quantity: 1 },
      ]) {
        refused(await insertBox(db, id, { items }), 'shipment_boxes_items_chk');
      }

      refused(
        await insertBox(db, id, {
          items: [{ orderItemId: item!.id, quantity: 1 }],
          sizes: [1000, 300, null, 100],
        }),
        'shipment_boxes_size_chk',
      );
      expect(
        await insertBox(db, id, {
          items: [{ orderItemId: item!.id, quantity: 1 }],
          sizes: [null, null, null, null],
        }),
      ).toMatchObject({ ok: true });
      refused(
        await insertBox(db, id, { items: [{ orderItemId: item!.id, quantity: 1 }] }),
        'shipment_boxes_number_uidx',
      );
    }));
});

describe('the delivery of an order with parcels', () => {
  it('counts from the parcels the carrier took, not from the ones it never had', () =>
    inRolledBackTx(async (db) => {
      const orderId = await paidCarrierOrder(db);
      const taken = await parcelOf(db, orderId);
      const never = await parcelOf(db, orderId);
      await asAdmin(db);
      await db.rows('select cartlify.void_order_parcel($1) as r', never);
      await db.rows(
        `update cartlify.order_shipments
         set state = 'sent', "shippedAt" = (now() at time zone 'utc') - interval '2 days'
         where id = $1`,
        taken,
      );
      await db.rows(`update cartlify.orders set status = 'shipped' where id = $1`, orderId);

      refused(
        await db.attempt(
          `update cartlify.orders
           set status = 'delivered', "deliveredAt" = (now() at time zone 'utc') - interval '3 days'
           where id = $1 returning 1`,
          orderId,
        ),
        'ORDER_DELIVERED_AT_INVALID',
      );
      const delivered = await db.attempt(
        `update cartlify.orders
         set status = 'delivered', "deliveredAt" = (now() at time zone 'utc') - interval '1 day'
         where id = $1 returning 1`,
        orderId,
      );
      expect(delivered).toMatchObject({ ok: true });
    }));
});

describe('the customs fields of a product', () => {
  it('take a code of 6 to 10 digits and a country of two capital letters, or nothing', () =>
    inRolledBackTx(async (db) => {
      await asAdmin(db);
      const set = (hsCode: string | null, originCountry: string | null) =>
        db.attempt(
          `update cartlify.products set "hsCode" = $2, "originCountry" = $3 where id = $1 returning 1`,
          product.id,
          hsCode,
          originCountry,
        );

      expect(await set('610510', 'PT')).toMatchObject({ ok: true });
      expect(await set('6105100000', null)).toMatchObject({ ok: true });
      expect(await set(null, null)).toMatchObject({ ok: true });
      refused(await set('61051', null), 'products_customs_chk');
      refused(await set('61051000000', null), 'character varying(10)');
      refused(await set('6105 10', null), 'products_customs_chk');
      refused(await set(null, 'pt'), 'products_customs_chk');
      refused(await set(null, 'PRT'), 'character varying(2)');
    }));
});
