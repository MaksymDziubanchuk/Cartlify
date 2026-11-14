import type { Prisma } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';

import env from '@config/env.js';
import { shopSettings } from '@config/shopSettings.js';
import { settleRefundsInTransit } from '@routes/api/payments/services/settleRefundsInTransit.service.js';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { asAdmin, inCommittedTx } from '../../../helpers/db.js';
import { newDisputeId, synced, withdrawal } from '../../../helpers/dbMoney.js';
import { takeLogs } from '../../../helpers/logs.js';
import {
  closeSessions,
  createProduct,
  createUser,
  removeProducts,
  stockLogOf,
  stockOf,
  type TestProduct,
  type TestUser,
} from '../../../helpers/factories.js';
import { watchMail } from '../../../helpers/mail.js';
import { deliveryBody } from '../../../helpers/orders.js';
import { placePaidOrderOf } from '../../../helpers/payments.js';
import { refundsOf, withStripeOutOfReach } from '../../../helpers/stripe.js';
import { whileLocked } from '../../../helpers/variants.js';

// the buyer withdraws from the contract from their account: POST /api/orders/:orderId/withdrawal
// makes the statement of withdrawal (the whole of what is left or the units named), for a paid order
// that was not sent the goods come back at once, the order is cancelled when it is all of it and the
// money goes back right away; for a sent order the statement waits for the parcel, which the buyer
// describes with POST /api/orders/:orderId/returns/:returnId/proof. The buyer is mailed the notice
// of it; their order shows the path of the statement and what can still be stated

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
let buyer: TestUser;
let stranger: TestUser;
const userIds: number[] = [];
const products: TestProduct[] = [];

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await createUser({ role: 'ADMIN' });
  buyer = await createUser({ name: 'Anna Koval' });
  stranger = await createUser();
  userIds.push(admin.id, buyer.id, stranger.id);
});

