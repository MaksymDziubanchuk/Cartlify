import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from '@jest/globals';

import env from '@config/env.js';
import { setAdminContext } from '@db/dbContext.service.js';
import { withdrawalCodeOf } from '@helpers/withdrawalCode.js';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { asAdmin, testTx } from '../../../helpers/db.js';
import {
  closeSessions,
  createProduct,
  createUser,
  removeProducts,
  stockOf,
  type TestProduct,
  type TestUser,
} from '../../../helpers/factories.js';
import { watchMail } from '../../../helpers/mail.js';
import { placeOrderOf } from '../../../helpers/orders.js';
import { moveClock, placePaidOrderOf } from '../../../helpers/payments.js';
import { refundsOf, withStripeOutOfReach } from '../../../helpers/stripe.js';

// the public form of withdrawal, for a buyer with no account to sign in to or without the mail at
// hand: POST /api/withdrawals/route says where the link of a mail leads, POST /api/withdrawals makes
// the statement (with the code of the order from the link it is the one of an account, without it an
// admin checks it by hand), POST /api/withdrawals/proof writes the parcel by the code. No one is
// signed in, and every refusal is the same answer

let app: FastifyInstance;
let csrf: Csrf;
let buyer: TestUser;
const userIds: number[] = [];
const products: TestProduct[] = [];

const FORM_EMAIL = 'anna.form@example.com';

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  buyer = await createUser({ name: 'Anna Koval' });
  userIds.push(buyer.id);
});

afterAll(async () => {
  try {
    await removeProducts(products);
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

let clock: { restore: () => void } | null = null;
const grace = env.WITHDRAWAL_GRACE_DAYS;

afterEach(() => {
  clock?.restore();
  clock = null;
  env.WITHDRAWAL_GRACE_DAYS = grace;
});

const post = (url: string, payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url, headers: withCsrf(csrf), payload });

const route = (payload: Record<string, unknown>) => post('/api/withdrawals/route', payload);
const form = (payload: Record<string, unknown>) => post('/api/withdrawals', payload);
const proof = (payload: Record<string, unknown>) => post('/api/withdrawals/proof', payload);

// the facts of the recipient of the orders of the tests (helpers/orders.ts), which the form without
// the code checks: the name, the phone, the country and the postal code
const FACTS = {
  recipientName: 'Anna Koval',
  phone: '+380501234567',
  country: 'UA',
  postalCode: '01001',
};

const filled = (orderId: number, extra: Record<string, unknown> = {}) => ({
  orderId,
  ...FACTS,
  email: FORM_EMAIL,
  ...extra,
});

const newProduct = async () => {
  const product = await createProduct({ price: 10, stock: 30 });
  products.push(product);
  return product;
};

// an order paid by a card Stripe really took, sent or not
async function order(quantity: number, stage: 'paid' | 'shipped' = 'paid', user: TestUser = buyer) {
  const product = await newProduct();
  const { orderId, paymentId } = await placePaidOrderOf(
    app,
    csrf,
    user,
    [{ item: product, quantity }],
    { stage },
  );
  return { product, orderId, paymentId };
}

const delivered = (orderId: number) =>
  asAdmin(
    (tx) =>
      tx.$executeRaw`update cartlify.orders set status = 'delivered' where id = ${orderId}::int`,
  );

const statementsOf = (orderId: number) =>
  asAdmin((tx) =>
    tx.orderReturn.findMany({
      where: { orderId },
      orderBy: { id: 'asc' },
      select: {
        id: true,
        source: true,
        basis: true,
        contactName: true,
        contactEmail: true,
        proofCarrier: true,
        proofTrackingNumber: true,
        proofTrackingUrl: true,
        closedAt: true,
      },
    }),
  );

const statusOf = async (orderId: number) =>
  (await asAdmin((tx) => tx.order.findUniqueOrThrow({ where: { id: orderId } }))).status;

describe('POST /api/withdrawals/route', () => {
  it('sends the code of an open order of an account that lives to the account', async () => {
    const { orderId } = await order(1);

    const res = await route({ orderId, code: withdrawalCodeOf(orderId) });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ where: 'account' });
  });

  it('sends a delivered order to the account inside its period and to the notice of the end after it', async () => {
    const { orderId } = await order(1, 'shipped');
    await delivered(orderId);
    const code = withdrawalCodeOf(orderId);

    expect((await route({ orderId, code })).json()).toEqual({ where: 'account' });

    clock = moveClock(400 * 86_400_000);
    expect((await route({ orderId, code })).json()).toEqual({ where: 'closed' });
  });

  it('sends the form for a wrong code, no code and an order there is not: the same answer, so nothing tells whether an order exists', async () => {
    const { orderId } = await order(1);

    const answers = [
      await route({ orderId, code: 'AAAA-AAAA-AAAA' }),
      await route({ orderId }),
      await route({ orderId: 2_000_000_000, code: withdrawalCodeOf(2_000_000_000) }),
      await route({ orderId: 2_000_000_000 }),
    ];

    for (const res of answers) {
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ where: 'form' });
    }
  });

  it('sends the form when the account of the order is deleted', async () => {
    const gone = await createUser({ name: 'Anna Koval' });
    userIds.push(gone.id);
    const { orderId } = await order(1, 'paid', gone);

    const deleted = await app.inject({
      method: 'DELETE',
      url: '/api/users/me',
      headers: withCsrf(csrf, accessCookie(gone)),
      payload: { password: gone.password, confirmOpenOrders: true },
    });
    expect(deleted.statusCode).toBe(204);

    const res = await route({ orderId, code: withdrawalCodeOf(orderId) });

    expect(res.json()).toEqual({ where: 'form' });
  });

  it('refuses a body without an order and an order number that is not one', async () => {
    for (const payload of [{}, { orderId: 'x' }, { orderId: 0 }, { orderId: 1.5 }]) {
      const res = await route(payload);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
    }
  });
});

