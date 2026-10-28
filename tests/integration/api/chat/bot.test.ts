import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from '@jest/globals';

import env from '@config/env.js';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { closeChatSockets, openChatSocket, type ChatSocket } from '../../../helpers/chatSocket.js';
import { getCsrf, withCsrf } from '../../../helpers/csrf.js';
import { asAdmin } from '../../../helpers/db.js';
import { closeSessions, createProduct, createUser } from '../../../helpers/factories.js';
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

// the bot asks the model of the app; here the model is the test's (tests/helpers/openai.ts): the
// decision whether a person is needed is the model's, so the test decides it

let app: FastifyInstance;
const userIds: number[] = [];

beforeAll(async () => {
  app = await startApp();
});

afterEach(stopModel);

afterAll(async () => {
  closeChatSockets();

  try {
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

type Chat = { userId: number | null; cookie: string; threadId: string; socket: ChatSocket };

// a customer with the chat open the way the widget opens it: the current chat through the api,
// then its socket joined to the thread
async function openChat(kind: 'user' | 'unverified' | 'guest'): Promise<Chat> {
  let cookie = `guestId=${randomUUID()}`;
  let userId: number | null = null;

  if (kind !== 'guest') {
    const user = await createUser({ isVerified: kind === 'user' });
    userIds.push(user.id);
    userId = user.id;
    cookie = accessCookie(user);
  }

  const res = await app.inject({
    method: 'GET',
    url: '/api/chat/thread/current',
    headers: { cookie },
  });
  expect(res.statusCode).toBe(200);
  const threadId = res.json().thread.id as string;

  const socket = await openChatSocket(app, { cookie });
  await socket.join(threadId);

  return { userId, cookie, threadId, socket };
}

const say = (chat: Chat, content: string) =>
  chat.socket.send({ type: 'message:send', payload: { threadId: chat.threadId, content } });

// the next message of the sender that reaches the socket of the chat
const nextMessage = async (chat: Chat, senderType: 'user' | 'guest' | 'bot') =>
  (await chat.socket.take('message:new', (e) => e.payload.senderType === senderType)).payload as {
    id: number;
    content: string;
    createdAt: string;
  };

// the customer says it and waits for the bot to answer
async function ask(chat: Chat, content: string) {
  say(chat, content);
  return nextMessage(chat, 'bot');
}

const threadRowOf = (threadId: string) =>
  asAdmin((tx) => tx.chatThread.findUniqueOrThrow({ where: { id: threadId } }));

const messageRowsOf = (threadId: string) =>
  asAdmin((tx) => tx.chatMessage.findMany({ where: { threadId }, orderBy: { id: 'asc' } }));

async function openAdminSocket() {
  const admin = await createUser({ role: 'ADMIN' });
  userIds.push(admin.id);

  return {
    cookie: accessCookie(admin),
    socket: await openChatSocket(app, { cookie: accessCookie(admin) }),
  };
}

// whether the thread is in the queue of chats waiting for an admin
async function isWaitingForAdmin(adminCookie: string, threadId: string) {
  const res = await app.inject({
    method: 'GET',
    url: '/api/chat/admin/threads?queue=waiting&limit=100',
    headers: { cookie: adminCookie },
  });
  expect(res.statusCode).toBe(200);

  return (res.json().items as Array<{ id: string }>).some((thread) => thread.id === threadId);
}

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

  // an order with a send taken back or a cancellation: the bot says nothing and hands it to an admin
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

  it('leaves a cancelled order to an admin and tells the model nothing of it', async () => {
    const csrf = await getCsrf(app);
    const chat = await openChat('user');
    const user = { id: chat.userId!, role: 'USER' as const, email: '', password: '' };
    const { orderId } = await placePaidOrder(app, csrf, user, await createProduct({ stock: 5 }));
    const admin = await createUser({ role: 'ADMIN' });
    userIds.push(admin.id);
    const cancelled = await app.inject({
      method: 'POST',
      url: `/api/orders/${orderId}/cancel`,
      headers: withCsrf(csrf, accessCookie(admin)),
    });
    expect(cancelled.statusCode).toBe(200);
    const calls = answerAsModel();

    await ask(chat, 'Why was my order cancelled?');

    const orders = ordersMessageOf(calls[0]!)!;
    expect(orders).toContain(`- order ${orderId}: HUMAN ONLY, an admin handles this order`);
    expect(orders).not.toContain('cancelled');
  });

  it('tells the model a guest has no orders', async () => {
    const calls = answerAsModel();
    const chat = await openChat('guest');

    await ask(chat, 'Where are my orders?');

    expect(ordersMessageOf(calls[0]!)).toBeNull();
    expect(calls[0]!.request.instructions).toContain('A guest has no orders');
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
