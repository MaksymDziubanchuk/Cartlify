import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';

import env from '@config/env.js';
import { getRedis } from '@redis/client.js';
import { redisKeys } from '@redis/keys.js';
import { botLimits } from '@routes/api/chat/services/bot/chatBotLimits.service.js';
import { ADMIN_CALL_TEXT } from '@routes/api/chat/services/callAdminChat.service.js';
import { ADMIN_CALL_TTL_SECONDS } from '@routes/api/chat/services/helpers/adminCall.helper.js';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { chatBotDriver, type Chat } from '../../../helpers/chatBot.js';
import { closeChatSockets } from '../../../helpers/chatSocket.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import {
  closeSessions,
  createChatThread,
  createUser,
  type TestUser,
} from '../../../helpers/factories.js';
import { takeLogs } from '../../../helpers/logs.js';
import { answerAsModel, modelResponse, plainAnswer, stopModel } from '../../../helpers/openai.js';

// The button "call an admin" (spec 10.5 to 10.7). When the bot cannot answer a user with a
// confirmed email (the model gives no answer, the turns of the shop or the turns of the user are
// used up) the chat gets a mark in redis for 30 minutes and the customer is told that the button is
// there: GET /api/chat/thread/current has adminCallAvailable and the socket sends thread:admin-call.
// The mark is set again by every failure and taken away by a turn the model answers, by the chat
// going to the admins, and by the time. POST /api/chat/threads/:threadId/call-admin gives a chat that
// has the mark to the admins. A guest and a user who has not confirmed the email never get the button.
// The model is the test's (helpers/openai.ts), the bot's failures are made by it and by the limits

let app: FastifyInstance;
let csrf: Csrf;
const userIds: number[] = [];

const {
  openChat,
  say,
  ask,
  settled,
  threadRowOf,
  messageRowsOf,
  openAdminSocket,
  isWaitingForAdmin,
} = chatBotDriver({ app: () => app, userIds });

let limits: Pick<
  typeof env,
  | 'CHAT_BOT_GUEST_DAILY_TURNS'
  | 'CHAT_BOT_USER_DAILY_TURNS'
  | 'CHAT_BOT_SHOP_DAILY_TURNS'
  | 'LIMIT_CHAT_CALL_ADMIN_PER_USER'
  | 'REQUEST_LIMITS_SCALE'
>;

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
});

beforeEach(() => {
  limits = {
    CHAT_BOT_GUEST_DAILY_TURNS: env.CHAT_BOT_GUEST_DAILY_TURNS,
    CHAT_BOT_USER_DAILY_TURNS: env.CHAT_BOT_USER_DAILY_TURNS,
    CHAT_BOT_SHOP_DAILY_TURNS: env.CHAT_BOT_SHOP_DAILY_TURNS,
    LIMIT_CHAT_CALL_ADMIN_PER_USER: env.LIMIT_CHAT_CALL_ADMIN_PER_USER,
    REQUEST_LIMITS_SCALE: env.REQUEST_LIMITS_SCALE,
  };
  // the counts of the addresses and of the shop are of the process: each test starts from none
  botLimits.reset();
});

afterEach(() => {
  Object.assign(env, limits);
  stopModel();
  jest.restoreAllMocks();
});

