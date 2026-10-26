import { readFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from '@jest/globals';

import env from '@config/env.js';

import { accessCookie, sessionCookie, signIn } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { closeChatSockets, openChatSocket } from '../../../helpers/chatSocket.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { asAdmin } from '../../../helpers/db.js';
import {
  closeSessions,
  createProduct,
  createUser,
  uniqueEmail,
  type TestUser,
} from '../../../helpers/factories.js';
import { watchMail } from '../../../helpers/mail.js';
import { FRONTEND_CALLBACK, callback } from '../../../helpers/oauth.js';
import { answerAsModel, stopModel } from '../../../helpers/openai.js';
import { placeOrder } from '../../../helpers/orders.js';
import { openPaymentPage } from '../../../helpers/payments.js';
import { stripeOfTests } from '../../../helpers/stripe.js';

// the settings a shop sets in its environment, and what each one changes: the pages of the
// frontend the server links to and sends the browser back to, the name of the shop the bot and the
// documentation give, the logo of the mails, the time a confirmed order holds its units and the
// time its payment page stays open after that, the life of the link of a verification. Each test
// sets them for itself and puts them back; the app reads them on each request

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
const userIds: number[] = [];

const SITE = new URL(FRONTEND_CALLBACK).origin;

type Settings = Partial<typeof env>;
let restore: Settings = {};

function set(values: Settings): void {
  for (const key of Object.keys(values) as Array<keyof typeof env>) {
    if (!(key in restore)) Object.assign(restore, { [key]: env[key] });
  }
  Object.assign(env, values);
}

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

afterEach(() => {
  Object.assign(env, restore);
  restore = {};
  stopModel();
});

afterAll(async () => {
  closeChatSockets();
  try {
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

const register = (email: string) =>
  app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: withCsrf(csrf),
    payload: { email, password: 'secret-pass-1' },
  });

const forgot = (email: string) =>
  app.inject({
    method: 'POST',
    url: '/api/auth/password/forgot',
    headers: withCsrf(csrf),
    payload: { email },
  });

const setStatus = (orderId: number, status: string) =>
  app.inject({
    method: 'PATCH',
    url: `/api/orders/${orderId}/status`,
    headers: withCsrf(csrf, accessCookie(admin)),
    payload: { status },
  });

const verificationRowOf = async (email: string) => {
  const user = await asAdmin((tx) =>
    tx.user.findUniqueOrThrow({ where: { email }, select: { id: true } }),
  );
  userIds.push(user.id);
  return asAdmin((tx) =>
    tx.userToken.findFirstOrThrow({
      where: { userId: user.id, type: 'VERIFY_EMAIL' },
      select: { expiresAt: true },
    }),
  );
};

describe('the pages of the frontend (WEB_PAGE_*)', () => {
  it('sends the browser back from a login of a provider to the page of the setting', async () => {
    set({ WEB_PAGE_OAUTH_CALLBACK: '/login/done' });

    const res = await callback(app, 'google', { error: 'access_denied' });

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toMatch(new RegExp(`^${SITE}/login/done\\?error=[A-Z_]+$`));
  });

  it('links the mails of an account to the pages of the settings', async () => {
    set({
      WEB_PAGE_VERIFY_EMAIL: '/account/verify',
      WEB_PAGE_PASSWORD_RESET: '/account/password?step=new',
      WEB_PAGE_LOGIN: '/sign-in',
    });
    const mails = watchMail();
    const email = uniqueEmail('settings');

    expect((await register(email)).statusCode).toBe(201);
    await verificationRowOf(email);
    const user = await newUser();
    expect((await forgot(user.email)).statusCode).toBe(200);
    const session = await signIn(app, csrf, user);
    const changed = await app.inject({
      method: 'POST',
      url: '/api/auth/password/change',
      headers: withCsrf(csrf, sessionCookie(session)),
      payload: { currentPassword: user.password, newPassword: 'another-pass-2' },
    });
    expect(changed.statusCode).toBeLessThan(300);

    const [verify, reset, passwordChanged] = mails;
    expect(verify!.text).toMatch(new RegExp(`${SITE}/account/verify\\?token=[\\w-]+`));
    expect(reset!.text).toMatch(new RegExp(`${SITE}/account/password\\?step=new&token=[\\w-]+`));
    expect(passwordChanged!.text).toContain(`${SITE}/sign-in`);
  });

  it('opens the payment page with the return pages of the settings', async () => {
    set({ WEB_PAGE_CHECKOUT_SUCCESS: '/pay/ok', WEB_PAGE_CHECKOUT_CANCEL: '/pay/back' });
    const buyer = await newUser();
    const orderId = await placeOrder(
      app,
      csrf,
      buyer,
      await createProduct({ price: 10 }),
      'waiting',
    );

    const sessionId = await openPaymentPage(app, csrf, buyer, orderId);
    const session = await stripeOfTests.checkout.sessions.retrieve(sessionId);

    expect(session.success_url).toBe(`${SITE}/pay/ok?session_id={CHECKOUT_SESSION_ID}`);
    expect(session.cancel_url).toBe(`${SITE}/pay/back?orderId=${orderId}`);
  });

  it('links the mails of an order to its page and to the reviews of its product', async () => {
    set({
      WEB_PAGE_ORDER: '/account/orders/{id}',
      WEB_PAGE_PRODUCT_REVIEWS: '/p/{id}?tab=reviews#rate',
    });
    const product = await createProduct({ price: 10 });
    const orderId = await placeOrder(app, csrf, await newUser(), product, 'paid');
    const mails = watchMail();

    expect((await setStatus(orderId, 'shipped')).statusCode).toBe(200);
    expect((await setStatus(orderId, 'delivered')).statusCode).toBe(200);

    const [shipped, delivered] = mails;
    expect(shipped!.text).toContain(`${SITE}/account/orders/${orderId}`);
    expect(delivered!.text).toContain(`${SITE}/account/orders/${orderId}`);
    expect(delivered!.text).toContain(`${SITE}/p/${product.id}?tab=reviews#rate`);
  });
});

describe('the name of the shop (SHOP_NAME)', () => {
  it('is the name the bot greets a new chat with', async () => {
    set({ SHOP_NAME: 'Lamp House' });

    const res = await app.inject({
      method: 'GET',
      url: '/api/chat/thread/current',
      headers: { cookie: `guestId=${randomUUID()}` },
    });

    expect(res.statusCode).toBe(200);
    const [welcome] = res.json().messages as Array<{ content: string }>;
    expect(welcome!.content).toContain('Lamp House assistant');
    expect(welcome!.content).not.toContain('Cartlify');
  });

  it('is the name the bot answers as', async () => {
    set({ SHOP_NAME: 'Lamp House' });
    const calls = answerAsModel();
    const cookie = accessCookie(await newUser({ isVerified: true }));
    const current = await app.inject({
      method: 'GET',
      url: '/api/chat/thread/current',
      headers: { cookie },
    });
    const threadId = current.json().thread.id as string;
    const socket = await openChatSocket(app, { cookie });
    await socket.join(threadId);

    socket.send({ type: 'message:send', payload: { threadId, content: 'Do you sell lamps?' } });
    await socket.take('message:new', (e) => e.payload?.senderType === 'bot');

    const instructions = calls.find((call) => call.purpose === 'answer')!.request.instructions;
    expect(instructions).toContain('Lamp House');
    expect(instructions).not.toContain('Cartlify');
  });
});

describe('the logo of the mails (SHOP_LOGO_PATH)', () => {
  it('goes inline with every mail, the file of the setting', async () => {
    const logo = 'tests/fixtures/images/jpeg-baseline.jpg';
    set({ SHOP_LOGO_PATH: logo });
    const user = await newUser();
    const mails = watchMail();

    expect((await forgot(user.email)).statusCode).toBe(200);

    expect(mails[0]!.attachments).toEqual([
      expect.objectContaining({
        type: 'image/jpeg',
        filename: 'jpeg-baseline.jpg',
        disposition: 'inline',
        content: readFileSync(path.join(process.cwd(), logo)).toString('base64'),
      }),
    ]);
  });
});

describe('the time of a reservation (ORDER_RESERVATION_MINUTES)', () => {
  it('holds the units of a confirmed order for the minutes of the setting', async () => {
    set({ ORDER_RESERVATION_MINUTES: 5 });
    const before = Date.now();

    const orderId = await placeOrder(
      app,
      csrf,
      await newUser(),
      await createProduct({ price: 10 }),
      'waiting',
    );

    const { reservationExpiresAt } = await asAdmin((tx) =>
      tx.order.findUniqueOrThrow({
        where: { id: orderId },
        select: { reservationExpiresAt: true },
      }),
    );
    const held = reservationExpiresAt!.getTime();
    expect(held).toBeGreaterThanOrEqual(before + 5 * 60_000 - 1_000);
    expect(held).toBeLessThanOrEqual(Date.now() + 5 * 60_000 + 1_000);
  });

  // stripe closes the page itself the minutes after the end of the reservation
  it('keeps the payment page open the minutes of STRIPE_PAGE_AFTER_RESERVATION_MINUTES after it', async () => {
    set({ STRIPE_PAGE_AFTER_RESERVATION_MINUTES: 45 });
    const buyer = await newUser();
    const orderId = await placeOrder(
      app,
      csrf,
      buyer,
      await createProduct({ price: 10 }),
      'waiting',
    );

    const session = await stripeOfTests.checkout.sessions.retrieve(
      await openPaymentPage(app, csrf, buyer, orderId),
    );

    const { reservationExpiresAt } = await asAdmin((tx) =>
      tx.order.findUniqueOrThrow({
        where: { id: orderId },
        select: { reservationExpiresAt: true },
      }),
    );
    expect(session.expires_at).toBe(
      Math.floor((reservationExpiresAt!.getTime() + 45 * 60_000) / 1000),
    );
  });
});

describe('the life of a verification link (VERIFY_TTL_MS)', () => {
  it('ends the link of the mail when the setting says, and the mail tells how long it lives', async () => {
    set({ VERIFY_TTL_MS: 2 * 60 * 60_000 });
    const mails = watchMail();
    const email = uniqueEmail('settings');
    const before = Date.now();

    expect((await register(email)).statusCode).toBe(201);

    const { expiresAt } = await verificationRowOf(email);
    expect(expiresAt.getTime()).toBeGreaterThanOrEqual(before + 2 * 60 * 60_000 - 1_000);
    expect(expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 2 * 60 * 60_000 + 1_000);
    expect(mails[0]!.text).toContain('This link is valid for 2 hours.');
  });
});