describe('POST /api/withdrawals with the code of the order', () => {
  it('makes the statement of an account for a paid order that was not sent: the goods come back at once, the order is cancelled and the money goes back', async () => {
    const { product, orderId, paymentId } = await order(2);
    const before = await stockOf(product);
    const mails = watchMail();

    const res = await form(
      filled(orderId, { code: withdrawalCodeOf(orderId), description: 'It does not fit.' }),
    );

    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ received: true });

    expect(await statementsOf(orderId)).toEqual([
      expect.objectContaining({
        source: 'form_code',
        basis: 'withdrawal',
        contactName: 'Anna Koval',
        contactEmail: FORM_EMAIL,
        closedAt: expect.any(Date),
      }),
    ]);
    expect(await statusOf(orderId)).toBe('cancelled');
    expect((await stockOf(product)).stock).toBe(before.stock + 2);
    expect(await refundsOf(paymentId)).toEqual([expect.objectContaining({ amount: 2000 })]);

    // the notice, then the money: both to the email of the form, none to the account
    expect(mails.filter((mail) => mail.to.includes(buyer.email))).toHaveLength(0);
    const own = mails.filter((mail) => mail.to.includes(FORM_EMAIL));
    expect(own).toHaveLength(2);
    const notice = own.find((mail) => mail.subject.includes('Withdrawal from order'))!;
    expect(notice.text.startsWith('Hi Anna Koval,')).toBe(true);
    expect(notice.text).toContain('Your order had not been sent, so the goods stay with us.');
    expect(notice.text).not.toContain('See your order');
    expect(own.some((mail) => mail.subject.includes('is closed'))).toBe(true);

    // the log names the buyer of the order: nobody was signed in
    const events = await asAdmin((tx) =>
      tx.adminAuditLog.findMany({
        where: { entityType: 'order', entityId: orderId },
        select: { event: true, actorId: true, actorRole: true },
      }),
    );
    expect(events).toEqual(
      expect.arrayContaining([
        { event: 'return.create', actorId: buyer.id, actorRole: 'USER' },
        { event: 'return.refund', actorId: buyer.id, actorRole: 'USER' },
      ]),
    );
  });

  it('keeps the statement and leaves the money pending when Stripe cannot be reached, the goods are back and the order is cancelled', async () => {
    const { orderId, paymentId } = await order(1);

    const res = await withStripeOutOfReach(() =>
      form(filled(orderId, { code: withdrawalCodeOf(orderId) })),
    );

    expect(res.statusCode).toBe(201);
    expect(await statusOf(orderId)).toBe('cancelled');
    expect(await refundsOf(paymentId)).toEqual([]);
    const [statement] = await statementsOf(orderId);
    const rows = await asAdmin((tx) =>
      tx.orderReturnItem.findMany({
        where: { returnId: statement!.id },
        select: { goods: true, money: true },
      }),
    );
    expect(rows).toEqual([{ goods: 'to_stock', money: 'pending' }]);
  });

  it('takes the units named and leaves the rest of the order as it was', async () => {
    const { product, orderId, paymentId } = await order(3);
    const items = await asAdmin((tx) =>
      tx.orderItem.findMany({ where: { orderId }, select: { id: true } }),
    );
    const before = await stockOf(product);

    const res = await form(
      filled(orderId, {
        code: withdrawalCodeOf(orderId),
        items: [{ orderItemId: items[0]!.id, quantity: 1 }],
      }),
    );

    expect(res.statusCode).toBe(201);
    expect(await statusOf(orderId)).toBe('paid');
    expect((await stockOf(product)).stock).toBe(before.stock + 1);
    expect(await refundsOf(paymentId)).toEqual([expect.objectContaining({ amount: 1000 })]);
  });

  it('opens a statement for a sent order that waits for the parcel, and the mail links the page where the parcel is written', async () => {
    const { product, orderId, paymentId } = await order(1, 'shipped');
    const before = await stockOf(product);
    const mails = watchMail();

    const res = await form(filled(orderId, { code: withdrawalCodeOf(orderId) }));

    expect(res.statusCode).toBe(201);
    const [statement] = await statementsOf(orderId);
    expect(statement).toMatchObject({ source: 'form_code', closedAt: null });
    expect(await statusOf(orderId)).toBe('shipped');
    expect(await stockOf(product)).toEqual(before);
    expect(await refundsOf(paymentId)).toEqual([]);

    const notice = mails.find((mail) => mail.to.includes(FORM_EMAIL))!;
    expect(notice.text).toContain('Please send the goods back to us.');
    expect(notice.text).toContain('write the carrier and the number on the page of the link below');
    const link = notice.text.match(/https?:\/\/\S+/)![0];
    expect(link).toContain(`/orders/${orderId}/withdrawal?return=${statement!.id}#`);
    expect(link.endsWith(`#${withdrawalCodeOf(orderId)}`)).toBe(true);
  });

  it('takes the name of the recipient in either order, in any case and with extra spaces', async () => {
    // one order for each: an order holds one statement made by hand at a time
    for (const recipientName of ['koval anna', '  ANNA   KOVAL ']) {
      const { orderId } = await order(1);
      const res = await form(filled(orderId, { recipientName }));
      expect(res.statusCode).toBe(201);
    }
  });
});

