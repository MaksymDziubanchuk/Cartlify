import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { alertsOf } from '../../helpers/alerts.js';
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
import { journeyOf, mailTo, mailsTo, statementCodeIn } from '../../helpers/returnJourney.js';
import { refundsOf } from '../../helpers/stripe.js';

// The parcels of the statements, each step with what its actor sees (docs/return-scenarios.md, 2, 10
// and 11): the buyer sends the goods in two parcels, the shop sends goods it did not accept back, the
// goods come in with no parcel told. A parcel back by a label of the shop is the flow of a return of
// the shop (returnShop.test.ts). The order is paid as the setup of the test

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
const alerts = alertsOf({ app: () => app, csrf: () => csrf });

// root finds the statements of the buyer that owe the way back the payment could not hold in the
// alert of the money that does not fit, and gives it outside the app
async function wayBackOutside(buyer: TestUser, count: number) {
  const short = (await alerts.listOf(root, 'returns_money_short', { userId: buyer.id })).items;
  expect(short).toHaveLength(count);
  for (const { id } of short) {
    const card = (await j.get(root, `/api/returns/${id}`)).json();
    expect(card.moneyLeft).toMatchObject({ rows: 0, short: true });
    const paid = await j.post(root, `/api/returns/${id}/refund/outside`, {
      method: 'bank_transfer',
      note: 'The receipts of the carriers came by mail.',
      at: card.statedAt,
    });
    expect(paid.statusCode).toBe(200);
  }
  expect((await alerts.listOf(root, 'returns_money_short', { userId: buyer.id })).items).toEqual(
    [],
  );
}

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

// a buyer with a paid order of so many units at 10, sent by the admin
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

// the admin finds a statement by the code in a mail or a letter, and opens its card
async function cardByCode(code: string) {
  const [found] = (await j.get(admin, `/api/returns?q=${code}`)).json().items;
  return (await j.get(admin, `/api/returns/${found.id}`)).json();
}

