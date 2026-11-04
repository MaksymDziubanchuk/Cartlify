import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { startApp, stopApp } from '../../helpers/app.js';
import { getCsrf, type Csrf } from '../../helpers/csrf.js';
import {
  closeSessions,
  createProduct,
  createUser,
  stockOf,
  type TestUser,
} from '../../helpers/factories.js';
import { shippingData } from '../../helpers/orders.js';
import { openPaymentPage, payPage } from '../../helpers/payments.js';
import { journeyOf } from '../../helpers/returnJourney.js';
import { closeOpenSessions, deliver, tryCardOnPage } from '../../helpers/stripe.js';

// A buyer who changes their mind, each step with what the buyer sees: the cart is changed (a
// quantity, a position taken out), confirmed, the payment page is opened and the payment called
// off, the order (unconfirmed now) is changed again and confirmed with its id only, the bank of a
// first card says no on the page, another card pays. The
// refusals of each step are the tests of the routes (api/orders, api/payments).
let app: FastifyInstance;
let csrf: Csrf;
let buyer: TestUser;
const j = journeyOf(
  () => app,
  () => csrf,
);

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  buyer = await createUser({ name: 'Marta Mind' });
});

afterAll(async () => {
  try {
    await closeOpenSessions();
    await closeSessions([buyer.id]);
  } finally {
    await stopApp();
  }
});

type Line = { id: number; variant: { id: number }; quantity: number };
const linesOf = (order: { items: Line[] }) =>
  order.items
    .map(({ variant, quantity }) => ({ variantId: variant.id, quantity }))
    .sort((a, b) => a.variantId - b.variantId);

describe('a buyer who changes their mind', () => {
  it('changes the cart, calls the payment off, changes the order and pays for what is left', async () => {
    const mug = await createProduct({ price: 10, stock: 5 });
    const tea = await createProduct({ price: 4, stock: 5 });
    const spoon = await createProduct({ price: 3, stock: 5 });

    // the cart: two mugs and a tea, then one mug and no tea
    await j.post(buyer, '/api/orders/current/items', { variantId: mug.variantId, quantity: 2 });
    const withTea = await j.post(buyer, '/api/orders/current/items', {
      variantId: tea.variantId,
      quantity: 1,
    });
    const cart = withTea.json() as { id: number; items: Line[] };
    const mugLine = cart.items.find(({ variant }) => variant.id === mug.variantId)!;
    const teaLine = cart.items.find(({ variant }) => variant.id === tea.variantId)!;
    expect(
      (await j.patch(buyer, `/api/orders/current/items/${mugLine.id}`, { quantity: 1 })).statusCode,
    ).toBe(200);
    const left = await j.del(buyer, `/api/orders/current/items/${teaLine.id}`);
    expect(left.statusCode).toBe(200);
    expect(linesOf(left.json())).toEqual([{ variantId: mug.variantId, quantity: 1 }]);

    const confirmed = await j.post(buyer, '/api/orders/current/confirm', {
      orderId: cart.id,
      ...shippingData,
    });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json()).toMatchObject({ status: 'waiting', total: 10 });

    // the payment page, called off: the order is unconfirmed
    await openPaymentPage(app, csrf, buyer, cart.id);
    const called = await j.post(buyer, `/api/orders/${cart.id}/cancel-payment`);
    expect(called.statusCode).toBe(200);
    expect(called.json().status).toBe('unconfirmed');

    // the buyer changes the order: a spoon more, two mugs, then confirms it with its id only
    const withSpoon = await j.post(buyer, `/api/orders/${cart.id}/items`, {
      variantId: spoon.variantId,
      quantity: 1,
    });
    expect(withSpoon.statusCode).toBe(200);
    const mugAgain = (withSpoon.json().items as Line[]).find(
      ({ variant }) => variant.id === mug.variantId,
    )!;
    const twoMugs = await j.patch(buyer, `/api/orders/${cart.id}/items/${mugAgain.id}`, {
      quantity: 2,
    });
    expect(linesOf(twoMugs.json())).toEqual(
      [
        { variantId: mug.variantId, quantity: 2 },
        { variantId: spoon.variantId, quantity: 1 },
      ].sort((a, b) => a.variantId - b.variantId),
    );
    const spoonLine = (twoMugs.json().items as Line[]).find(
      ({ variant }) => variant.id === spoon.variantId,
    )!;
    expect((await j.del(buyer, `/api/orders/${cart.id}/items/${spoonLine.id}`)).statusCode).toBe(
      200,
    );
    const again = await j.post(buyer, '/api/orders/current/confirm', {
      orderId: cart.id,
      expectedDeliveryPrice: 0,
    });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ status: 'waiting', total: 20 });

    // paid at last; in the end two mugs are sold, the tea and the spoon are untouched
    const sessionId = await openPaymentPage(app, csrf, buyer, cart.id);
    // the first card has not the money: the bank says no on the page, the order still waits
    expect(await tryCardOnPage(sessionId, 'tok_chargeDeclinedInsufficientFunds')).toMatchObject({
      declineCode: 'insufficient_funds',
    });
    expect((await j.get(buyer, `/api/orders/${cart.id}`)).json().status).toBe('waiting');
    const { event } = await payPage(sessionId);
    expect((await deliver(app, event)).statusCode).toBe(200);
    // the page the buyer comes back to reads the payment page and the order
    const back = await j.get(buyer, `/api/payments/stripe/checkout/sessions/${sessionId}`);
    expect(back.json()).toMatchObject({
      checkoutSession: { paymentStatus: 'paid' },
      order: { id: cart.id, status: 'paid' },
    });
    expect((await j.get(buyer, `/api/orders/${cart.id}`)).json().status).toBe('paid');
    expect(await stockOf(mug)).toEqual({ stock: 3, reservedStock: 0 });
    expect([await stockOf(tea), await stockOf(spoon)]).toEqual([
      { stock: 5, reservedStock: 0 },
      { stock: 5, reservedStock: 0 },
    ]);
  });
});