describe('POST /api/withdrawals without the code', () => {
  it('opens a statement for the admin to check by hand: the goods, the stock, the order and the money stay where they were', async () => {
    const { product, orderId, paymentId } = await order(2);
    const before = await stockOf(product);
    const mails = watchMail();

    const res = await form(filled(orderId));

    expect(res.statusCode).toBe(201);
    expect(await statementsOf(orderId)).toEqual([
      expect.objectContaining({ source: 'form_manual', closedAt: null }),
    ]);
    expect(await statusOf(orderId)).toBe('paid');
    expect(await stockOf(product)).toEqual(before);
    expect(await refundsOf(paymentId)).toEqual([]);

    const own = mails.filter((mail) => mail.to.includes(FORM_EMAIL));
    expect(own).toHaveLength(1);
    expect(own[0]!.text).toContain('Our team checks your statement against the order');
    for (const part of ['https://', 'Send them to', 'we stay with us', 'carrier']) {
      expect(own[0]!.text).not.toContain(part);
    }
  });

  // anybody who knows the number and the name of the recipient sends a form without a code: the
  // mail of its end goes to the address they gave, so it names neither the goods of the order nor
  // the account
  it('closes a statement that was not of the buyer with a mail to the form that names no goods and no account', async () => {
    const root = await createUser({ role: 'ROOT' });
    const owner = await createUser({ name: 'Olena Shevchenko' });
    userIds.push(root.id, owner.id);
    const { orderId } = await order(1, 'paid', owner);
    const [item] = await asAdmin((tx) =>
      tx.orderItem.findMany({ where: { orderId }, select: { productName: true } }),
    );
    await form(filled(orderId, { email: 'someone@example.com' }));
    const [statement] = await statementsOf(orderId);
    const mails = watchMail();

    const closed = await app.inject({
      method: 'POST',
      url: `/api/returns/${statement!.id}/close`,
      headers: withCsrf(csrf, accessCookie(root)),
      payload: { code: 'not_buyer', note: 'The buyer did not send it.' },
    });

    expect(closed.statusCode).toBe(200);
    const sent = mails.filter((mail) => mail.to.includes('someone@example.com'));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.subject).toContain('is closed');
    expect(sent[0]!.text).toContain('Hi Anna Koval,');
    expect(sent[0]!.text).toContain('We could not match the statement to your purchase.');
    for (const part of [item!.productName!, 'Olena Shevchenko']) {
      expect(sent[0]!.text).not.toContain(part);
      expect(sent[0]!.html).not.toContain(part);
    }
  });

  it('treats a wrong code as no code', async () => {
    const { orderId } = await order(1);

    const res = await form(filled(orderId, { code: 'AAAA-AAAA-AAAA' }));

    expect(res.statusCode).toBe(201);
    expect(await statementsOf(orderId)).toEqual([
      expect.objectContaining({ source: 'form_manual' }),
    ]);
  });
});

