import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from '@jest/globals';

import { startApp, stopApp } from '../../helpers/app.js';
import { chatBotDriver } from '../../helpers/chatBot.js';
import { closeChatSockets, openChatSocket } from '../../helpers/chatSocket.js';
import { getCsrf, type Csrf } from '../../helpers/csrf.js';
import { closeSessions } from '../../helpers/factories.js';
import { takeLogs } from '../../helpers/logs.js';
import { answerAsModel, modelResponse, plainAnswer, stopModel } from '../../helpers/openai.js';
import { journeyOf } from '../../helpers/returnJourney.js';

// The help of the chat, each step with what its actor sees: a customer talks to the bot and asks
// for a person in words, or presses the button the bot leaves when it cannot answer; the chat comes
// to the queue of the admins, an admin opens it, answers on the socket and closes it; the customer
// reads the talk and the next chat is a new one with the bot. The rules of each step (the button,
// the queues, the socket) are the tests of api/chat.
let app: FastifyInstance;
let csrf: Csrf;
const userIds: number[] = [];
const bot = chatBotDriver({ app: () => app, userIds });
const j = journeyOf(
  () => app,
  () => csrf,
);

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
});

afterEach(() => {
  stopModel();
});

afterAll(async () => {
  try {
    closeChatSockets();
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

type Thread = { id: string; type: string; status: string };
type Message = { senderType: string; content: string };

// the model hands the chat over when the customer asks for a person
const handsOverOnRequest = () =>
  answerAsModel((call) =>
    call.purpose === 'answer' && /person/i.test(call.customerText ?? '')
      ? { reply: 'An admin will answer you here.', escalate: true, reason: 'DIRECT_ADMIN_REQUEST' }
      : plainAnswer(call),
  );

describe('the help of the chat', () => {
  it('a customer asks the bot, then a person; an admin answers and closes the chat, the next one is with the bot', async () => {
    handsOverOnRequest();
    const admin = await bot.openAdminSocket();
    const chat = await bot.openChat('user');

    const answer = await bot.ask(chat, 'Do you have lamps?');
    expect(answer.content).toContain('Bot answer to:');
    await bot.ask(chat, 'I need a person, my lamp came broken');
    bot.say(chat, 'Order 5, the glass is cracked');
    await admin.socket.take('admin:requested', (e) => e.payload.thread.id === chat.threadId);

    // the admin finds the chat in the waiting queue, opens it and answers on the socket
    const queue = await j.get(admin.admin, '/api/chat/admin/threads?queue=waiting&limit=100');
    expect((queue.json().items as Thread[]).map(({ id }) => id)).toContain(chat.threadId);
    const opened = await j.get(admin.admin, `/api/chat/admin/threads/${chat.threadId}`);
    expect(opened.statusCode).toBe(200);
    expect((opened.json().messages as Message[]).map(({ content }) => content)).toContain(
      'Order 5, the glass is cracked',
    );
    await admin.socket.join(chat.threadId);
    admin.socket.send({
      type: 'message:send',
      payload: { threadId: chat.threadId, content: 'We send you a new lamp.' },
    });
    const reply = await chat.socket.take('message:new', (e) => e.payload.senderType === 'admin');
    expect(reply.payload.content).toBe('We send you a new lamp.');

    const closed = await j.patch(admin.admin, `/api/chat/admin/threads/${chat.threadId}/close`, {});
    expect(closed.statusCode).toBe(200);

    // the customer reads the whole talk; the next chat is a new one with the bot
    const talk = await j.get(chat.user, `/api/chat/threads/${chat.threadId}/messages`);
    expect((talk.json().messages as Message[]).map(({ senderType }) => senderType)).toEqual(
      expect.arrayContaining(['user', 'bot', 'admin']),
    );
    const next = await j.get(chat.user, '/api/chat/thread/current');
    expect(next.json().thread).toMatchObject({ type: 'bot', status: 'open' });
    expect(next.json().thread.id).not.toBe(chat.threadId);
  });

  it('a customer the bot could not answer presses the button and the chat comes to the admins', async () => {
    const admin = await bot.openAdminSocket();
    const chat = await bot.openChat('user');

    // the answer of the model breaks off: the bot apologises and leaves the button
    answerAsModel((call) =>
      call.purpose === 'answer'
        ? modelResponse('{"reply":"We have six lamps: the fir', { incomplete: 'max_output_tokens' })
        : plainAnswer(call),
    );
    await bot.ask(chat, 'Tell me about all your lamps');
    expect(takeLogs({ msg: 'chat bot ai request failed' })).toHaveLength(1);
    expect((await chat.socket.take('thread:admin-call')).payload.available).toBe(true);
    expect((await j.get(chat.user, '/api/chat/thread/current')).json().adminCallAvailable).toBe(
      true,
    );

    const called = await j.post(chat.user, `/api/chat/threads/${chat.threadId}/call-admin`);
    expect(called.statusCode).toBe(200);
    bot.say(chat, 'Which lamp is the brightest?');
    const requested = await admin.socket.take(
      'admin:requested',
      (e) => e.payload.thread.id === chat.threadId,
    );
    expect(requested.payload.thread).toMatchObject({ type: 'admin' });
  });

  it('a guest talks to the bot in the widget and reads the talk', async () => {
    const guest = `guestId=${crypto.randomUUID()}`;
    const guestChat = await app.inject({
      method: 'GET',
      url: '/api/chat/thread/current',
      headers: { cookie: guest },
    });
    const guestThread = guestChat.json().thread.id as string;
    const socket = await openChatSocket(app, { cookie: guest });
    await socket.join(guestThread);
    answerAsModel();
    socket.send({ type: 'message:send', payload: { threadId: guestThread, content: 'Hi there' } });
    await socket.take('message:new', (e) => e.payload.senderType === 'bot');
    const read = await app.inject({
      method: 'GET',
      url: `/api/chat/threads/${guestThread}/messages`,
      headers: { cookie: guest },
    });
    expect((read.json().messages as Message[]).map(({ senderType }) => senderType)).toEqual(
      expect.arrayContaining(['guest', 'bot']),
    );
  });
});
