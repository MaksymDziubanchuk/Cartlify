import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { setUserContext } from '@db/dbContext.service.js';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { closeChatSockets, openChatSocket, type ChatSocket } from '../../../helpers/chatSocket.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { asAdmin, testTx } from '../../../helpers/db.js';
import { createChatThread, createUser, type TestUser } from '../../../helpers/factories.js';

// the work of an admin in the support chat: the queues, a chat opened, answered, read and closed,
// and what the sockets of the chat hear of it
let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await createUser({ role: 'ADMIN' });
});

afterAll(async () => {
  closeChatSockets();
  await stopApp();
});

// a customer with a chat of their own: a user has one open chat at a time
const customer = () => createUser();

// the chat the bot leaves when the customer asks for a person: an admin chat that waits for the
// customer to describe the problem, so no message of theirs waits for the admin yet
function escalatedChat(userId: number): Promise<{ id: string }> {
  return testTx(async (tx) => {
    await setUserContext(tx, { userId, role: 'USER' });
    const id = randomUUID();
    await tx.chatThread.create({
      data: { id, userId, type: 'admin', status: 'open', adminRequestedAt: new Date() },
    });
    return { id };
  });
}

const threadOf = (id: string) =>
  asAdmin((tx) => tx.chatThread.findUniqueOrThrow({ where: { id } }));

const messagesOf = (threadId: string) =>
  asAdmin((tx) =>
    tx.chatMessage.findMany({
      where: { threadId },
      select: { senderType: true, isRead: true, content: true },
      orderBy: { id: 'asc' },
    }),
  );

const openChat = (threadId: string, actor: TestUser = admin) =>
  app.inject({
    method: 'GET',
    url: `/api/chat/admin/threads/${threadId}`,
    headers: { cookie: accessCookie(actor) },
  });

const closeChat = (threadId: string, actor: TestUser = admin) =>
  app.inject({
    method: 'PATCH',
    url: `/api/chat/admin/threads/${threadId}/close`,
    headers: withCsrf(csrf, accessCookie(actor)),
  });