describe('POST /api/withdrawals by hand, which anybody who knows the order and its recipient can send', () => {
  it('takes an empty code, and a right code while the server has no secret, as no code', async () => {
    const empty = await order(2);
    expect((await form(filled(empty.orderId, { code: '' }))).statusCode).toBe(201);
    expect(await statementsOf(empty.orderId)).toEqual([
      expect.objectContaining({ source: 'form_manual' }),
    ]);

    const bare = await order(1);
    const code = withdrawalCodeOf(bare.orderId)!;
    const secret = env.WITHDRAWAL_CODE_SECRET;
    env.WITHDRAWAL_CODE_SECRET = '';
    try {
      expect((await form(filled(bare.orderId, { code }))).statusCode).toBe(201);
    } finally {
      env.WITHDRAWAL_CODE_SECRET = secret;
    }
    expect(await statementsOf(bare.orderId)).toEqual([
      expect.objectContaining({ source: 'form_manual' }),
    ]);
    expect(await statusOf(bare.orderId)).toBe('paid');
    expect(await refundsOf(bare.paymentId)).toEqual([]);
  });

  // the facts matched: the person is told a statement waits for the check (and how to withdraw at
  // once), not refused without a word
  it('opens one statement at a time per order until an admin accepts it (409 WITHDRAWAL_UNDER_REVIEW)', async () => {
    const { orderId } = await order(3);

    expect((await form(filled(orderId, { items: await oneUnit(orderId) }))).statusCode).toBe(201);
    const second = await form(filled(orderId, { items: await oneUnit(orderId) }));

    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ errorCode: 'WITHDRAWAL_UNDER_REVIEW' });
    expect(await statementsOf(orderId)).toHaveLength(1);

    // the buyer's own statement, with the code, is not stopped by it
    const withCode = await form(
      filled(orderId, { code: withdrawalCodeOf(orderId), items: await oneUnit(orderId) }),
    );
    expect(withCode.statusCode).toBe(201);
  });

  it('two at once leave one: the other waits for the lock of the order and sees it', async () => {
    const { orderId } = await order(3);
    const items = await oneUnit(orderId);

    const answers = await Promise.all([
      form(filled(orderId, { items })),
      form(filled(orderId, { items })),
    ]);

    expect(answers.map((res) => res.statusCode).sort()).toEqual([201, 409]);
    expect(await statementsOf(orderId)).toHaveLength(1);
  });

  it('tells the account of the order too, in a mail that names no goods, so the buyer knows of a statement they did not make', async () => {
    const { orderId } = await order(1);
    const mails = watchMail();

    const res = await form(filled(orderId, { recipientName: 'Anna Koval' }));

    expect(res.statusCode).toBe(201);
    const toForm = mails.filter((mail) => mail.to.includes(FORM_EMAIL));
    const toOwner = mails.filter((mail) => mail.to.includes(buyer.email));
    expect(toForm).toHaveLength(1);
    expect(toOwner).toHaveLength(1);

    for (const mail of [toForm[0]!, toOwner[0]!]) {
      expect(mail.text).toContain('If you did not make this statement, write to us.');
      // no line of the goods: the order is not told to whoever sends the form
      expect(mail.text).not.toMatch(/^- .* x \d+/m);
      expect(mail.html).not.toContain('>Qty<');
    }
    expect(toOwner[0]!.text.startsWith('Hi Anna Koval,')).toBe(true);
  });

  it('mails one address once when the form gives the address of the account', async () => {
    const { orderId } = await order(1);
    const mails = watchMail();

    await form(filled(orderId, { email: buyer.email.toUpperCase() }));

    const own = mails.filter((mail) =>
      mail.to.some((to) => to.toLowerCase() === buyer.email.toLowerCase()),
    );
    expect(own).toHaveLength(1);
  });
});

