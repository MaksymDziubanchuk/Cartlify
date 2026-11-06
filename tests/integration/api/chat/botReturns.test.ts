import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';

import { shopSettings } from '@config/shopSettings.js';
import { botLimits } from '@routes/api/chat/services/bot/chatBotLimits.service.js';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { chatBotDriver, type Chat } from '../../../helpers/chatBot.js';
import { closeChatSockets } from '../../../helpers/chatSocket.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import {
  closeSessions,
  createProduct,
  createUser,
  uniqueTag,
  type TestProduct,
  type TestUser,
} from '../../../helpers/factories.js';
import { answerAsModel, stopModel, type ModelCall } from '../../../helpers/openai.js';
import { placeOrder } from '../../../helpers/orders.js';
import { moveClock } from '../../../helpers/payments.js';
import { returnFlows } from '../../../helpers/returnFlows.js';
import { beginReturnRefund, failReturnRefund, refundReturn } from '../../../helpers/returns.js';

const DAY_MS = 86_400_000;

// What the bot knows of the withdrawals and the returns of the orders of a customer (spec 10.1 to
// 10.4): per order the state of its statements, until when the customer may withdraw and for which
// units, and where the money of each statement is (refunded with the day, on its way, not refunded
// yet, refused with the reason); never what the shop does with the goods. An order with money that
// failed to go back, or that the bank disputed, is for an admin: the bot says nothing of it. The
// orders and the statements come through the real routes and the database functions of the money
// (helpers/returnFlows.ts, helpers/returns.ts); the model is the test's, and what it is told is
// read from its request

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
let root: TestUser;
const userIds: number[] = [];
let clock: ReturnType<typeof moveClock> | undefined;

const { openChat, ask } = chatBotDriver({ app: () => app, userIds });
const flows = returnFlows({ app: () => app, csrf: () => csrf, admin: () => admin });
const {
  shippedOrder: sent,
  adminStatement,
  setGoods,
  confirmProof,
  withdrawFromAccount,
  tellOfParcel,
} = flows;

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await createUser({ role: 'ADMIN' });
  root = await createUser({ role: 'ROOT' });
  userIds.push(admin.id, root.id);
});

// the counts of the addresses and of the shop are of the process: each test starts from none
beforeEach(() => botLimits.reset());