// every chat of a queue, page by page: other files write chats at the same time
async function queueOf(queue: 'waiting' | 'active' | 'unread'): Promise<string[]> {
  const ids: string[] = [];
  for (let page = 1; ; page++) {
    const res = await app.inject({
      method: 'GET',
      url: `/api/chat/admin/threads?queue=${queue}&limit=100&page=${page}`,
      headers: { cookie: accessCookie(admin) },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: Array<{ id: string }>; total: number };
    ids.push(...body.items.map((t) => t.id));
    if (ids.length >= body.total || body.items.length === 0) return ids;
  }
}

const socketOf = (actor: TestUser) => openChatSocket(app, { cookie: accessCookie(actor) });

// the error the socket answers an event with
const errorAfter = async (socket: ChatSocket, event: unknown) => {
  socket.send(event);
  return (await socket.take('error')).payload?.code as string;
};

describe('GET /api/chat/admin/threads', () => {
  it('gives the waiting queue the chats whose customer described the problem, the longest waiting first', async () => {
    const first = await createChatThread((await customer()).id);
    const second = await createChatThread((await customer()).id);

    const waiting = await queueOf('waiting');

    expect(waiting).toContain(first.id);
    expect(waiting.indexOf(first.id)).toBeLessThan(waiting.indexOf(second.id));
    expect(await queueOf('active')).not.toContain(first.id);
  });

  it('leaves out a chat whose customer has not described the problem yet', async () => {
    const chat = await escalatedChat((await customer()).id);

    expect(await queueOf('waiting')).not.toContain(chat.id);
    expect(await queueOf('active')).not.toContain(chat.id);
  });

  it('moves a chat an admin opened to the active queue', async () => {
    const chat = await createChatThread((await customer()).id);
    expect((await openChat(chat.id)).statusCode).toBe(200);

    expect(await queueOf('active')).toContain(chat.id);
    expect(await queueOf('waiting')).not.toContain(chat.id);
  });

  it('leaves out chats with the bot and closed chats', async () => {
    const bot = await createChatThread((await customer()).id, { type: 'bot' });
    const closed = await createChatThread((await customer()).id, { status: 'closed' });
    const all = [...(await queueOf('waiting')), ...(await queueOf('active'))];

    expect(all).not.toContain(bot.id);
    expect(all).not.toContain(closed.id);
  });

  // the alerts of an admin send to it: every chat with a message no admin has read, the one that
  // waits the longest first, whether an admin took it or not
  it('gives the unread queue the chats with a message no admin has read, the longest unread first', async () => {
    const first = await createChatThread((await customer()).id);
    const second = await createChatThread((await customer()).id);
    const read = await createChatThread((await customer()).id);
    expect((await openChat(read.id)).statusCode).toBe(200);
    const undescribed = await escalatedChat((await customer()).id);
    const bot = await createChatThread((await customer()).id, { type: 'bot' });

    const unread = await queueOf('unread');

    expect(unread).toContain(first.id);
    expect(unread).toContain(second.id);
    expect(unread.indexOf(first.id)).toBeLessThan(unread.indexOf(second.id));
    expect(unread).not.toContain(read.id);
    expect(unread).not.toContain(undescribed.id);
    expect(unread).not.toContain(bot.id);
  });

  it('keeps a chat an admin read in the active queue, out of the unread one', async () => {
    const chat = await createChatThread((await customer()).id);
    expect(await queueOf('unread')).toContain(chat.id);

    expect((await openChat(chat.id)).statusCode).toBe(200);

    expect(await queueOf('active')).toContain(chat.id);
    expect(await queueOf('unread')).not.toContain(chat.id);
    expect((await threadOf(chat.id)).adminUnreadSince).toBeNull();
  });

  it('refuses a page that is no whole number', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/chat/admin/threads?page=1.5',
      headers: { cookie: accessCookie(admin) },
    });

    expect(res.statusCode).toBe(400);
  });

  it('refuses a user', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/chat/admin/threads',
      headers: { cookie: accessCookie(await customer()) },
    });

    expect({ status: res.statusCode, code: res.json().errorCode }).toEqual({
      status: 403,
      code: 'INSUFFICIENT_ROLE',
    });
  });
});

describe('GET /api/chat/admin/threads/:threadId', () => {
  it('opens a waiting chat: the messages of the customer become read, nothing waits any more', async () => {
    const chat = await createChatThread((await customer()).id);

    const res = await openChat(chat.id);
    const body = res.json();

    expect(res.statusCode).toBe(200);
    expect(body.thread).toMatchObject({ id: chat.id, status: 'open', unreadCount: 0 });
    expect(body.thread.adminRequestedAt).toBeNull();
    expect(body.messages.map((m: { content: string }) => m.content)).toEqual([
      'Where is my order?',
    ]);
    expect(await messagesOf(chat.id)).toEqual([
      { senderType: 'user', isRead: true, content: 'Where is my order?' },
    ]);
  });

  // the admin goes into a chat from the profile of the customer (openChatThreadId) at any time
  it('opens a chat whose customer has not described the problem yet', async () => {
    const chat = await escalatedChat((await customer()).id);

    const res = await openChat(chat.id);

    expect(res.statusCode).toBe(200);
    expect(res.json().thread).toMatchObject({ id: chat.id, type: 'admin', status: 'open' });
    // the admin took it: it waits in no queue any more, it is one of the active chats
    expect(await queueOf('active')).toContain(chat.id);
    expect(await queueOf('waiting')).not.toContain(chat.id);
  });

  it('gives the closed chats of the same customer before it', async () => {
    const user = await customer();
    const closed = await createChatThread(user.id, { status: 'closed' });
    const chat = await createChatThread(user.id);

    const res = await openChat(chat.id);

    expect(res.statusCode).toBe(200);
    expect(res.json().previousThreads.map((t: { id: string }) => t.id)).toEqual([closed.id]);
  });

  it('shows a closed chat as it is', async () => {
    const chat = await createChatThread((await customer()).id, { status: 'closed' });
    const before = await threadOf(chat.id);

    const res = await openChat(chat.id);

    expect(res.statusCode).toBe(200);
    expect(res.json().thread).toMatchObject({ id: chat.id, status: 'closed' });
    expect(await threadOf(chat.id)).toEqual(before);
  });

  it('refuses a chat with the bot: it is the customer alone', async () => {
    const chat = await createChatThread((await customer()).id, { type: 'bot' });

    const res = await openChat(chat.id);

    expect({ status: res.statusCode, code: res.json().errorCode }).toEqual({
      status: 403,
      code: 'CHAT_THREAD_FORBIDDEN',
    });
  });

  it('answers 404 for no such chat', async () => {
    const res = await openChat(randomUUID());

    expect({ status: res.statusCode, code: res.json().errorCode }).toEqual({
      status: 404,
      code: 'CHAT_THREAD_NOT_FOUND',
    });
  });

  it('refuses a user', async () => {
    const user = await customer();
    const chat = await createChatThread(user.id);

    const res = await openChat(chat.id, user);

    expect({ status: res.statusCode, code: res.json().errorCode }).toEqual({
      status: 403,
      code: 'INSUFFICIENT_ROLE',
    });
  });
});