// a statement without the code holds its units only until the buyer states them themselves, from
// the account or with the code: those units leave it (not arrived, the money refused, the code
// stated_again) for the new statement, the rest of it stays open for the admin, and its person is
// told the reason without the units
describe('a statement of the buyer takes over the units of one without the code', () => {
  const rowsOf = (returnId: number) =>
    asAdmin((tx) =>
      tx.orderReturnItem.findMany({
        where: { returnId },
        orderBy: { id: 'asc' },
        select: { quantity: true, goods: true, money: true, refusedCode: true },
      }),
    );

  it('takes all of them with the code and mails the form the change, naming no goods', async () => {
    const { orderId } = await order(3, 'shipped');
    const [item] = await asAdmin((tx) =>
      tx.orderItem.findMany({ where: { orderId }, select: { productName: true } }),
    );
    expect((await form(filled(orderId))).statusCode).toBe(201);
    const [manual] = await statementsOf(orderId);
    const mails = watchMail();

    const res = await form(
      filled(orderId, { code: withdrawalCodeOf(orderId), email: 'own@example.com' }),
    );

    expect(res.statusCode).toBe(201);
    const statements = await statementsOf(orderId);
    // nothing of the statement without the code is left: it is over, closed by its results
    expect(statements).toEqual([
      expect.objectContaining({
        id: manual!.id,
        source: 'form_manual',
        closedAt: expect.any(Date),
      }),
      expect.objectContaining({ source: 'form_code', closedAt: null }),
    ]);
    expect(await rowsOf(manual!.id)).toEqual([
      { quantity: 3, goods: 'not_arrived', money: 'refused', refusedCode: 'stated_again' },
    ]);
    expect(await rowsOf(statements[1]!.id)).toEqual([
      expect.objectContaining({ quantity: 3, goods: 'expected', money: 'not_refunded' }),
    ]);

    const changed = mails.filter(
      (mail) => mail.to.includes(FORM_EMAIL) && mail.subject.includes('changed'),
    );
    expect(changed).toHaveLength(1);
    expect(changed[0]!.subject).toBe(
      `Cartlify — Your statement for order #${orderId} changed (W${orderId}-1)`,
    );
    expect(changed[0]!.text.startsWith('Hi Anna Koval,')).toBe(true);
    expect(changed[0]!.text).toContain('All the goods of your statement are now handled');
    expect(changed[0]!.text).not.toContain('buyer');
    expect(changed[0]!.text).toContain('yours is closed');
    for (const part of [item!.productName!, 'x 3']) {
      expect(changed[0]!.text).not.toContain(part);
      expect(changed[0]!.html).not.toContain(part);
    }

    // the line of the new statement names the statement it took the units from
    const [line] = await asAdmin((tx) =>
      tx.adminAuditLog.findMany({
        where: { entityType: 'order', entityId: orderId, event: 'return.create' },
        orderBy: { id: 'desc' },
        take: 1,
        select: { meta: true },
      }),
    );
    expect(line!.meta).toEqual(
      expect.arrayContaining([{ field: 'takenFrom', old: null, new: [manual!.id] }]),
    );
  });

  it('takes the units the account names and leaves the rest open; the buyer sees them free', async () => {
    const { orderId } = await order(3, 'shipped');
    expect((await form(filled(orderId))).statusCode).toBe(201);
    const [manual] = await statementsOf(orderId);
    const [item] = await asAdmin((tx) =>
      tx.orderItem.findMany({ where: { orderId }, select: { id: true } }),
    );

    // the units of the statement without the code are free to the buyer
    const view = await app.inject({
      method: 'GET',
      url: `/api/orders/${orderId}`,
      headers: { cookie: accessCookie(buyer) },
    });
    expect(view.json().withdrawable).toEqual([{ orderItemId: item!.id, quantity: 3 }]);
    const mails = watchMail();

    const res = await app.inject({
      method: 'POST',
      url: `/api/orders/${orderId}/withdrawal`,
      headers: withCsrf(csrf, accessCookie(buyer)),
      payload: { items: [{ orderItemId: item!.id, quantity: 1 }] },
    });

    expect(res.statusCode).toBe(201);
    expect(await rowsOf(manual!.id)).toEqual([
      { quantity: 2, goods: 'expected', money: 'not_refunded', refusedCode: null },
      { quantity: 1, goods: 'not_arrived', money: 'refused', refusedCode: 'stated_again' },
    ]);
    expect((await statementsOf(orderId))[0]).toMatchObject({ closedAt: null });
    const changed = mails.filter(
      (mail) => mail.to.includes(FORM_EMAIL) && mail.subject.includes('changed'),
    );
    expect(changed).toHaveLength(1);
    expect(changed[0]!.text).toContain('Some of the goods of your statement are now handled');
    expect(changed[0]!.text).toContain('the rest of yours stays as it was');
  });

  // a second statement without the code stays refused: it takes nothing over
  it('does not take units over for another statement without the code', async () => {
    const { orderId } = await order(2, 'shipped');
    expect((await form(filled(orderId))).statusCode).toBe(201);
    const [manual] = await statementsOf(orderId);
    const mails = watchMail();

    const second = await form(filled(orderId));

    expect(second.statusCode).toBe(400);
    expect(await statementsOf(orderId)).toHaveLength(1);
    expect(await rowsOf(manual!.id)).toEqual([
      { quantity: 2, goods: 'expected', money: 'not_refunded', refusedCode: null },
    ]);
    expect(mails.filter((mail) => mail.subject.includes('changed'))).toEqual([]);
  });
});