afterEach(() => {
  clock?.restore();
  clock = undefined;
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

const ordersMessageOf = (call: ModelCall) =>
  call.request.input.find((m) => m.content.startsWith('Orders of the customer'))?.content ?? null;

// each question of a chat is its own: the same one again and again is a bot going in circles
let questions = 0;

// the customer asks and the model is told the orders: the whole message of the orders
async function ordersTold(chat: Chat): Promise<string> {
  const calls = answerAsModel();
  await ask(chat, `Where is my order, question ${(questions += 1)}?`);

  return ordersMessageOf(calls[0]!)!;
}

// the line the model is told of the order
async function lineOf(chat: Chat, orderId: number): Promise<string> {
  const orders = await ordersTold(chat);

  return orders.split('\n').find((line) => line.startsWith(`- order ${orderId}:`))!;
}

const HUMAN_ONLY = (orderId: number) =>
  `- order ${orderId}: HUMAN ONLY, an admin handles this order`;

// the order the way its buyer sees it: the dates and the statements the bot must agree with
async function viewOf(buyer: TestUser, orderId: number) {
  const res = await app.inject({
    method: 'GET',
    url: `/api/orders/${orderId}`,
    headers: { cookie: accessCookie(buyer) },
  });
  expect(res.statusCode).toBe(200);

  return res.json();
}

const setStatus = (orderId: number, status: string) =>
  app.inject({
    method: 'PATCH',
    url: `/api/orders/${orderId}/status`,
    headers: withCsrf(csrf, accessCookie(admin)),
    payload: { status },
  });

// a customer with the chat open, the product they buy and its name in the order
async function customer() {
  const chat = await openChat('user');
  const tag = uniqueTag();
  const product = await createProduct({ name: `Lamp ${tag}`, price: 10, stock: 40 });

  return { chat, buyer: chat.user!, product, name: `Lamp ${tag}` };
}

// a delivered order of the customer for the units, the way an admin delivers it
async function delivered(buyer: TestUser, product: TestProduct, units: number) {
  const placed = await sent(buyer, product, units);
  expect((await setStatus(placed.orderId, 'delivered')).statusCode).toBe(200);

  return placed;
}

// the statement of an admin for units of the item, the goods in: its money is not refunded yet
async function goodsIn(placed: { orderId: number; itemId: number }, units: number) {
  const card = await adminStatement(placed.orderId, placed.itemId, units);
  await setGoods(card, units, 'to_stock');

  return card;
}

describe('the withdrawal from an order', () => {
  // the period of a sent order has not started: it starts with the delivery
  it('is open for a sent order, with no end date, for all its units', async () => {
    const { chat, buyer, product, name } = await customer();
    const { orderId } = await sent(buyer, product, 2);

    const line = await lineOf(chat, orderId);

    expect(line).toContain(`- order ${orderId}: shipped (sent, on its way to the customer);`);
    expect(line).toContain(
      `; withdrawal: the customer may still withdraw from the contract for ${name} x 2, the period starts with the delivery`,
    );
    expect(line).not.toContain('until');
    // no statement yet: nothing of returns
    expect(line).not.toContain('returns:');
    expect(line).not.toContain('statement');
    // the same as the buyer is shown
    const view = await viewOf(buyer, orderId);
    expect(view).toMatchObject({ withdrawalOpen: true, returnStatus: 'none' });
    expect(view.withdrawable).toEqual([expect.objectContaining({ quantity: 2 })]);
  });

  // goods the law gives no right of withdrawal for (a perishable good) are not "already stated":
  // there is nothing to state for them
  it('says the goods have no right of withdrawal, which is not that every unit is stated', async () => {
    const chat = await openChat('user');
    const tag = uniqueTag();
    const bread = await createProduct({
      name: `Fresh bread ${tag}`,
      price: 10,
      stock: 10,
      withdrawal: 'perishable',
    });
    const { orderId } = await sent(chat.user!, bread, 2);

    const line = await lineOf(chat, orderId);

    expect(line).toContain(
      `; withdrawal: the goods of this order have no right of withdrawal (Fresh bread ${tag})`,
    );
    expect(line).not.toContain('already in a statement');
    expect(line).not.toContain('may still withdraw');
    expect((await viewOf(chat.user!, orderId)).withdrawable ?? []).toEqual([]);
  });

  it('is open for a paid order that is not sent yet', async () => {
    const { chat, buyer, product, name } = await customer();
    const orderId = await placeOrder(app, csrf, buyer, product, 'paid', 2);

    const line = await lineOf(chat, orderId);

    expect(line).toContain(`- order ${orderId}: paid (paid, being prepared for shipping);`);
    expect(line).toContain(
      `; withdrawal: the customer may still withdraw from the contract for ${name} x 2, the period starts with the delivery`,
    );
  });

  it('ends on the day the order shows for a delivered order, with the free units by name', async () => {
    const { chat, buyer, product, name } = await customer();
    const { orderId } = await delivered(buyer, product, 3);
    const view = await viewOf(buyer, orderId);

    const line = await lineOf(chat, orderId);

    expect(view.withdrawalEndsAt).toEqual(expect.any(String));
    expect(line).toContain(`- order ${orderId}: delivered (delivered to the customer);`);
    expect(line).toContain(
      `; withdrawal: the customer may still withdraw from the contract for ${name} x 3, until ${view.withdrawalEndsAt} (UTC)`,
    );
    expect(line).not.toContain('the period starts with the delivery');
  });

  it('drops the units already stated from what is left to state', async () => {
    const { chat, buyer, product, name } = await customer();
    const { orderId, itemId } = await sent(buyer, product, 3);
    const stated = await flows.post(
      `/api/orders/${orderId}/withdrawal`,
      { items: [{ orderItemId: itemId, quantity: 1 }] },
      buyer,
    );
    expect(stated.statusCode).toBe(201);

    const line = await lineOf(chat, orderId);

    expect(line).toContain(
      `; withdrawal: the customer may still withdraw from the contract for ${name} x 2, the period starts with the delivery`,
    );
    const view = await viewOf(buyer, orderId);
    expect(view.withdrawable).toEqual([expect.objectContaining({ quantity: 2 })]);
  });

  it('has nothing left to state once every unit is in a statement', async () => {
    const { chat, buyer, product } = await customer();
    const { orderId } = await sent(buyer, product, 2);
    await withdrawFromAccount(buyer, orderId);

    const line = await lineOf(chat, orderId);

    expect(line).toContain(
      '; withdrawal: every unit is already in a statement, nothing is left to state',
    );
    expect(line).not.toContain('may still withdraw');
    expect((await viewOf(buyer, orderId)).withdrawable).toEqual([]);
  });

  // the end of the contract is the date told; the days of grace of the shop come after it
  it('still takes a statement in the days of grace and tells the end that passed', async () => {
    const { chat, buyer, product } = await customer();
    const { orderId } = await delivered(buyer, product, 2);
    const view = await viewOf(buyer, orderId);
    const ends = new Date(view.withdrawalEndsAt).getTime();
    // a minute past the end: the clock of the app runs while the request does
    clock = moveClock(ends - Date.now() + 60_000);

    const line = await lineOf(chat, orderId);

    expect(shopSettings().withdrawalGraceDays).toBeGreaterThan(0);
    expect(line).toContain(
      `the period of the contract ended ${view.withdrawalEndsAt} (UTC), the shop still takes a statement for now`,
    );
    expect(line).not.toContain('the period is over');
  });

  it('is over after the days of grace, the end of the contract stays in the words of the bot', async () => {
    const { chat, buyer, product } = await customer();
    const { orderId } = await delivered(buyer, product, 2);
    const view = await viewOf(buyer, orderId);
    const ends = new Date(view.withdrawalEndsAt).getTime();
    // the end of the last day of grace; two hours past it whatever change of the clock of the zone
    clock = moveClock(
      ends - Date.now() + shopSettings().withdrawalGraceDays * DAY_MS + 2 * 3_600_000,
    );

    const line = await lineOf(chat, orderId);

    expect(line).toContain(
      `; withdrawal: the period is over (it ended ${view.withdrawalEndsAt} UTC)`,
    );
    expect(line).not.toContain('may still withdraw');
    expect(line).not.toContain('every unit is already');
  });

  // an order that is not paid has nothing to withdraw from; it is not mentioned
  it('is not mentioned for an order that waits for its payment', async () => {
    const { chat, buyer, product } = await customer();
    const orderId = await placeOrder(app, csrf, buyer, product, 'waiting');

    const line = await lineOf(chat, orderId);

    expect(line).toContain(`- order ${orderId}: waiting (confirmed, waiting for the payment);`);
    expect(line).not.toContain('withdrawal:');
    expect(line).not.toContain('returns:');
  });
});

describe('the statements of an order', () => {
  it('follows the statement of the customer from its registration to the confirmation of the parcel', async () => {
    const { chat, buyer, product } = await customer();
    const { orderId } = await sent(buyer, product, 2);
    const returnId = await withdrawFromAccount(buyer, orderId);
    const view = await viewOf(buyer, orderId);
    const stated = view.withdrawals[0].statedAt as string;
    const open = 'a statement of withdrawal or return is open, no money went back yet';
    const money = 'money: 20 EUR for 2 unit(s) is not refunded yet';

    const first = await lineOf(chat, orderId);
    await tellOfParcel(buyer, orderId, returnId);
    const told = await lineOf(chat, orderId);
    await confirmProof(returnId);
    const confirmed = await lineOf(chat, orderId);

    expect(first).toContain(`; returns: ${open}`);
    expect(first).toContain(`; statement ${returnId} (stated ${stated} UTC): registered; ${money}`);
    expect(told).toContain(
      `; statement ${returnId} (stated ${stated} UTC): the customer told of the parcel, the shop has not confirmed it yet; ${money}`,
    );
    expect(confirmed).toContain(
      `; statement ${returnId} (stated ${stated} UTC): the shop confirmed the parcel; ${money}`,
    );
  });

  it('names every statement of the order', async () => {
    const { chat, buyer, product } = await customer();
    const { orderId, itemId } = await sent(buyer, product, 3);
    const first = await adminStatement(orderId, itemId, 1);
    const second = await adminStatement(orderId, itemId, 2);

    const line = await lineOf(chat, orderId);

    expect(line).toContain(`; statement ${first.id} (stated `);
    expect(line).toContain(`; statement ${second.id} (stated `);
    expect(line.indexOf(`statement ${second.id}`)).toBeGreaterThan(
      line.indexOf(`statement ${first.id}`),
    );
    expect(line).toContain('money: 10 EUR for 1 unit(s) is not refunded yet');
    expect(line).toContain('money: 20 EUR for 2 unit(s) is not refunded yet');
  });

  it('shows no statement of another customer', async () => {
    const mine = await customer();
    const other = await customer();
    const { orderId } = await sent(mine.buyer, mine.product, 1);
    const stranger = await sent(other.buyer, other.product, 1);
    await withdrawFromAccount(other.buyer, stranger.orderId);

    const line = await lineOf(mine.chat, orderId);

    expect(line).not.toContain('statement');
    expect(line).not.toContain('returns:');
  });
});

describe('where the money of a statement is', () => {
  it('is not refunded yet while the shop has not paid it back', async () => {
    const { chat, buyer, product } = await customer();
    const placed = await sent(buyer, product, 2);
    const card = await goodsIn(placed, 1);

    const line = await lineOf(chat, placed.orderId);

    expect(line).toContain(`statement ${card.id}`);
    expect(line).toContain('money: 10 EUR for 1 unit(s) is not refunded yet');
    expect(line).toContain(
      '; returns: a statement of withdrawal or return is open, no money went back yet',
    );
  });

  it('is on its way to the card while the provider has not said that it went', async () => {
    const { chat, buyer, product } = await customer();
    const placed = await sent(buyer, product, 2);
    const card = await goodsIn(placed, 1);
    await beginReturnRefund(admin.id, card.id);

    const line = await lineOf(chat, placed.orderId);

    expect(line).toContain('money: 10 EUR for 1 unit(s) is on its way to the card');
    expect(line).not.toContain('refunded 10');
    // a transfer on its way is no failure: the bot goes on with the order
    expect(line).not.toContain('HUMAN ONLY');
  });

  it('is refunded, with the day it went back, and the state of the order follows', async () => {
    const { chat, buyer, product } = await customer();
    const placed = await sent(buyer, product, 2);
    const card = await goodsIn(placed, 1);
    const { refundedAt } = await refundReturn(admin.id, card.id);

    const line = await lineOf(chat, placed.orderId);

    // one of two units went back: the statement is closed and the order is partly refunded
    expect(line).toContain(
      `- order ${placed.orderId}: shipped (sent, on its way to the customer);`,
    );
    expect(line).toContain('; returns: all statements are closed and part of the money went back');
    expect(line).toContain(
      `: closed; money: refunded 10 EUR for 1 unit(s) on ${refundedAt.toISOString()} (UTC)`,
    );
    expect((await viewOf(buyer, placed.orderId)).withdrawals[0].items[0]).toMatchObject({
      money: 'refunded',
      refundedAt: refundedAt.toISOString(),
    });
    // the rest of the units can still be stated
    expect(line).toContain('may still withdraw from the contract for');
  });

  it('is cancelled when every unit went back with its money, with the day the money went back', async () => {
    const { chat, buyer, product } = await customer();
    const placed = await sent(buyer, product, 1);
    const card = await goodsIn(placed, 1);
    const { refundedAt } = await refundReturn(admin.id, card.id);

    const line = await lineOf(chat, placed.orderId);

    expect(line).toContain(
      `- order ${placed.orderId}: cancelled (cancelled, the money goes back to the card);`,
    );
    expect(line).toContain('; returns: all statements are closed and all the money went back');
    expect(line).toContain(
      `: closed; money: refunded 10 EUR for 1 unit(s) on ${refundedAt.toISOString()} (UTC)`,
    );
    // a cancelled order has nothing to withdraw from
    expect(line).not.toContain('withdrawal:');
    expect(line).not.toContain('HUMAN ONLY');
  });

  it('is refused with the reason when the goods were not accepted, and nothing went back', async () => {
    const { chat, buyer, product } = await customer();
    const placed = await sent(buyer, product, 2);
    const card = await adminStatement(placed.orderId, placed.itemId, 1);
    await setGoods(card, 1, 'not_accepted', { notAcceptedReason: 'unsealed' });

    const line = await lineOf(chat, placed.orderId);

    expect(line).toContain('money: 10 EUR for 1 unit(s) is refused (unsealed)');
    expect(line).toContain('; returns: all statements are closed and no money went back');
    // what the shop did with the goods is no part of what the bot is told
    expect(line).not.toMatch(/not_accepted|to_stock|written_off|shelf/);
  });

  it('is refused because the goods never arrived when the owner closed the statement without them', async () => {
    const { chat, buyer, product } = await customer();
    const placed = await sent(buyer, product, 2);
    const returnId = await withdrawFromAccount(buyer, placed.orderId);
    const closed = await flows.post(
      `/api/returns/${returnId}/close`,
      { code: 'goods_not_returned', note: 'The parcel never came.' },
      root,
    );
    expect(closed.statusCode).toBe(200);

    const line = await lineOf(chat, placed.orderId);

    expect(line).toContain('money: 20 EUR for 2 unit(s) is refused (the goods never arrived)');
    expect(line).toContain('; returns: all statements are closed and no money went back');
    expect(line).not.toContain('not_arrived');
  });

  // each statement has its own money, and the order says one open statement with money back
  it('is told for each statement apart: one refunded and closed, one open and not refunded', async () => {
    const { chat, buyer, product } = await customer();
    const placed = await sent(buyer, product, 3);
    const refunded = await goodsIn(placed, 1);
    const { refundedAt } = await refundReturn(admin.id, refunded.id);
    const waiting = await goodsIn(placed, 1);
    const [first, second] = (await viewOf(buyer, placed.orderId)).withdrawals as Array<{
      id: number;
      statedAt: string;
    }>;

    const line = await lineOf(chat, placed.orderId);

    expect(first!.id).toBe(refunded.id);
    expect(second!.id).toBe(waiting.id);
    expect(line).toContain(
      `statement ${refunded.id} (stated ${first!.statedAt} UTC): closed; money: refunded 10 EUR for 1 unit(s) on ${refundedAt.toISOString()} (UTC)`,
    );
    expect(line).toContain(
      `statement ${waiting.id} (stated ${second!.statedAt} UTC): registered; money: 10 EUR for 1 unit(s) is not refunded yet`,
    );
    expect(line).toContain('; returns: a statement is open and part of the money went back');
  });
});

// spec 10.4: a transfer of return money that failed, or that the bank disputed, is for an admin
describe('an order with money that failed to go back', () => {
  it.each(['card_unavailable', 'shop_balance', 'disputed', 'unknown'] as const)(
    'is left to an admin when the transfer failed with %s, and the bot says nothing of it',
    async (failure) => {
      const { chat, buyer, product } = await customer();
      const placed = await sent(buyer, product, 2);
      const card = await goodsIn(placed, 1);
      await failReturnRefund(admin.id, card.id, failure);

      const orders = await ordersTold(chat);

      expect(orders).toContain(HUMAN_ONLY(placed.orderId));
      const line = orders.split('\n').find((one) => one.startsWith(`- order ${placed.orderId}:`));
      expect(line).toBe(HUMAN_ONLY(placed.orderId));
      expect(orders).toContain('An order marked HUMAN ONLY is for an admin');
      expect(orders).not.toContain('is not refunded yet');
      expect(orders).not.toContain(failure);
    },
  );

  it('is no longer left to an admin when a later transfer went through', async () => {
    const { chat, buyer, product } = await customer();
    const placed = await sent(buyer, product, 2);
    const card = await goodsIn(placed, 1);
    await failReturnRefund(admin.id, card.id, 'card_unavailable');
    expect(await lineOf(chat, placed.orderId)).toBe(HUMAN_ONLY(placed.orderId));

    const { refundedAt } = await refundReturn(admin.id, card.id);
    const line = await lineOf(chat, placed.orderId);

    expect(line).not.toContain('HUMAN ONLY');
    expect(line).toContain(
      `money: refunded 10 EUR for 1 unit(s) on ${refundedAt.toISOString()} (UTC)`,
    );
  });

  // the failure is of one order: the others of the customer go on as they were
  it('leaves the other orders of the customer to the bot', async () => {
    const { chat, buyer, product, name } = await customer();
    const failed = await sent(buyer, product, 2);
    const card = await goodsIn(failed, 1);
    await failReturnRefund(admin.id, card.id, 'disputed');
    const fine = await sent(buyer, product, 1);

    const orders = await ordersTold(chat);
    const lines = orders.split('\n');

    expect(lines).toContain(HUMAN_ONLY(failed.orderId));
    const other = lines.find((line) => line.startsWith(`- order ${fine.orderId}:`))!;
    expect(other).toContain(`shipped (sent, on its way to the customer)`);
    expect(other).toContain(`for ${name} x 1, the period starts with the delivery`);
  });

  it('hides the statements of the order that failed, whatever they hold', async () => {
    const { chat, buyer, product } = await customer();
    const placed = await sent(buyer, product, 2);
    const card = await goodsIn(placed, 1);
    await failReturnRefund(admin.id, card.id, 'disputed');
    const second = await adminStatement(placed.orderId, placed.itemId, 1);

    const orders = await ordersTold(chat);

    expect(orders).not.toContain(`statement ${card.id}`);
    expect(orders).not.toContain(`statement ${second.id}`);
    expect(orders).not.toContain('withdrawal:');
  });
});
