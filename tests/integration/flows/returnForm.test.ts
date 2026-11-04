import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from '@jest/globals';

import { startApp, stopApp } from '../../helpers/app.js';
import { getCsrf, type Csrf } from '../../helpers/csrf.js';
import {
  closeSessions,
  createProduct,
  createUser,
  removeProducts,
  stockOf,
  type TestProduct,
  type TestUser,
} from '../../helpers/factories.js';
import { watchMail } from '../../helpers/mail.js';
import { placePaidOrderOf } from '../../helpers/payments.js';
import {
  journeyOf,
  mailTo,
  mailsTo,
  statementCodeIn,
  withdrawalLinkIn,
} from '../../helpers/returnJourney.js';
import { refundsOf } from '../../helpers/stripe.js';

// The public form of withdrawal (docs/return-scenarios.md, 3, 4 and 5), each step with what its
// actor sees: a visitor what they typed (the facts from the parcel, the link of a mail) and the
// answers of the public routes, the buyer their account and their mails, the admin the alerts, the
// lists and the cards. The order is paid and sent as the setup of the test

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
let root: TestUser;
const userIds: number[] = [];
const products: TestProduct[] = [];
const j = journeyOf(
  () => app,
  () => csrf,
);

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await createUser({ role: 'ADMIN' });
  root = await createUser({ role: 'ROOT' });
  userIds.push(admin.id, root.id);
});

