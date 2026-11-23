import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';

import { DELIVERY_WEBHOOK_PATH, deliveryProvider } from '@providers/delivery/index.js';
import { voidPendingParcels } from '@routes/api/orders/services/voidParcels.service.js';

import { startApp, stopApp } from '../../helpers/app.js';
import { CARRIER_SHOP, MADRID, SIZED } from '../../helpers/carrierOrders.js';
import { getCsrf, type Csrf } from '../../helpers/csrf.js';
import { asAdmin } from '../../helpers/db.js';
import {
  closeSessions,
  createProduct,
  createUser,
  type TestUser,
} from '../../helpers/factories.js';
import { watchMail } from '../../helpers/mail.js';
import { openPaymentPage, payPage } from '../../helpers/payments.js';
import { deliveryHarness } from '../../helpers/providers.js';
import { journeyOf, mailTo } from '../../helpers/returnJourney.js';
import { resetShopSettings, setShopSettings } from '../../helpers/shopSettings.js';
import { closeOpenSessions, deliver } from '../../helpers/stripe.js';

import type { DeliveryEventKind } from '@providers/delivery/index.js';

// the delivery of an order by a carrier of the delivery provider (item 5, step 13), as its people go
// it: the buyer gets the prices of the carriers for the address, picks one, pays it with the goods;
// the admin finds the paid orders without parcels on the desk, makes the parcels from the draft;
// the carrier takes them and delivers them (the events of the provider), the buyer is mailed each
// step with the numbers of the parcels; a withdrawal before the carrier took the parcel voids it;
// a parcel refused at the door or lost is the alert of the admin, who tells it on the usual routes
// of the statements; a delivery by hand costs what the zone of the country says. Each step takes
// what it needs from what its actor saw; the provider knows its own parcels (their ids are read
// where it keeps them); the database is read at the end, for what came of it

const harness = deliveryHarness[deliveryProvider.name];

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
const userIds: number[] = [];
const j = journeyOf(
  () => app,
  () => csrf,
);

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await createUser({ role: 'ADMIN' });
  userIds.push(admin.id);
});

afterEach(() => {
  resetShopSettings();
});

