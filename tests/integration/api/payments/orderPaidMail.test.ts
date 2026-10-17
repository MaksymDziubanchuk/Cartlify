import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';

import { prisma } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { sendOrderPaidEmail } from '@routes/api/payments/services/helpers/sendOrderPaidEmail.helper.js';

import { sessionCookie, signIn } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, withCsrf } from '../../../helpers/csrf.js';
import { asAdmin } from '../../../helpers/db.js';
import {
  closeSessions,
  createProduct,
  createUser,
  removeProducts,
  type TestProduct,
  type TestUser,
} from '../../../helpers/factories.js';
import { itWithMail, watchMail } from '../../../helpers/mail.js';

// the mail the stripe webhook sends once an order is paid; the order is a real cart of a user,
// the mail goes to SendGrid in sandbox mode and waits for a working account

let app: FastifyInstance;
let user: TestUser;
let product: TestProduct;
let orderId: number;

const log = () => ({ warn: jest.fn(), error: jest.fn() });

beforeAll(async () => {
  app = await startApp();
  const csrf = await getCsrf(app);

  user = await createUser({ name: 'Anna' });
  product = await createProduct({ price: 25.5, stock: 5 });
  const session = await signIn(app, csrf, user);

  const added = await app.inject({
    method: 'POST',
    url: '/api/orders/current/items',
    headers: withCsrf(csrf, sessionCookie(session)),
    payload: { productId: product.id, quantity: 2 },
  });
  expect(added.statusCode).toBe(200);

  ({ id: orderId } = await asAdmin((tx) =>
    tx.order.findFirstOrThrow({ where: { userId: user.id }, select: { id: true } }),
  ));
});

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(async () => {
  try {
    // only the owner deletes an order that is still a cart; its items go with it
    await prisma.$transaction(async (tx) => {
      await setUserContext(tx, { userId: user.id, role: 'USER' });
      await tx.order.deleteMany({ where: { id: orderId } });
    });
    await removeProducts([product]);
    await closeSessions([user.id]);
  } finally {
    await stopApp();
  }
});

describe('sendOrderPaidEmail', () => {
  itWithMail('mails the buyer the order with its items, total and link', async () => {
    const mails = watchMail();

    await sendOrderPaidEmail(orderId, log());

    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({ to: [user.email], sandbox: true });
    expect(mails[0]!.subject).toBe(`Cartlify — Order #${orderId} is paid`);
    expect(mails[0]!.text).toContain('x 2 = €51.00');
    expect(mails[0]!.text).toContain('Total: €51.00');
    expect(mails[0]!.text).toContain(`https://shop.example.com/orders/${orderId}`);
    expect(mails[0]!.html).toContain('Hi Anna,');
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
