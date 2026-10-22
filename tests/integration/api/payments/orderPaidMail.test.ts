import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';

import { sendOrderPaidEmail } from '@routes/api/payments/services/helpers/sendOrderPaidEmail.helper.js';

import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, type Csrf } from '../../../helpers/csrf.js';
import { asAdmin } from '../../../helpers/db.js';
import {
  closeSessions,
  createProduct,
  createUser,
  type TestProduct,
  type TestUser,
} from '../../../helpers/factories.js';
import { watchMail } from '../../../helpers/mail.js';
import { placeOrder } from '../../../helpers/orders.js';

// the mail the stripe webhook sends once an order is paid; the order is a real order of a user
// paid the way the webhook pays it, the mail goes to the SendGrid mock (tests/helpers/mail.ts).
// A paid order keeps its product, so the product stays; the test database goes after the run

let app: FastifyInstance;
let csrf: Csrf;
let user: TestUser;
let product: TestProduct;
let orderId: number;
const userIds: number[] = [];

const log = () => ({ warn: jest.fn(), error: jest.fn() });

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);

  user = await createUser({ name: 'Anna' });
  userIds.push(user.id);
  product = await createProduct({ price: 25.5, stock: 5 });
  orderId = await placeOrder(app, csrf, user, product, 'paid', 2);
});

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(async () => {
  try {
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

describe('sendOrderPaidEmail', () => {
  it('mails the buyer the order with its items, total and link', async () => {
    const mails = watchMail();

    await sendOrderPaidEmail(orderId, log());

    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({ to: [user.email], accepted: true });
    expect(mails[0]!.subject).toBe(`Cartlify — Order #${orderId} is paid`);
    expect(mails[0]!.text).toContain('x 2 = €51.00');
    expect(mails[0]!.text).toContain('Total: €51.00');
    expect(mails[0]!.text).toContain(`https://shop.example.com/orders/${orderId}`);
    expect(mails[0]!.html).toContain('Hi Anna,');
  });

  // the time of the payment the order holds, not of its last change; in utc, as the mail says
  it('names the time the order was paid', async () => {
    const { paidAt } = await asAdmin((tx) =>
      tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { paidAt: true } }),
    );
    const mails = watchMail();

    await sendOrderPaidEmail(orderId, log());

    const shown = new Intl.DateTimeFormat('en-GB', {
      dateStyle: 'long',
      timeStyle: 'short',
      timeZone: 'UTC',
    }).format(paidAt!);
    expect(mails[0]!.text).toContain(`${shown} UTC`);
  });

  it('skips an order that is not paid with a warning', async () => {
    const buyer = await createUser();
    userIds.push(buyer.id);
    const waitingId = await placeOrder(app, csrf, buyer, product, 'waiting');
    const mails = watchMail();
    const logger = log();

    await sendOrderPaidEmail(waitingId, logger);

    expect(mails).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledWith(
      { orderId: waitingId },
      'order paid mail skipped: the order is not paid',
    );
  });

  // the payment is recorded before the mail: a failure must not reach the webhook,
  // or stripe would deliver the event again
  it('only logs a mail that could not be sent', async () => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{"errors":[{"message":"down"}]}', { status: 503 }));
    const logger = log();

    await expect(sendOrderPaidEmail(orderId, logger)).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ orderId }),
      'order paid mail was not sent',
    );
  });

  it('keeps the address of the buyer out of the log', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 503 }));
    const logger = log();

    await sendOrderPaidEmail(orderId, logger);

    const logged = JSON.stringify(logger.error.mock.calls[0]?.[0] ?? {});
    expect(logged).not.toContain(user.email);
  });

  it('skips an order that is gone with a warning', async () => {
    const logger = log();

    await expect(sendOrderPaidEmail(2_000_000_000, logger)).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledWith(
      { orderId: 2_000_000_000 },
      'order paid mail skipped: the order is gone',
    );
    expect(logger.error).not.toHaveBeenCalled();
  });
});