afterAll(async () => {
  try {
    await closeOpenSessions();
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

type Option = {
  method: string;
  price: number;
  carrier: { name: string; service: string; connection: string } | null;
};
type Shipment = {
  id: number;
  state: string;
  trackingNumber: string | null;
  shippedAt: string | null;
  boxes: { items: { orderItemId: number; quantity: number }[] }[];
};

const recipient = {
  recipientFirstName: 'Ana',
  recipientLastName: 'Garcia',
  recipientPhone: '+34910000000',
};

// the buyer puts the goods in the cart, asks the prices for the address and confirms the line
// picked (a carrier, or the delivery by hand); then pays the page. The id of the order and the price
// of the delivery the buyer saw
async function buy(
  buyer: TestUser,
  goods: { variantId: number; quantity: number }[],
  pick: (options: Option[]) => Option,
  address = MADRID,
): Promise<{ orderId: number; price: number }> {
  let orderId = 0;
  for (const item of goods) {
    const added = await j.post(buyer, '/api/orders/current/items', item);
    expect(added.statusCode).toBe(200);
    orderId = added.json().id;
  }

  // the page of the delivery shows the ways of the shop first, then their prices for the address
  const methods = await j.get(buyer, '/api/delivery/methods');
  expect(methods.statusCode).toBe(200);
  const options = await j.post(buyer, '/api/orders/current/delivery-options', { address });
  expect(options.statusCode).toBe(200);
  const line = pick(options.json().options as Option[]);
  // the way picked is one of the ways of the shop
  expect((methods.json().methods as { method: string }[]).map((one) => one.method)).toContain(
    line.method,
  );

  const confirmed = await j.post(buyer, '/api/orders/current/confirm', {
    orderId,
    expectedDeliveryPrice: line.price,
    delivery: {
      method: line.method,
      ...recipient,
      address,
      ...(line.carrier ? { carrier: line.carrier } : {}),
    },
  });
  expect(confirmed.statusCode).toBe(200);

  const { event } = await payPage(await openPaymentPage(app, csrf, buyer, orderId));
  expect((await deliver(app, event)).statusCode).toBe(200);
  return { orderId, price: line.price };
}

const carrierLine = (name: string) => (options: Option[]) =>
  options.find((option) => option.carrier?.name === name)!;

const newBuyer = async () => {
  const buyer = await createUser({ name: 'Ana Garcia' });
  userIds.push(buyer.id);
  return buyer;
};

const cardOf = async (orderId: number) => {
  const res = await j.get(admin, `/api/orders/${orderId}`);
  expect(res.statusCode).toBe(200);
  return res.json() as {
    status: string;
    total: number;
    paidAt: string | null;
    shipments: Shipment[];
  };
};

// the provider tells an event of its parcel: it knows the parcel by its own id
async function carrierTells(kind: DeliveryEventKind, shipmentId: number) {
  const { providerParcelId, trackingNumber } = await asAdmin((tx) =>
    tx.orderShipment.findUniqueOrThrow({
      where: { id: shipmentId },
      select: { providerParcelId: true, trackingNumber: true },
    }),
  );
  const res = await app.inject({
    method: 'POST',
    url: DELIVERY_WEBHOOK_PATH,
    headers: harness.webhookHeaders(),
    payload: JSON.stringify(
      harness.eventBody(kind, {
        parcelId: providerParcelId!,
        reference: 'x',
        trackingNumber,
      }),
    ),
  });
  expect(res.statusCode).toBe(200);
}

// the cases of an alert in the list it names, narrowed to the order
async function inAlert(kind: string, orderId: number): Promise<boolean> {
  const res = await j.get(admin, `/api/admin/alerts?kinds=${kind}`);
  const { list } = (
    res.json().alerts as { kind: string; list: { path: string; query: Record<string, string> } }[]
  ).find((alert) => alert.kind === kind)!;
  const page = await j.get(
    admin,
    `${list.path}?${new URLSearchParams({ ...list.query, q: String(orderId) })}`,
  );
  return (page.json().items as { id: number }[]).some((row) => row.id === orderId);
}

const sized = (price: number) => createProduct({ price, stock: 5, ...SIZED });

describe('an order sent by a carrier', () => {
  it('goes from the prices for the address to the delivery by the events of the carrier, the buyer mailed each step', async () => {
    setShopSettings(CARRIER_SHOP);
    const lamp = await sized(30);
    const buyer = await newBuyer();
    const mails = watchMail();

    const { orderId, price } = await buy(
      buyer,
      [{ variantId: lamp.variantId, quantity: 1 }],
      carrierLine('MockExpress'),
    );
    // the buyer paid the goods and the price of the carrier the page showed
    const mine = await j.get(buyer, `/api/orders/${orderId}`);
    expect(mine.json()).toMatchObject({ status: 'paid', total: 30 + price });
    expect(mine.json().delivery).toMatchObject({ method: 'carrier', price });

    // the admin finds it among the paid orders of a carrier without parcels and makes the draft
    // the orders of its buyer: the digits of a number are looked for in the postal codes too
    const desk = await j.get(admin, `/api/orders?parcels=none&userId=${buyer.id}`);
    expect((desk.json().items as { id: number }[]).map((row) => row.id)).toEqual([orderId]);
    const draft = await j.get(admin, `/api/orders/${orderId}/parcels/draft`);
    expect(draft.statusCode).toBe(200);
    const made = await j.post(admin, `/api/orders/${orderId}/parcels`, {
      parcels: draft
        .json()
        .parcels.map((parcel: { boxes: unknown[] }) => ({ boxes: parcel.boxes })),
    });
    expect(made.statusCode).toBe(200);
    const [parcel] = made.json().order.shipments as Shipment[];
    expect(parcel).toMatchObject({ state: 'created', trackingNumber: expect.any(String) });
    expect(
      (await j.get(admin, `/api/orders?parcels=none&userId=${buyer.id}`)).json().items,
    ).toEqual([]);

    // the carrier takes it: shipped, the buyer gets the number; then delivers it
    await carrierTells('collected', parcel!.id);
    const shipped = mailTo(mails, buyer.email, 'is shipped');
    expect(shipped.text).toContain(parcel!.trackingNumber!);
    await carrierTells('delivered', parcel!.id);
    mailTo(mails, buyer.email, 'is delivered');

    const after = await j.get(buyer, `/api/orders/${orderId}`);
    expect(after.json()).toMatchObject({ status: 'delivered' });
    expect(after.json().delivery.shipments).toEqual([
      expect.objectContaining({ trackingNumber: parcel!.trackingNumber, state: 'delivered' }),
    ]);
  });

  it('goes in two parcels the admin lays out: shipped once both are taken, the mail names both', async () => {
    setShopSettings(CARRIER_SHOP);
    const mug = await sized(10);
    const lamp = await sized(30);
    const buyer = await newBuyer();
    const mails = watchMail();
    const { orderId } = await buy(
      buyer,
      [
        { variantId: mug.variantId, quantity: 1 },
        { variantId: lamp.variantId, quantity: 1 },
      ],
      carrierLine('MockExpress'),
    );

    // the draft has one box of every unit: the admin puts each item in a parcel of its own
    const draft = await j.get(admin, `/api/orders/${orderId}/parcels/draft`);
    const [box] = draft.json().parcels[0].boxes as {
      weightGrams: number;
      lengthMm: number;
      widthMm: number;
      heightMm: number;
      items: { orderItemId: number; quantity: number }[];
    }[];
    const made = await j.post(admin, `/api/orders/${orderId}/parcels`, {
      parcels: box!.items.map((item) => ({
        boxes: [{ weightGrams: 400, lengthMm: 300, widthMm: 200, heightMm: 50, items: [item] }],
      })),
    });
    expect(made.statusCode).toBe(200);
    const parcels = made.json().order.shipments as Shipment[];
    expect(parcels).toHaveLength(2);

    await carrierTells('collected', parcels[0]!.id);
    expect((await cardOf(orderId)).status).toBe('paid');
    await carrierTells('collected', parcels[1]!.id);
    expect((await cardOf(orderId)).status).toBe('shipped');

    const shipped = mailTo(mails, buyer.email, 'is shipped');
    for (const parcel of parcels) expect(shipped.text).toContain(parcel.trackingNumber!);
    expect(shipped.text).toContain('Parcel 2');

    for (const parcel of parcels) await carrierTells('delivered', parcel.id);
    expect((await cardOf(orderId)).status).toBe('delivered');
  });
});

describe('an order of a carrier that does not reach the buyer', () => {
  it('voids the parcel not taken when the buyer withdraws, its cost taken back, the money back', async () => {
    setShopSettings(CARRIER_SHOP);
    const lamp = await sized(30);
    const buyer = await newBuyer();
    const mails = watchMail();
    const { orderId } = await buy(
      buyer,
      [{ variantId: lamp.variantId, quantity: 1 }],
      carrierLine('MockExpress'),
    );
    const made = await j.post(admin, `/api/orders/${orderId}/parcels`, {});
    const [parcel] = made.json().order.shipments as Shipment[];

    // the buyer withdraws from the whole order before the carrier came
    const withdrawn = await j.post(buyer, `/api/orders/${orderId}/withdrawal`, {});
    expect(withdrawn.statusCode).toBe(201);
    expect(withdrawn.json().status).toBe('cancelled');
    mailTo(mails, buyer.email, 'Withdrawal from order');

    // the worker of the voids asks the provider, which voids it
    expect((await cardOf(orderId)).shipments[0]).toMatchObject({ state: 'void_pending' });
    const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    expect(await voidPendingParcels(log, { orderId })).toBe(1);
    expect((await cardOf(orderId)).shipments[0]).toMatchObject({
      id: parcel!.id,
      state: 'voided',
      expense: true,
    });
    expect(await inAlert('parcels_void_pending', orderId)).toBe(false);
  });

  it('waits for the admin to cancel a parcel the carrier cannot be asked to void, then takes its cost back', async () => {
    setShopSettings(CARRIER_SHOP);
    const lamp = await sized(30);
    const buyer = await newBuyer();
    const { orderId } = await buy(
      buyer,
      [{ variantId: lamp.variantId, quantity: 1 }],
      carrierLine(harness.steadyCarrier),
    );
    const made = await j.post(admin, `/api/orders/${orderId}/parcels`, {});
    const [parcel] = made.json().order.shipments as Shipment[];

    // the buyer withdraws before the carrier came; the carrier voids nothing it is asked
    expect((await j.post(buyer, `/api/orders/${orderId}/withdrawal`, {})).statusCode).toBe(201);
    const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    await voidPendingParcels(log, { orderId });
    expect((await cardOf(orderId)).shipments[0]).toMatchObject({ state: 'void_pending' });
    expect(await inAlert('parcels_void_pending', orderId)).toBe(true);

    // the admin cancels it in the dashboard of the carrier and says so
    const confirmed = await j.post(
      admin,
      `/api/orders/${orderId}/shipments/${parcel!.id}/void-confirmation`,
      {},
    );
    expect(confirmed.statusCode).toBe(200);
    expect((await cardOf(orderId)).shipments[0]).toMatchObject({ state: 'voided', expense: true });
    expect(await inAlert('parcels_void_pending', orderId)).toBe(false);
  });

  it('is refused at the door: the alert, the refusal the admin tells, the goods back, the money back, the order cancelled', async () => {
    setShopSettings(CARRIER_SHOP);
    const lamp = await sized(30);
    const buyer = await newBuyer();
    const mails = watchMail();
    const { orderId } = await buy(
      buyer,
      [{ variantId: lamp.variantId, quantity: 1 }],
      carrierLine('MockExpress'),
    );
    const made = await j.post(admin, `/api/orders/${orderId}/parcels`, {});
    const [parcel] = made.json().order.shipments as Shipment[];
    await carrierTells('collected', parcel!.id);
    await carrierTells('returning', parcel!.id);

    // the parcel goes back without a reason: the alert of the admin names the order
    expect(await inAlert('parcels_coming_back', orderId)).toBe(true);
    const card = await cardOf(orderId);
    expect(card.shipments[0]).toMatchObject({ state: 'returning' });

    // the admin tells the refusal at the earliest moment the card allows: the payment, or the moment
    // the carrier took the parcel (it tells whole seconds), whichever is later
    const item = card.shipments[0]!.boxes[0]!.items[0]!;
    const refusal = await j.post(admin, '/api/returns', {
      orderId,
      items: [item],
      basis: 'withdrawal',
      reason: 'refused',
      statedAt: [card.paidAt!, card.shipments[0]!.shippedAt!].sort().at(-1),
    });
    expect(refusal.statusCode).toBe(201);
    mailTo(mails, buyer.email, 'registered');
    const returnId = refusal.json().id as number;
    expect(await inAlert('parcels_coming_back', orderId)).toBe(false);

    // the parcel is back: the admin takes the goods in and gives the money back
    await carrierTells('returned', parcel!.id);
    const row = (refusal.json().items as { id: number }[])[0]!;
    const received = await j.post(admin, `/api/returns/${returnId}/receive`, {
      parcel: { buyerPaid: 0 },
      results: [{ itemId: row.id, quantity: 1, goods: 'to_stock' }],
    });
    expect(received.statusCode).toBe(200);
    expect((await j.post(admin, `/api/returns/${returnId}/refund`)).statusCode).toBe(200);

    mailTo(mails, buyer.email, 'is closed');
    expect((await cardOf(orderId)).status).toBe('cancelled');
  });

  it('is lost by the carrier: the alert, the statement of the units of its boxes the admin opens', async () => {
    setShopSettings(CARRIER_SHOP);
    const lamp = await sized(30);
    const buyer = await newBuyer();
    const { orderId } = await buy(
      buyer,
      [{ variantId: lamp.variantId, quantity: 1 }],
      carrierLine('MockExpress'),
    );
    const made = await j.post(admin, `/api/orders/${orderId}/parcels`, {});
    const [parcel] = made.json().order.shipments as Shipment[];
    await carrierTells('collected', parcel!.id);
    await carrierTells('lost', parcel!.id);

    expect(await inAlert('parcels_lost', orderId)).toBe(true);
    const lost = (await cardOf(orderId)).shipments[0]!;
    expect(lost.state).toBe('lost');

    const statement = await j.post(admin, '/api/returns', {
      orderId,
      items: lost.boxes.flatMap((box) => box.items),
      basis: 'other',
      reason: 'other',
    });
    expect(statement.statusCode).toBe(201);
    expect(await inAlert('parcels_lost', orderId)).toBe(false);
  });
});

describe('a delivery by hand', () => {
  it('costs each buyer what the zone of their country says, and they pay it', async () => {
    setShopSettings({
      deliveryMethods: ['manual', 'pickup'],
      deliveryZones: [
        { name: 'Spain', countries: ['ES'], manualPrice: 5, freeFrom: null },
        { name: 'Poland', countries: ['PL'], manualPrice: 12, freeFrom: null },
      ],
    });
    const lamp = await sized(30);
    const warsaw = {
      country: 'PL',
      postalCode: '00-001',
      city: 'Warszawa',
      street: 'Nowy Swiat',
      house: '1',
    };

    const byHand = (options: Option[]) => options.find((option) => option.method === 'manual')!;
    const spanish = await newBuyer();
    const polish = await newBuyer();
    const inSpain = await buy(spanish, [{ variantId: lamp.variantId, quantity: 1 }], byHand);
    const inPoland = await buy(
      polish,
      [{ variantId: lamp.variantId, quantity: 1 }],
      byHand,
      warsaw,
    );

    expect([inSpain.price, inPoland.price]).toEqual([5, 12]);
    expect((await j.get(spanish, `/api/orders/${inSpain.orderId}`)).json().total).toBe(35);
    expect((await j.get(polish, `/api/orders/${inPoland.orderId}`)).json().total).toBe(42);

    // the admin sends one of them by hand: it is shipped, the buyer sees the parcel
    const sent = await j.patch(admin, `/api/orders/${inPoland.orderId}/status`, {
      status: 'shipped',
      shipments: [{ carrier: 'InPost', trackingNumber: 'PL-1' }],
    });
    expect(sent.statusCode).toBe(200);
    expect(
      (await j.get(polish, `/api/orders/${inPoland.orderId}`)).json().delivery.shipments,
    ).toEqual([{ carrier: 'InPost', trackingNumber: 'PL-1', trackingUrl: null, state: 'sent' }]);
  });
});