afterAll(async () => {
  try {
    await removeProducts(products);
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

const post = (url: string, payload: Record<string, unknown>, actor: TestUser | null = buyer) =>
  app.inject({
    method: 'POST',
    url,
    headers: actor ? withCsrf(csrf, accessCookie(actor)) : withCsrf(csrf),
    payload,
  });

const withdraw = (orderId: number, payload: Record<string, unknown> = {}, actor = buyer) =>
  post(`/api/orders/${orderId}/withdrawal`, payload, actor);

const proof = (
  orderId: number,
  returnId: number,
  payload: Record<string, unknown> = { carrier: 'DHL', trackingNumber: 'JD0146000123' },
  actor: TestUser | null = buyer,
) => post(`/api/orders/${orderId}/returns/${returnId}/proof`, payload, actor);

const newProduct = async (opts: Parameters<typeof createProduct>[0] = {}) => {
  const product = await createProduct({ price: 10, stock: 30, ...opts });
  products.push(product);
  return product;
};

// an order paid by a card Stripe really took, with the lines given, sent or not
async function order(
  lines: Array<{ item: TestProduct; quantity: number }>,
  stage: 'paid' | 'shipped' = 'paid',
  owner: TestUser = buyer,
) {
  const { orderId, paymentId } = await placePaidOrderOf(app, csrf, owner, lines, { stage });
  const items = await asAdmin((tx) =>
    tx.orderItem.findMany({ where: { orderId }, orderBy: { id: 'asc' }, select: { id: true } }),
  );
  return { orderId, paymentId, itemIds: items.map((item) => item.id) };
}

const read = async (orderId: number, actor = buyer) =>
  (
    await app.inject({
      method: 'GET',
      url: `/api/orders/${orderId}`,
      headers: { cookie: accessCookie(actor) },
    })
  ).json();

describe('POST /api/orders/:orderId/withdrawal for a paid order that was not sent', () => {
  // the language of the buyer's account (mailLocaleOf): the notice and the money alike
  it("mails the notice and the money in the language of the buyer's account", async () => {
    const owner = await createUser({ name: 'Ana', locale: 'es' });
    userIds.push(owner.id);
    const product = await newProduct();
    const { orderId } = await order([{ item: product, quantity: 1 }], 'paid', owner);
    const mails = watchMail();

    const res = await withdraw(orderId, {}, owner);

    expect(res.statusCode).toBe(201);
    const own = mails.filter((mail) => mail.to.includes(owner.email));
    expect(own.map((mail) => mail.subject)).toEqual(
      expect.arrayContaining([
        expect.stringContaining(`Cartlify — Desistimiento del pedido #${orderId} registrado`),
        expect.stringContaining(`Cartlify — Se cerró la devolución del pedido #${orderId}`),
      ]),
    );
    expect(own.every((mail) => mail.text.includes('Hola, Ana:'))).toBe(true);
  });

  it('takes the goods back at once, cancels the order and gives all the money back, mailing the notice and the money', async () => {
    const product = await newProduct();
    const { orderId, paymentId } = await order([{ item: product, quantity: 2 }]);
    const before = await stockOf(product);
    const mails = watchMail();

    const res = await withdraw(orderId, { description: 'It does not fit.' });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({
      status: 'cancelled',
      returnStatus: 'full',
      withdrawalOpen: false,
      withdrawable: [],
      withdrawals: [
        expect.objectContaining({
          source: 'account',
          basis: 'withdrawal',
          reason: null,
          step: 'closed',
          parcels: [],
          items: [
            expect.objectContaining({
              quantity: 2,
              amount: 20,
              money: 'refunded',
              refusal: null,
            }),
          ],
          // the money of the statement: one transfer of the goods, sent; no delivery of a pickup
          refundedTotal: 20,
          refunds: [
            expect.objectContaining({
              way: 'payment',
              state: 'sent',
              goods: 20,
              delivery: 0,
              deduction: 0,
              amount: 20,
            }),
          ],
        }),
      ],
    });
    expect((await stockOf(product)).stock).toBe(before.stock + 2);
    expect(await refundsOf(paymentId)).toEqual([expect.objectContaining({ amount: 2000 })]);

    // the notice first, then the money: two mails
    const own = mails.filter((mail) => mail.to.includes(buyer.email));
    expect(own).toHaveLength(2);
    const notice = own.find((mail) => mail.subject.includes('Withdrawal from order'))!;
    expect(notice.text).toContain('Your order had not been sent, so the goods stay with us.');
    expect(notice.text).toContain(shopSettings().emailReplyTo);
    expect(own.some((mail) => mail.subject.includes('is closed'))).toBe(true);

    // the log names the buyer for the statement; the money the system sent for it, in the name of
    // the shop, is the money journal only
    const events = await asAdmin((tx) =>
      tx.adminAuditLog.findMany({
        where: { entityType: 'order', entityId: orderId },
        select: { event: true, actorId: true, actorRole: true },
        orderBy: { id: 'asc' },
      }),
    );
    expect(events).toEqual([{ event: 'return.create', actorId: buyer.id, actorRole: 'USER' }]);
    const money = await asAdmin((tx) =>
      tx.moneyLog.findMany({
        where: { orderId, event: 'money.refund' },
        select: { purpose: true, part: true, state: true, actorId: true },
      }),
    );
    expect(money).toEqual([{ purpose: 'return', part: 'goods', state: 'sent', actorId: null }]);
    expect(
      (await stockLogOf({ orderId })).filter((line) => line.event === 'stock.return'),
    ).toHaveLength(1);
  });

  it('takes the whole order when the request comes without a body', async () => {
    const product = await newProduct();
    const { orderId } = await order([{ item: product, quantity: 1 }]);

    const res = await app.inject({
      method: 'POST',
      url: `/api/orders/${orderId}/withdrawal`,
      headers: withCsrf(csrf, accessCookie(buyer)),
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ status: 'cancelled', returnStatus: 'full' });
  });

  it('leaves the money pending when Stripe cannot be reached, with the goods back and the order cancelled; the worker finishes it', async () => {
    const product = await newProduct();
    const { orderId, paymentId } = await order([{ item: product, quantity: 1 }]);

    const res = await withStripeOutOfReach(() => withdraw(orderId));

    expect(res.statusCode).toBe(201);
    const statement = res.json().withdrawals[0];
    expect(res.json()).toMatchObject({ status: 'cancelled', returnStatus: 'open' });
    expect(statement.step).toBe('received');
    expect(statement.items[0]).toMatchObject({ money: 'pending' });
    expect(await refundsOf(paymentId)).toEqual([]);

    // the worker asks again with the same key and the one refund is made
    const settled = await settleRefundsInTransit(
      {
        info: jest.fn<(obj: unknown, msg?: string) => void>(),
        warn: jest.fn<(obj: unknown, msg?: string) => void>(),
        error: jest.fn<(obj: unknown, msg?: string) => void>(),
      },
      { olderThanMs: 0, returnId: statement.id },
    );

    expect(settled).toBe(1);
    expect(await refundsOf(paymentId)).toEqual([expect.objectContaining({ amount: 1000 })]);
    expect((await read(orderId)).returnStatus).toBe('full');
  });

  // the bank has a dispute of the payment open: no transfer goes (the bank gives the money back);
  // the statement stands, the goods are back, the refusal is in the log for the admin
  it('keeps the statement and starts no transfer while a dispute of the payment is open', async () => {
    const product = await newProduct();
    const { orderId, paymentId } = await order([{ item: product, quantity: 1 }]);
    await inCommittedTx((db) =>
      synced(db, {
        stripeId: newDisputeId(),
        paymentId,
        status: 'needs_response',
        transactions: [withdrawal(10)],
      }),
    );

    const res = await withdraw(orderId);

    expect(res.statusCode).toBe(201);
    expect(res.json().withdrawals[0].items[0]).toMatchObject({ money: 'not_refunded' });
    expect(await refundsOf(paymentId)).toEqual([]);
    expect(takeLogs({ msg: 'return refund was not started' })).toEqual([
      expect.objectContaining({
        code: 'RETURN_REFUND_DISPUTED',
        returnId: res.json().withdrawals[0].id,
      }),
    ]);
  });

  it('lets one of two identical requests at once win (409 for the other) and gives the money back once', async () => {
    const product = await newProduct();
    const { orderId, paymentId, itemIds } = await order([{ item: product, quantity: 1 }]);
    const body = { items: [{ orderItemId: itemIds[0]!, quantity: 1 }] };

    const results = await whileLocked(
      async (tx: Prisma.TransactionClient) => {
        await tx.$queryRaw`select id from cartlify.orders where id = ${orderId}::int for update`;
      },
      () => Promise.all([withdraw(orderId, body), withdraw(orderId, body)]),
      { waiters: 2 },
    );

    expect(results.map((res) => res.statusCode).sort()).toEqual([201, 409]);
    expect(results.find((res) => res.statusCode === 409)!.json()).toMatchObject({
      errorCode: expect.stringMatching(/^RETURN_(QUANTITY_EXCEEDED|ORDER_NOT_RETURNABLE)$/),
    });
    expect(await refundsOf(paymentId)).toHaveLength(1);
  });

  it('lets one win when the admin sends the order at the same moment: the goods come back, or the statement waits for the parcel', async () => {
    const product = await newProduct();
    const { orderId, paymentId } = await order([{ item: product, quantity: 1 }]);
    const before = await stockOf(product);

    const [statement, ship] = await whileLocked(
      async (tx: Prisma.TransactionClient) => {
        await tx.$queryRaw`select id from cartlify.orders where id = ${orderId}::int for update`;
      },
      () =>
        Promise.all([
          withdraw(orderId),
          app.inject({
            method: 'PATCH',
            url: `/api/orders/${orderId}/status`,
            headers: withCsrf(csrf, accessCookie(admin)),
            payload: { status: 'shipped' },
          }),
        ]),
      { waiters: 2 },
    );

    const read1 = await read(orderId);
    if (ship!.statusCode === 200) {
      // sent first: the statement waits for the parcel, no goods and no money moved
      expect(statement!.statusCode).toBe(201);
      expect(read1.status).toBe('shipped');
      expect(read1.withdrawals[0].step).toBe('received');
      expect((await stockOf(product)).stock).toBe(before.stock);
      expect(await refundsOf(paymentId)).toEqual([]);
    } else {
      // the statement first: the goods are back, the order is cancelled and cannot be sent
      expect(statement!.statusCode).toBe(201);
      expect(ship!.statusCode).toBe(409);
      expect(read1.status).toBe('cancelled');
      expect((await stockOf(product)).stock).toBe(before.stock + 1);
      expect(await refundsOf(paymentId)).toHaveLength(1);
    }
  });

  it('withdraws from the units named only: the order stays paid, the rest can still be stated', async () => {
    const product = await newProduct();
    const { orderId, paymentId, itemIds } = await order([{ item: product, quantity: 3 }]);

    const res = await withdraw(orderId, { items: [{ orderItemId: itemIds[0]!, quantity: 1 }] });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      status: 'paid',
      returnStatus: 'partial',
      withdrawable: [{ orderItemId: itemIds[0], quantity: 2 }],
    });
    expect(await refundsOf(paymentId)).toEqual([expect.objectContaining({ amount: 1000 })]);
  });

  // the admin who sends the order sees at once that a unit came back before the sending (6.3, 6.4)
  it('shows the admin what the statement did to each item and the money, and marks the order when it is sent', async () => {
    const product = await newProduct();
    const { orderId, itemIds } = await order([{ item: product, quantity: 3 }]);
    await withdraw(orderId, { items: [{ orderItemId: itemIds[0]!, quantity: 1 }] });

    const card = await app.inject({
      method: 'GET',
      url: `/api/orders/${orderId}`,
      headers: { cookie: accessCookie(admin) },
    });
    const mails = watchMail();
    const bulk = await post(
      '/api/orders/status',
      { status: 'shipped', orders: [{ orderId, shipment: { carrier: 'DHL' } }] },
      admin,
    );
    const own = await read(orderId);

    expect(card.statusCode).toBe(200);
    expect(card.json().returnUnits).toEqual({
      // two of the three units are left to pack
      items: [
        {
          orderItemId: itemIds[0],
          quantity: 3,
          refunded: 1,
          refused: 0,
          waiting: 0,
          withShop: 1,
          toShip: 2,
        },
      ],
      refundedTotal: 10,
      netTotal: 20,
    });
    expect(bulk.statusCode).toBe(200);
    expect(bulk.json().results).toEqual([
      { orderId, ok: true, status: 'shipped', returnStatus: 'partial' },
    ]);
    // the buyer has their own view of the statements
    expect(own.returnUnits).toBeUndefined();
    // the mail of the sending names what travels: the unit withdrawn before stays with the shop (7.2)
    const shipped = mails.find(
      (mail) => mail.to.includes(buyer.email) && mail.subject.includes('is shipped'),
    )!;
    expect(shipped.text).toMatch(/ x 2 = €20\.00/);
    expect(shipped.text).not.toMatch(/ x 3 /);
    expect(shipped.text).toContain('Total: €20.00');
  });

  it('takes whatever is left when no units are named, and skips the items that have no right of withdrawal', async () => {
    const plain = await newProduct();
    const fresh = await newProduct({ withdrawal: 'perishable' });
    const { orderId, itemIds } = await order([
      { item: plain, quantity: 1 },
      { item: fresh, quantity: 1 },
    ]);

    const res = await withdraw(orderId);

    expect(res.statusCode).toBe(201);
    const body = res.json();
    // only the plain item went; the perishable one stays bought and the order stays paid
    expect(
      body.withdrawals[0].items.map((row: { orderItemId: number }) => row.orderItemId),
    ).toEqual([itemIds[0]]);
    expect(body.status).toBe('paid');
    expect(body.withdrawable).toEqual([]);
  });
});

// a pickup that is ready is sent for the order, yet its goods are still on the shelf of the shop
describe('POST /api/orders/:orderId/withdrawal for a pickup that is ready and not collected', () => {
  const { address: _address, ...person } = deliveryBody;

  async function readyPickup(lines: Array<{ item: TestProduct; quantity: number }>) {
    const { orderId, paymentId } = await placePaidOrderOf(app, csrf, buyer, lines, {
      stage: 'shipped',
      delivery: { ...person, method: 'pickup' },
    });
    const items = await asAdmin((tx) =>
      tx.orderItem.findMany({ where: { orderId }, orderBy: { id: 'asc' }, select: { id: true } }),
    );
    return { orderId, paymentId, itemIds: items.map((item) => item.id) };
  }

  it('takes the goods back at once, cancels the order and gives all the money back, as before a sending', async () => {
    const product = await newProduct();
    const { orderId, paymentId } = await readyPickup([{ item: product, quantity: 2 }]);
    const before = await stockOf(product);
    const mails = watchMail();

    const res = await withdraw(orderId);

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      status: 'cancelled',
      returnStatus: 'full',
      withdrawals: [
        expect.objectContaining({
          step: 'closed',
          items: [expect.objectContaining({ quantity: 2, money: 'refunded' })],
        }),
      ],
    });
    expect((await stockOf(product)).stock).toBe(before.stock + 2);
    expect(await refundsOf(paymentId)).toEqual([expect.objectContaining({ amount: 2000 })]);
    const notice = mails.find(
      (mail) => mail.to.includes(buyer.email) && mail.subject.includes('Withdrawal from order'),
    )!;
    expect(notice.text).toContain('Your order had not been sent, so the goods stay with us.');
  });

  it('keeps the pickup ready with the rest when a part is withdrawn', async () => {
    const first = await newProduct();
    const second = await newProduct();
    const { orderId, itemIds } = await readyPickup([
      { item: first, quantity: 1 },
      { item: second, quantity: 1 },
    ]);
    const before = await stockOf(first);

    const res = await withdraw(orderId, { items: [{ orderItemId: itemIds[0], quantity: 1 }] });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ status: 'shipped', returnStatus: 'partial' });
    expect((await stockOf(first)).stock).toBe(before.stock + 1);
  });

  it('is cancelled by the shop as a paid order that was not sent', async () => {
    const product = await newProduct();
    const { orderId, paymentId, itemIds } = await readyPickup([{ item: product, quantity: 1 }]);

    const res = await post(
      '/api/returns',
      {
        orderId,
        items: [{ orderItemId: itemIds[0], quantity: 1 }],
        basis: 'other',
        reason: 'shop_cancel',
      },
      admin,
    );

    expect(res.statusCode).toBe(201);
    expect(res.json().order).toMatchObject({ status: 'cancelled' });
    expect(await refundsOf(paymentId)).toEqual([expect.objectContaining({ amount: 1000 })]);
  });
});

