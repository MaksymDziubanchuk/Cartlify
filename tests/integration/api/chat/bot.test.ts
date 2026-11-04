import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';

import env from '@config/env.js';
import { botLimits } from '@routes/api/chat/services/bot/chatBotLimits.service.js';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { cancelPaidOrder } from '../../../helpers/cancel.js';
import { chatBotDriver } from '../../../helpers/chatBot.js';
import { closeChatSockets } from '../../../helpers/chatSocket.js';
import { getCsrf, withCsrf } from '../../../helpers/csrf.js';
import { asAdmin } from '../../../helpers/db.js';
import {
  closeSessions,
  createProduct,
  createUser,
  createVariant,
  deleteProductFromCatalog,
  putOnSale,
} from '../../../helpers/factories.js';
import { takeLogs } from '../../../helpers/logs.js';
import {
  answerAsModel,
  gate,
  modelResponse,
  plainAnswer,
  stopModel,
  type ModelCall,
} from '../../../helpers/openai.js';
import { deliveryBody, placeOrder } from '../../../helpers/orders.js';
import { placePaidOrder } from '../../../helpers/payments.js';
import { cancelAndRefund } from '../../../helpers/returns.js';

// the bot asks the model of the app; here the model is the test's (tests/helpers/openai.ts): the
// decision whether a person is needed is the model's, so the test decides it

let app: FastifyInstance;
const userIds: number[] = [];

beforeAll(async () => {
  app = await startApp();
});

afterEach(stopModel);

// the counts of the addresses and of the shop are of the process: each test starts from none
beforeEach(() => botLimits.reset());

