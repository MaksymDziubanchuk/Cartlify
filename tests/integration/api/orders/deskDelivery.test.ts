import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, type Csrf } from '../../../helpers/csrf.js';
import { resetDelivery, setDelivery } from '../../../helpers/delivery.js';
import {
  closeSessions,
  createProduct,
  createUser,
  type TestUser,
} from '../../../helpers/factories.js';
import { asAdmin } from '../../../helpers/db.js';
import { addShipment, deliveryBody, placeOrder } from '../../../helpers/orders.js';

// the desk of an admin by what the orders have to do with their delivery: how it goes (by hand or a
// pickup), to which country and city, by which carrier, whether its cost is written, whether it is
// paid by the buyer, whether a product of it has no weight; the same filters and sorts for the csv
// the courier gets. Other files make orders at the same time: a test looks at the orders of its own
// buyer only

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
const userIds: number[] = [];

const newUser = async (opts: Parameters<typeof createUser>[0] = {}) => {
  const user = await createUser(opts);
  userIds.push(user.id);
  return user;
};

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await newUser({ role: 'ADMIN' });
});

afterEach(resetDelivery);

afterAll(async () => {
  try {
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

const listAs = (actor: TestUser, query: string) =>
  app.inject({
    method: 'GET',
    url: `/api/orders?${query}`,
    headers: { cookie: accessCookie(actor) },
  });

const idsOf = (res: { json: () => { items: Array<{ id: number }> } }) =>
  res.json().items.map((order) => order.id);

const sortedIdsOf = (res: { json: () => { items: Array<{ id: number }> } }) =>
  idsOf(res).sort((a, b) => a - b);

const address = (country: string, postalCode: string, city: string) => ({
  ...deliveryBody,
  address: { country, postalCode, city, street: 'Test street', house: '1' },
});

const { address: _address, ...person } = deliveryBody;
const pickupBody = { ...person, method: 'pickup' };

// a buyer with four orders: paid to Kyiv, shipped to Warsaw by DHL with a number and a cost, shipped to
// Berlin by DPD without either (and a free delivery, a product without weight), paid for a pickup
async function buyerWithOrders() {
  setDelivery({ DELIVERY_FLAT_PRICE: 4.99, DELIVERY_FREE_FROM: 30 });
  const buyer = await newUser({ name: 'Olena' });
  const light = await createProduct({
    price: 10,
    stock: 20,
    weightGrams: 300,
    sizesMm: { length: 200, width: 100, height: 50 },
  });
  const unweighed = await createProduct({ price: 12, stock: 20 });

  const kyiv = await placeOrder(app, csrf, buyer, light, 'paid');
  const warsaw = await placeOrder(
    app,
    csrf,
    buyer,
    light,
    'shipped',
    1,
    address('PL', '00-950', 'Warsaw'),
  );
  await addShipment(warsaw, { carrier: 'DHL Express', trackingNumber: 'JD0146000123', cost: 7 });
  const berlin = await placeOrder(
    app,
    csrf,
    buyer,
    unweighed,
    'shipped',
    3,
    address('DE', '10115', 'Berlin'),
  );
  await addShipment(berlin, { carrier: 'DPD' });
  const pickup = await placeOrder(app, csrf, buyer, light, 'paid', 1, pickupBody);

  return { buyer, kyiv, warsaw, berlin, pickup };
}

describe('GET /api/orders: the delivery filters of an admin', () => {
  it('lists the orders of a method, a few through commas', async () => {
    const { buyer, kyiv, warsaw, berlin, pickup } = await buyerWithOrders();

    expect(sortedIdsOf(await listAs(admin, `userId=${buyer.id}&deliveryMethod=pickup`))).toEqual([
      pickup,
    ]);
    expect(sortedIdsOf(await listAs(admin, `userId=${buyer.id}&deliveryMethod=manual`))).toEqual([
      kyiv,
      warsaw,
      berlin,
    ]);
    expect(
      sortedIdsOf(await listAs(admin, `userId=${buyer.id}&deliveryMethod=manual,pickup`)),
    ).toEqual([kyiv, warsaw, berlin, pickup]);
  });

  it('refuses a method nobody knows', async () => {
    const res = await listAs(admin, 'deliveryMethod=courier');

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
  });

  it('lists the orders to a country, a few through commas', async () => {
    const { buyer, kyiv, warsaw, berlin } = await buyerWithOrders();

    expect(sortedIdsOf(await listAs(admin, `userId=${buyer.id}&country=PL`))).toEqual([warsaw]);
    expect(sortedIdsOf(await listAs(admin, `userId=${buyer.id}&country=PL,DE`))).toEqual([
      warsaw,
      berlin,
    ]);
    expect(sortedIdsOf(await listAs(admin, `userId=${buyer.id}&country=UA`))).toEqual([kyiv]);
  });

  it('lists the orders of a carrier by a part of its name, without the case', async () => {
    const { buyer, warsaw, berlin } = await buyerWithOrders();

    expect(sortedIdsOf(await listAs(admin, `userId=${buyer.id}&carrier=dhl`))).toEqual([warsaw]);
    expect(sortedIdsOf(await listAs(admin, `userId=${buyer.id}&carrier=D`))).toEqual([
      warsaw,
      berlin,
    ]);
  });

  it('leaves out a send that was rolled back when it looks for a carrier', async () => {
    const { buyer, warsaw } = await buyerWithOrders();
    await addShipment(warsaw, { carrier: 'UPS', rolledBack: true });

    expect(sortedIdsOf(await listAs(admin, `userId=${buyer.id}&carrier=ups`))).toEqual([]);
  });

  it('lists the orders shipped without a tracking number', async () => {
    const { buyer, berlin } = await buyerWithOrders();

    expect(
      sortedIdsOf(await listAs(admin, `userId=${buyer.id}&shippedWithoutNumber=true`)),
    ).toEqual([berlin]);
  });

  it('lists the orders of a delivery the buyer pays for, and of one the shop pays for', async () => {
    const { buyer, kyiv, warsaw, berlin, pickup } = await buyerWithOrders();

    expect(sortedIdsOf(await listAs(admin, `userId=${buyer.id}&deliveryCharged=true`))).toEqual([
      kyiv,
      warsaw,
    ]);
    expect(sortedIdsOf(await listAs(admin, `userId=${buyer.id}&deliveryCharged=false`))).toEqual([
      berlin,
      pickup,
    ]);
  });

  it('lists the orders with a product that has no weight', async () => {
    const { buyer, berlin } = await buyerWithOrders();

    expect(sortedIdsOf(await listAs(admin, `userId=${buyer.id}&withoutWeight=true`))).toEqual([
      berlin,
    ]);
  });

  it('lists the orders sent without the cost the shop paid for it written', async () => {
    const { buyer, berlin } = await buyerWithOrders();

    expect(sortedIdsOf(await listAs(admin, `userId=${buyer.id}&shippingCostMissing=true`))).toEqual(
      [berlin],
    );
  });

  it('counts a send the shop owes nothing for as no missing cost', async () => {
    const { buyer, berlin, warsaw } = await buyerWithOrders();
    // a send of Warsaw with no cost that the shop does not owe, and the one of Berlin made so
    await addShipment(warsaw, { carrier: 'UPS', expense: false, rolledBack: true });
    await asAdmin((tx) =>
      tx.orderShipment.updateMany({ where: { orderId: berlin }, data: { expense: false } }),
    );

    expect(sortedIdsOf(await listAs(admin, `userId=${buyer.id}&shippingCostMissing=true`))).toEqual(
      [],
    );
  });

  it.each([
    'deliveryMethod=manual',
    'country=UA',
    'carrier=dhl',
    'shippedWithoutNumber=true',
    'deliveryCharged=true',
    'withoutWeight=true',
    'shippingCostMissing=true',
  ])('refuses %s to a buyer', async (query) => {
    const res = await listAs(await newUser(), query);

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({
      errorCode: 'FILTER_FORBIDDEN',
      details: { filter: query.split('=')[0] },
    });
  });
});

describe('GET /api/orders: the text an admin looks for in the delivery', () => {
  it('finds an order by its tracking number, the city or the postal code of its address', async () => {
    const { buyer, warsaw } = await buyerWithOrders();

    for (const text of ['JD0146000123', 'jd01460', 'Warsaw', 'arsa', '00-950']) {
      expect(
        sortedIdsOf(await listAs(admin, `userId=${buyer.id}&q=${encodeURIComponent(text)}`)),
      ).toEqual([warsaw]);
    }
  });

  // a postal code is digits, and digits are the number of an order too: both are looked for
  it('finds an order by a postal code written in digits, which is the number of an order too', async () => {
    const { buyer, berlin } = await buyerWithOrders();

    expect(sortedIdsOf(await listAs(admin, `userId=${buyer.id}&q=10115`))).toEqual([berlin]);
    expect(sortedIdsOf(await listAs(admin, `userId=${buyer.id}&q=${berlin}`))).toEqual([berlin]);
  });

  it('finds an order by the name or the phone of the recipient', async () => {
    const { buyer, kyiv, warsaw, berlin, pickup } = await buyerWithOrders();

    const all = [kyiv, warsaw, berlin, pickup];
    expect(sortedIdsOf(await listAs(admin, `userId=${buyer.id}&q=Koval`))).toEqual(all);
    expect(
      sortedIdsOf(await listAs(admin, `userId=${buyer.id}&q=${encodeURIComponent('+3805012')}`)),
    ).toEqual(all);
  });
});

describe('GET /api/orders: the delivery sorts of an admin', () => {
  async function walk(buyerId: number, sort: string, dir: 'asc' | 'desc') {
    const ids: number[] = [];
    let cursor: string | null = null;

    do {
      const res: Awaited<ReturnType<typeof listAs>> = await listAs(
        admin,
        `userId=${buyerId}&sortBy=${sort}&sortDir=${dir}&limit=1${cursor ? `&cursor=${cursor}` : ''}`,
      );
      expect(res.statusCode).toBe(200);
      ids.push(...idsOf(res));
      cursor = res.json().nextCursor;
    } while (cursor);

    return ids;
  }

  it('sorts by the method, the manual ones before the pickups', async () => {
    const { buyer, kyiv, warsaw, berlin, pickup } = await buyerWithOrders();

    expect(await walk(buyer.id, 'deliveryMethod', 'asc')).toEqual([kyiv, warsaw, berlin, pickup]);
    expect(await walk(buyer.id, 'deliveryMethod', 'desc')).toEqual([pickup, berlin, warsaw, kyiv]);
  });

  it('sorts by the country and then the city, and lists only the orders that go to an address', async () => {
    const { buyer, kyiv, warsaw, berlin } = await buyerWithOrders();

    expect(await walk(buyer.id, 'destination', 'asc')).toEqual([berlin, warsaw, kyiv]);
    expect(await walk(buyer.id, 'destination', 'desc')).toEqual([kyiv, warsaw, berlin]);
  });

  it('sorts by the city when the country is the same', async () => {
    const buyer = await newUser();
    const product = await createProduct({ price: 10, stock: 5 });
    const warsaw = await placeOrder(
      app,
      csrf,
      buyer,
      product,
      'paid',
      1,
      address('PL', '00-950', 'Warsaw'),
    );
    const lodz = await placeOrder(
      app,
      csrf,
      buyer,
      product,
      'paid',
      1,
      address('PL', '90-001', 'Lodz'),
    );
    const krakow = await placeOrder(
      app,
      csrf,
      buyer,
      product,
      'paid',
      1,
      address('PL', '30-001', 'Krakow'),
    );

    expect(await walk(buyer.id, 'destination', 'asc')).toEqual([krakow, lodz, warsaw]);
    expect(await walk(buyer.id, 'destination', 'desc')).toEqual([warsaw, lodz, krakow]);
  });

  it('sorts by the price of the delivery', async () => {
    const { buyer, kyiv, warsaw, berlin, pickup } = await buyerWithOrders();

    expect(await walk(buyer.id, 'deliveryPrice', 'desc')).toEqual([warsaw, kyiv, pickup, berlin]);
    expect(await walk(buyer.id, 'deliveryPrice', 'asc')).toEqual([berlin, pickup, kyiv, warsaw]);
  });

  it('refuses the cursor of another delivery sort', async () => {
    const { buyer } = await buyerWithOrders();
    const first = await listAs(
      admin,
      `userId=${buyer.id}&sortBy=deliveryMethod&sortDir=asc&limit=1`,
    );

    const res = await listAs(
      admin,
      `userId=${buyer.id}&sortBy=destination&sortDir=asc&limit=1&cursor=${first.json().nextCursor}`,
    );

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'CURSOR_INVALID' });
  });

  it('gives a buyer the sorts of the delivery too, for the own orders', async () => {
    const { buyer } = await buyerWithOrders();

    const res = await listAs(buyer, 'sortBy=deliveryMethod&sortDir=asc');

    expect(res.statusCode).toBe(200);
  });
});

describe('GET /api/orders: the orders sent without a cost, by the send that waits longest', () => {
  // orders of one buyer shipped by hand, each send written one after the other with no cost
  async function sentWithoutCost(count = 3) {
    const buyer = await newUser();
    const product = await createProduct({ price: 10, stock: 10 });
    const ids: number[] = [];
    for (let i = 0; i < count; i++) {
      const orderId = await placeOrder(app, csrf, buyer, product, 'shipped');
      await addShipment(orderId, { carrier: 'DHL' });
      ids.push(orderId);
    }
    return { buyer, ids };
  }

  const missing = (buyer: TestUser, extra = '') =>
    listAs(admin, `userId=${buyer.id}&shippingCostMissing=true${extra}`);

  it('lists them by the send that waits longest, the oldest first, by default', async () => {
    const { buyer, ids } = await sentWithoutCost();

    const res = await missing(buyer);

    expect(res.statusCode).toBe(200);
    expect(idsOf(res)).toEqual(ids);
    expect(res.json().total).toBe(3);
  });

  it('lists them the newest send first when the admin asks', async () => {
    const { buyer, ids } = await sentWithoutCost();

    const res = await missing(buyer, '&sortBy=shippingCostMissingSince&sortDir=desc');

    expect(idsOf(res)).toEqual([...ids].reverse());
  });

  it('goes by the oldest send of each order without a cost, not by when the order was made', async () => {
    const buyer = await newUser();
    const product = await createProduct({ price: 10, stock: 10 });
    const first = await placeOrder(app, csrf, buyer, product, 'shipped');
    const second = await placeOrder(app, csrf, buyer, product, 'shipped');
    await addShipment(second, { carrier: 'DHL' });
    await addShipment(first, { carrier: 'DHL' });
    // a send of the second written later, and a send with its cost: neither moves it
    await addShipment(second, { carrier: 'UPS', rolledBack: true });
    await addShipment(first, { carrier: 'UPS', cost: 3, rolledBack: true });

    expect(idsOf(await missing(buyer))).toEqual([second, first]);
  });

  it('pages through them with the cursor of the sort', async () => {
    const { buyer, ids } = await sentWithoutCost();

    const seen: number[] = [];
    let cursor: string | null = null;
    do {
      const res = await missing(
        buyer,
        `&limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      );
      expect(res.statusCode).toBe(200);
      expect(res.json().total).toBe(3);
      seen.push(...idsOf(res));
      cursor = res.json().nextCursor;
    } while (cursor);

    expect(seen).toEqual(ids);
  });

  it('lets the admin sort them by another field', async () => {
    const { buyer, ids } = await sentWithoutCost();

    const res = await missing(buyer, '&sortBy=createdAt&sortDir=desc');

    expect(idsOf(res)).toEqual([...ids].reverse());
  });

  it('gives the csv in the same order', async () => {
    const { buyer, ids } = await sentWithoutCost();

    const res = await missing(buyer, '&format=csv');

    expect(res.statusCode).toBe(200);
    const lines = res.body
      .replace(/^\uFEFF/, '')
      .trim()
      .split('\r\n')
      .slice(1);
    expect(lines.map((line) => Number(line.split(',')[0]))).toEqual(ids);
  });

  it('refuses the sort without the filter, and a cursor of another sort', async () => {
    const { buyer } = await sentWithoutCost(2);
    const page = await missing(buyer, '&limit=1&sortBy=createdAt&sortDir=asc');

    const withoutFilter = await listAs(admin, 'sortBy=shippingCostMissingSince');
    const otherCursor = await missing(
      buyer,
      `&limit=1&cursor=${encodeURIComponent(page.json().nextCursor)}`,
    );

    expect(withoutFilter.statusCode).toBe(400);
    expect(withoutFilter.json()).toMatchObject({
      errorCode: 'SORT_SHIPPING_COST_MISSING_REQUIRES_FILTER',
    });
    expect(otherCursor.statusCode).toBe(400);
    expect(otherCursor.json()).toMatchObject({ errorCode: 'CURSOR_INVALID' });
  });
});

describe('GET /api/orders?format=csv: the delivery for the courier', () => {
  const HEADER = [
    'Order',
    'Status',
    'Paid at',
    'Buyer email',
    'Recipient',
    'Phone',
    'Method',
    'Country',
    'Postal code',
    'City',
    'Street',
    'House',
    'Apartment',
    'Note',
    'Delivery price',
    'Items',
    'Weight g',
    'Weight complete',
    'Total',
    'Carrier',
    'Tracking number',
    'Shipping cost',
  ].join(',');

  const csvOf = async (query: string) => {
    const res = await listAs(admin, `${query}&format=csv`);
    expect(res.statusCode).toBe(200);
    return res.body
      .replace(/^\uFEFF/, '')
      .trim()
      .split('\r\n');
  };

  it('has the person, the address, the price, the weight and the send of each order', async () => {
    const { buyer, warsaw } = await buyerWithOrders();

    const lines = await csvOf(`userId=${buyer.id}&country=PL`);

    expect(lines[0]).toBe(HEADER);
    expect(lines).toHaveLength(2);
    const cells = lines[1]!.split(',');
    expect(cells[0]).toBe(String(warsaw));
    // the phone begins with a plus: the file puts an apostrophe before it, a spreadsheet takes no formula
    expect(lines[1]).toContain("Anna Koval,'+380501234567,manual,PL,00-950,Warsaw,Test street,1,");
    expect(lines[1]).toContain(',4.99,');
    // one unit of 300 g, a product that has its weight
    expect(lines[1]).toContain(',300,yes,');
    expect(lines[1]).toContain('DHL Express,JD0146000123,7.00');
  });

  it('says the weight is not complete when a product has none, and the pickup has no address', async () => {
    const { buyer } = await buyerWithOrders();

    const berlin = (await csvOf(`userId=${buyer.id}&country=DE`))[1]!;
    const pickup = (await csvOf(`userId=${buyer.id}&deliveryMethod=pickup`))[1]!;

    expect(berlin).toContain(',0,no,');
    expect(pickup).toContain("Anna Koval,'+380501234567,pickup,,,,,,");
  });

  it('takes the filters and the sort of the list', async () => {
    const { buyer, kyiv, warsaw, berlin } = await buyerWithOrders();

    const lines = await csvOf(
      `userId=${buyer.id}&deliveryMethod=manual&sortBy=destination&sortDir=asc`,
    );

    expect(lines.slice(1).map((line) => Number(line.split(',')[0]))).toEqual([
      berlin,
      warsaw,
      kyiv,
    ]);
  });
});
