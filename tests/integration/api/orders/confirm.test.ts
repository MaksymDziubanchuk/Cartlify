import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { asAdmin } from '../../../helpers/db.js';
import { resetDelivery, setDelivery } from '../../../helpers/delivery.js';
import {
  closeSessions,
  createProduct,
  createUser,
  deleteProductFromCatalog,
  setProductPrice,
  stockOf,
  type TestProduct,
  type TestUser,
} from '../../../helpers/factories.js';
import {
  deliveryAnswer,
  deliveryBody,
  loseReservation,
  placeOrder,
  shippingData,
} from '../../../helpers/orders.js';

// the delivery of an order: where it goes and to whom come with the confirmation and stay on the
// order as they were confirmed, the price of the delivery is fixed with them; every order answer
// shows them, never the payment id

let app: FastifyInstance;
let csrf: Csrf;
const userIds: number[] = [];
// an order keeps its product, so these products stay; the test database goes after the run
const products: TestProduct[] = [];

const newUser = async (opts: Parameters<typeof createUser>[0] = {}) => {
  const user = await createUser(opts);
  userIds.push(user.id);
  return user;
};

const newProduct = async () => {
  const product = await createProduct({ price: 10, stock: 5 });
  products.push(product);
  return product;
};

// a user with a cart of one item
const newCart = async () => {
  const user = await newUser();
  const orderId = await placeOrder(app, csrf, user, await newProduct(), 'cart');
  return { user, orderId };
};

// the confirmation as the page sends it; a test that does not name the price of the delivery the
// page showed is one where it costs nothing
const confirm = (user: TestUser, payload: Record<string, unknown>) =>
  app.inject({
    method: 'POST',
    url: '/api/orders/current/confirm',
    headers: withCsrf(csrf, accessCookie(user)),
    payload:
      'expectedDeliveryPrice' in payload ? payload : { ...payload, expectedDeliveryPrice: 0 },
  });

const orderOf = (id: number) => asAdmin((tx) => tx.order.findUniqueOrThrow({ where: { id } }));

const deliveryOf = (orderId: number) =>
  asAdmin((tx) => tx.orderDelivery.findUnique({ where: { orderId } }));

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
});

afterEach(resetDelivery);