afterAll(async () => {
  try {
    await removeProducts(products);
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

const FORM_EMAIL = 'anna.form@example.com';

// the facts of the recipient as a person types them: spaces in the phone and the postal code, the
// country in lower case (helpers/orders.ts writes Anna Koval, +380501234567, UA, 01001)
const typed = {
  recipientName: 'koval anna',
  phone: '+380 50 123 45 67',
  country: 'ua',
  postalCode: '01 001',
};

async function sentOrder(units: number) {
  const buyer = await createUser({ name: 'Anna Koval' });
  userIds.push(buyer.id);
  const product = await createProduct({ price: 10, stock: 20 });
  products.push(product);
  const { orderId, paymentId } = await placePaidOrderOf(app, csrf, buyer, [
    { item: product, quantity: units },
  ]);
  expect(
    (await j.patch(admin, `/api/orders/${orderId}/status`, { status: 'shipped' })).statusCode,
  ).toBe(200);
  return { buyer, product, orderId, paymentId };
}

// the statements of the check of the admins, as the alert names them, narrowed to the order
async function manualCheckOf(orderId: number) {
  const alerts = (await j.get(admin, '/api/admin/alerts')).json().alerts as Array<{
    kind: string;
    list: { path: string; query: Record<string, string> } | null;
  }>;
  const { list } = alerts.find((alert) => alert.kind === 'returns_manual_check')!;
  const query = new URLSearchParams({ ...list!.query, orderId: String(orderId) });
  return (await j.get(admin, `${list!.path}?${query}`)).json().items as Array<{
    id: number;
    code: string;
  }>;
}

afterEach(() => undefined);

describe('the link of a mail after the account is deleted', () => {
  it('shows the units by the code and the name, takes the statement, the parcel by its link, and the money goes back', async () => {
    const { buyer, product, orderId, paymentId } = await sentOrder(2);
    const mails = watchMail();
    expect(
      (await j.patch(admin, `/api/orders/${orderId}/status`, { status: 'delivered' })).statusCode,
    ).toBe(200);
    const link = withdrawalLinkIn(mailTo(mails, buyer.email, 'is delivered'));

    // the buyer deletes the account; the mail of the delivery stays with them
    const gone = await j.del(buyer, '/api/users/me', {
      password: buyer.password,
      confirmOpenOrders: true,
    });
    expect(gone.statusCode).toBe(204);

    // the page of the link asks where to go: the account is gone, the form it is
    expect(
      (
        await j.post(null, '/api/withdrawals/route', { orderId: link.orderId, code: link.code })
      ).json(),
    ).toEqual({ where: 'form' });

    // the form shows the units after the name of the recipient
    const shown = await j.post(null, '/api/withdrawals/items', {
      orderId: link.orderId,
      code: link.code,
      recipientName: 'Anna Koval',
    });
    expect(shown.statusCode).toBe(200);
    expect(shown.json()).toEqual({
      items: [{ orderItemId: expect.any(Number), name: expect.any(String), quantity: 2 }],
      signIn: false,
      underReview: false,
    });
    const [item] = shown.json().items;

    // one unit of them, the answers to a new address
    const made = await j.post(null, '/api/withdrawals', {
      orderId: link.orderId,
      code: link.code,
      recipientName: 'Anna Koval',
      email: FORM_EMAIL,
      items: [{ orderItemId: item.orderItemId, quantity: 1 }],
    });
    expect(made.statusCode).toBe(201);

    // the notice comes to that address with the link of the parcel
    const notice = mailTo(mails, FORM_EMAIL, `Withdrawal from order #${orderId}`);
    const code = statementCodeIn(notice);
    const parcel = withdrawalLinkIn(notice);
    expect(parcel.returnId).not.toBeNull();
    const proof = await j.post(null, '/api/withdrawals/proof', {
      orderId,
      code: parcel.code,
      returnId: parcel.returnId,
      carrier: 'DHL',
      trackingNumber: 'JD0146000999',
    });
    expect(proof.statusCode).toBe(200);

    // the admin finds it by its code, takes the goods in and gives the money back
    const [found] = (await j.get(admin, `/api/returns?q=${code}`)).json().items;
    const card = (await j.get(admin, `/api/returns/${found.id}`)).json();
    expect(card.proof).toMatchObject({ carrier: 'DHL', trackingNumber: 'JD0146000999' });
    const before = await stockOf(product);
    expect(
      (
        await j.post(admin, `/api/returns/${found.id}/receive`, {
          results: [{ itemId: card.items[0].id, quantity: 1, goods: 'to_stock' }],
        })
      ).statusCode,
    ).toBe(200);
    expect((await j.post(admin, `/api/returns/${found.id}/refund`)).statusCode).toBe(200);

    // the end goes to the address of the form; the unit is on the shelf and its money at Stripe
    expect(mailTo(mails, FORM_EMAIL, 'is closed').text).toContain('€10.00 went back to you.');
    expect((await stockOf(product)).stock).toBe(before.stock + 1);
    expect((await refundsOf(paymentId)).map((refund) => refund.amount)).toEqual([1000]);
  });
});

describe('the form without the code', () => {
  it('shows the units after the facts of the recipient, holds the next statement until an admin accepts the first, then takes it', async () => {
    const { buyer, orderId } = await sentOrder(3);
    const mails = watchMail();

    // the units, after the facts the person typed
    const shown = (await j.post(null, '/api/withdrawals/items', { orderId, ...typed })).json();
    expect(shown).toMatchObject({ signIn: true, underReview: false });
    const [item] = shown.items;
    expect(item.quantity).toBe(3);

    // one unit of them
    const first = await j.post(null, '/api/withdrawals', {
      orderId,
      ...typed,
      email: FORM_EMAIL,
      items: [{ orderItemId: item.orderItemId, quantity: 1 }],
    });
    expect(first.statusCode).toBe(201);
    // the account of the order learns of a statement it may not have made
    expect(mailsTo(mails, buyer.email, `Withdrawal from order #${orderId}`)).toHaveLength(1);

    // the next one waits: the form says so before and after it is filled
    const again = (await j.post(null, '/api/withdrawals/items', { orderId, ...typed })).json();
    expect(again).toMatchObject({ underReview: true, items: [{ quantity: 2 }] });
    const held = await j.post(null, '/api/withdrawals', {
      orderId,
      ...typed,
      email: FORM_EMAIL,
      items: [{ orderItemId: item.orderItemId, quantity: 1 }],
    });
    expect(held.statusCode).toBe(409);
    expect(held.json()).toMatchObject({ errorCode: 'WITHDRAWAL_UNDER_REVIEW' });

    // the admin finds it in the alert of the check; nothing of it is handled before it is accepted
    const [waiting] = await manualCheckOf(orderId);
    const card = (await j.get(admin, `/api/returns/${waiting!.id}`)).json();
    const early = await j.post(admin, `/api/returns/${waiting!.id}/receive`, {
      results: [{ itemId: card.items[0].id, quantity: 1, goods: 'to_stock' }],
    });
    expect(early.statusCode).toBe(409);
    expect(early.json()).toMatchObject({ errorCode: 'RETURN_NOT_ACCEPTED' });

    // the admin wrote to the email of the statement and accepts it: it leaves the alert
    const accepted = await j.post(admin, `/api/returns/${waiting!.id}/accept`);
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({
      acceptedAt: expect.any(String),
      acceptedBy: { id: admin.id },
    });
    expect(await manualCheckOf(orderId)).toEqual([]);

    // the next statement is taken now, for the units left
    const second = await j.post(null, '/api/withdrawals', {
      orderId,
      ...typed,
      email: FORM_EMAIL,
      items: [{ orderItemId: item.orderItemId, quantity: 1 }],
    });
    expect(second.statusCode).toBe(201);
    expect(await manualCheckOf(orderId)).toHaveLength(1);
  });

  it('shows nothing when a fact is wrong, the same answer whatever it was', async () => {
    const { orderId } = await sentOrder(1);

    for (const wrong of [
      { ...typed, recipientName: 'Olena Koval' },
      { ...typed, phone: '+380509999999' },
      { ...typed, country: 'pl' },
      { ...typed, postalCode: '01002' },
      { recipientName: typed.recipientName },
    ]) {
      const res = await j.post(null, '/api/withdrawals/items', { orderId, ...wrong });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode: 'WITHDRAWAL_REJECTED' });
    }
    // an order there is not answers the same
    const none = await j.post(null, '/api/withdrawals/items', { orderId: 2_000_000_100, ...typed });
    expect(none.json()).toMatchObject({ errorCode: 'WITHDRAWAL_REJECTED' });
  });

  it("closes a statement that is not the buyer's without accepting it, with a mail that names no goods", async () => {
    const { orderId } = await sentOrder(1);
    const shown = (await j.post(null, '/api/withdrawals/items', { orderId, ...typed })).json();
    expect(
      (
        await j.post(null, '/api/withdrawals', {
          orderId,
          ...typed,
          email: 'someone@example.com',
          items: [{ orderItemId: shown.items[0].orderItemId, quantity: 1 }],
        })
      ).statusCode,
    ).toBe(201);
    const mails = watchMail();

    const [waiting] = await manualCheckOf(orderId);
    const closed = await j.post(root, `/api/returns/${waiting!.id}/close`, {
      code: 'not_buyer',
      note: 'The buyer did not send it.',
    });

    expect(closed.statusCode).toBe(200);
    expect(mailTo(mails, 'someone@example.com', 'is closed').text).toContain(
      'We could not match the statement to your purchase.',
    );
    expect(await manualCheckOf(orderId)).toEqual([]);
  });
});

describe('the buyer states units a form without the code holds', () => {
  it('takes them over from a statement still under review, which is closed, and its person gets a mail that names neither the buyer nor the goods', async () => {
    const { buyer, orderId } = await sentOrder(2);
    const shown = (await j.post(null, '/api/withdrawals/items', { orderId, ...typed })).json();
    expect(
      (await j.post(null, '/api/withdrawals', { orderId, ...typed, email: FORM_EMAIL })).statusCode,
    ).toBe(201);
    const mails = watchMail();

    // the page of the buyer counts the units of the form as free
    const page = (await j.get(buyer, `/api/orders/${orderId}`)).json();
    expect(page.withdrawable).toEqual([{ orderItemId: shown.items[0].orderItemId, quantity: 2 }]);
    expect((await j.post(buyer, `/api/orders/${orderId}/withdrawal`)).statusCode).toBe(201);

    const changed = mailTo(mails, FORM_EMAIL, 'changed');
    expect(changed.text).toContain(
      'All the goods of your statement are now handled in another statement of this order',
    );
    expect(changed.text).not.toContain('buyer');
    expect(changed.text).not.toContain(shown.items[0].name);
    expect(await manualCheckOf(orderId)).toEqual([]);
  });

  it('leaves an accepted statement as it is: the buyer may state only the units left', async () => {
    const { buyer, orderId } = await sentOrder(3);
    const shown = (await j.post(null, '/api/withdrawals/items', { orderId, ...typed })).json();
    const itemId = shown.items[0].orderItemId;
    expect(
      (
        await j.post(null, '/api/withdrawals', {
          orderId,
          ...typed,
          email: FORM_EMAIL,
          items: [{ orderItemId: itemId, quantity: 1 }],
        })
      ).statusCode,
    ).toBe(201);
    const [waiting] = await manualCheckOf(orderId);
    expect((await j.post(admin, `/api/returns/${waiting!.id}/accept`)).statusCode).toBe(200);
    const mails = watchMail();

    const page = (await j.get(buyer, `/api/orders/${orderId}`)).json();
    expect(page.withdrawable).toEqual([{ orderItemId: itemId, quantity: 2 }]);
    const made = await j.post(buyer, `/api/orders/${orderId}/withdrawal`);
    expect(made.statusCode).toBe(201);

    expect(mailsTo(mails, FORM_EMAIL, 'changed')).toEqual([]);
    const card = (await j.get(admin, `/api/returns/${waiting!.id}`)).json();
    expect(card.items).toEqual([expect.objectContaining({ quantity: 1, goods: 'expected' })]);
  });
});