// an admin accepts a statement without the code as the buyer's: only then it is handled, and the
// form takes another one for the order (the flows in flows/returnForm walk it whole)
describe('POST /api/returns/:returnId/accept', () => {
  const accept = (returnId: number, actor: TestUser | null) =>
    app.inject({
      method: 'POST',
      url: `/api/returns/${returnId}/accept`,
      headers: actor ? withCsrf(csrf, accessCookie(actor)) : withCsrf(csrf),
    });

  it('accepts once, logs it, and answers the card; a buyer (403), a statement of another source or accepted (409) and one there is not (404) are refused', async () => {
    const admin = await createUser({ role: 'ADMIN' });
    userIds.push(admin.id);
    const { orderId } = await order(1, 'shipped');
    expect((await form(filled(orderId))).statusCode).toBe(201);
    const [manual] = await statementsOf(orderId);
    const withCode = await order(1, 'shipped');
    expect(
      (await form(filled(withCode.orderId, { code: withdrawalCodeOf(withCode.orderId) })))
        .statusCode,
    ).toBe(201);
    const [ofCode] = await statementsOf(withCode.orderId);

    const byBuyer = await accept(manual!.id, buyer);
    const first = await accept(manual!.id, admin);
    const twice = await accept(manual!.id, admin);
    const notManual = await accept(ofCode!.id, admin);
    const missing = await accept(2_000_000_000, admin);

    expect(byBuyer.statusCode).toBe(403);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      id: manual!.id,
      acceptedAt: expect.any(String),
      acceptedBy: { id: admin.id },
      history: expect.arrayContaining([expect.objectContaining({ event: 'return.accept' })]),
    });
    expect(twice.statusCode).toBe(409);
    expect(twice.json()).toMatchObject({ errorCode: 'RETURN_ALREADY_ACCEPTED' });
    expect(notManual.statusCode).toBe(409);
    expect(notManual.json()).toMatchObject({ errorCode: 'RETURN_NOT_MANUAL' });
    expect(missing.statusCode).toBe(404);
  });
});

describe('POST /api/withdrawals when the database is busy', () => {
  it('answers 409 RESOURCE_BUSY, not a refusal, when the order stays locked longer than the form waits', async () => {
    const { orderId } = await order(1);

    let res!: Awaited<ReturnType<typeof form>>;
    await testTx(async (tx) => {
      await setAdminContext(tx);
      await tx.$queryRaw`select id from cartlify.orders where id = ${orderId}::int for update`;
      res = await form(filled(orderId));
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ errorCode: 'RESOURCE_BUSY' });
    expect(await statementsOf(orderId)).toEqual([]);
  });

  it('answers the proof the same way', async () => {
    const { orderId } = await order(1, 'shipped');
    expect((await form(filled(orderId, { code: withdrawalCodeOf(orderId) }))).statusCode).toBe(201);
    const [statement] = await statementsOf(orderId);

    let res!: Awaited<ReturnType<typeof proof>>;
    await testTx(async (tx) => {
      await setAdminContext(tx);
      await tx.$queryRaw`select id from cartlify.orders where id = ${orderId}::int for update`;
      res = await proof({
        orderId,
        code: withdrawalCodeOf(orderId),
        returnId: statement!.id,
        carrier: 'DHL',
        trackingNumber: 'JD0146000123',
      });
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ errorCode: 'RESOURCE_BUSY' });
  });
});

// the units a form without the code may name, after every fact of the recipient matches; a fact
// that does not match answers as an order there is not (the flow of the form walks the units)
describe('POST /api/withdrawals/items', () => {
  it('gives the units for the facts of the recipient, and one answer for any fact that does not match', async () => {
    const { orderId } = await order(1, 'shipped');

    const right = await post('/api/withdrawals/items', { orderId, ...FACTS });
    expect(right.statusCode).toBe(200);

    const answers = [];
    for (const wrong of [
      { ...FACTS, recipientName: 'Olena Koval' },
      { ...FACTS, phone: '+380509999999' },
      { ...FACTS, country: 'pl' },
      { ...FACTS, postalCode: '01002' },
      { recipientName: FACTS.recipientName },
    ]) {
      answers.push(await post('/api/withdrawals/items', { orderId, ...wrong }));
    }
    answers.push(await post('/api/withdrawals/items', { orderId: 2_000_000_100, ...FACTS }));

    for (const res of answers) {
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode: 'WITHDRAWAL_REJECTED' });
    }
    expect(new Set(answers.map((res) => res.json().message)).size).toBe(1);
  });
});

