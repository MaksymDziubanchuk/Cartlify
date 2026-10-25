import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from '@jest/globals';

import env from '@config/env.js';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { closeChatSockets, openChatSocket, type ChatSocket } from '../../../helpers/chatSocket.js';
import { asAdmin } from '../../../helpers/db.js';
import { closeSessions, createProduct, createUser } from '../../../helpers/factories.js';
import { realOpenAi, stopModel, useModel } from '../../../helpers/openai.js';

// the model of the bot itself: the test's own unless the run takes openai for real (service:openai,
// a few cents a run). These tests check what does not hang on the words of the model: an answer
// comes and is not the fallback text of the app, the request keeps nothing at openai and asks for
// the structured answer of the app. What the bot does with a decision of the model is in
// bot.test.ts, with the model of the test

let app: FastifyInstance;
const userIds: number[] = [];

// the text the bot sends when the model gives no answer it can use
const FALLBACK = 'cannot answer reliably right now';

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

type Chat = { threadId: string; socket: ChatSocket };

// a customer with the chat open the way the widget opens it
async function openChat(kind: 'user' | 'guest'): Promise<Chat> {
  let cookie = `guestId=${randomUUID()}`;

  if (kind === 'user') {
    const user = await createUser({ isVerified: true });
    userIds.push(user.id);
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

  return { threadId, socket };
}

// the customer says it and waits for the answer of the bot; the real model takes a few seconds
async function ask(chat: Chat, content: string) {
  chat.socket.send({ type: 'message:send', payload: { threadId: chat.threadId, content } });

  return (await chat.socket.take('message:new', (e) => e.payload.senderType === 'bot', 25_000))
    .payload as { content: string };
}

describe(`the model of the bot (${realOpenAi ? 'openai' : 'the model of the test'})`, () => {
  it('answers a question about the catalog with an answer of its own', async () => {
    const lampName = `Brass desk lamp ${randomUUID().slice(0, 8)}`;
    await createProduct({ name: lampName, price: 49.9, stock: 3 });
    const calls = useModel();
    const chat = await openChat('user');

    const bot = await ask(chat, `Do you sell the ${lampName}? What does it cost?`);

    expect(bot.content.trim()).not.toBe('');
    expect(bot.content).not.toContain(FALLBACK);
    expect(calls.map((call) => call.purpose)).toEqual(['answer']);
    const [call] = calls;
    // nothing of the chat stays at openai, and the answer comes in the schema of the app
    expect(call!.request).toMatchObject({
      model: env.OPENAI_MODEL,
      store: false,
      text: { format: { type: 'json_schema', name: 'chat_bot_reply', strict: true } },
    });
    if (realOpenAi) expect(call!.status).toBe(200);
    // the request named the product of the catalog it asked about
    expect(JSON.stringify(call!.request)).toContain(lampName);
  });

  // a fixed text of the app the model puts in the words of the customer
  it('tells a guest who asks for a person that it takes a confirmed email', async () => {
    const calls = useModel();
    const chat = await openChat('guest');

    const bot = await ask(chat, 'I need a human please');

    expect(bot.content).toMatch(/e-?mail/i);
    expect(bot.content).not.toContain(FALLBACK);
    expect(calls.map((call) => call.purpose)).toEqual(['fixed_text']);
    expect(calls[0]!.request).toMatchObject({ store: false });
    if (realOpenAi) expect(calls[0]!.status).toBe(200);
    // the chat stays with the bot
    const thread = await asAdmin((tx) =>
      tx.chatThread.findUniqueOrThrow({ where: { id: chat.threadId } }),
    );
    expect(thread).toMatchObject({ type: 'bot', adminRequestedAt: null });
  });
});