describe('the parcels of the statements', () => {
  it('the buyer sends the goods in two parcels: the units of the second get a statement of their own, each comes in with its money', async () => {
    const { buyer, product, orderId, paymentId } = await sentOrder(3);
    const before = await stockOf(product);
    const mails = watchMail();

    // the whole order back; the first parcel carries two of the three units
    const made = await j.post(buyer, `/api/orders/${orderId}/withdrawal`);
    expect(made.statusCode).toBe(201);
    const first = made.json().withdrawals[0];
    const told = await j.post(buyer, `/api/orders/${orderId}/returns/${first.id}/proof`, {
      carrier: 'DHL',
      trackingNumber: 'JD0146000201',
      buyerPaid: 3.5,
      items: [{ itemId: first.items[0].id, quantity: 2 }],
    });
    expect(told.statusCode).toBe(200);

    // the mail names the statement of the third unit; the page of the order shows it, and the buyer
    // tells of its parcel there
    const secondCode = statementCodeIn(
      mailTo(mails, buyer.email, `A statement of its own for goods of order #${orderId}`),
    );
    expect(secondCode).toBe(`W${orderId}-2`);
    const second = told.json().withdrawals.find((one: { code: string }) => one.code === secondCode);
    expect(second).toMatchObject({ items: [expect.objectContaining({ quantity: 1 })] });
    const toldAgain = await j.post(buyer, `/api/orders/${orderId}/returns/${second.id}/proof`, {
      carrier: 'UPS',
      trackingNumber: '1Z999AA10123456784',
      buyerPaid: 2,
    });
    expect(toldAgain.statusCode).toBe(200);

    // each parcel comes in: the admin takes the units in with the sum of the receipt, and sends the
    // money of each
    for (const [code, units, buyerPaid] of [
      [first.code, 2, 3.5],
      [secondCode, 1, 2],
    ] as const) {
      const card = await cardByCode(code);
      const taken = await j.post(admin, `/api/returns/${card.id}/receive`, {
        results: [{ itemId: card.items[0].id, quantity: units, goods: 'to_stock' }],
        parcel: { buyerPaid },
      });
      expect(taken.statusCode).toBe(200);
      expect((await j.post(admin, `/api/returns/${card.id}/refund`)).statusCode).toBe(200);
    }
    // the payment held the goods only: the statements wait for the way back of each parcel
    await wayBackOutside(buyer, 2);

    // the buyer sees both statements closed with their parcels, the order back in full
    const page = (await j.get(buyer, `/api/orders/${orderId}`)).json();
    expect(page).toMatchObject({ status: 'cancelled', returnStatus: 'full' });
    expect(
      page.withdrawals.map((one: { code: string; step: string; parcels: unknown[] }) => [
        one.code,
        one.step,
        one.parcels,
      ]),
    ).toEqual([
      [
        first.code,
        'closed',
        [expect.objectContaining({ carrier: 'DHL', buyerPaid: 3.5, confirmed: true })],
      ],
      [
        secondCode,
        'closed',
        [expect.objectContaining({ carrier: 'UPS', buyerPaid: 2, confirmed: true })],
      ],
    ]);
    const back = mailsTo(
      mails,
      buyer.email,
      `We paid back the cost of sending order #${orderId} back`,
    );
    expect(back.map((mail) => mail.text.includes('We paid you back'))).toEqual([true, true]);
    expect((await stockOf(product)).stock).toBe(before.stock + 3);
    // a transfer for each statement
    expect(
      (await refundsOf(paymentId)).map((refund) => refund.amount).sort((a, b) => a - b),
    ).toEqual([1000, 2000]);
  });

  it('the parcel comes with some of the units: the admin splits the others off, each statement comes in with its money', async () => {
    const { buyer, product, orderId, paymentId } = await sentOrder(3);
    const before = await stockOf(product);
    const mails = watchMail();

    // the whole order back, in one parcel as the buyer tells it
    const made = await j.post(buyer, `/api/orders/${orderId}/withdrawal`);
    expect(made.statusCode).toBe(201);
    const first = made.json().withdrawals[0];
    const told = await j.post(buyer, `/api/orders/${orderId}/returns/${first.id}/proof`, {
      carrier: 'DHL',
      trackingNumber: 'JD0146000211',
      buyerPaid: 0,
    });
    expect(told.statusCode).toBe(200);

    // the parcel carries two of the three units, the buyer wrote the third goes apart: the admin
    // splits it off from the card, then takes the two in and sends their money
    const card = await cardByCode(first.code);
    const split = await j.post(admin, `/api/returns/${card.id}/split`, {
      items: [{ itemId: card.items[0].id, quantity: 1 }],
    });
    expect(split.statusCode).toBe(201);
    const taken = await j.post(admin, `/api/returns/${card.id}/receive`, {
      results: [{ itemId: card.items[0].id, quantity: 2, goods: 'to_stock' }],
      parcel: { buyerPaid: 0 },
    });
    expect(taken.statusCode).toBe(200);
    expect((await j.post(admin, `/api/returns/${card.id}/refund`)).statusCode).toBe(200);

    // the buyer is mailed the code of the statement of the third unit, finds it on the page of the
    // order and tells of its parcel there
    const secondCode = statementCodeIn(
      mailTo(mails, buyer.email, `A statement of its own for goods of order #${orderId}`),
    );
    expect(secondCode).toBe(`W${orderId}-2`);
    const second = (await j.get(buyer, `/api/orders/${orderId}`))
      .json()
      .withdrawals.find((one: { code: string }) => one.code === secondCode);
    expect(second).toMatchObject({ items: [expect.objectContaining({ quantity: 1 })] });
    const toldAgain = await j.post(buyer, `/api/orders/${orderId}/returns/${second.id}/proof`, {
      carrier: 'UPS',
      trackingNumber: '1Z999AA10123456785',
      buyerPaid: 0,
    });
    expect(toldAgain.statusCode).toBe(200);

    // the third unit comes in with its money
    const later = await cardByCode(secondCode);
    expect(
      (
        await j.post(admin, `/api/returns/${later.id}/receive`, {
          results: [{ itemId: later.items[0].id, quantity: 1, goods: 'to_stock' }],
          parcel: { buyerPaid: 0 },
        })
      ).statusCode,
    ).toBe(200);
    expect((await j.post(admin, `/api/returns/${later.id}/refund`)).statusCode).toBe(200);

    // the buyer sees both statements closed, the order back in full; the units are on the shelf
    const page = (await j.get(buyer, `/api/orders/${orderId}`)).json();
    expect(page).toMatchObject({ status: 'cancelled', returnStatus: 'full' });
    expect(
      page.withdrawals.map((one: { code: string; step: string }) => [one.code, one.step]),
    ).toEqual([
      [first.code, 'closed'],
      [secondCode, 'closed'],
    ]);
    expect((await stockOf(product)).stock).toBe(before.stock + 3);
    expect(
      (await refundsOf(paymentId)).map((refund) => refund.amount).sort((a, b) => a - b),
    ).toEqual([1000, 2000]);
  });

  it('the shop does not accept the goods and sends them back: the buyer is told why, then of the parcel they come in', async () => {
    const { buyer, product, orderId } = await sentOrder(2);
    const before = await stockOf(product);
    const mails = watchMail();
    const made = await j.post(buyer, `/api/orders/${orderId}/withdrawal`);
    const statement = made.json().withdrawals[0];
    await j.post(buyer, `/api/orders/${orderId}/returns/${statement.id}/proof`, {
      carrier: 'DHL',
      trackingNumber: 'JD0146000202',
    });

    // the goods came used: the shop does not take them back, the statement closes with the money
    // refused, and the buyer is told why
    const card = await cardByCode(statement.code);
    const taken = await j.post(admin, `/api/returns/${card.id}/receive`, {
      results: [
        { itemId: card.items[0].id, quantity: 2, goods: 'not_accepted', notAcceptedReason: 'used' },
      ],
      parcel: { buyerPaid: 0 },
    });
    expect(taken.statusCode).toBe(200);
    expect(taken.json().closedAt).not.toBeNull();
    expect(mailTo(mails, buyer.email, 'is closed').text).toContain('the goods were used');

    // the admin sends the goods back with a carrier of the shop, at the moment the card shows
    const sent = await j.post(admin, `/api/returns/${card.id}/shipments`, {
      direction: 'to_buyer',
      items: [{ itemId: card.items[0].id, quantity: 2 }],
      carrier: 'DHL',
      trackingNumber: 'JD0146000302',
      cost: 6,
      shippedAt: taken.json().closedAt,
    });
    expect(sent.statusCode).toBe(201);

    // the buyer is mailed the parcel and sees it on the page of the order
    const back = mailTo(mails, buyer.email, `We sent goods of order #${orderId} back to you`);
    expect(back.text).toContain('The parcel goes with DHL, number JD0146000302.');
    const page = (await j.get(buyer, `/api/orders/${orderId}`)).json();
    expect(page.withdrawals[0].parcels).toEqual([
      expect.objectContaining({ direction: 'to_shop', trackingNumber: 'JD0146000202' }),
      expect.objectContaining({ direction: 'to_buyer', trackingNumber: 'JD0146000302' }),
    ]);
    // the goods never went back to the shelf, and the shop paid the carrier for them
    expect((await stockOf(product)).stock).toBe(before.stock);
    expect((await j.get(admin, `/api/returns/${card.id}`)).json().parcels[1]).toMatchObject({
      direction: 'to_buyer',
      cost: 6,
      itemIds: [card.items[0].id],
    });
  });

  it('the shop pays the way back: the sum of the receipt goes back to the buyer with the money of the goods', async () => {
    const { buyer, orderId, paymentId } = await sentOrder(3);
    const mails = watchMail();

    // the order kept no contract that makes the buyer pay the way back: the shop pays it
    const page = (await j.get(buyer, `/api/orders/${orderId}`)).json();
    const made = await j.post(buyer, `/api/orders/${orderId}/withdrawal`, {
      items: [{ orderItemId: page.withdrawable[0].orderItemId, quantity: 1 }],
    });
    expect(made.statusCode).toBe(201);
    const statement = made.json().withdrawals[0];
    await j.post(buyer, `/api/orders/${orderId}/returns/${statement.id}/proof`, {
      carrier: 'DHL',
      trackingNumber: 'JD0146000204',
      buyerPaid: 5,
    });

    // the parcel comes with the receipt: the buyer paid 4.50, the admin takes the goods in with it
    const card = await cardByCode(statement.code);
    expect(card.parcels[0]).toMatchObject({ buyerPaid: 5 });
    const taken = await j.post(admin, `/api/returns/${card.id}/receive`, {
      results: [{ itemId: card.items[0].id, quantity: 1, goods: 'to_stock' }],
      parcel: { buyerPaid: 4.5 },
    });
    expect(taken.statusCode).toBe(200);
    expect((await j.post(admin, `/api/returns/${card.id}/refund`)).statusCode).toBe(200);

    // the buyer gets the unit and the way back in one transfer, and is told both
    const closed = mailTo(mails, buyer.email, `Return of order #${orderId} is closed`);
    expect(closed.text).toContain('€14.50');
    const after = (await j.get(buyer, `/api/orders/${orderId}`)).json();
    expect(after.withdrawals[0].refunds).toEqual([
      expect.objectContaining({ goods: 10, wayBack: 4.5, amount: 14.5 }),
    ]);
    expect((await refundsOf(paymentId)).map((refund) => refund.amount)).toEqual([1450]);
  });

  // the way back goes with the transfer of the goods when the payment holds it beside the money the
  // other statements of the order still owe; left alone, the admin sends it by a transfer of its own
  // once it fits (docs/return-scenarios.md, 12)
  it('the way back does not fit beside another statement: it waits, and goes by a transfer of its own once that statement is closed', async () => {
    const { buyer, orderId, paymentId } = await sentOrder(3);
    const mails = watchMail();

    // the buyer withdraws one unit and sends it, then the two others, which never come
    const page = (await j.get(buyer, `/api/orders/${orderId}`)).json();
    const first = await j.post(buyer, `/api/orders/${orderId}/withdrawal`, {
      items: [{ orderItemId: page.withdrawable[0].orderItemId, quantity: 1 }],
    });
    expect(first.statusCode).toBe(201);
    const one = first.json().withdrawals[0];
    await j.post(buyer, `/api/orders/${orderId}/returns/${one.id}/proof`, {
      carrier: 'DHL',
      trackingNumber: 'JD0146000205',
      buyerPaid: 6.5,
    });
    const second = await j.post(buyer, `/api/orders/${orderId}/withdrawal`, {
      items: [{ orderItemId: page.withdrawable[0].orderItemId, quantity: 2 }],
    });
    expect(second.statusCode).toBe(201);
    const two = second.json().withdrawals.find((made: { id: number }) => made.id !== one.id);

    // the unit comes with the receipt of 6.50: the transfer sends the unit, the way back does not
    // fit beside the 20 the other statement owes of the 20 left of the payment
    const card = await cardByCode(one.code);
    expect(
      (
        await j.post(admin, `/api/returns/${card.id}/receive`, {
          results: [{ itemId: card.items[0].id, quantity: 1, goods: 'to_stock' }],
          parcel: { buyerPaid: 6.5 },
        })
      ).statusCode,
    ).toBe(200);
    const sent = await j.post(admin, `/api/returns/${card.id}/refund`);
    expect(sent.statusCode).toBe(200);
    expect(sent.json()).toMatchObject({
      closedAt: null,
      moneyLeft: { rows: 0, wayBack: 6.5, short: true },
    });
    const short = async () =>
      (await alerts.listOf(root, 'returns_money_short', { userId: buyer.id })).items.map(
        (item) => item.id,
      );
    expect(await short()).toEqual([card.id]);

    // the other units never come: root closes them without money
    const other = await cardByCode(two.code);
    expect(
      (
        await j.post(root, `/api/returns/${other.id}/close`, {
          code: 'goods_not_returned',
          note: 'The units never came.',
        })
      ).statusCode,
    ).toBe(200);

    // the way back fits now: the alert lets it go, the admin sends it by a transfer of its own
    expect(await short()).toEqual([]);
    const back = await j.post(admin, `/api/returns/${card.id}/refund`);
    expect(back.statusCode).toBe(200);
    expect(back.json().closedAt).not.toBeNull();
    // Stripe lists the refunds of a payment newest first
    expect((await refundsOf(paymentId)).map((refund) => refund.amount)).toEqual([650, 1000]);
    const told = mailTo(
      mails,
      buyer.email,
      `We paid back the cost of sending order #${orderId} back`,
    );
    expect(told.text).toContain('€6.50');
    expect(told.text).toContain('the card or account you paid with');
  });

  it('the goods come in with no parcel told: the admin writes it with the goods in hand, from the receipt in the box', async () => {
    const { buyer, orderId, paymentId } = await sentOrder(1);
    const mails = watchMail();

    // the buyer called the shop: an admin writes the statement for them
    const items = (await j.get(admin, `/api/orders/${orderId}`)).json().items;
    const made = await j.post(admin, '/api/returns', {
      orderId,
      items: [{ orderItemId: items[0].id, quantity: 1 }],
      basis: 'other',
      reason: 'defect',
    });
    expect(made.statusCode).toBe(201);
    const code = statementCodeIn(mailTo(mails, buyer.email, 'registered'));

    // the parcel comes with no proof: the admin writes it from the label and the receipt in the box
    const card = await cardByCode(code);
    const taken = await j.post(admin, `/api/returns/${card.id}/receive`, {
      results: [{ itemId: card.items[0].id, quantity: 1, goods: 'to_stock' }],
      parcel: { carrier: 'GLS', trackingNumber: 'GLS0146000203', buyerPaid: 4.2 },
    });
    expect(taken.statusCode).toBe(200);
    expect(taken.json().parcels).toEqual([
      expect.objectContaining({
        direction: 'to_shop',
        carrier: 'GLS',
        buyerPaid: 4.2,
        confirmedBy: expect.objectContaining({ id: admin.id }),
      }),
    ]);
    expect((await j.post(admin, `/api/returns/${card.id}/refund`)).statusCode).toBe(200);
    // the payment of 10 held the unit only: the way back goes outside the app
    await wayBackOutside(buyer, 1);

    // the buyer sees the parcel the shop wrote, confirmed, and the money back
    const page = (await j.get(buyer, `/api/orders/${orderId}`)).json();
    expect(page.withdrawals[0]).toMatchObject({
      code,
      step: 'closed',
      parcels: [expect.objectContaining({ carrier: 'GLS', buyerPaid: 4.2, confirmed: true })],
    });
    expect((await refundsOf(paymentId)).map((refund) => refund.amount)).toEqual([1000]);
  });
});