describe('POST /api/withdrawals refusals', () => {
  it('gives one answer for an order there is not, a recipient who does not match, a period that is over, an order not paid and units that are not the order', async () => {
    const paid = await order(1);
    const shipped = await order(1, 'shipped');
    await delivered(shipped.orderId);
    const waiting = await placeOrderOf(app, csrf, buyer, [{ item: await newProduct() }], 'waiting');
    // the period of the delivered order is over, the paid ones have none
    env.WITHDRAWAL_GRACE_DAYS = -400;

    const other = await order(1);
    const foreignItem = await asAdmin((tx) =>
      tx.orderItem.findFirstOrThrow({ where: { orderId: other.orderId }, select: { id: true } }),
    );

    const answers = [
      await form(filled(2_000_000_000, { code: withdrawalCodeOf(2_000_000_000) })),
      await form(filled(paid.orderId, { recipientName: 'Anna Petrenko' })),
      await form(
        filled(paid.orderId, {
          code: withdrawalCodeOf(paid.orderId),
          recipientName: 'Anna Petrenko',
        }),
      ),
      await form(filled(shipped.orderId, { code: withdrawalCodeOf(shipped.orderId) })),
      await form(filled(waiting, { code: withdrawalCodeOf(waiting) })),
      await form(
        filled(paid.orderId, {
          code: withdrawalCodeOf(paid.orderId),
          items: [{ orderItemId: foreignItem.id, quantity: 1 }],
        }),
      ),
    ];

    for (const res of answers) {
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode: 'WITHDRAWAL_REJECTED' });
    }
    expect(new Set(answers.map((res) => res.json().message)).size).toBe(1);

    for (const orderId of [paid.orderId, shipped.orderId, waiting, other.orderId]) {
      expect(await statementsOf(orderId)).toEqual([]);
    }
  });

  it('refuses units beyond what the order holds, and a second statement for what the first holds', async () => {
    const { orderId } = await order(2);
    const code = withdrawalCodeOf(orderId);
    const [item] = await asAdmin((tx) =>
      tx.orderItem.findMany({ where: { orderId }, select: { id: true } }),
    );

    const over = await form(
      filled(orderId, { code, items: [{ orderItemId: item!.id, quantity: 3 }] }),
    );
    expect(over.statusCode).toBe(400);
    expect(over.json()).toMatchObject({ errorCode: 'WITHDRAWAL_REJECTED' });

    // no code: the first is accepted by an admin, the second asks for what the first holds
    const admin = await createUser({ role: 'ADMIN' });
    userIds.push(admin.id);
    const first = await form(filled(orderId, { items: [{ orderItemId: item!.id, quantity: 2 }] }));
    expect(first.statusCode).toBe(201);
    const [manual] = await statementsOf(orderId);
    const accepted = await app.inject({
      method: 'POST',
      url: `/api/returns/${manual!.id}/accept`,
      headers: withCsrf(csrf, accessCookie(admin)),
    });
    expect(accepted.statusCode).toBe(200);
    const again = await form(filled(orderId, { items: [{ orderItemId: item!.id, quantity: 1 }] }));
    expect(again.statusCode).toBe(400);
    expect(again.json()).toMatchObject({ errorCode: 'WITHDRAWAL_REJECTED' });
  });

  it('refuses a body without an order, a recipient or an email, with a wrong email and with bad units', async () => {
    const { orderId } = await order(1);

    for (const payload of [
      { recipientName: 'Anna Koval', email: FORM_EMAIL },
      { orderId, email: FORM_EMAIL },
      { orderId, recipientName: 'Anna Koval' },
      { orderId, recipientName: 'Anna Koval', email: 'not-an-email' },
      { orderId, recipientName: 'Anna Koval', email: FORM_EMAIL, items: [] },
      { orderId, recipientName: 'Anna Koval', email: FORM_EMAIL, items: [{ orderItemId: 1 }] },
    ]) {
      const res = await form(payload);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
    }
    expect(await statementsOf(orderId)).toEqual([]);
  });
});

describe('POST /api/withdrawals for an order of a deleted account', () => {
  it('still takes the statement: the money goes back, the answers go to the email of the form', async () => {
    const gone = await createUser({ name: 'Anna Koval' });
    userIds.push(gone.id);
    const { orderId, paymentId } = await order(1, 'paid', gone);
    const deleted = await app.inject({
      method: 'DELETE',
      url: '/api/users/me',
      headers: withCsrf(csrf, accessCookie(gone)),
      payload: { password: gone.password, confirmOpenOrders: true },
    });
    expect(deleted.statusCode).toBe(204);
    const mails = watchMail();

    const res = await form(filled(orderId, { code: withdrawalCodeOf(orderId) }));

    expect(res.statusCode).toBe(201);
    expect(await statusOf(orderId)).toBe('cancelled');
    expect(await refundsOf(paymentId)).toEqual([expect.objectContaining({ amount: 1000 })]);
    expect(mails.filter((mail) => mail.to.includes(FORM_EMAIL))).toHaveLength(2);
    expect(mails.every((mail) => !mail.to.some((to) => to.startsWith('deleted+')))).toBe(true);
  });
});

