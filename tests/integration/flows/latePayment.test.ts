import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie } from '../../helpers/actors.js';
import { startApp, stopApp } from '../../helpers/app.js';
import { getCsrf, type Csrf } from '../../helpers/csrf.js';
import { closeSessions, createProduct, createUser, stockOf } from '../../helpers/factories.js';
import { watchMail } from '../../helpers/mail.js';
import { loseReservation, placeOrder } from '../../helpers/orders.js';
import { openPaymentPage, orderStateOf, payPage, refundAuditOf } from '../../helpers/payments.js';
import { closeOpenSessions, deliver, refundsOf } from '../../helpers/stripe.js';

// a payment that comes late, through the routes of orders, payments and admin with Stripe (its
// mock, or the test sandbox with service:stripe): the first buyer loses the reservation, a second buyer takes and pays the last units,
// the page of the first is paid after all. The money goes back, the buyer gets a mail of why, the
// admin log keeps the refund and the alerts of the admins count it
let app: FastifyInstance;
let csrf: Csrf;
const userIds: number[] = [];

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
});

afterAll(async () => {
  try {
    await closeOpenSessions();
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

describe('a payment that comes after the units were sold', () => {
  it('gives the money back, tells the buyer and the admins, and keeps the sale of the other', async () => {
    const product = await createProduct({ price: 15, stock: 2 });
    const late = await createUser();
    const quick = await createUser();
    const admin = await createUser({ role: 'ADMIN' });
    userIds.push(late.id, quick.id, admin.id);
    const mails = watchMail();

    // the first buyer waits on a page and loses the reservation
    const lateOrder = await placeOrder(app, csrf, late, product, 'waiting', 2);
    const latePage = await openPaymentPage(app, csrf, late, lateOrder);
    await loseReservation(lateOrder);

    // the second buyer takes the 2 units and pays them
    const quickOrder = await placeOrder(app, csrf, quick, product, 'waiting', 2);
    const quickPage = await openPaymentPage(app, csrf, quick, quickOrder);
    const quickPaid = await payPage(quickPage);
    expect((await deliver(app, quickPaid.event)).statusCode).toBe(200);
    expect(await stockOf(product.id)).toEqual({ stock: 0, reservedStock: 0 });

    // the old page of the first buyer is paid after all: the units are gone, the money goes back
    const latePaid = await payPage(latePage);
    expect((await deliver(app, latePaid.event)).statusCode).toBe(200);

    const refunds = await refundsOf(latePaid.paymentId);
    expect(refunds).toEqual([expect.objectContaining({ amount: 3000 })]);
    expect(await orderStateOf(lateOrder)).toMatchObject({ status: 'unconfirmed', paymentId: null });
    expect(await orderStateOf(quickOrder)).toMatchObject({
      status: 'paid',
      paymentId: quickPaid.paymentId,
    });
    expect(await refundAuditOf(lateOrder)).toHaveLength(1);
    expect(
      mails.filter((mail) => mail.to.includes(late.email)).map((mail) => mail.subject),
    ).toEqual([expect.stringContaining(`payment for order #${lateOrder} is refunded`)]);

    // the admins see the refund among their alerts
    const alerts = await app.inject({
      method: 'GET',
      url: '/api/admin/alerts',
      headers: { cookie: accessCookie(admin) },
    });
    const refunded = (alerts.json().alerts as { kind: string; ids: number[] }[]).find(
      (alert) => alert.kind === 'refunded_payments',
    );
    expect(refunded?.ids).toContain(lateOrder);
  });
});