afterAll(async () => {
  try {
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

describe('POST /api/orders/current/confirm: where the order goes', () => {
  it('confirms with the delivery and answers with it', async () => {
    const { user, orderId } = await newCart();

    const res = await confirm(user, {
      orderId,
      delivery: {
        ...deliveryBody,
        address: { ...deliveryBody.address, apartment: '12' },
        note: 'Leave near the door.',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id: orderId,
      status: 'waiting',
      confirmed: true,
      delivery: {
        ...deliveryAnswer,
        address: { ...deliveryAnswer.address, apartment: '12' },
        price: 0,
        note: 'Leave near the door.',
        pickup: null,
        shipment: null,
      },
      reservationExpiresAt: expect.any(String),
    });
    expect(new Date(res.json().reservationExpiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(await deliveryOf(orderId)).toMatchObject({
      method: 'manual',
      recipientFirstName: 'Anna',
      country: 'UA',
      city: 'Kyiv',
      street: 'Test street',
      house: '1',
      apartment: '12',
      note: 'Leave near the door.',
    });
  });

  it('stores the text without the spaces around it, and the postal code the way its country writes it', async () => {
    const { user, orderId } = await newCart();

    const res = await confirm(user, {
      orderId,
      delivery: {
        method: 'manual',
        recipientFirstName: ' Anna ',
        recipientLastName: ' Koval ',
        recipientPhone: '+380501234567',
        address: {
          country: 'PL',
          postalCode: ' 00950 ',
          city: ' Warsaw ',
          street: ' Marszalkowska ',
          house: ' 10/12 ',
          apartment: ' 5 ',
        },
        note: '  Call first. ',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(await deliveryOf(orderId)).toMatchObject({
      recipientFirstName: 'Anna',
      recipientLastName: 'Koval',
      country: 'PL',
      postalCode: '00-950',
      city: 'Warsaw',
      street: 'Marszalkowska',
      house: '10/12',
      apartment: '5',
      note: 'Call first.',
    });
  });

  it('takes names of any script, with hyphens and apostrophes', async () => {
    const { user, orderId } = await newCart();

    const res = await confirm(user, {
      orderId,
      delivery: {
        ...deliveryBody,
        recipientFirstName: 'Ελένη',
        recipientLastName: "O'Brien-Smith",
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().delivery.recipient).toMatchObject({
      firstName: 'Ελένη',
      lastName: "O'Brien-Smith",
    });
  });

  it('takes a house by its name only', async () => {
    const { user, orderId } = await newCart();

    const res = await confirm(user, {
      orderId,
      delivery: { ...deliveryBody, address: { ...deliveryBody.address, house: 'Rose Cottage' } },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().delivery.address).toMatchObject({ house: 'Rose Cottage' });
  });

  it('takes a house without a number and an address without an apartment or a note', async () => {
    const { user, orderId } = await newCart();

    const res = await confirm(user, {
      orderId,
      delivery: { ...deliveryBody, address: { ...deliveryBody.address, house: 's/n' } },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().delivery).toMatchObject({
      note: null,
      address: { house: 's/n', apartment: null },
    });
  });

  it('refuses an order that has no delivery yet and sends none, and keeps it a cart', async () => {
    const { user, orderId } = await newCart();

    const res = await confirm(user, { orderId });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'DELIVERY_REQUIRED' });
    expect(await orderOf(orderId)).toMatchObject({ confirmed: false, status: 'pending' });
  });

  it.each([
    ['the method', 'method'],
    ['the first name', 'recipientFirstName'],
    ['the last name', 'recipientLastName'],
    ['the phone', 'recipientPhone'],
  ])('refuses a delivery without %s by the request schema', async (_name, field) => {
    const { user, orderId } = await newCart();
    const delivery = Object.fromEntries(
      Object.entries(deliveryBody).filter(([key]) => key !== field),
    );

    const res = await confirm(user, { orderId, delivery });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
    expect((await orderOf(orderId)).confirmed).toBe(false);
  });

  it('refuses a manual delivery without an address', async () => {
    const { user, orderId } = await newCart();
    const { address: _address, ...withoutAddress } = deliveryBody;

    const res = await confirm(user, { orderId, delivery: withoutAddress });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'DELIVERY_ADDRESS_REQUIRED' });
    expect(await deliveryOf(orderId)).toBeNull();
  });

  it.each([
    ['the country', 'country'],
    ['the postal code', 'postalCode'],
    ['the city', 'city'],
    ['the street', 'street'],
    ['the house', 'house'],
  ])('refuses an address without %s by the request schema', async (_name, field) => {
    const { user, orderId } = await newCart();
    const address = Object.fromEntries(
      Object.entries(deliveryBody.address).filter(([key]) => key !== field),
    );

    const res = await confirm(user, { orderId, delivery: { ...deliveryBody, address } });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
  });

  it.each([
    ['a first name with a digit', { recipientFirstName: 'Anna2' }, 'RECIPIENT_FIRST_NAME_INVALID'],
    ['a first name of only spaces', { recipientFirstName: '   ' }, 'RECIPIENT_FIRST_NAME_INVALID'],
    ['a last name without a letter', { recipientLastName: '---' }, 'RECIPIENT_LAST_NAME_INVALID'],
  ])('refuses %s and keeps the order a cart', async (_case, patch, errorCode) => {
    const { user, orderId } = await newCart();

    const res = await confirm(user, { orderId, delivery: { ...deliveryBody, ...patch } });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode });
    expect(await orderOf(orderId)).toMatchObject({ confirmed: false });
    expect(await deliveryOf(orderId)).toBeNull();
  });

  it.each([
    ['a city without a letter', { city: '123' }, 'DELIVERY_CITY_INVALID'],
    ['a city of only spaces', { city: '   ' }, 'DELIVERY_CITY_INVALID'],
    ['a street without a letter', { street: '12' }, 'DELIVERY_STREET_INVALID'],
    ['a house of only spaces', { house: '   ' }, 'DELIVERY_HOUSE_INVALID'],
    ['a postal code of another country', { postalCode: '00-950' }, 'DELIVERY_POSTAL_CODE_INVALID'],
    ['a postal code with a typo', { postalCode: '0100' }, 'DELIVERY_POSTAL_CODE_INVALID'],
    [
      'a country the shop does not deliver to',
      { country: 'FR', postalCode: '75001' },
      'DELIVERY_COUNTRY_NOT_ALLOWED',
    ],
    [
      'a country the app does not know',
      { country: 'US', postalCode: '10001' },
      'DELIVERY_COUNTRY_NOT_ALLOWED',
    ],
  ])('refuses %s and keeps the order a cart', async (_case, patch, errorCode) => {
    const { user, orderId } = await newCart();

    const res = await confirm(user, {
      orderId,
      delivery: { ...deliveryBody, address: { ...deliveryBody.address, ...patch } },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode });
    expect(await deliveryOf(orderId)).toBeNull();
  });

  it('names the country of a delivery the shop does not make', async () => {
    const { user, orderId } = await newCart();

    const res = await confirm(user, {
      orderId,
      delivery: {
        ...deliveryBody,
        address: { ...deliveryBody.address, country: 'FR', postalCode: '75001' },
      },
    });

    expect(res.json().details).toEqual({ country: 'FR' });
  });

  // the request schema holds the lengths and the forms of the phone and the country
  it.each([
    ['a phone without the plus sign', { recipientPhone: '0501234567' }],
    ['a phone with spaces', { recipientPhone: '+38 050 123 45 67' }],
    ['a first name of 101 characters', { recipientFirstName: 'x'.repeat(101) }],
    ['a last name of 101 characters', { recipientLastName: 'x'.repeat(101) }],
    ['a note of 501 characters', { note: 'x'.repeat(501) }],
    ['a method nobody knows', { method: 'courier' }],
  ])('refuses %s by the request schema', async (_case, patch) => {
    const { user, orderId } = await newCart();

    const res = await confirm(user, { orderId, delivery: { ...deliveryBody, ...patch } });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
    expect((await orderOf(orderId)).confirmed).toBe(false);
  });

  it.each([
    ['a country in small letters', { country: 'ua' }],
    ['a country of three letters', { country: 'UKR' }],
    ['a city of 101 characters', { city: 'x'.repeat(101) }],
    ['a street of 151 characters', { street: 'x'.repeat(151) }],
    ['a house of 21 characters', { house: '1'.repeat(21) }],
    ['an apartment of 41 characters', { apartment: '1'.repeat(41) }],
    ['a postal code of 17 characters', { postalCode: '1'.repeat(17) }],
  ])('refuses an address with %s by the request schema', async (_case, patch) => {
    const { user, orderId } = await newCart();

    const res = await confirm(user, {
      orderId,
      delivery: { ...deliveryBody, address: { ...deliveryBody.address, ...patch } },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
  });

  // fastify drops a field the schema does not name: a shop of persons asks no company and no region
  it('leaves out a company and a region nobody asks for, and confirms', async () => {
    const { user, orderId } = await newCart();

    const res = await confirm(user, {
      orderId,
      delivery: {
        ...deliveryBody,
        company: 'Acme',
        address: { ...deliveryBody.address, region: 'Kyivska' },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.stringify(res.json().delivery)).not.toMatch(/Acme|Kyivska/);
  });

  it('takes 100 characters in a name', async () => {
    const { user, orderId } = await newCart();

    const res = await confirm(user, {
      orderId,
      delivery: { ...deliveryBody, recipientLastName: 'x'.repeat(100) },
    });

    expect(res.statusCode).toBe(200);
  });

  it('refuses a method the shop has not enabled', async () => {
    const { user, orderId } = await newCart();
    setDelivery({ DELIVERY_METHODS: ['pickup'] });

    const res = await confirm(user, { orderId, delivery: deliveryBody });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      errorCode: 'DELIVERY_METHOD_NOT_AVAILABLE',
      details: { method: 'manual' },
    });
  });

  it('confirms a pickup without an address, and answers with where to collect the order', async () => {
    const { user, orderId } = await newCart();
    const { address: _address, ...person } = deliveryBody;

    const res = await confirm(user, { orderId, delivery: { ...person, method: 'pickup' } });

    expect(res.statusCode).toBe(200);
    expect(res.json().delivery).toEqual({
      method: 'pickup',
      price: 0,
      recipient: deliveryAnswer.recipient,
      address: null,
      note: null,
      pickup: { address: 'Test shop, Main street 1, Kyiv', hours: 'Mon-Fri 10:00-18:00' },
      shipment: null,
    });
    expect(await deliveryOf(orderId)).toMatchObject({
      method: 'pickup',
      country: null,
      city: null,
    });
  });

  it('refuses an address with a pickup', async () => {
    const { user, orderId } = await newCart();

    const res = await confirm(user, { orderId, delivery: { ...deliveryBody, method: 'pickup' } });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'DELIVERY_ADDRESS_NOT_ALLOWED' });
  });

  it('confirms an order that lost its reservation again with only its id', async () => {
    const { user, orderId } = await newCart();
    expect(
      (await confirm(user, { orderId, delivery: { ...deliveryBody, note: 'Call first.' } }))
        .statusCode,
    ).toBe(200);
    await loseReservation(orderId);

    const res = await confirm(user, { orderId });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: 'waiting',
      delivery: { ...deliveryAnswer, note: 'Call first.' },
    });
  });

  it.each([
    [
      'a country the shop stopped to deliver to',
      { DELIVERY_COUNTRIES: ['PL'] },
      'DELIVERY_COUNTRY_NOT_ALLOWED',
    ],
    [
      'a method the shop turned off',
      { DELIVERY_METHODS: ['pickup' as const] },
      'DELIVERY_METHOD_NOT_AVAILABLE',
    ],
  ])(
    'refuses an order that goes on with only its id when it has %s',
    async (_name, settings, errorCode) => {
      const { user, orderId } = await newCart();
      await confirm(user, { orderId, delivery: deliveryBody });
      await loseReservation(orderId);

      setDelivery(settings);
      const res = await confirm(user, { orderId });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode });
      expect(await orderOf(orderId)).toMatchObject({ status: 'unconfirmed' });
    },
  );

  it('replaces the delivery when a new one is sent, and removes the note with an empty one', async () => {
    const { user, orderId } = await newCart();
    await confirm(user, { orderId, delivery: { ...deliveryBody, note: 'Call first.' } });
    await loseReservation(orderId);

    const res = await confirm(user, {
      orderId,
      delivery: { ...deliveryBody, recipientPhone: '+12025550123', note: '' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().delivery).toMatchObject({ note: null, recipient: { phone: '+12025550123' } });
    expect(await deliveryOf(orderId)).toMatchObject({
      recipientFirstName: 'Anna',
      recipientPhone: '+12025550123',
      note: null,
    });
  });

  it('keeps the delivery of a confirmed order as it was confirmed', async () => {
    const { user, orderId } = await newCart();
    await confirm(user, { orderId, delivery: deliveryBody });

    const res = await confirm(user, {
      orderId,
      delivery: { ...deliveryBody, recipientPhone: '+12025550123' },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ errorCode: 'ORDER_ALREADY_CONFIRMED' });
    expect((await deliveryOf(orderId))!.recipientPhone).toBe('+380501234567');
  });
});

describe('POST /api/orders/current/confirm: the price of the delivery', () => {
  // a cart of two items at 10, 20 in all
  const cartOfTwenty = async () => {
    const user = await newUser();
    const orderId = await placeOrder(app, csrf, user, await newProduct(), 'cart', 2);
    return { user, orderId };
  };

  it('adds the flat price of the manual method to the total and fixes it', async () => {
    setDelivery({ DELIVERY_FLAT_PRICE: 4.99 });
    const { user, orderId } = await cartOfTwenty();

    const res = await confirm(user, {
      orderId,
      delivery: deliveryBody,
      expectedDeliveryPrice: 4.99,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ itemsTotal: 20, total: 24.99, delivery: { price: 4.99 } });
    expect(Number((await deliveryOf(orderId))!.price)).toBe(4.99);
    expect(await orderOf(orderId)).toMatchObject({ status: 'waiting' });
    expect(Number((await orderOf(orderId)).total)).toBe(24.99);
  });

  it('keeps the price it was confirmed with when the shop changes its price after that', async () => {
    setDelivery({ DELIVERY_FLAT_PRICE: 4.99 });
    const { user, orderId } = await cartOfTwenty();
    await confirm(user, { orderId, delivery: deliveryBody, expectedDeliveryPrice: 4.99 });

    setDelivery({ DELIVERY_FLAT_PRICE: 9.99 });
    const res = await app.inject({
      method: 'GET',
      url: `/api/orders/${orderId}`,
      headers: { cookie: accessCookie(user) },
    });

    expect(res.json()).toMatchObject({ total: 24.99, delivery: { price: 4.99 } });
  });

  it('makes the delivery free from the sum of the items on, the sum itself included', async () => {
    const at = await cartOfTwenty();
    const below = await cartOfTwenty();

    setDelivery({ DELIVERY_FLAT_PRICE: 4.99, DELIVERY_FREE_FROM: 20 });
    const free = await confirm(at.user, { orderId: at.orderId, delivery: deliveryBody });
    setDelivery({ DELIVERY_FLAT_PRICE: 4.99, DELIVERY_FREE_FROM: 20.01 });
    const paid = await confirm(below.user, {
      orderId: below.orderId,
      delivery: deliveryBody,
      expectedDeliveryPrice: 4.99,
    });

    expect(free.json()).toMatchObject({ total: 20, delivery: { price: 0 } });
    expect(paid.json()).toMatchObject({ total: 24.99, delivery: { price: 4.99 } });
  });

  it('asks nothing for a pickup, whatever the flat price is', async () => {
    setDelivery({ DELIVERY_FLAT_PRICE: 4.99 });
    const { user, orderId } = await cartOfTwenty();
    const { address: _address, ...person } = deliveryBody;

    const res = await confirm(user, { orderId, delivery: { ...person, method: 'pickup' } });

    expect(res.json()).toMatchObject({ total: 20, delivery: { price: 0 } });
  });

  it('lets a buyer whose order went back to a cart change a priced manual delivery to a pickup', async () => {
    setDelivery({ DELIVERY_FLAT_PRICE: 4.99 });
    const { user, orderId } = await cartOfTwenty();
    await confirm(user, { orderId, delivery: deliveryBody, expectedDeliveryPrice: 4.99 });
    // the buyer gives up paying: the order is a cart again and keeps the price of its delivery
    const cancelled = await app.inject({
      method: 'POST',
      url: `/api/orders/${orderId}/cancel-payment`,
      headers: withCsrf(csrf, accessCookie(user)),
    });
    expect(cancelled.statusCode).toBe(200);
    expect(Number((await deliveryOf(orderId))!.price)).toBe(4.99);
    const { address: _address, ...person } = deliveryBody;

    const res = await confirm(user, { orderId, delivery: { ...person, method: 'pickup' } });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ total: 20, delivery: { method: 'pickup', price: 0 } });
    expect(Number((await deliveryOf(orderId))!.price)).toBe(0);
  });

  // the page always says what it showed: without it a change of the price would pass unseen
  it('refuses a confirmation that does not name the price of the delivery the page showed', async () => {
    const { user, orderId } = await cartOfTwenty();

    const res = await confirm(user, {
      orderId,
      delivery: deliveryBody,
      expectedDeliveryPrice: undefined,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
    expect(await orderOf(orderId)).toMatchObject({ confirmed: false, status: 'pending' });
  });

  it('confirms when the price the buyer saw is the price now', async () => {
    setDelivery({ DELIVERY_FLAT_PRICE: 4.99 });
    const { user, orderId } = await cartOfTwenty();

    const res = await confirm(user, {
      orderId,
      delivery: deliveryBody,
      expectedDeliveryPrice: 4.99,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ total: 24.99 });
  });

  it('refuses when the price the buyer saw is not the price now, names the price and confirms nothing', async () => {
    setDelivery({ DELIVERY_FLAT_PRICE: 5.99 });
    const { user, orderId } = await cartOfTwenty();

    const res = await confirm(user, {
      orderId,
      delivery: deliveryBody,
      expectedDeliveryPrice: 4.99,
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      errorCode: 'DELIVERY_PRICE_CHANGED',
      details: { price: 5.99 },
    });
    expect(await orderOf(orderId)).toMatchObject({ confirmed: false, status: 'pending' });
    expect(await deliveryOf(orderId)).toBeNull();
  });

  it('refuses a free delivery the buyer saw when the cart is not free any more', async () => {
    setDelivery({ DELIVERY_FLAT_PRICE: 4.99, DELIVERY_FREE_FROM: 30 });
    const { user, orderId } = await cartOfTwenty();

    const res = await confirm(user, { orderId, delivery: deliveryBody, expectedDeliveryPrice: 0 });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      errorCode: 'DELIVERY_PRICE_CHANGED',
      details: { price: 4.99 },
    });
  });

  it('counts the delivery in the smallest payment: free items with a delivery that reaches it are let through', async () => {
    setDelivery({ DELIVERY_FLAT_PRICE: 1 });
    const user = await newUser();
    const product = await createProduct({ price: 0, stock: 5 });
    products.push(product);
    const added = await app.inject({
      method: 'POST',
      url: '/api/orders/current/items',
      headers: withCsrf(csrf, accessCookie(user)),
      payload: { productId: product.id, quantity: 1 },
    });

    const res = await confirm(user, {
      orderId: added.json().id,
      delivery: deliveryBody,
      expectedDeliveryPrice: 1,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ itemsTotal: 0, total: 1, delivery: { price: 1 } });
  });

  it('refuses a total below the smallest payment when the delivery does not reach it', async () => {
    setDelivery({ DELIVERY_FLAT_PRICE: 0.1 });
    const user = await newUser();
    const product = await createProduct({ price: 0.3, stock: 5 });
    products.push(product);
    const added = await app.inject({
      method: 'POST',
      url: '/api/orders/current/items',
      headers: withCsrf(csrf, accessCookie(user)),
      payload: { productId: product.id, quantity: 1 },
    });

    const res = await confirm(user, { orderId: added.json().id, delivery: deliveryBody });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'ORDER_TOTAL_BELOW_MINIMUM' });
  });

  it('prices the delivery again when an order that lost its reservation is confirmed again', async () => {
    setDelivery({ DELIVERY_FLAT_PRICE: 4.99 });
    const { user, orderId } = await cartOfTwenty();
    await confirm(user, { orderId, delivery: deliveryBody, expectedDeliveryPrice: 4.99 });
    await loseReservation(orderId);
    expect((await orderOf(orderId)).total.toString()).toBe('20');

    setDelivery({ DELIVERY_FLAT_PRICE: 7 });
    const res = await confirm(user, { orderId, expectedDeliveryPrice: 7 });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ total: 27, delivery: { price: 7 } });
  });
});

