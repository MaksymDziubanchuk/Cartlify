import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { expect } from '@jest/globals';

import { accessCookie } from './actors.js';
import { openChatSocket, type ChatSocket } from './chatSocket.js';
import { asAdmin } from './db.js';
import { createUser, type TestUser } from './factories.js';

// A customer with the chat open the way the widget opens it, and the steps of a talk with the bot,
// for the tests of the bot and of the button "call an admin". The test hands over the app as a
// function, because a test file makes it in beforeAll, and the list of the users it makes, which
// the file closes the sessions of in afterAll

// the user is none for a guest
export type Chat = {
  user: TestUser | null;
  userId: number | null;
  cookie: string;
  threadId: string;
  socket: ChatSocket;
};

export type ChatKind = 'user' | 'unverified' | 'guest';

export function chatBotDriver(context: { app: () => FastifyInstance; userIds: number[] }) {
  // the chat of the customer through the api, then its socket joined to the thread. The address is
  // the one the socket seems to come from (the bot counts the turns of a guest by it)
  async function openChat(kind: ChatKind, address?: string): Promise<Chat> {
    let cookie = `guestId=${randomUUID()}`;
    let user: TestUser | null = null;

    if (kind !== 'guest') {
      user = await createUser({ isVerified: kind === 'user' });
      context.userIds.push(user.id);
      cookie = accessCookie(user);
    }

    const res = await context.app().inject({
      method: 'GET',
      url: '/api/chat/thread/current',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const threadId = res.json().thread.id as string;

    const socket = await openChatSocket(context.app(), { cookie }, address);
    await socket.join(threadId);

    return { user, userId: user?.id ?? null, cookie, threadId, socket };
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

  // the server has sent the chat everything it had for it so far: events reach a socket in the
  // order they were sent, so the answer to a join comes after them
  async function settled(chat: Chat) {
    chat.socket.send({ type: 'thread:join', payload: { threadId: chat.threadId } });
    await chat.socket.take('thread:joined', (e) => e.payload?.threadId === chat.threadId);
  }

  const threadRowOf = (threadId: string) =>
    asAdmin((tx) => tx.chatThread.findUniqueOrThrow({ where: { id: threadId } }));

  const messageRowsOf = (threadId: string) =>
    asAdmin((tx) => tx.chatMessage.findMany({ where: { threadId }, orderBy: { id: 'asc' } }));

  async function openAdminSocket() {
    const admin = await createUser({ role: 'ADMIN' });
    context.userIds.push(admin.id);

    return {
      admin,
      cookie: accessCookie(admin),
      socket: await openChatSocket(context.app(), { cookie: accessCookie(admin) }),
    };
  }

  // whether the thread is in the queue of chats waiting for an admin
  async function isWaitingForAdmin(adminCookie: string, threadId: string) {
    const res = await context.app().inject({
      method: 'GET',
      url: '/api/chat/admin/threads?queue=waiting&limit=100',
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);

    return (res.json().items as Array<{ id: string }>).some((thread) => thread.id === threadId);
  }

  return {
    openChat,
    say,
    nextMessage,
    ask,
    settled,
    threadRowOf,
    messageRowsOf,
    openAdminSocket,
    isWaitingForAdmin,
  };
}