describe('POST /api/orders/:orderId/withdrawal for a sent order', () => {
  it('waits for the parcel: no stock, no money, and the notice says where to send it, by when and who pays', async () => {
    const product = await newProduct();
    const { orderId, paymentId, itemIds } = await order(
      [{ item: product, quantity: 2 }],
      'shipped',
    );
    const before = await stockOf(product);
    const mails = watchMail();

    const res = await withdraw(orderId, { items: [{ orderItemId: itemIds[0]!, quantity: 1 }] });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      status: 'shipped',
      returnStatus: 'open',
      withdrawable: [{ orderItemId: itemIds[0], quantity: 1 }],
      withdrawals: [
        expect.objectContaining({
          step: 'received',
          parcels: [],
          closedAt: null,
          items: [expect.objectContaining({ quantity: 1, money: 'not_refunded', refusal: null })],
        }),
      ],
    });
    expect((await stockOf(product)).stock).toBe(before.stock);
    expect(await refundsOf(paymentId)).toEqual([]);

    const own = mails.filter((mail) => mail.to.includes(buyer.email));
    expect(own).toHaveLength(1);
    expect(own[0]!.text).toContain('Please send the goods back to us.');
    expect(own[0]!.text).toContain('Send them back by');
    expect(own[0]!.text).toContain('write the carrier and the number in your order');
  });

  it('shows the buyer the path of the statement and not what became of the goods or who handled it', async () => {
    const product = await newProduct();
    const { orderId } = await order([{ item: product, quantity: 1 }], 'shipped');
    const made = await withdraw(orderId);

    const statement = made.json().withdrawals[0];

    expect(Object.keys(statement).sort()).toEqual(
      [
        'basis',
        'closedAt',
        'code',
        'id',
        'items',
        'parcels',
        'reason',
        'refundedTotal',
        'refunds',
        'source',
        'statedAt',
        'step',
      ].sort(),
    );
    expect(Object.keys(statement.items[0]).sort()).toEqual(
      ['amount', 'id', 'money', 'orderItemId', 'quantity', 'refundedAt', 'refusal'].sort(),
    );
    // an admin's view of the same order has no buyer path
    const admins = await app.inject({
      method: 'GET',
      url: `/api/orders/${orderId}`,
      headers: { cookie: accessCookie(admin) },
    });
    expect(admins.json().withdrawals).toBeUndefined();
    expect(admins.json().returns).toHaveLength(1);
  });

  // the journal of the admins is never cleaned: the words of the buyer and their parcel stay on
  // the statement, which is cleaned after its term
  it('keeps the words of the buyer and the number of the parcel out of the journal of the admins', async () => {
    const product = await newProduct();
    const { orderId } = await order([{ item: product, quantity: 1 }], 'shipped');
    const returnId: number = (
      await withdraw(orderId, { description: 'It does not fit my sister.' })
    ).json().withdrawals[0].id;
    await proof(orderId, returnId, {
      carrier: 'DHL',
      trackingNumber: 'JD0146000999',
      trackingUrl: 'https://track.example.com/JD0146000999',
    });

    const lines = await asAdmin((tx) =>
      tx.adminAuditLog.findMany({
        where: { entityType: 'order', entityId: orderId },
        select: { event: true, meta: true },
        orderBy: { id: 'asc' },
      }),
    );

    expect(lines.map((line) => line.event)).toEqual(['return.create', 'return.proof_provide']);
    const text = JSON.stringify(lines);
    expect(text).not.toContain('It does not fit my sister.');
    expect(text).not.toContain('JD0146000999');
    expect(lines[0]!.meta).toEqual(
      expect.arrayContaining([{ field: 'described', old: null, new: true }]),
    );
    expect(lines[1]!.meta).toEqual([
      { field: 'returnId', old: null, new: returnId },
      { field: 'proof', old: null, new: { carrier: 'DHL' } },
    ]);
  });

  it('records the proof of the parcel, lets the buyer correct it, and stops when the shop confirms it', async () => {
    const product = await newProduct();
    const { orderId } = await order([{ item: product, quantity: 1 }], 'shipped');
    const returnId: number = (await withdraw(orderId)).json().withdrawals[0].id;

    const first = await proof(orderId, returnId);
    const second = await proof(orderId, returnId, {
      carrier: 'UPS',
      trackingNumber: '1Z999AA10123456784',
      trackingUrl: 'https://track.example.com/1Z999AA10123456784',
    });
    const confirm = await post(`/api/returns/${returnId}/proof/confirm`, { buyerPaid: 0 }, admin);
    const after = await read(orderId);
    const late = await proof(orderId, returnId);

    expect(first.statusCode).toBe(200);
    expect(first.json().withdrawals[0]).toMatchObject({
      step: 'proof_provided',
      parcels: [
        {
          direction: 'to_shop',
          carrier: 'DHL',
          trackingNumber: 'JD0146000123',
          trackingUrl: null,
          shippedAt: expect.any(String),
          confirmed: false,
          buyerPaid: null,
        },
      ],
    });
    expect(second.json().withdrawals[0].parcels).toEqual([
      expect.objectContaining({
        carrier: 'UPS',
        trackingUrl: 'https://track.example.com/1Z999AA10123456784',
      }),
    ]);
    expect(confirm.statusCode).toBe(200);
    expect(after.withdrawals[0]).toMatchObject({ step: 'proof_confirmed' });
    expect(after.withdrawals[0].parcels[0].confirmed).toBe(true);
    expect(late.statusCode).toBe(409);
    expect(late.json()).toMatchObject({ errorCode: 'RETURN_PROOF_ALREADY_CONFIRMED' });
  });

  // the shop sent a label and wrote the parcel with what it cost: it is the shop's to change
  it('leaves the parcel an admin recorded as it is (409 RETURN_PARCEL_EXISTS)', async () => {
    const product = await newProduct();
    const { orderId } = await order([{ item: product, quantity: 1 }], 'shipped');
    const returnId: number = (await withdraw(orderId)).json().withdrawals[0].id;
    const { paidAt } = await asAdmin((tx) =>
      tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { paidAt: true } }),
    );
    const recorded = await post(
      `/api/returns/${returnId}/shipments`,
      {
        direction: 'to_shop',
        carrier: 'GLS',
        trackingNumber: 'SHOP-0001',
        shippedAt: new Date(paidAt!.getTime() + 1).toISOString(),
        cost: 4,
      },
      admin,
    );
    expect(recorded.statusCode).toBe(201);

    const res = await proof(orderId, returnId);

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ errorCode: 'RETURN_PARCEL_EXISTS' });
    expect((await read(orderId)).withdrawals[0].parcels).toEqual([
      expect.objectContaining({
        direction: 'to_shop',
        carrier: 'GLS',
        trackingNumber: 'SHOP-0001',
      }),
    ]);
  });

  it('shows the admin the proof the buyer wrote, to check before confirming it', async () => {
    const product = await newProduct();
    const { orderId } = await order([{ item: product, quantity: 1 }], 'shipped');
    const returnId: number = (await withdraw(orderId)).json().withdrawals[0].id;
    await proof(orderId, returnId, {
      carrier: 'DHL',
      trackingNumber: 'JD0146000123',
      trackingUrl: 'https://track.example.com/JD0146000123',
    });

    const card = await app.inject({
      method: 'GET',
      url: `/api/returns/${returnId}`,
      headers: { cookie: accessCookie(admin) },
    });

    expect(card.statusCode).toBe(200);
    expect(card.json().parcels).toEqual([
      expect.objectContaining({
        direction: 'to_shop',
        shippedAt: expect.any(String),
        carrier: 'DHL',
        trackingNumber: 'JD0146000123',
        trackingUrl: 'https://track.example.com/JD0146000123',
        recordedBy: expect.objectContaining({ email: expect.any(String) }),
        confirmedAt: null,
      }),
    ]);
  });

  it('shows the buyer what they paid the carrier, which the shop replaces from the receipt when it confirms the parcel', async () => {
    const product = await newProduct();
    const { orderId } = await order([{ item: product, quantity: 1 }], 'shipped');
    const returnId: number = (await withdraw(orderId)).json().withdrawals[0].id;

    const told = await proof(orderId, returnId, {
      carrier: 'DHL',
      trackingNumber: 'JD0146000123',
      buyerPaid: 7.25,
    });
    const confirm = await post(`/api/returns/${returnId}/proof/confirm`, { buyerPaid: 6 }, admin);
    const after = await read(orderId);

    expect(told.statusCode).toBe(200);
    expect(told.json().withdrawals[0].parcels).toEqual([
      expect.objectContaining({ buyerPaid: 7.25, confirmed: false }),
    ]);
    expect(confirm.statusCode).toBe(200);
    expect(confirm.json().parcels).toEqual([
      expect.objectContaining({ direction: 'to_shop', buyerPaid: 6, carrier: 'DHL' }),
    ]);
    expect(after.withdrawals[0].parcels).toEqual([
      expect.objectContaining({ buyerPaid: 6, confirmed: true }),
    ]);
  });

  it('names the units the parcel carries: the rest goes into a statement of its own, whose code the buyer is mailed', async () => {
    const product = await newProduct();
    const { orderId } = await order([{ item: product, quantity: 3 }], 'shipped');
    const made = (await withdraw(orderId)).json().withdrawals[0];
    const mails = watchMail();

    const res = await proof(orderId, made.id, {
      carrier: 'DHL',
      trackingNumber: 'JD0146000123',
      items: [{ itemId: made.items[0].id, quantity: 1 }],
    });

    expect(res.statusCode).toBe(200);
    const [first, second] = res.json().withdrawals;
    expect(first).toMatchObject({
      id: made.id,
      step: 'proof_provided',
      items: [expect.objectContaining({ id: made.items[0].id, quantity: 1 })],
    });
    expect(second).toMatchObject({
      code: `W${orderId}-2`,
      parcels: [],
      items: [expect.objectContaining({ quantity: 2 })],
    });
    const own = mails.filter(
      (mail) =>
        mail.to.includes(buyer.email) &&
        mail.subject.includes(`A statement of its own for goods of order #${orderId}`),
    );
    expect(own).toHaveLength(1);
    expect(own[0]!.subject.endsWith(`(W${orderId}-2)`)).toBe(true);
    expect(own[0]!.text).toContain(`not in the parcel of statement ${made.code}`);
  });

  it('names only rows of the statement whose goods wait (404 RETURN_ITEM_NOT_FOUND, 409 RETURN_QUANTITY_EXCEEDED)', async () => {
    const product = await newProduct();
    const { orderId } = await order([{ item: product, quantity: 2 }], 'shipped');
    const made = (await withdraw(orderId)).json().withdrawals[0];

    const foreign = await proof(orderId, made.id, {
      carrier: 'DHL',
      trackingNumber: 'JD0146000123',
      items: [{ itemId: 2_000_000_000, quantity: 1 }],
    });
    const exceeded = await proof(orderId, made.id, {
      carrier: 'DHL',
      trackingNumber: 'JD0146000123',
      items: [{ itemId: made.items[0].id, quantity: 3 }],
    });

    expect(foreign.statusCode).toBe(404);
    expect(foreign.json()).toMatchObject({ errorCode: 'RETURN_ITEM_NOT_FOUND' });
    expect(exceeded.statusCode).toBe(409);
    expect(exceeded.json()).toMatchObject({ errorCode: 'RETURN_QUANTITY_EXCEEDED' });
  });

  it('refuses a sum paid that is not money (400 VALIDATION_ERROR)', async () => {
    const product = await newProduct();
    const { orderId } = await order([{ item: product, quantity: 1 }], 'shipped');
    const returnId: number = (await withdraw(orderId)).json().withdrawals[0].id;

    const res = await proof(orderId, returnId, {
      carrier: 'DHL',
      trackingNumber: 'JD0146000123',
      buyerPaid: 1.005,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
  });

  it('takes the rest of a sent order in a second statement, and shows nothing left to state', async () => {
    const product = await newProduct();
    const { orderId, itemIds } = await order([{ item: product, quantity: 2 }], 'shipped');
    await withdraw(orderId, { items: [{ orderItemId: itemIds[0]!, quantity: 1 }] });

    const second = await withdraw(orderId);

    expect(second.statusCode).toBe(201);
    const body = second.json();
    expect(body.withdrawals).toHaveLength(2);
    expect(body.withdrawals[1].items).toEqual([expect.objectContaining({ quantity: 1 })]);
    expect(body.withdrawable).toEqual([]);
  });

  it.each([
    ['no number', { carrier: 'DHL' }, 400, 'VALIDATION_ERROR'],
    ['an empty carrier', { carrier: '   ', trackingNumber: '77' }, 400, 'RETURN_PROOF_INVALID'],
    [
      'a link that is not https',
      { carrier: 'DHL', trackingNumber: '77', trackingUrl: 'http://track.example.com/77' },
      400,
      'VALIDATION_ERROR',
    ],
  ])('refuses a proof with %s', async (_what, body, status, code) => {
    const product = await newProduct();
    const { orderId } = await order([{ item: product, quantity: 1 }], 'shipped');
    const returnId: number = (await withdraw(orderId)).json().withdrawals[0].id;

    const res = await proof(orderId, returnId, body);

    expect({ status: res.statusCode, code: res.json().errorCode }).toEqual({ status, code });
  });

  it('has no proof to write for a statement whose goods are in already (409 RETURN_NOTHING_WAITING) or that is closed (409 RETURN_ALREADY_CLOSED)', async () => {
    const product = await newProduct();
    const { orderId, itemIds } = await order([{ item: product, quantity: 3 }]);
    // Stripe cannot be reached: the goods are in and the money is on its way, the statement is open
    const open: number = (
      await withStripeOutOfReach(() =>
        withdraw(orderId, { items: [{ orderItemId: itemIds[0]!, quantity: 1 }] }),
      )
    ).json().withdrawals[0].id;
    // the money went back at once: the statement is closed
    const closed: number = (
      await withdraw(orderId, { items: [{ orderItemId: itemIds[0]!, quantity: 1 }] })
    ).json().withdrawals[1].id;

    const nothing = await proof(orderId, open);
    const over = await proof(orderId, closed);

    expect([nothing.statusCode, nothing.json().errorCode]).toEqual([409, 'RETURN_NOTHING_WAITING']);
    expect([over.statusCode, over.json().errorCode]).toEqual([409, 'RETURN_ALREADY_CLOSED']);
  });

  it('keeps the proof for the buyer who made the statement: another buyer finds none (404)', async () => {
    const product = await newProduct();
    const { orderId } = await order([{ item: product, quantity: 1 }], 'shipped');
    const returnId: number = (await withdraw(orderId)).json().withdrawals[0].id;

    const res = await proof(orderId, returnId, undefined, stranger);

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ errorCode: 'RETURN_NOT_FOUND' });
  });
});