describe('POST /api/orders/current/confirm, the order itself', () => {
  const addItem = (user: TestUser, productId: number, quantity: number) =>
    app.inject({
      method: 'POST',
      url: '/api/orders/current/items',
      headers: withCsrf(csrf, accessCookie(user)),
      payload: { productId, quantity },
    });

  it('holds the stock of the items for the payment and the cart is gone', async () => {
    const user = await newUser();
    const product = await createProduct({ stock: 5 });
    products.push(product);
    const added = await addItem(user, product.id, 2);

    const res = await confirm(user, { orderId: added.json().id, ...shippingData });

    expect(res.statusCode).toBe(200);
    expect(await stockOf(product.id)).toEqual({ stock: 5, reservedStock: 2 });
    const cart = await app.inject({
      method: 'GET',
      url: '/api/orders/current',
      headers: { cookie: accessCookie(user) },
    });
    expect(cart.statusCode).toBe(404);
  });

  it('refuses an order without items', async () => {
    const user = await newUser();
    const product = await newProduct();
    const added = await addItem(user, product.id, 1);
    await app.inject({
      method: 'DELETE',
      url: `/api/orders/current/items/${added.json().items[0].id}`,
      headers: withCsrf(csrf, accessCookie(user)),
    });

    const res = await confirm(user, { orderId: added.json().id, ...shippingData });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'ORDER_ITEMS_REQUIRED' });
  });

  // Stripe takes no smaller payment: the order is refused before its stock is held, the page tells
  // the buyer the smallest total, before the payment page is asked for
  it.each([
    ['a total below the smallest payment', 0.3],
    ['a free order', 0],
  ])('refuses %s and holds no stock', async (_case, price) => {
    const user = await newUser();
    const product = await createProduct({ price, stock: 5 });
    products.push(product);
    const added = await addItem(user, product.id, 1);

    const res = await confirm(user, { orderId: added.json().id, ...shippingData });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      errorCode: 'ORDER_TOTAL_BELOW_MINIMUM',
      details: { minimum: 0.5, currency: 'eur' },
    });
    expect(await orderOf(added.json().id)).toMatchObject({
      status: 'pending',
      confirmed: false,
      reservationExpiresAt: null,
    });
    expect(await deliveryOf(added.json().id)).toBeNull();
    expect(await stockOf(product.id)).toEqual({ stock: 5, reservedStock: 0 });
  });

  it.each([
    ['the smallest payment', 0.5, 1],
    ['a total over it of cheap items', 0.3, 2],
  ])('confirms %s', async (_case, price, quantity) => {
    const user = await newUser();
    const product = await createProduct({ price, stock: 5 });
    products.push(product);
    const added = await addItem(user, product.id, quantity);

    const res = await confirm(user, { orderId: added.json().id, ...shippingData });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'waiting', total: price * quantity });
  });

  // the confirmation takes the prices of the catalog: a price that fell below the smallest payment
  // after the cart was read is refused for it, a reload would show the same
  it('counts the prices of the catalog, not the ones the cart was read at', async () => {
    const user = await newUser();
    const product = await newProduct();
    const added = await addItem(user, product.id, 1);
    await setProductPrice(product.id, 0.3);

    const res = await confirm(user, { orderId: added.json().id, ...shippingData });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'ORDER_TOTAL_BELOW_MINIMUM' });
  });

  it('names an item whose product was deleted from the catalog and keeps the cart', async () => {
    const user = await newUser();
    const product = await newProduct();
    const added = await addItem(user, product.id, 1);
    await deleteProductFromCatalog(product.id);

    const res = await confirm(user, { orderId: added.json().id, ...shippingData });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      errorCode: 'ORDER_ITEMS_UNAVAILABLE',
      details: {
        items: [
          {
            itemId: added.json().items[0].id,
            productId: product.id,
            reason: 'deleted',
            available: 0,
            requested: 1,
          },
        ],
      },
    });
    expect(await orderOf(added.json().id)).toMatchObject({ status: 'pending', confirmed: false });
  });

  it('names an item there is not enough free stock of', async () => {
    const user = await newUser();
    const product = await createProduct({ stock: 5 });
    products.push(product);
    const added = await addItem(user, product.id, 2);
    // another buyer confirms first and holds 4 of the 5
    await placeOrder(app, csrf, await newUser(), product, 'waiting', 4);

    const res = await confirm(user, { orderId: added.json().id, ...shippingData });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      errorCode: 'ORDER_ITEMS_UNAVAILABLE',
      details: {
        items: [{ productId: product.id, reason: 'out_of_stock', available: 1, requested: 2 }],
      },
    });
    expect(await stockOf(product.id)).toEqual({ stock: 5, reservedStock: 4 });
  });

  it('names every item it cannot take and only those', async () => {
    const user = await newUser();
    const fine = await newProduct();
    const gone = await newProduct();
    const scarce = await createProduct({ stock: 2 });
    products.push(scarce);
    await addItem(user, fine.id, 1);
    await addItem(user, gone.id, 1);
    const added = await addItem(user, scarce.id, 2);
    await deleteProductFromCatalog(gone.id);
    await placeOrder(app, csrf, await newUser(), scarce, 'waiting', 1);

    const res = await confirm(user, { orderId: added.json().id, ...shippingData });

    expect(res.statusCode).toBe(409);
    const items = res.json().details.items as { productId: number; reason: string }[];
    expect(items.map(({ productId, reason }) => ({ productId, reason }))).toEqual([
      { productId: gone.id, reason: 'deleted' },
      { productId: scarce.id, reason: 'out_of_stock' },
    ]);
  });

  it('refuses a price that changed after the cart was read, then confirms the new one', async () => {
    const user = await newUser();
    const product = await newProduct();
    const added = await addItem(user, product.id, 2);
    await setProductPrice(product.id, 8);

    const refused = await confirm(user, { orderId: added.json().id, ...shippingData });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ errorCode: 'ORDER_PRICES_CHANGED' });

    // the page reloads the cart: it gets the new prices
    await app.inject({
      method: 'GET',
      url: '/api/orders/current',
      headers: { cookie: accessCookie(user) },
    });
    const res = await confirm(user, { orderId: added.json().id, ...shippingData });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ total: 16 });
  });

  it('does not confirm the cart of another user', async () => {
    const owner = await newUser();
    const added = await addItem(owner, (await newProduct()).id, 1);

    const res = await confirm(await newUser(), { orderId: added.json().id, ...shippingData });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ errorCode: 'ORDER_NOT_FOUND' });
    expect((await orderOf(added.json().id)).confirmed).toBe(false);
  });

  it('answers 404 for an order that does not exist', async () => {
    const res = await confirm(await newUser(), { orderId: 2_000_000_000, ...shippingData });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ errorCode: 'ORDER_NOT_FOUND' });
  });

  it('refuses an order id over the largest id', async () => {
    const res = await confirm(await newUser(), { orderId: 2_147_483_648, ...shippingData });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
  });

  // the database would cut 1.5 to 1 and confirm another order of the user
  it('refuses an order id of 1.5 and confirms no order', async () => {
    const user = await newUser();
    const added = await addItem(user, (await newProduct()).id, 1);

    const res = await confirm(user, { orderId: added.json().id + 0.5, ...shippingData });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
    expect((await orderOf(added.json().id)).confirmed).toBe(false);
  });

  it('refuses an admin', async () => {
    const res = await confirm(await newUser({ role: 'ADMIN' }), { orderId: 1, ...shippingData });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ errorCode: 'INSUFFICIENT_ROLE' });
  });
});