describe('PATCH /api/chat/admin/threads/:threadId/close', () => {
  it('closes an open chat, tells its sockets, and the customer writes no more into it', async () => {
    const user = await customer();
    const chat = await createChatThread(user.id);
    const socket = await socketOf(user);
    await socket.join(chat.id);

    const res = await closeChat(chat.id);

    expect(res.statusCode).toBe(200);
    expect(res.json().thread).toMatchObject({
      id: chat.id,
      status: 'closed',
      unreadCount: 0,
      adminRequestedAt: null,
      adminUnreadSince: null,
    });
    expect((await socket.take('thread:closed')).payload.thread.id).toBe(chat.id);

    const code = await errorAfter(socket, {
      type: 'message:send',
      payload: { threadId: chat.id, content: 'Are you there?' },
    });
    expect(['THREAD_NOT_JOINED', 'CHAT_THREAD_CLOSED']).toContain(code);
    expect(await messagesOf(chat.id)).toHaveLength(1);
  });

  it('answers 409 for a chat closed already', async () => {
    const chat = await createChatThread((await customer()).id, { status: 'closed' });

    const res = await closeChat(chat.id);

    expect({ status: res.statusCode, code: res.json().errorCode }).toEqual({
      status: 409,
      code: 'CHAT_THREAD_ALREADY_CLOSED',
    });
  });

  it('refuses a chat with the bot', async () => {
    const chat = await createChatThread((await customer()).id, { type: 'bot' });

    const res = await closeChat(chat.id);

    expect({ status: res.statusCode, code: res.json().errorCode }).toEqual({
      status: 403,
      code: 'CHAT_THREAD_FORBIDDEN',
    });
    expect((await threadOf(chat.id)).status).toBe('open');
  });

  it('answers 404 for no such chat', async () => {
    const res = await closeChat(randomUUID());

    expect({ status: res.statusCode, code: res.json().errorCode }).toEqual({
      status: 404,
      code: 'CHAT_THREAD_NOT_FOUND',
    });
  });

  it('refuses a user', async () => {
    const user = await customer();
    const chat = await createChatThread(user.id);

    const res = await closeChat(chat.id, user);

    expect({ status: res.statusCode, code: res.json().errorCode }).toEqual({
      status: 403,
      code: 'INSUFFICIENT_ROLE',
    });
    expect((await threadOf(chat.id)).status).toBe('open');
  });
});