afterAll(async () => {
  closeChatSockets();

  try {
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

// ---- the mark of a chat in redis ----

const markKeyOf = (threadId: string) => `${redisKeys.chatAdminCallPrefix}${threadId}`;

const hasMark = async (threadId: string) =>
  (await (await getRedis()).exists(markKeyOf(threadId))) > 0;

const markTtlOf = async (threadId: string) => (await getRedis()).ttl(markKeyOf(threadId));

// the mark the way the bot puts it, for the tests of the route that do not need a failure of the bot
const putMark = async (threadId: string) =>
  (await getRedis()).set(markKeyOf(threadId), '1', { EX: ADMIN_CALL_TTL_SECONDS });

// ---- the api ----

const currentOf = async (cookie: string) => {
  const res = await app.inject({
    method: 'GET',
    url: '/api/chat/thread/current',
    headers: { cookie },
  });
  expect(res.statusCode).toBe(200);

  return res.json();
};

const callAdmin = (
  threadId: string,
  who: Pick<TestUser, 'id' | 'role'> | string | null,
  opts: { csrf?: boolean } = {},
) => {
  const cookie =
    typeof who === 'string' ? who : who ? accessCookie(who) : `guestId=${randomUUID()}`;

  return app.inject({
    method: 'POST',
    url: `/api/chat/threads/${threadId}/call-admin`,
    headers: opts.csrf === false ? { cookie } : withCsrf(csrf, cookie),
  });
};

// ---- the failures of the bot ----

// a model that gives no usable answer: the json of the answer breaks off at the limit
const failingModel = () =>
  answerAsModel((call) =>
    call.purpose === 'answer'
      ? modelResponse('{"reply":"We have six lamps: the fir', { incomplete: 'max_output_tokens' })
      : plainAnswer(call),
  );

type Down = 'model' | 'shop' | 'limit';

// the chat asks and the bot cannot answer, three ways: the model gives no answer, the shop used up
// its turns of the day, the customer used up theirs (the first question is answered, the second is
// past the limit). Returns what the bot wrote to the last question
async function botDown(chat: Chat, how: Down): Promise<string> {
  if (how === 'model') {
    failingModel();
    const bot = await ask(chat, 'Tell me about all your lamps');
    // the failure of the model is logged, as it is in the tests of the model that fails
    expect(takeLogs({ msg: 'chat bot ai request failed' })).toHaveLength(1);

    return bot.content;
  }

  answerAsModel();

  if (how === 'shop') {
    env.CHAT_BOT_SHOP_DAILY_TURNS = 0;

    return (await ask(chat, 'Tell me about all your lamps')).content;
  }

  // a user who has not confirmed the email has the limit of a guest
  env.CHAT_BOT_USER_DAILY_TURNS = 1;
  env.CHAT_BOT_GUEST_DAILY_TURNS = 1;
  await ask(chat, 'Do you have lamps?');

  return (await ask(chat, 'And chairs?')).content;
}

// the events of the socket that tell the button came or went
const buttonEventsOf = (chat: Chat) =>
  chat.socket.events.filter((event) => event.type === 'thread:admin-call');

describe('the button after a turn the bot could not answer', () => {
  it.each([
    ['the model gives no answer', 'model'],
    ['the turns of the shop are used up', 'shop'],
    ['the turns of the user are used up', 'limit'],
  ] as const)('is offered to a user with a confirmed email when %s', async (_case, how) => {
    const chat = await openChat('user');

    const text = await botDown(chat, how);

    expect(text).not.toContain('Bot answer to:');
    const event = await chat.socket.take('thread:admin-call');
    expect(event.payload).toEqual({ threadId: chat.threadId, available: true });
    expect(await hasMark(chat.threadId)).toBe(true);
    // the mark runs out in 30 minutes, from now
    expect(ADMIN_CALL_TTL_SECONDS).toBe(1800);
    const ttl = await markTtlOf(chat.threadId);
    expect(ttl).toBeGreaterThan(1700);
    expect(ttl).toBeLessThanOrEqual(1800);
    expect((await currentOf(chat.cookie)).adminCallAvailable).toBe(true);
    // the chat is still with the bot
    expect((await threadRowOf(chat.threadId)).type).toBe('bot');
  });

  // nothing but a failure of the bot puts the button on a chat
  it('is not there for a user whose questions the bot answers', async () => {
    answerAsModel();
    const chat = await openChat('user');

    await ask(chat, 'Do you have lamps?');
    await settled(chat);

    expect(buttonEventsOf(chat)).toEqual([]);
    expect(await hasMark(chat.threadId)).toBe(false);
    expect((await currentOf(chat.cookie)).adminCallAvailable).toBe(false);
  });

  // a guest may be anyone, and a mistyped email is somebody else: neither talks to an admin
  it.each([
    ['guest', 'model'],
    ['guest', 'shop'],
    ['guest', 'limit'],
    ['unverified', 'model'],
    ['unverified', 'shop'],
    ['unverified', 'limit'],
  ] as const)('is never offered to a %s when the bot cannot answer (%s)', async (kind, how) => {
    const chat = await openChat(kind);

    const text = await botDown(chat, how);
    await settled(chat);

    expect(text).not.toContain('Bot answer to:');
    expect(buttonEventsOf(chat)).toEqual([]);
    expect(await hasMark(chat.threadId)).toBe(false);
    expect((await currentOf(chat.cookie)).adminCallAvailable).toBe(false);
  });

  it('is taken away by a turn the model answers, and the chat is told', async () => {
    const chat = await openChat('user');
    await botDown(chat, 'model');
    expect((await chat.socket.take('thread:admin-call')).payload.available).toBe(true);

    answerAsModel();
    const bot = await ask(chat, 'Do you have lamps?');

    expect(bot.content).toBe('Bot answer to: Do you have lamps?');
    const event = await chat.socket.take('thread:admin-call', (e) => e.payload.available === false);
    expect(event.payload).toEqual({ threadId: chat.threadId, available: false });
    expect(await hasMark(chat.threadId)).toBe(false);
    expect((await currentOf(chat.cookie)).adminCallAvailable).toBe(false);
  });

  // every failure sets the mark again: the time runs from the last one
  it('is offered again by every failure, with a time of 30 minutes from the last one', async () => {
    const chat = await openChat('user');
    await botDown(chat, 'model');
    await chat.socket.take('thread:admin-call');
    await (await getRedis()).expire(markKeyOf(chat.threadId), 100);
    expect(await markTtlOf(chat.threadId)).toBeLessThanOrEqual(100);

    failingModel();
    await ask(chat, 'Any news about lamps?');

    expect(takeLogs({ msg: 'chat bot ai request failed' })).toHaveLength(1);
    expect((await chat.socket.take('thread:admin-call')).payload.available).toBe(true);
    expect(await markTtlOf(chat.threadId)).toBeGreaterThan(1700);
  });

  it('is taken away when the customer asks for a person in words and the chat goes to the admins', async () => {
    const chat = await openChat('user');
    await botDown(chat, 'model');
    await chat.socket.take('thread:admin-call');

    answerAsModel();
    await ask(chat, 'I need a human please');

    expect((await threadRowOf(chat.threadId)).type).toBe('admin');
    const event = await chat.socket.take('thread:admin-call', (e) => e.payload.available === false);
    expect(event.payload).toEqual({ threadId: chat.threadId, available: false });
    expect(await hasMark(chat.threadId)).toBe(false);
  });

  // the third time the same question comes the bot asks what exactly the customer wants to know; that
  // text answers nothing, so it neither puts the button on a chat nor takes it away
  it('stays while the shop is out of turns and the customer repeats a question', async () => {
    const chat = await openChat('user');
    answerAsModel();
    env.CHAT_BOT_SHOP_DAILY_TURNS = 0;

    await ask(chat, 'Where is my order now?');
    await ask(chat, 'Where is my order now?');
    const third = await ask(chat, 'Where is my order now?');

    expect(third.content).toContain('I may be repeating myself');
    expect(await hasMark(chat.threadId)).toBe(true);
    expect((await currentOf(chat.cookie)).adminCallAvailable).toBe(true);
    expect(buttonEventsOf(chat).every((event) => event.payload.available === true)).toBe(true);
  });

  it('stays when the model that gave no answer is asked for the text of a repeated question', async () => {
    const chat = await openChat('user');
    failingModel();

    await ask(chat, 'Where is my order now?');
    expect(takeLogs({ msg: 'chat bot ai request failed' })).toHaveLength(1);
    await ask(chat, 'Where is my order now?');
    expect(takeLogs({ msg: 'chat bot ai request failed' })).toHaveLength(1);
    const third = await ask(chat, 'Where is my order now?');

    // the model wrote the text of the third turn, and it is no answer
    expect(third.content).toContain('the conversation may be repeating');
    expect(await hasMark(chat.threadId)).toBe(true);
    expect(buttonEventsOf(chat).every((event) => event.payload.available === true)).toBe(true);
  });

  // the mark is of a chat: the bot of another chat does not touch it
  it('is of the chat it was put on', async () => {
    const down = await openChat('user');
    const fine = await openChat('user');
    await botDown(down, 'model');
    await down.socket.take('thread:admin-call');

    answerAsModel();
    await ask(fine, 'Do you have lamps?');
    await settled(fine);

    expect(buttonEventsOf(fine)).toEqual([]);
    expect(await hasMark(down.threadId)).toBe(true);
    expect(await hasMark(fine.threadId)).toBe(false);
  });
});

describe('GET /api/chat/thread/current: adminCallAvailable', () => {
  it('is false for a new chat of a user and of a guest', async () => {
    const user = await createUser();
    userIds.push(user.id);

    expect((await currentOf(accessCookie(user))).adminCallAvailable).toBe(false);
    expect((await currentOf(`guestId=${randomUUID()}`)).adminCallAvailable).toBe(false);
  });

  it('is true while the chat has the mark, and false once it is gone', async () => {
    const user = await createUser();
    userIds.push(user.id);
    const cookie = accessCookie(user);
    const threadId = (await currentOf(cookie)).thread.id as string;

    await putMark(threadId);
    expect((await currentOf(cookie)).adminCallAvailable).toBe(true);

    await (await getRedis()).del(markKeyOf(threadId));
    expect((await currentOf(cookie)).adminCallAvailable).toBe(false);
  });

  // the mark runs out by itself
  it('is false once the time of the mark is over', async () => {
    const user = await createUser();
    userIds.push(user.id);
    const cookie = accessCookie(user);
    const threadId = (await currentOf(cookie)).thread.id as string;
    await putMark(threadId);
    await (await getRedis()).expire(markKeyOf(threadId), 1);

    await new Promise((resolve) => setTimeout(resolve, 1300));

    expect((await currentOf(cookie)).adminCallAvailable).toBe(false);
  });

  it('is false for a chat that is with the admins, whatever mark it has', async () => {
    const user = await createUser();
    userIds.push(user.id);
    const { id: threadId } = await createChatThread(user.id, { type: 'admin' });
    await putMark(threadId);

    const current = await currentOf(accessCookie(user));

    expect(current.thread).toMatchObject({ id: threadId, type: 'admin' });
    expect(current.adminCallAvailable).toBe(false);
  });

  // the button is a help, not a need: without redis the chat is read as it was, with no button
  it('is false and the chat is read when redis fails', async () => {
    const user = await createUser();
    userIds.push(user.id);
    const cookie = accessCookie(user);
    const threadId = (await currentOf(cookie)).thread.id as string;
    await putMark(threadId);
    jest
      .spyOn(await getRedis(), 'exists')
      .mockRejectedValueOnce(new Error('Socket closed unexpectedly'));

    const current = await currentOf(cookie);

    expect(current.thread.id).toBe(threadId);
    expect(current.adminCallAvailable).toBe(false);
  });
});

describe('POST /api/chat/threads/:threadId/call-admin', () => {
  describe('gives the chat to the admins', () => {
    it('with a message of the bot, the chat in the hands of the admins and the button gone', async () => {
      const chat = await openChat('user');
      await putMark(chat.threadId);

      const res = await callAdmin(chat.threadId, chat.user!);

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.thread).toMatchObject({
        id: chat.threadId,
        userId: chat.userId,
        type: 'admin',
        status: 'open',
        adminRequestedAt: expect.any(String),
      });
      expect(body.message).toMatchObject({
        threadId: chat.threadId,
        senderType: 'bot',
        senderId: null,
        content: ADMIN_CALL_TEXT,
      });
      expect(ADMIN_CALL_TEXT).toContain('admin');
      // one step: the chat was given at the time the bot wrote
      expect(body.thread.adminRequestedAt).toBe(body.message.createdAt);
      expect(body.thread.lastMessagePreview).toBe(ADMIN_CALL_TEXT.slice(0, 120));

      expect(await hasMark(chat.threadId)).toBe(false);
      expect(await threadRowOf(chat.threadId)).toMatchObject({ type: 'admin', status: 'open' });
      const rows = await messageRowsOf(chat.threadId);
      expect(rows.at(-1)).toMatchObject({ senderType: 'bot', content: ADMIN_CALL_TEXT });
      const current = await currentOf(chat.cookie);
      expect(current.thread.type).toBe('admin');
      expect(current.adminCallAvailable).toBe(false);
    });

    // the chat tells its own screen what happened, as when the bot passes the chat on itself
    it('and tells the chat on its socket: the message of the bot and that the button is gone', async () => {
      const chat = await openChat('user');
      await putMark(chat.threadId);

      const res = await callAdmin(chat.threadId, chat.user!);

      expect(res.statusCode).toBe(200);
      const message = await chat.socket.take(
        'message:new',
        (e) => e.payload.senderType === 'bot' && e.payload.content === ADMIN_CALL_TEXT,
      );
      expect(message.payload.id).toBe(res.json().message.id);
      const event = await chat.socket.take('thread:admin-call');
      expect(event.payload).toEqual({ threadId: chat.threadId, available: false });
    });

    // the chat enters the queue of the admins with the next message of the customer, as when the
    // bot passes it on: the admins read what the customer wrote
    it('and the chat enters the queue of the admins with the next message of the customer, with the bot quiet', async () => {
      const calls = answerAsModel();
      const admin = await openAdminSocket();
      const chat = await openChat('user');
      await putMark(chat.threadId);

      expect((await callAdmin(chat.threadId, chat.user!)).statusCode).toBe(200);
      expect(await isWaitingForAdmin(admin.cookie, chat.threadId)).toBe(false);

      say(chat, 'My parcel 5 came broken');
      const requested = await admin.socket.take(
        'admin:requested',
        (e) => e.payload.thread.id === chat.threadId,
      );

      expect(requested.payload.thread).toMatchObject({ type: 'admin', unreadCount: 1 });
      expect(await isWaitingForAdmin(admin.cookie, chat.threadId)).toBe(true);
      expect((await messageRowsOf(chat.threadId)).at(-1)).toMatchObject({
        senderType: 'user',
        content: 'My parcel 5 came broken',
      });
      expect(calls).toHaveLength(0);
    });

    // the whole way of the customer: the bot is down, the button comes, the customer presses it
    it('after the bot failed: the button comes with the failure and the press gives the chat to the admins', async () => {
      const chat = await openChat('user');
      await botDown(chat, 'model');
      expect((await chat.socket.take('thread:admin-call')).payload.available).toBe(true);
      expect((await currentOf(chat.cookie)).adminCallAvailable).toBe(true);

      const res = await callAdmin(chat.threadId, chat.user!);

      expect(res.statusCode).toBe(200);
      expect(res.json().thread).toMatchObject({ id: chat.threadId, type: 'admin' });
      expect((await currentOf(chat.cookie)).adminCallAvailable).toBe(false);
    });

    it('once: the second call finds no button', async () => {
      const chat = await openChat('user');
      await putMark(chat.threadId);
      expect((await callAdmin(chat.threadId, chat.user!)).statusCode).toBe(200);

      const again = await callAdmin(chat.threadId, chat.user!);

      expect(again.statusCode).toBe(409);
      expect(again.json()).toMatchObject({ errorCode: 'CHAT_ADMIN_CALL_UNAVAILABLE' });
      expect(
        (await messageRowsOf(chat.threadId)).filter((m) => m.content === ADMIN_CALL_TEXT),
      ).toHaveLength(1);
    });

    // two presses at once: one gives the chat, the other finds it given
    it('once when two calls come at once: one is 200, the other 409', async () => {
      const chat = await openChat('user');
      await putMark(chat.threadId);

      const answers = await Promise.all([
        callAdmin(chat.threadId, chat.user!),
        callAdmin(chat.threadId, chat.user!),
      ]);

      expect(answers.map((res) => res.statusCode).sort()).toEqual([200, 409]);
      const refused = answers.find((res) => res.statusCode === 409)!;
      expect(refused.json()).toMatchObject({ errorCode: 'CHAT_ADMIN_CALL_UNAVAILABLE' });
      expect(
        (await messageRowsOf(chat.threadId)).filter((m) => m.content === ADMIN_CALL_TEXT),
      ).toHaveLength(1);
      expect(await hasMark(chat.threadId)).toBe(false);
    });
  });

  describe('refuses', () => {
    it('a guest, an admin and the root with INSUFFICIENT_ROLE', async () => {
      const chat = await openChat('user');
      await putMark(chat.threadId);
      const admin = await createUser({ role: 'ADMIN' });
      const root = await createUser({ role: 'ROOT' });
      userIds.push(admin.id, root.id);

      for (const who of [null, `guestId=${randomUUID()}`, admin, root]) {
        const res = await callAdmin(chat.threadId, who);

        expect(res.statusCode).toBe(403);
        expect(res.json()).toMatchObject({ errorCode: 'INSUFFICIENT_ROLE' });
      }
      // nothing was given away, the button stays
      expect(await hasMark(chat.threadId)).toBe(true);
      expect((await threadRowOf(chat.threadId)).type).toBe('bot');
    });

    it('a request without a session (LOGIN_REQUIRED)', async () => {
      const chat = await openChat('user');
      await putMark(chat.threadId);

      const res = await callAdmin(chat.threadId, 'accessToken=not-a-token');

      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ errorCode: 'LOGIN_REQUIRED' });
    });

    it('a request without the csrf token, like every post (CSRF_TOKEN_INVALID)', async () => {
      const chat = await openChat('user');
      await putMark(chat.threadId);

      const res = await callAdmin(chat.threadId, chat.user!, { csrf: false });

      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ errorCode: 'CSRF_TOKEN_INVALID' });
      expect(await hasMark(chat.threadId)).toBe(true);
    });

    it('a thread id that is not a uuid', async () => {
      const chat = await openChat('user');

      const res = await callAdmin('not-a-uuid', chat.user!);

      expect(res.statusCode).toBe(400);
    });

    it('a chat that is not there (CHAT_THREAD_NOT_FOUND)', async () => {
      const chat = await openChat('user');

      const res = await callAdmin(randomUUID(), chat.user!);

      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ errorCode: 'CHAT_THREAD_NOT_FOUND' });
    });

    it('the chat of another customer (CHAT_THREAD_NOT_FOUND: the user does not see it), and leaves its button', async () => {
      const owner = await openChat('user');
      await putMark(owner.threadId);
      const stranger = await openChat('user');

      const res = await callAdmin(owner.threadId, stranger.user!);

      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ errorCode: 'CHAT_THREAD_NOT_FOUND' });
      expect(await hasMark(owner.threadId)).toBe(true);
      expect((await threadRowOf(owner.threadId)).type).toBe('bot');
    });

    it('a user who has not confirmed the email (CHAT_ADMIN_EMAIL_NOT_CONFIRMED)', async () => {
      const chat = await openChat('unverified');
      await putMark(chat.threadId);

      const res = await callAdmin(chat.threadId, chat.user!);

      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ errorCode: 'CHAT_ADMIN_EMAIL_NOT_CONFIRMED' });
      expect((await threadRowOf(chat.threadId)).type).toBe('bot');
    });

    it('a closed chat (CHAT_THREAD_CLOSED), with or without the button', async () => {
      const user = await createUser();
      userIds.push(user.id);
      const { id: closed } = await createChatThread(user.id, { type: 'bot', status: 'closed' });

      const without = await callAdmin(closed, user);
      await putMark(closed);
      const withMark = await callAdmin(closed, user);

      for (const res of [without, withMark]) {
        expect(res.statusCode).toBe(409);
        expect(res.json()).toMatchObject({ errorCode: 'CHAT_THREAD_CLOSED' });
      }
      expect((await threadRowOf(closed)).status).toBe('closed');
    });

    it('a chat that has no button, the bot answered lately (CHAT_ADMIN_CALL_UNAVAILABLE)', async () => {
      answerAsModel();
      const chat = await openChat('user');
      await ask(chat, 'Do you have lamps?');

      const res = await callAdmin(chat.threadId, chat.user!);

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ errorCode: 'CHAT_ADMIN_CALL_UNAVAILABLE' });
      expect((await threadRowOf(chat.threadId)).type).toBe('bot');
      expect((await messageRowsOf(chat.threadId)).some((m) => m.content === ADMIN_CALL_TEXT)).toBe(
        false,
      );
    });

    it('a chat that is with the admins already, whatever mark it has (CHAT_ADMIN_CALL_UNAVAILABLE)', async () => {
      const user = await createUser();
      userIds.push(user.id);
      const { id: threadId } = await createChatThread(user.id, { type: 'admin' });
      await putMark(threadId);

      const res = await callAdmin(threadId, user);

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ errorCode: 'CHAT_ADMIN_CALL_UNAVAILABLE' });
      expect((await messageRowsOf(threadId)).some((m) => m.content === ADMIN_CALL_TEXT)).toBe(
        false,
      );
    });

    // the time of the mark is over: the bot failed too long ago
    it('a chat whose button ran out (CHAT_ADMIN_CALL_UNAVAILABLE)', async () => {
      const chat = await openChat('user');
      await putMark(chat.threadId);
      await (await getRedis()).expire(markKeyOf(chat.threadId), 1);
      await new Promise((resolve) => setTimeout(resolve, 1300));

      const res = await callAdmin(chat.threadId, chat.user!);

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ errorCode: 'CHAT_ADMIN_CALL_UNAVAILABLE' });
    });

    // the route needs redis to know the button is there: without it, not a guess
    it('a call that cannot read the button, with REDIS_UNAVAILABLE, and gives nothing away', async () => {
      const chat = await openChat('user');
      await putMark(chat.threadId);
      jest
        .spyOn(await getRedis(), 'exists')
        .mockRejectedValueOnce(new Error('Socket closed unexpectedly'));

      const res = await callAdmin(chat.threadId, chat.user!);

      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ errorCode: 'REDIS_UNAVAILABLE' });
      expect(takeLogs({ msg: 'request failed', errorCode: 'REDIS_UNAVAILABLE' })).toHaveLength(1);
      expect((await threadRowOf(chat.threadId)).type).toBe('bot');
      expect(await hasMark(chat.threadId)).toBe(true);
    });
  });

  // a script would fill the queue of the admins: a user may call a few times an hour
  describe('the limit of calls', () => {
    it('stops a user who calls too often in an hour (429 RATE_LIMITED, naming chatCallAdmin)', async () => {
      const user = await createUser();
      userIds.push(user.id);
      const other = await createUser();
      userIds.push(other.id);
      // the tests raise every limit a thousand times: here it counts as the server has it
      env.LIMIT_CHAT_CALL_ADMIN_PER_USER = 2;
      env.REQUEST_LIMITS_SCALE = 1;

      // a chat that is not there: each request is a 404, counted all the same
      for (let i = 0; i < 2; i += 1) {
        expect((await callAdmin(randomUUID(), user)).statusCode).toBe(404);
      }
      const refused = await callAdmin(randomUUID(), user);

      expect(refused.statusCode).toBe(429);
      expect(refused.json()).toMatchObject({
        errorCode: 'RATE_LIMITED',
        details: { limit: 'chatCallAdmin' },
      });
      expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
      // the count is of the user: another one is not stopped
      expect((await callAdmin(randomUUID(), other)).statusCode).toBe(404);
    });

    // the press that gave the chat is a call too: the user cannot press it over and over
    it('counts the calls that gave the chat as well', async () => {
      env.LIMIT_CHAT_CALL_ADMIN_PER_USER = 1;
      env.REQUEST_LIMITS_SCALE = 1;
      const chat = await openChat('user');
      await putMark(chat.threadId);

      expect((await callAdmin(chat.threadId, chat.user!)).statusCode).toBe(200);
      const again = await callAdmin(chat.threadId, chat.user!);

      expect(again.statusCode).toBe(429);
      expect(again.json()).toMatchObject({
        errorCode: 'RATE_LIMITED',
        details: { limit: 'chatCallAdmin' },
      });
    });
  });
});