describe('the order answers after the confirmation', () => {
  it('GET /api/orders/:orderId shows the owner the paid order with its delivery, not the payment id', async () => {
    const user = await newUser();
    const orderId = await placeOrder(app, csrf, user, await newProduct(), 'paid');

    const res = await app.inject({
      method: 'GET',
      url: `/api/orders/${orderId}`,
      headers: { cookie: accessCookie(user) },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: orderId, status: 'paid', delivery: deliveryAnswer });
    // a paid order holds no stock for the payment any more
    expect(res.json()).not.toHaveProperty('reservationExpiresAt');
    expect(res.json()).not.toHaveProperty('paymentId');
    expect(res.json()).not.toHaveProperty('paymentProvider');
    expect(await orderOf(orderId)).toMatchObject({
      paymentProvider: 'stripe',
      paymentId: `pi_test_${orderId}`,
    });
  });

  it('GET /api/orders lists the orders with their delivery', async () => {
    const user = await newUser();
    const orderId = await placeOrder(app, csrf, user, await newProduct(), 'waiting');

    const res = await app.inject({
      method: 'GET',
      url: '/api/orders',
      headers: { cookie: accessCookie(user) },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().items).toEqual([
      expect.objectContaining({
        id: orderId,
        delivery: expect.objectContaining(deliveryAnswer),
        reservationExpiresAt: expect.any(String),
      }),
    ]);
  });

  it('PATCH /api/orders/:orderId/status gives the admin where to ship the order', async () => {
    const user = await newUser();
    const admin = await newUser({ role: 'ADMIN' });
    const orderId = await placeOrder(app, csrf, user, await newProduct(), 'paid');

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/orders/${orderId}/status`,
      headers: withCsrf(csrf, accessCookie(admin)),
      payload: { status: 'shipped' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'shipped', delivery: deliveryAnswer });
    expect(res.json()).not.toHaveProperty('paymentId');
    expect(res.json()).not.toHaveProperty('paymentProvider');
  });
});