describe('who may withdraw, and what', () => {
  it('is the buyer of the order: another buyer finds no order (404), an admin and a visitor are refused (403)', async () => {
    const product = await newProduct();
    const { orderId } = await order([{ item: product, quantity: 1 }]);

    const byStranger = await withdraw(orderId, {}, stranger);
    const byAdmin = await withdraw(orderId, {}, admin);
    const byGuest = await post(`/api/orders/${orderId}/withdrawal`, {}, null);

    expect(byStranger.statusCode).toBe(404);
    expect(byStranger.json()).toMatchObject({ errorCode: 'ORDER_NOT_FOUND' });
    expect(byAdmin.statusCode).toBe(403);
    expect(byGuest.statusCode).toBe(403);
  });

  it.each([
    [
      'an item that has no right of withdrawal (409 RETURN_ITEM_NOT_RETURNABLE)',
      async () => {
        const fresh = await newProduct({ withdrawal: 'perishable' });
        const { orderId, itemIds } = await order([{ item: fresh, quantity: 1 }]);
        return [orderId, { items: [{ orderItemId: itemIds[0]!, quantity: 1 }] }] as const;
      },
      409,
      'RETURN_ITEM_NOT_RETURNABLE',
    ],
    [
      'more units than were bought (409 RETURN_QUANTITY_EXCEEDED)',
      async () => {
        const product = await newProduct();
        const { orderId, itemIds } = await order([{ item: product, quantity: 1 }]);
        return [orderId, { items: [{ orderItemId: itemIds[0]!, quantity: 5 }] }] as const;
      },
      409,
      'RETURN_QUANTITY_EXCEEDED',
    ],
    [
      'an item that is not one of the order (404 RETURN_ITEM_NOT_FOUND)',
      async () => {
        const product = await newProduct();
        const { orderId } = await order([{ item: product, quantity: 1 }]);
        return [orderId, { items: [{ orderItemId: 2_000_000_000, quantity: 1 }] }] as const;
      },
      404,
      'RETURN_ITEM_NOT_FOUND',
    ],
    [
      'an item named twice (400 RETURN_ITEMS_REPEATED)',
      async () => {
        const product = await newProduct();
        const { orderId, itemIds } = await order([{ item: product, quantity: 2 }]);
        return [
          orderId,
          {
            items: [
              { orderItemId: itemIds[0]!, quantity: 1 },
              { orderItemId: itemIds[0]!, quantity: 1 },
            ],
          },
        ] as const;
      },
      400,
      'RETURN_ITEMS_REPEATED',
    ],
  ])('refuses %s', async (_what, setup, status, code) => {
    const [orderId, body] = await setup();

    const res = await withdraw(orderId, body);

    expect({ status: res.statusCode, code: res.json().errorCode }).toEqual({ status, code });
  });

  it('refuses a second withdrawal when nothing is left of the order (400 RETURN_ITEMS_REQUIRED)', async () => {
    const product = await newProduct();
    const { orderId } = await order([{ item: product, quantity: 1 }], 'shipped');
    await withdraw(orderId);

    const again = await withdraw(orderId);

    expect(again.statusCode).toBe(400);
    expect(again.json()).toMatchObject({ errorCode: 'RETURN_ITEMS_REQUIRED' });
  });

  it('refuses an order that is not paid yet (409 RETURN_ORDER_NOT_RETURNABLE)', async () => {
    const product = await newProduct();
    await post('/api/orders/current/items', { variantId: product.variantId, quantity: 1 });
    const cart = await asAdmin((tx) =>
      tx.order.findFirstOrThrow({
        where: { userId: buyer.id, confirmed: false },
        orderBy: { id: 'desc' },
        select: { id: true, items: { select: { id: true } } },
      }),
    );

    const res = await withdraw(cart.id, {
      items: [{ orderItemId: cart.items[0]!.id, quantity: 1 }],
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ errorCode: 'RETURN_ORDER_NOT_RETURNABLE' });
  });

  it('stops a buyer that makes too many statements in an hour (429 RATE_LIMITED)', async () => {
    const limited = await createUser();
    userIds.push(limited.id);
    // the tests raise every limit a thousand times: here it counts as the server has it
    const before = { limit: env.LIMIT_WITHDRAWAL_PER_USER, scale: env.REQUEST_LIMITS_SCALE };
    env.LIMIT_WITHDRAWAL_PER_USER = 2;
    env.REQUEST_LIMITS_SCALE = 1;

    try {
      // an order that is not the buyer's: each request is a 404, counted all the same
      const attempt = () => withdraw(2_000_000_000, {}, limited);
      for (let i = 0; i < 2; i += 1) expect((await attempt()).statusCode).toBe(404);

      const refused = await attempt();
      expect(refused.statusCode).toBe(429);
      expect(refused.json()).toMatchObject({
        errorCode: 'RATE_LIMITED',
        details: { limit: 'withdrawal' },
      });
    } finally {
      env.LIMIT_WITHDRAWAL_PER_USER = before.limit;
      env.REQUEST_LIMITS_SCALE = before.scale;
    }
  });
});