describe('POST /api/withdrawals/proof', () => {
  const parcel = (orderId: number, returnId: number, extra: Record<string, unknown> = {}) => ({
    orderId,
    code: withdrawalCodeOf(orderId),
    returnId,
    carrier: 'DHL',
    trackingNumber: 'JD0146000123',
    trackingUrl: 'https://track.example.com/JD0146000123',
    ...extra,
  });

  async function sentStatement() {
    const { orderId } = await order(1, 'shipped');
    expect((await form(filled(orderId, { code: withdrawalCodeOf(orderId) }))).statusCode).toBe(201);
    const [statement] = await statementsOf(orderId);
    return { orderId, returnId: statement!.id };
  }

  it('keeps the words of the form and the number of the parcel out of the journal of the admins', async () => {
    const { orderId } = await order(1, 'shipped');
    await form(
      filled(orderId, { code: withdrawalCodeOf(orderId), description: 'Bought it twice.' }),
    );
    const [statement] = await statementsOf(orderId);
    await proof(parcel(orderId, statement!.id, { trackingNumber: 'JD0146000777' }));

    const lines = await asAdmin((tx) =>
      tx.adminAuditLog.findMany({
        where: { entityType: 'order', entityId: orderId },
        select: { event: true, meta: true },
        orderBy: { id: 'asc' },
      }),
    );

    expect(lines.map((line) => line.event)).toEqual(['return.create', 'return.proof_provide']);
    const text = JSON.stringify(lines);
    expect(text).not.toContain('Bought it twice.');
    expect(text).not.toContain('JD0146000777');
    expect(text).not.toContain('track.example.com');
  });

  it('writes the carrier and the number of the parcel by the code, and the log names the buyer', async () => {
    const { orderId, returnId } = await sentStatement();

    const res = await proof(parcel(orderId, returnId));

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true });
    expect((await statementsOf(orderId))[0]).toMatchObject({
      proofCarrier: 'DHL',
      proofTrackingNumber: 'JD0146000123',
      proofTrackingUrl: 'https://track.example.com/JD0146000123',
    });
    const events = await asAdmin((tx) =>
      tx.adminAuditLog.findMany({
        where: { entityType: 'order', entityId: orderId, event: 'return.proof_provide' },
        select: { actorId: true, actorRole: true },
      }),
    );
    expect(events).toEqual([{ actorId: buyer.id, actorRole: 'USER' }]);
  });

  it('writes the parcel again until the shop confirms it', async () => {
    const { orderId, returnId } = await sentStatement();

    expect((await proof(parcel(orderId, returnId))).statusCode).toBe(200);
    expect(
      (await proof(parcel(orderId, returnId, { carrier: 'UPS', trackingNumber: 'X1' }))).statusCode,
    ).toBe(200);
    expect((await statementsOf(orderId))[0]).toMatchObject({
      proofCarrier: 'UPS',
      proofTrackingNumber: 'X1',
    });
  });

  it('gives one answer for a wrong code, a statement there is not or of another order, one made by hand and one that waits for nothing', async () => {
    const { orderId, returnId } = await sentStatement();
    const other = await sentStatement();

    // a statement made without the code: only the admin takes the parcel of it
    const byHand = await order(1, 'shipped');
    expect((await form(filled(byHand.orderId))).statusCode).toBe(201);
    const [manual] = await statementsOf(byHand.orderId);

    // a statement whose goods are in already
    const unsent = await order(1);
    expect(
      (await form(filled(unsent.orderId, { code: withdrawalCodeOf(unsent.orderId) }))).statusCode,
    ).toBe(201);
    const [closed] = await statementsOf(unsent.orderId);

    const answers = [
      await proof(parcel(orderId, returnId, { code: 'AAAA-AAAA-AAAA' })),
      await proof(parcel(orderId, 2_000_000_000)),
      await proof(parcel(orderId, other.returnId)),
      await proof(parcel(2_000_000_000, returnId)),
      await proof(parcel(byHand.orderId, manual!.id)),
      await proof(parcel(unsent.orderId, closed!.id)),
    ];

    for (const res of answers) {
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode: 'WITHDRAWAL_REJECTED' });
    }
    expect(new Set(answers.map((res) => res.json().message)).size).toBe(1);
    expect((await statementsOf(orderId))[0]).toMatchObject({ proofCarrier: null });
    expect((await statementsOf(byHand.orderId))[0]).toMatchObject({ proofCarrier: null });
  });

  it('refuses a body without the parcel, a link that is not https and a code of nothing', async () => {
    const { orderId, returnId } = await sentStatement();

    for (const payload of [
      parcel(orderId, returnId, { carrier: '' }),
      parcel(orderId, returnId, { trackingNumber: undefined }),
      parcel(orderId, returnId, { trackingUrl: 'http://track.example.com/1' }),
      parcel(orderId, returnId, { code: undefined }),
    ]) {
      const res = await proof(payload);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
    }
  });
});

// the one unit of the first line of the order
async function oneUnit(orderId: number) {
  const [item] = await asAdmin((tx) =>
    tx.orderItem.findMany({ where: { orderId }, select: { id: true } }),
  );
  return [{ orderItemId: item!.id, quantity: 1 }];
}