describe('the chat socket of an admin', () => {
  it('lets an admin join an admin chat and refuses a chat with the bot', async () => {
    const chat = await createChatThread((await customer()).id);
    const bot = await createChatThread((await customer()).id, { type: 'bot' });
    const socket = await socketOf(admin);

    await socket.join(chat.id);
    expect(await errorAfter(socket, { type: 'thread:join', payload: { threadId: bot.id } })).toBe(
      'CHAT_THREAD_FORBIDDEN',
    );
  });

  // the chat of another user is no chat the user can see, the way the history of it answers 404
  it('refuses a user the chat of another user, and a closed chat', async () => {
    const other = await createChatThread((await customer()).id);
    const user = await customer();
    const closed = await createChatThread(user.id, { status: 'closed' });
    const socket = await socketOf(user);

    expect(await errorAfter(socket, { type: 'thread:join', payload: { threadId: other.id } })).toBe(
      'CHAT_THREAD_NOT_FOUND',
    );
    expect(
      await errorAfter(socket, { type: 'thread:join', payload: { threadId: closed.id } }),
    ).toBe('CHAT_THREAD_CLOSED');
  });

  it('refuses a message, a read and typing in a chat the socket has not joined', async () => {
    const user = await customer();
    const chat = await createChatThread(user.id);
    const socket = await socketOf(user);

    for (const event of [
      { type: 'message:send', payload: { threadId: chat.id, content: 'Hello' } },
      { type: 'thread:read', payload: { threadId: chat.id } },
      { type: 'typing:start', payload: { threadId: chat.id } },
    ]) {
      expect(await errorAfter(socket, event)).toBe('THREAD_NOT_JOINED');
    }
    expect(await messagesOf(chat.id)).toHaveLength(1);
  });

  it('answers an event it does not know', async () => {
    const socket = await socketOf(await customer());

    expect(await errorAfter(socket, { type: 'thread:leave', payload: {} })).toBe(
      'UNKNOWN_EVENT_TYPE',
    );
  });

  it('tells the chat when the admin reads it: the customer messages are read, nothing waits', async () => {
    const user = await customer();
    const chat = await createChatThread(user.id);
    const userSocket = await socketOf(user);
    const adminSocket = await socketOf(admin);
    await userSocket.join(chat.id);
    await adminSocket.join(chat.id);

    adminSocket.send({ type: 'thread:read', payload: { threadId: chat.id } });

    const seen = await userSocket.take('thread:read');
    expect(seen.payload).toMatchObject({
      readerRole: 'ADMIN',
      thread: { id: chat.id, unreadCount: 0 },
    });
    expect(await messagesOf(chat.id)).toEqual([
      { senderType: 'user', isRead: true, content: 'Where is my order?' },
    ]);
    expect((await threadOf(chat.id)).adminRequestedAt).toBeNull();
    expect((await threadOf(chat.id)).adminUnreadSince).toBeNull();
    expect(await queueOf('active')).toContain(chat.id);
    expect(await queueOf('unread')).not.toContain(chat.id);
  });

  it('lets the admin read a chat whose customer has not described the problem yet', async () => {
    const chat = await escalatedChat((await customer()).id);
    const socket = await socketOf(admin);
    await socket.join(chat.id);

    socket.send({ type: 'thread:read', payload: { threadId: chat.id } });

    expect((await socket.take('thread:read')).payload.thread.id).toBe(chat.id);
    expect(await queueOf('active')).toContain(chat.id);
  });

  it('marks what the admin wrote read when the customer reads, not what the customer wrote', async () => {
    const user = await customer();
    const chat = await createChatThread(user.id);
    const userSocket = await socketOf(user);
    const adminSocket = await socketOf(admin);
    await userSocket.join(chat.id);
    await adminSocket.join(chat.id);
    adminSocket.send({
      type: 'message:send',
      payload: { threadId: chat.id, content: 'On its way.' },
    });
    await userSocket.take('message:new', (e) => e.payload?.senderType === 'admin');

    // the answer of the admin waits for the customer until they read it
    expect(await messagesOf(chat.id)).toEqual([
      { senderType: 'user', isRead: true, content: 'Where is my order?' },
      { senderType: 'admin', isRead: false, content: 'On its way.' },
    ]);

    userSocket.send({ type: 'thread:read', payload: { threadId: chat.id } });
    await adminSocket.take('thread:read', (e) => e.payload?.readerRole === 'USER');

    expect((await messagesOf(chat.id)).map((m) => m.isRead)).toEqual([true, true]);
  });

  it('brings the answer of the admin to the customer: nothing waits for an admin then', async () => {
    const user = await customer();
    const chat = await createChatThread(user.id);
    const userSocket = await socketOf(user);
    const adminSocket = await socketOf(admin);
    await userSocket.join(chat.id);
    await adminSocket.join(chat.id);

    adminSocket.send({ type: 'message:send', payload: { threadId: chat.id, content: 'Hello!' } });

    const answer = await userSocket.take('message:new', (e) => e.payload?.senderType === 'admin');
    expect(answer.payload).toMatchObject({
      threadId: chat.id,
      content: 'Hello!',
      senderId: admin.id,
    });
    const thread = await threadOf(chat.id);
    expect({
      unreadCount: thread.unreadCount,
      adminRequestedAt: thread.adminRequestedAt,
      adminUnreadSince: thread.adminUnreadSince,
    }).toEqual({
      unreadCount: 0,
      adminRequestedAt: null,
      adminUnreadSince: null,
    });
    expect(await queueOf('unread')).not.toContain(chat.id);
  });

  it('lets the admin answer a chat whose customer has not described the problem yet', async () => {
    const user = await customer();
    const chat = await escalatedChat(user.id);
    const userSocket = await socketOf(user);
    const adminSocket = await socketOf(admin);
    await userSocket.join(chat.id);
    await adminSocket.join(chat.id);

    adminSocket.send({
      type: 'message:send',
      payload: { threadId: chat.id, content: 'How can I help?' },
    });

    const answer = await userSocket.take('message:new', (e) => e.payload?.senderType === 'admin');
    expect(answer.payload.content).toBe('How can I help?');
    expect(await queueOf('active')).toContain(chat.id);

    expect(await queueOf('unread')).not.toContain(chat.id);

    // what the customer writes then reaches the admin who answered, the chat stays active and is
    // unread again, from the first message no admin has read
    userSocket.send({ type: 'message:send', payload: { threadId: chat.id, content: 'My order.' } });
    await adminSocket.take('message:new', (e) => e.payload?.content === 'My order.');
    const thread = await threadOf(chat.id);
    expect({ unreadCount: thread.unreadCount, requested: thread.adminRequestedAt }).toEqual({
      unreadCount: 1,
      requested: null,
    });
    expect(thread.adminUnreadSince).not.toBeNull();
    expect(await queueOf('active')).toContain(chat.id);
    expect(await queueOf('unread')).toContain(chat.id);

    userSocket.send({ type: 'message:send', payload: { threadId: chat.id, content: 'Please.' } });
    await adminSocket.take('message:new', (e) => e.payload?.content === 'Please.');
    const later = await threadOf(chat.id);
    expect(later.unreadCount).toBe(2);
    expect(later.adminUnreadSince).toEqual(thread.adminUnreadSince);
  });

  it('shares typing with the others of the chat', async () => {
    const user = await customer();
    const chat = await createChatThread(user.id);
    const userSocket = await socketOf(user);
    const adminSocket = await socketOf(admin);
    await userSocket.join(chat.id);
    await adminSocket.join(chat.id);

    userSocket.send({ type: 'typing:start', payload: { threadId: chat.id } });
    expect((await adminSocket.take('typing:start')).payload).toEqual({
      threadId: chat.id,
      actorId: user.id,
      actorRole: 'USER',
    });

    userSocket.send({ type: 'typing:stop', payload: { threadId: chat.id } });
    expect((await adminSocket.take('typing:stop')).payload.actorId).toBe(user.id);
  });
});
