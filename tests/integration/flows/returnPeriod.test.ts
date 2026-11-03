import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import env from '@config/env.js';

import { startApp, stopApp } from '../../helpers/app.js';
import { getCsrf, type Csrf } from '../../helpers/csrf.js';
import {
  closeSessions,
  createProduct,
  createUser,
  removeProducts,
  type TestProduct,
  type TestUser,
} from '../../helpers/factories.js';
import { watchMail } from '../../helpers/mail.js';
import { placePaidOrderOf } from '../../helpers/payments.js';
import { journeyOf, mailTo, statementCodeIn } from '../../helpers/returnJourney.js';
import { refundsOf } from '../../helpers/stripe.js';

// The period and the life of a statement (docs/return-scenarios.md, 15, 17 and 18): the carrier
// delivered before the admin marked it, a statement that extends another, the account deleted while
// a statement is open. The days of grace after the end of the contract (16) are not walked here:
// the database checks the period by its own clock, which a test cannot move; api/orders/withdrawal
// and db/withdrawal hold them

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
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
  userIds.push(admin.id);
});

afterAll(async () => {
  try {
    await removeProducts(products);
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

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
  return { buyer, orderId, paymentId };
}

const orderCardOf = async (orderId: number) =>
  (await j.get(admin, `/api/orders/${orderId}`)).json();

const dateIn = (at: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: env.SHOP_TIME_ZONE }).format(new Date(at));
const plusDays = (day: string, days: number) => {
  const at = new Date(`${day}T12:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
};

describe('the period and the life of a statement', () => {
  it('counts the period from the moment of the delivery the admin gives, not from the step', async () => {
    const { buyer, orderId } = await sentOrder(1);
    const sent = (await orderCardOf(orderId)).shipments[0].shippedAt as string;

    // the tracking of the carrier says it was delivered right when it was sent off: the earliest
    const delivered = await j.patch(admin, `/api/orders/${orderId}/status`, {
      status: 'delivered',
      deliveredAt: sent,
    });

    expect(delivered.statusCode).toBe(200);
    const page = (await j.get(buyer, `/api/orders/${orderId}`)).json();
    expect(page.deliveredAt).toBe(sent);
    expect(dateIn(page.withdrawalEndsAt)).toBe(plusDays(dateIn(sent), 14));
    expect(page.withdrawalOpen).toBe(true);
  });

  it('extends an earlier statement with another of the same order, each with its code', async () => {
    const { buyer, orderId } = await sentOrder(2);
    const card = await orderCardOf(orderId);
    const itemId = card.items[0].id as number;
    const mails = watchMail();

    const first = await j.post(admin, '/api/returns', {
      orderId,
      items: [{ orderItemId: itemId, quantity: 1 }],
      basis: 'other',
      reason: 'defect',
    });
    // the buyer writes there is a second one with the same fault
    const second = await j.post(admin, '/api/returns', {
      orderId,
      items: [{ orderItemId: itemId, quantity: 1 }],
      basis: 'other',
      reason: 'defect',
      extendsId: first.json().id,
    });

    expect(second.statusCode).toBe(201);
    expect(second.json()).toMatchObject({ code: `R${orderId}-2`, extendsId: first.json().id });
    const notices = mails.filter(
      (mail) => mail.to.includes(buyer.email) && mail.subject.includes('registered'),
    );
    expect(notices.map((mail) => statementCodeIn(mail))).toEqual([
      `R${orderId}-1`,
      `R${orderId}-2`,
    ]);
    expect(notices[1]!.text).toContain('It extends your earlier statement.');
    const chain = (await j.get(admin, `/api/returns?orderId=${orderId}&extended=true`)).json()
      .items;
    expect(chain.map((row: { code: string }) => row.code).sort()).toEqual([
      `R${orderId}-1`,
      `R${orderId}-2`,
    ]);
  });

  it('goes on after the account is deleted: the mails to the email of the statement, the money to the card', async () => {
    const { buyer, orderId, paymentId } = await sentOrder(1);
    const mails = watchMail();
    expect((await j.post(buyer, `/api/orders/${orderId}/withdrawal`)).statusCode).toBe(201);
    const code = statementCodeIn(mailTo(mails, buyer.email, 'Withdrawal from order'));

    const gone = await j.del(buyer, '/api/users/me', {
      password: buyer.password,
      confirmOpenOrders: true,
    });
    expect(gone.statusCode).toBe(204);

    const [found] = (await j.get(admin, `/api/returns?q=${code}`)).json().items;
    expect(found.buyer).toMatchObject({ alive: false });
    const card = (await j.get(admin, `/api/returns/${found.id}`)).json();
    expect(
      (
        await j.post(admin, `/api/returns/${found.id}/receive`, {
          results: [{ itemId: card.items[0].id, quantity: 1, goods: 'to_stock' }],
        })
      ).statusCode,
    ).toBe(200);
    expect((await j.post(admin, `/api/returns/${found.id}/refund`)).statusCode).toBe(200);

    expect(mailTo(mails, buyer.email, 'is closed').text).toContain('€10.00 went back to you.');
    expect((await refundsOf(paymentId)).map((refund) => refund.amount)).toEqual([1000]);
  });
});