afterAll(async () => {
  closeChatSockets();

  try {
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

const {
  openChat,
  say,
  nextMessage,
  ask,
  threadRowOf,
  messageRowsOf,
  openAdminSocket,
  isWaitingForAdmin,
} = chatBotDriver({ app: () => app, userIds });

const purposes = (calls: ModelCall[]) => calls.map((call) => call.purpose);

describe('a message to the bot', () => {
  // the answer of the model takes seconds: the customer saw nothing of their own message until then
  it('shows the customer their message before the bot has answered', async () => {
    const held = gate();
    const calls = answerAsModel(async (call) => {
      await held.wait;
      return plainAnswer(call);
    });
    const chat = await openChat('user');

    say(chat, 'Do you have red mugs?');
    const own = await nextMessage(chat, 'user');

    expect(own.content).toBe('Do you have red mugs?');
    expect(chat.socket.events.some((e) => e.payload?.senderType === 'bot')).toBe(false);

    held.open();
    expect((await nextMessage(chat, 'bot')).content).toBe('Bot answer to: Do you have red mugs?');
    expect(purposes(calls)).toEqual(['answer']);
  });

  // two answers at once are two paid turns for one conversation, and they come in any order
  it('takes no message while the bot answers the one before and keeps none of it', async () => {
    const held = gate();
    answerAsModel(async (call) => {
      await held.wait;
      return plainAnswer(call);
    });
    const chat = await openChat('guest');

    say(chat, 'Do you have red mugs?');
    await nextMessage(chat, 'guest');
    say(chat, 'And blue ones?');

    expect((await chat.socket.take('error')).payload).toEqual({ code: 'CHAT_BOT_REPLYING' });

    held.open();
    await nextMessage(chat, 'bot');
    expect((await messageRowsOf(chat.threadId)).map((m) => m.content)).not.toContain(
      'And blue ones?',
    );

    // once the bot has answered, the next message goes through
    expect((await ask(chat, 'And blue ones?')).content).toBe('Bot answer to: And blue ones?');
  });
});

describe('a customer who asks for a person', () => {
  it('is asked to describe the issue, and that description is what reaches the admin', async () => {
    const calls = answerAsModel();
    const admin = await openAdminSocket();
    const chat = await openChat('user');

    const bot = await ask(chat, 'I need a human please');

    // the fixed text of the app in the language of the customer: the model is asked once
    expect(bot.content).toContain('describe their issue for the admin');
    expect(purposes(calls)).toEqual(['fixed_text']);

    // the chat is the admin's now, but there is nothing to read yet
    const switched = await threadRowOf(chat.threadId);
    expect(switched).toMatchObject({
      type: 'admin',
      status: 'open',
      adminUnreadSince: null,
      unreadCount: 0,
    });
    expect(await isWaitingForAdmin(admin.cookie, chat.threadId)).toBe(false);

    say(chat, 'My parcel 5 came broken');
    const requested = await admin.socket.take(
      'admin:requested',
      (e) => e.payload.thread.id === chat.threadId,
    );

    expect(requested.payload.thread).toMatchObject({ type: 'admin', unreadCount: 1 });
    expect(await isWaitingForAdmin(admin.cookie, chat.threadId)).toBe(true);

    // the bot is quiet in a chat of the admin
    const rows = await messageRowsOf(chat.threadId);
    expect(rows.at(-1)).toMatchObject({ senderType: 'user', content: 'My parcel 5 came broken' });
    expect(calls).toHaveLength(1);
  });

  // a bot that promised the admin and a chat that stayed with the bot: two steps, the second failed
  it('writes the answer of the bot and gives the chat to the admin in one step', async () => {
    answerAsModel();
    const chat = await openChat('user');

    const bot = await ask(chat, 'connect me to a real person');
    const thread = await threadRowOf(chat.threadId);
    const botRow = (await messageRowsOf(chat.threadId)).find((m) => m.id === bot.id)!;

    expect(thread.type).toBe('admin');
    // one transaction: the time of the request is the time the answer was written
    expect(thread.adminRequestedAt).toEqual(botRow.createdAt);
    expect(thread.lastMessagePreview).toBe(bot.content.slice(0, 120));
  });

  it('is taken to the admin the same way when the model finds a person is needed', async () => {
    const calls = answerAsModel((call) =>
      call.purpose === 'answer'
        ? { reply: 'I am sorry to hear that.', escalate: true, reason: 'HUMAN_REQUIRED' }
        : plainAnswer(call),
    );
    const chat = await openChat('user');

    const bot = await ask(chat, 'My parcel came broken, what now?');

    expect(bot.content).toContain('describe their issue for the admin');
    expect(purposes(calls)).toEqual(['answer', 'fixed_text']);
    expect((await threadRowOf(chat.threadId)).type).toBe('admin');
  });

  // a matter that may need a person is the model's to decide, it answers most of them itself
  it('leaves a word like refund to the model, and stays with the bot when the model answers it', async () => {
    const calls = answerAsModel();
    const chat = await openChat('user');

    const bot = await ask(chat, 'How long does a refund take?');

    expect(bot.content).toBe('Bot answer to: How long does a refund take?');
    expect(purposes(calls)).toEqual(['answer']);
    expect((await threadRowOf(chat.threadId)).type).toBe('bot');
  });

  // only a person who proved the email talks to an admin: a guest may be anyone
  it('tells a guest that only customers with a confirmed email talk to an admin', async () => {
    const calls = answerAsModel();
    const chat = await openChat('guest');

    const bot = await ask(chat, 'I need a human please');

    expect(bot.content).toContain(
      'only logged-in customers with a confirmed email can talk to an admin',
    );
    expect(purposes(calls)).toEqual(['fixed_text']);
    expect(await threadRowOf(chat.threadId)).toMatchObject({ type: 'bot', adminRequestedAt: null });
  });

  it('tells a customer who has not confirmed the email to confirm it first', async () => {
    const calls = answerAsModel();
    const chat = await openChat('unverified');

    const bot = await ask(chat, 'I need a human please');

    expect(bot.content).toContain('only customers with a confirmed email can talk to an admin');
    expect(bot.content).toContain('confirm their email');
    expect(purposes(calls)).toEqual(['fixed_text']);
    expect(await threadRowOf(chat.threadId)).toMatchObject({ type: 'bot', adminRequestedAt: null });
  });

  it('keeps a guest with the bot when the model finds a person is needed', async () => {
    answerAsModel((call) =>
      call.purpose === 'answer'
        ? { reply: 'An admin should look at it.', escalate: true, reason: 'HUMAN_REQUIRED' }
        : plainAnswer(call),
    );
    const chat = await openChat('guest');

    const bot = await ask(chat, 'My parcel came broken, what now?');

    expect(bot.content).toContain('only logged-in customers with a confirmed email');
    expect((await threadRowOf(chat.threadId)).type).toBe('bot');
  });
});

describe('a customer who keeps saying the same', () => {
  // "yes" again and again is a good conversation, not a bot going in circles
  it('lets the model answer a short answer each time it comes', async () => {
    const calls = answerAsModel();
    const chat = await openChat('user');

    for (let i = 0; i < 3; i += 1) {
      expect((await ask(chat, 'yes')).content).toBe('Bot answer to: yes');
    }
    expect(purposes(calls)).toEqual(['answer', 'answer', 'answer']);
  });

  it('asks what exactly they want to know the third time a question comes', async () => {
    const calls = answerAsModel();
    const chat = await openChat('user');

    await ask(chat, 'Where is my order now?');
    await ask(chat, 'Where is my order now?');
    const third = await ask(chat, 'Where is my order now?');

    expect(third.content).toContain('the conversation may be repeating');
    expect(purposes(calls)).toEqual(['answer', 'answer', 'fixed_text']);
    expect((await threadRowOf(chat.threadId)).type).toBe('bot');
  });
});

describe('the daily turns of the bot', () => {
  // each turn is a paid call of the model: a customer without a limit runs the bill without one
  it('answers with its own text and asks the model no more once a user used up the day', async () => {
    const limit = env.CHAT_BOT_USER_DAILY_TURNS;
    env.CHAT_BOT_USER_DAILY_TURNS = 2;

    try {
      const calls = answerAsModel();
      const chat = await openChat('user');

      await ask(chat, 'Do you have mugs?');
      await ask(chat, 'And lamps?');
      const third = await ask(chat, 'And chairs?');

      expect(third.content).toBe(
        'I have answered as many messages as I can today. Please come back tomorrow. If you need help now, ask to talk to a real person.',
      );
      expect(calls).toHaveLength(2);
    } finally {
      env.CHAT_BOT_USER_DAILY_TURNS = limit;
    }
  });

  it('still takes a user to an admin past the limit, with the text of the app as it is', async () => {
    const limit = env.CHAT_BOT_USER_DAILY_TURNS;
    env.CHAT_BOT_USER_DAILY_TURNS = 1;

    try {
      const calls = answerAsModel();
      const chat = await openChat('user');

      await ask(chat, 'Do you have mugs?');
      const bot = await ask(chat, 'I need a human please');

      expect(bot.content).toBe(
        'Please describe your issue for the admin. An admin will be able to reply here later. The bot will stop replying in this thread now.',
      );
      expect(calls).toHaveLength(1);
      expect((await threadRowOf(chat.threadId)).type).toBe('admin');
    } finally {
      env.CHAT_BOT_USER_DAILY_TURNS = limit;
    }
  });

  it('counts the turns of a guest against the limit of guests', async () => {
    const limit = env.CHAT_BOT_GUEST_DAILY_TURNS;
    env.CHAT_BOT_GUEST_DAILY_TURNS = 1;

    try {
      const calls = answerAsModel();
      const chat = await openChat('guest');

      await ask(chat, 'Do you have mugs?');
      const second = await ask(chat, 'And lamps?');

      expect(second.content).toBe(
        'I have answered as many messages as I can today. Please come back tomorrow.',
      );
      expect(calls).toHaveLength(1);
    } finally {
      env.CHAT_BOT_GUEST_DAILY_TURNS = limit;
    }
  });
});

describe('what the bot knows of the customer', () => {
  const ordersMessageOf = (call: ModelCall) =>
    call.request.input.find((m) => m.content.startsWith('Orders of the customer'))?.content ?? null;

  // "where is my order": the bot answered from nothing
  it('tells the model the last 5 orders of the user and nothing of anyone else', async () => {
    const csrf = await getCsrf(app);
    const product = await createProduct({ stock: 50 });
    const chat = await openChat('user');
    const user = { id: chat.userId!, role: 'USER' as const, email: '', password: '' };

    const orderIds: number[] = [];
    for (let i = 0; i < 6; i += 1)
      orderIds.push(await placeOrder(app, csrf, user, product, 'waiting'));
    const cart = await placeOrder(app, csrf, user, product, 'cart');

    const other = await createUser();
    userIds.push(other.id);
    const otherOrder = await placeOrder(app, csrf, other, product, 'waiting');

    const calls = answerAsModel();
    await ask(chat, 'Where are my orders?');

    const orders = ordersMessageOf(calls[0]!)!;
    const listed = [...orders.matchAll(/- order (\d+):/g)].map((m) => Number(m[1]));

    expect(listed).toEqual(orderIds.slice(1).reverse());
    expect(orders).toContain('waiting (confirmed, waiting for the payment)');
    expect(listed).not.toContain(cart);
    expect(listed).not.toContain(otherOrder);
  });

  // an admin moves the order of the customer the way the desk does
  async function adminMoves(orderId: number, payload: Record<string, unknown>) {
    const csrf = await getCsrf(app);
    const admin = await createUser({ role: 'ADMIN' });
    userIds.push(admin.id);
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/orders/${orderId}/status`,
      headers: withCsrf(csrf, accessCookie(admin)),
      payload,
    });
    expect(res.statusCode).toBe(200);
  }

  const customerWithOrder = async (
    stage: 'waiting' | 'paid',
    delivery?: Record<string, unknown>,
  ) => {
    const csrf = await getCsrf(app);
    const chat = await openChat('user');
    const user = { id: chat.userId!, role: 'USER' as const, email: '', password: '' };
    const orderId = await placeOrder(
      app,
      csrf,
      user,
      await createProduct({ stock: 5 }),
      stage,
      1,
      delivery,
    );
    return { chat, orderId };
  };

  it('tells the model how the delivery of the shop works', async () => {
    const calls = answerAsModel();
    const chat = await openChat('user');

    await ask(chat, 'How do you deliver?');

    const { instructions } = calls[0]!.request;
    expect(instructions).toContain('the customer picks one when confirming the order');
    expect(instructions).toMatch(
      /- by hand: the shop sends the order to an address in UA, PL, DE or GB;/,
    );
    expect(instructions).toContain('- pickup: the customer collects the order at');
    expect(instructions).toContain(
      'Name no other delivery method, country, price, carrier or delivery time than these.',
    );
  });

  it('tells the model how an order goes, by its country and price, never by the address or the phone', async () => {
    const { chat } = await customerWithOrder('waiting');
    const calls = answerAsModel();

    await ask(chat, 'Where does my order go?');

    const orders = ordersMessageOf(calls[0]!)!;
    expect(orders).toMatch(/delivery: by hand to UA for \d+(\.\d+)? eur/i);
    expect(orders).not.toContain('Test street');
    expect(orders).not.toContain('Kyiv');
    expect(orders).not.toContain(deliveryBody.recipientPhone);
  });

  it('tells the model the carrier and the number an admin wrote when the order was sent', async () => {
    const { chat, orderId } = await customerWithOrder('paid');
    await adminMoves(orderId, {
      status: 'shipped',
      shipment: {
        carrier: 'DHL',
        trackingNumber: 'JD0146',
        trackingUrl: 'https://dhl.example.com/JD0146',
      },
    });
    const calls = answerAsModel();

    await ask(chat, 'Where is my order now?');

    expect(ordersMessageOf(calls[0]!)).toContain(
      `order ${orderId}: shipped (sent, on its way to the customer)`,
    );
    expect(ordersMessageOf(calls[0]!)).toContain(
      'send: carrier DHL, tracking number JD0146, tracking link https://dhl.example.com/JD0146',
    );
  });

  it('tells the model a pickup is ready to collect, not on its way', async () => {
    const { address: _address, ...person } = deliveryBody;
    const { chat, orderId } = await customerWithOrder('paid', { ...person, method: 'pickup' });
    await adminMoves(orderId, { status: 'shipped' });
    const calls = answerAsModel();

    await ask(chat, 'Can I come for my order?');

    expect(ordersMessageOf(calls[0]!)).toContain(
      `order ${orderId}: shipped (ready, waiting for the customer to collect it)`,
    );
    expect(ordersMessageOf(calls[0]!)).toContain('delivery: pickup at the shop');
  });

  // an order with a send or a step taken back: the bot says nothing and hands it to an admin
  it.each([
    [
      'a send taken back',
      async (orderId: number) => {
        await adminMoves(orderId, { status: 'shipped', shipment: { carrier: 'DHL' } });
        await adminMoves(orderId, { status: 'paid', keepShippingCost: false });
      },
    ],
    [
      // no send is taken back here, the order only lost a step: the journal of the admins knows
      'a delivery taken back',
      async (orderId: number) => {
        await adminMoves(orderId, { status: 'shipped', shipment: { carrier: 'DHL' } });
        await adminMoves(orderId, { status: 'delivered' });
        await adminMoves(orderId, { status: 'shipped' });
      },
    ],
  ])(
    'leaves an order with %s to an admin and tells the model nothing of it',
    async (_case, make) => {
      const { chat, orderId } = await customerWithOrder('paid');
      await make(orderId);
      const calls = answerAsModel();

      await ask(chat, 'What happened to my order?');

      const orders = ordersMessageOf(calls[0]!)!;
      expect(orders).toContain(`- order ${orderId}: HUMAN ONLY, an admin handles this order`);
      expect(orders).not.toContain('DHL');
      expect(orders).not.toContain('delivery:');
      expect(orders).toContain('An order marked HUMAN ONLY is for an admin');
    },
  );

  // a cancellation is no event for an admin: the bot tells that the order is cancelled and that the
  // money goes back to the card, never that the shop did it
  it('tells the model a cancelled order is cancelled and its money goes back to the card', async () => {
    const csrf = await getCsrf(app);
    const chat = await openChat('user');
    const user = { id: chat.userId!, role: 'USER' as const, email: '', password: '' };
    const { orderId } = await placePaidOrder(app, csrf, user, await createProduct({ stock: 5 }));
    const admin = await createUser({ role: 'ADMIN' });
    userIds.push(admin.id);
    await cancelPaidOrder(admin.id, orderId);
    const calls = answerAsModel();

    await ask(chat, 'Why was my order cancelled?');

    const orders = ordersMessageOf(calls[0]!)!;
    const line = orders.split('\n').find((one) => one.startsWith(`- order ${orderId}:`))!;
    expect(line).toContain(
      `- order ${orderId}: cancelled (cancelled, the money goes back to the card); total`,
    );
    expect(line).toContain('; paid ');
    expect(orders).not.toContain('HUMAN ONLY');
    expect(orders).not.toContain('by the shop');
    // there is nothing to withdraw from in a cancelled order
    expect(line).not.toContain('withdrawal:');
  });

  it('tells the model the money of a cancelled order went back once it did', async () => {
    const csrf = await getCsrf(app);
    const chat = await openChat('user');
    const user = { id: chat.userId!, role: 'USER' as const, email: '', password: '' };
    const { orderId } = await placePaidOrder(app, csrf, user, await createProduct({ stock: 5 }));
    const admin = await createUser({ role: 'ADMIN' });
    userIds.push(admin.id);
    const { refundedAt } = await cancelAndRefund(admin.id, orderId);
    const calls = answerAsModel();

    await ask(chat, 'Where is my money?');

    const orders = ordersMessageOf(calls[0]!)!;
    const line = orders.split('\n').find((one) => one.startsWith(`- order ${orderId}:`))!;
    expect(line).toContain(`- order ${orderId}: cancelled (cancelled, the money goes back to the card)`);
    expect(line).toContain(
      '; returns: all statements are closed and all the money went back',
    );
    expect(line).toMatch(/: closed; money: refunded [\d.]+ EUR for 1 unit\(s\) on /);
    expect(line).toContain(`on ${refundedAt.toISOString()} (UTC)`);
    expect(orders).not.toContain('HUMAN ONLY');
  });

  it('tells the model a guest has no orders', async () => {
    const calls = answerAsModel();
    const chat = await openChat('guest');

    await ask(chat, 'Where are my orders?');

    expect(ordersMessageOf(calls[0]!)).toBeNull();
    expect(calls[0]!.request.instructions).toContain('A guest has no orders');
  });
});

// the product context of the prompt: the products a buyer sees, each with its variants
describe('what the bot knows of the products', () => {
  const productsMessageOf = (call: ModelCall) =>
    call.request.input.find((m) => m.content.startsWith('Available product context'))?.content ??
    null;

  // the bot searches the catalog by the words of the customer: a word of its own finds one product
  const wordOf = () => `quokka${randomUUID().replace(/-/g, '').slice(0, 8)}`;

  const named = async (word: string, opts: Parameters<typeof createProduct>[0] = {}) =>
    createProduct({ name: `Lamp ${word}`, ...opts });

  const askAbout = async (word: string) => {
    const calls = answerAsModel();
    const chat = await openChat('user');
    await ask(chat, `${word}?`);

    return productsMessageOf(calls[0]!);
  };

  it('names the variants a buyer sees, each with its price, the sale while it lasts and the free units', async () => {
    const word = wordOf();
    const product = await named(word, { price: 10, stock: 3 });
    const second = await createVariant(product.id, { price: 12, stock: 2 });
    await putOnSale({ variantId: second.id }, 9);

    const context = await askAbout(word);

    expect(context).toContain(`- product id: ${product.id}; name: Lamp ${word};`);
    expect(context).toContain(
      `  - variant id: ${product.variantId}; name: Lamp ${word}; price: 10 EUR; in stock: 3`,
    );
    expect(context).toMatch(
      new RegExp(
        `  - variant id: ${second.id}; name: Lamp ${word}; price: 12 EUR; sale price: 9 EUR until \\S+ \\(UTC\\); in stock: 2`,
      ),
    );
    expect(context).toContain('Use only this product context when recommending specific products');
  });

  it('counts the free units of a variant: what a waiting order holds is not free', async () => {
    const word = wordOf();
    const product = await named(word, { price: 10, stock: 5 });
    const second = await createVariant(product.id, { price: 11, stock: 4 });
    const csrf = await getCsrf(app);
    const buyer = await createUser();
    userIds.push(buyer.id);
    await placeOrder(app, csrf, buyer, product, 'waiting', 2);

    const context = await askAbout(word);

    expect(context).toContain(`variant id: ${product.variantId};`);
    expect(context).toMatch(new RegExp(`variant id: ${product.variantId};[^\\n]*in stock: 3`));
    expect(context).toMatch(new RegExp(`variant id: ${second.id};[^\\n]*in stock: 4`));
  });

  it('names a variant that is sold out as sold out, while another one has units', async () => {
    const word = wordOf();
    const product = await named(word, { price: 10, stock: 0 });
    const second = await createVariant(product.id, { price: 11, stock: 2 });

    const context = await askAbout(word);

    expect(context).toMatch(new RegExp(`variant id: ${product.variantId};[^\\n]*in stock: 0`));
    expect(context).toMatch(new RegExp(`variant id: ${second.id};[^\\n]*in stock: 2`));
    // the variant with units is named first
    expect(context!.indexOf(`variant id: ${second.id};`)).toBeLessThan(
      context!.indexOf(`variant id: ${product.variantId};`),
    );
  });

  it('knows nothing of a variant taken out of sale or one that shows no picture', async () => {
    const word = wordOf();
    const product = await named(word, { price: 10, stock: 3 });
    const gone = await createVariant(product.id, { price: 11, stock: 3 });
    const bare = await createVariant(product.id, { price: 12, stock: 3 });
    await asAdmin((tx) =>
      tx.productVariant.update({ where: { id: gone.id }, data: { deletedAt: new Date() } }),
    );
    await asAdmin((tx) => tx.variantImage.deleteMany({ where: { variantId: bare.id } }));

    const context = await askAbout(word);

    expect(context).toContain(`variant id: ${product.variantId};`);
    expect(context).not.toContain(`variant id: ${gone.id};`);
    expect(context).not.toContain(`variant id: ${bare.id};`);
  });

  it.each([
    [
      'a product taken out of the catalog',
      async (word: string) => {
        const product = await named(word, { stock: 3 });
        await deleteProductFromCatalog(product.id);
      },
    ],
    [
      'a product whose variants show no picture',
      async (word: string) => {
        const product = await named(word, { stock: 3 });
        await asAdmin((tx) =>
          tx.variantImage.deleteMany({ where: { variant: { productId: product.id } } }),
        );
      },
    ],
    [
      'a product with no unit free to buy',
      async (word: string) => {
        await named(word, { stock: 0 });
      },
    ],
  ])('does not recommend %s', async (_case, make) => {
    const word = wordOf();
    await make(word);

    expect(await askAbout(word)).not.toContain(word);
  });

  // the prompt is a paid input of every turn: it does not grow with the variants of a shop
  it('names 20 variants of a product at most and sums up the rest', async () => {
    const word = wordOf();
    const product = await named(word, { price: 10, stock: 2 });
    const ids = [product.variantId];
    for (let n = 1; n < 22; n += 1) {
      ids.push((await createVariant(product.id, { price: 10 + n, stock: 2 })).id);
    }

    const context = (await askAbout(word))!;

    const listed = [...context.matchAll(/ {2}- variant id: (\d+);/g)].map((m) => Number(m[1]));
    expect(listed).toEqual(ids.slice(0, 20));
    expect(context).toContain(
      '  - 2 more variants are not listed (2 of them in stock), they sell at 30 to 31 EUR; name no detail of them',
    );
  });

  it('keeps a long description out of the prompt', async () => {
    const word = wordOf();
    const product = await named(word, { stock: 2 });
    await asAdmin((tx) =>
      tx.product.update({ where: { id: product.id }, data: { description: 'y'.repeat(3000) } }),
    );

    const context = (await askAbout(word))!;

    expect(context).toContain(`description: ${'y'.repeat(500)}...`);
    expect(context).not.toContain('y'.repeat(501));
  });
});

// the names of the items of an order are the copies of the confirmation, not the names of now
describe('what the bot knows of the items of the orders', () => {
  it('tells the model the name an item was confirmed with, not the name of its product now', async () => {
    const csrf = await getCsrf(app);
    const chat = await openChat('user');
    const user = { id: chat.userId!, role: 'USER' as const, email: '', password: '' };
    const tag = randomUUID().slice(0, 8);
    const product = await createProduct({ name: `Alpha mug ${tag}`, stock: 5 });
    const orderId = await placeOrder(app, csrf, user, product, 'waiting', 2);
    await asAdmin((tx) =>
      tx.product.update({ where: { id: product.id }, data: { name: `Beta mug ${tag}` } }),
    );
    const calls = answerAsModel();

    await ask(chat, 'Where is my order now?');

    const orders = calls[0]!.request.input.find((m) =>
      m.content.startsWith('Orders of the customer'),
    )!.content;
    expect(orders).toContain(`- order ${orderId}: waiting`);
    expect(orders).toContain(`items: Alpha mug ${tag} x 2`);
    expect(orders).not.toContain('Beta mug');
  });
});

// each turn is a paid call of the model; a new cookie, a new account or a crowd of addresses does not
// lift the limits
describe('the limits of the bot against abuse', () => {
  const IP_A = '203.0.113.10';
  const IP_B = '203.0.113.11';

  const GUEST_LIMIT_TEXT =
    'I have answered as many messages as I can today. Please come back tomorrow.';
  const FALLBACK_TEXT =
    'I cannot answer reliably right now. Please try again later or ask for admin support.';

  let limits: Pick<
    typeof env,
    | 'CHAT_BOT_GUEST_DAILY_TURNS'
    | 'CHAT_BOT_USER_DAILY_TURNS'
    | 'CHAT_BOT_IP_DAILY_TURNS'
    | 'CHAT_BOT_SHOP_DAILY_TURNS'
  >;

  beforeEach(() => {
    limits = {
      CHAT_BOT_GUEST_DAILY_TURNS: env.CHAT_BOT_GUEST_DAILY_TURNS,
      CHAT_BOT_USER_DAILY_TURNS: env.CHAT_BOT_USER_DAILY_TURNS,
      CHAT_BOT_IP_DAILY_TURNS: env.CHAT_BOT_IP_DAILY_TURNS,
      CHAT_BOT_SHOP_DAILY_TURNS: env.CHAT_BOT_SHOP_DAILY_TURNS,
    };
  });

  afterEach(() => {
    Object.assign(env, limits);
  });

  describe('by the address', () => {
    // the limit of a guest is by its guest id: a new cookie started the day again
    it('stops a guest who takes a new cookie for each question, the address stays the same', async () => {
      env.CHAT_BOT_IP_DAILY_TURNS = 3;
      const calls = answerAsModel();

      const answers: string[] = [];
      for (const question of ['one?', 'two?', 'three?', 'four?', 'five?']) {
        answers.push((await ask(await openChat('guest', IP_A), question)).content);
      }

      expect(answers).toEqual([
        'Bot answer to: one?',
        'Bot answer to: two?',
        'Bot answer to: three?',
        GUEST_LIMIT_TEXT,
        GUEST_LIMIT_TEXT,
      ]);
      expect(calls).toHaveLength(3);
    });

    it('counts another address on its own', async () => {
      env.CHAT_BOT_IP_DAILY_TURNS = 1;
      const calls = answerAsModel();

      await ask(await openChat('guest', IP_A), 'one?');
      const blocked = await ask(await openChat('guest', IP_A), 'two?');
      const other = await ask(await openChat('guest', IP_B), 'three?');

      expect(blocked.content).toBe(GUEST_LIMIT_TEXT);
      expect(other.content).toBe('Bot answer to: three?');
      expect(calls).toHaveLength(2);
    });

    // an account made for the purpose is no confirmed account: its address counts the same
    it('counts the turns of users who have not confirmed the email together with the guests', async () => {
      env.CHAT_BOT_IP_DAILY_TURNS = 2;
      const calls = answerAsModel();

      await ask(await openChat('guest', IP_A), 'one?');
      await ask(await openChat('unverified', IP_A), 'two?');
      const blocked = await ask(await openChat('unverified', IP_A), 'three?');

      expect(blocked.content).toBe(GUEST_LIMIT_TEXT);
      expect(calls).toHaveLength(2);
    });

    it('leaves a user with a confirmed email alone, whoever else writes from the address', async () => {
      env.CHAT_BOT_IP_DAILY_TURNS = 1;
      const calls = answerAsModel();

      await ask(await openChat('guest', IP_A), 'one?');
      const blocked = await ask(await openChat('guest', IP_A), 'two?');
      const first = await ask(await openChat('user', IP_A), 'three?');
      const second = await ask(await openChat('user', IP_A), 'four?');

      expect(blocked.content).toBe(GUEST_LIMIT_TEXT);
      expect([first.content, second.content]).toEqual([
        'Bot answer to: three?',
        'Bot answer to: four?',
      ]);
      expect(calls).toHaveLength(3);
    });

    it('counts the addresses of one IPv6 network as one', async () => {
      env.CHAT_BOT_IP_DAILY_TURNS = 1;
      const calls = answerAsModel();

      await ask(await openChat('guest', '2001:db8:aa:bb::1'), 'one?');
      const blocked = await ask(await openChat('guest', '2001:db8:aa:bb:cc::2'), 'two?');

      expect(blocked.content).toBe(GUEST_LIMIT_TEXT);
      expect(calls).toHaveLength(1);
    });

    // asking for a person costs the bill nothing but the fixed text, and it is the way out
    it('still tells a guest the answer to a request for a person, with the text of the app as it is', async () => {
      env.CHAT_BOT_IP_DAILY_TURNS = 1;
      const calls = answerAsModel();

      await ask(await openChat('guest', IP_A), 'one?');
      const bot = await ask(await openChat('guest', IP_A), 'I need a human please');

      expect(bot.content).toContain(
        'Only logged-in customers with a confirmed email can talk to an admin.',
      );
      expect(calls).toHaveLength(1);
    });
  });

  describe('by the account that has not confirmed the email', () => {
    it('gives it the limit of a guest, a user with a confirmed email has the limit of users', async () => {
      env.CHAT_BOT_GUEST_DAILY_TURNS = 1;
      env.CHAT_BOT_USER_DAILY_TURNS = 3;
      const calls = answerAsModel();
      const unverified = await openChat('unverified');
      const confirmed = await openChat('user');

      const unverifiedAnswers = [
        (await ask(unverified, 'one?')).content,
        (await ask(unverified, 'two?')).content,
      ];
      const confirmedAnswers = [
        (await ask(confirmed, 'one?')).content,
        (await ask(confirmed, 'two?')).content,
      ];

      expect(unverifiedAnswers).toEqual(['Bot answer to: one?', GUEST_LIMIT_TEXT]);
      expect(confirmedAnswers).toEqual(['Bot answer to: one?', 'Bot answer to: two?']);
      expect(calls).toHaveLength(3);
    });

    it('does not offer it the admin in the text past the limit, it cannot talk to one', async () => {
      env.CHAT_BOT_GUEST_DAILY_TURNS = 1;
      answerAsModel();
      const chat = await openChat('unverified');

      await ask(chat, 'one?');
      const past = await ask(chat, 'two?');

      expect(past.content).toBe(GUEST_LIMIT_TEXT);
      expect(past.content).not.toContain('real person');
    });
  });

  describe('by the whole shop', () => {
    it('answers with the fallback text and asks the model nothing once the shop used up its day', async () => {
      env.CHAT_BOT_SHOP_DAILY_TURNS = 2;
      const calls = answerAsModel();

      const answers = [
        (await ask(await openChat('guest', IP_A), 'one?')).content,
        (await ask(await openChat('user', IP_B), 'two?')).content,
        (await ask(await openChat('user', IP_B), 'three?')).content,
        (await ask(await openChat('guest', '203.0.113.99'), 'four?')).content,
      ];

      expect(answers).toEqual([
        'Bot answer to: one?',
        'Bot answer to: two?',
        FALLBACK_TEXT,
        FALLBACK_TEXT,
      ]);
      expect(calls).toHaveLength(2);
    });

    // a customer past their own limit takes no turn of the shop: the model is not asked for them
    it('counts only the turns that call the model', async () => {
      env.CHAT_BOT_SHOP_DAILY_TURNS = 2;
      env.CHAT_BOT_GUEST_DAILY_TURNS = 1;
      const calls = answerAsModel();
      const chat = await openChat('guest', IP_A);

      await ask(chat, 'one?');
      for (const question of ['two?', 'three?', 'four?']) {
        expect((await ask(chat, question)).content).toBe(GUEST_LIMIT_TEXT);
      }
      const other = await ask(await openChat('guest', IP_B), 'five?');

      expect(other.content).toBe('Bot answer to: five?');
      expect(calls).toHaveLength(2);
    });

    it('still takes a user with a confirmed email to an admin, with the text of the app as it is', async () => {
      env.CHAT_BOT_SHOP_DAILY_TURNS = 1;
      const calls = answerAsModel();
      await ask(await openChat('user'), 'one?');
      const chat = await openChat('user');

      const bot = await ask(chat, 'I need a human please');

      expect(bot.content).toBe(
        'Please describe your issue for the admin. An admin will be able to reply here later. The bot will stop replying in this thread now.',
      );
      expect(calls).toHaveLength(1);
      expect((await threadRowOf(chat.threadId)).type).toBe('admin');
    });
  });

  // the most the model may write in an answer: the bill of an answer is bounded whatever it is asked
  describe('the length of the answer of the model', () => {
    it('is bounded in every request the bot makes', async () => {
      const calls = answerAsModel();
      const chat = await openChat('user');

      await ask(chat, 'Do you have mugs?');
      await ask(chat, 'I need a human please');

      // the answer of the bot has the ceiling of the setting, a fixed text a smaller one of its own
      expect(env.OPENAI_MAX_OUTPUT_TOKENS).toBeGreaterThan(0);
      expect(env.OPENAI_MAX_OUTPUT_TOKENS).toBeLessThanOrEqual(1000);
      expect(calls.map((call) => [call.purpose, call.request.max_output_tokens])).toEqual([
        ['answer', env.OPENAI_MAX_OUTPUT_TOKENS],
        ['fixed_text', 120],
      ]);
    });
  });
});

describe('a model that fails', () => {
  // the json of the answer breaks off at the limit, asking the same again gets the same piece
  it('sends the fallback after an answer cut short and does not ask the same again', async () => {
    const calls = answerAsModel((call) =>
      call.purpose === 'answer'
        ? modelResponse('{"reply":"We have six lamps: the fir', { incomplete: 'max_output_tokens' })
        : plainAnswer(call),
    );
    const chat = await openChat('user');

    const bot = await ask(chat, 'Tell me about all your lamps');

    expect(bot.content).toContain('cannot answer reliably right now');
    expect(purposes(calls)).toEqual(['answer', 'fixed_text']);
    expect(takeLogs({ msg: 'chat bot ai request failed' })).toEqual([
      expect.objectContaining({ code: 'AI_INCOMPLETE_RESPONSE', willRetry: false }),
    ]);
  });
});
