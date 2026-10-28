import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { setUserContext } from '@db/dbContext.service.js';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { asAdmin, testTx } from '../../../helpers/db.js';
import { closeSessions, createChatThread, createUser } from '../../../helpers/factories.js';

let app: FastifyInstance;
const userIds: number[] = [];

beforeAll(async () => {
  app = await startApp();
});

afterAll(async () => {
  try {
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

const getCurrent = (cookie: string) =>
  app.inject({ method: 'GET', url: '/api/chat/thread/current', headers: { cookie } });

const getMessages = (cookie: string, threadId: string, cursor?: string) =>
  app.inject({
    method: 'GET',
    url: `/api/chat/threads/${threadId}/messages${cursor === undefined ? '' : `?cursor=${cursor}`}`,
    headers: { cookie },
  });

async function signedInUser() {
  const user = await createUser();
  userIds.push(user.id);
  return { user, cookie: accessCookie(user) };
}

async function signedInAdmin() {
  const admin = await createUser({ role: 'ADMIN' });
  userIds.push(admin.id);
  return accessCookie(admin);
}

// messages of the user written into an open chat of theirs, the way the socket writes them
const writeMessages = (userId: number, threadId: string, count: number) =>
  testTx(async (tx) => {
    await setUserContext(tx, { userId, role: 'USER' });
    await tx.chatMessage.createMany({
      data: Array.from({ length: count }, (_, n) => ({
        threadId,
        senderId: userId,
        senderType: 'user' as const,
        content: `message ${n + 1}`,
      })),
    });
  });

const messageIdsOf = (threadId: string) =>
  asAdmin(async (tx) =>
    (
      await tx.chatMessage.findMany({
        where: { threadId },
        orderBy: { id: 'asc' },
        select: { id: true },
      })
    ).map((m) => m.id),
  );

describe('GET /api/chat/thread/current', () => {
  it('opens a chat with the bot for a guest, with its welcome, and gives the same chat next time', async () => {
    const cookie = `guestId=${randomUUID()}`;

    const first = await getCurrent(cookie);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      thread: { type: 'bot', status: 'open', userId: null },
      messages: [{ senderType: 'bot', isRead: true }],
      nextCursor: null,
      ws: { url: '/api/chat/ws', threadId: first.json().thread.id },
    });

    const second = await getCurrent(cookie);
    expect(second.json().thread.id).toBe(first.json().thread.id);
  });

  // the widget of two tabs asks at once: both found no chat and both made one, the second hit the
  // index of one open chat and answered 500
  it('gives one chat to tabs that open it at once', async () => {
    for (let round = 0; round < 5; round += 1) {
      const { user, cookie } = await signedInUser();

      const answers = await Promise.all(Array.from({ length: 8 }, () => getCurrent(cookie)));

      expect(answers.map((res) => res.statusCode)).toEqual(Array(8).fill(200));
      expect(new Set(answers.map((res) => res.json().thread.id)).size).toBe(1);
      const open = await asAdmin((tx) =>
        tx.chatThread.count({ where: { userId: user.id, status: 'open' } }),
      );
      expect(open).toBe(1);
    }
  });

  it('refuses an admin, who has no chat with the bot', async () => {
    const res = await getCurrent(await signedInAdmin());

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ errorCode: 'INSUFFICIENT_ROLE' });
  });

  // the chat with the bot is never closed: the whole history came with every page load
  describe('a long chat', () => {
    it('gives the newest 50 messages, oldest first, and a cursor for the ones before', async () => {
      const { user, cookie } = await signedInUser();
      const threadId = (await getCurrent(cookie)).json().thread.id as string;
      await writeMessages(user.id, threadId, 59);
      const ids = await messageIdsOf(threadId);

      const res = await getCurrent(cookie);

      expect(res.statusCode).toBe(200);
      expect(res.json().messages.map((m: { id: number }) => m.id)).toEqual(ids.slice(10));
      expect(res.json().nextCursor).toEqual(expect.any(String));
    });

    it('gives the messages before the cursor, and no cursor once the start is reached', async () => {
      const { user, cookie } = await signedInUser();
      const threadId = (await getCurrent(cookie)).json().thread.id as string;
      await writeMessages(user.id, threadId, 59);
      const ids = await messageIdsOf(threadId);
      const { nextCursor } = (await getCurrent(cookie)).json();

      const older = await getMessages(cookie, threadId, nextCursor);

      expect(older.statusCode).toBe(200);
      expect(older.json()).toEqual({
        messages: ids.slice(0, 10).map((id) => expect.objectContaining({ id, threadId })),
        nextCursor: null,
      });
    });

    it('gives the newest page without a cursor', async () => {
      const { user, cookie } = await signedInUser();
      const threadId = (await getCurrent(cookie)).json().thread.id as string;
      await writeMessages(user.id, threadId, 3);

      const res = await getMessages(cookie, threadId);

      expect(
        res
          .json()
          .messages.map((m: { content: string }) => m.content)
          .slice(1),
      ).toEqual(['message 1', 'message 2', 'message 3']);
      expect(res.json().nextCursor).toBeNull();
    });
  });
});

describe('GET /api/chat/threads/:threadId/messages', () => {
  it('does not show a chat of another customer', async () => {
    const owner = await signedInUser();
    const threadId = (await getCurrent(owner.cookie)).json().thread.id as string;
    const stranger = await signedInUser();

    const res = await getMessages(stranger.cookie, threadId);

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ errorCode: 'CHAT_THREAD_NOT_FOUND' });
  });

  it('does not show a chat of a user to a guest', async () => {
    const owner = await signedInUser();
    const threadId = (await getCurrent(owner.cookie)).json().thread.id as string;

    const res = await getMessages(`guestId=${randomUUID()}`, threadId);

    expect(res.statusCode).toBe(404);
  });

  it.each(['%25%25%25', 'eyJpZCI6MH0', 'bm90IGpzb24'])(
    'refuses a broken cursor %s',
    async (cursor) => {
      const { cookie } = await signedInUser();
      const threadId = (await getCurrent(cookie)).json().thread.id as string;

      const res = await getMessages(cookie, threadId, cursor);

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode: 'CURSOR_INVALID' });
    },
  );

  it('refuses a thread id that is not a uuid', async () => {
    const { cookie } = await signedInUser();

    const res = await getMessages(cookie, 'not-a-uuid');

    expect(res.statusCode).toBe(400);
  });

  it('shows an admin the older messages of a chat given to the admins', async () => {
    const { user } = await signedInUser();
    const { id: threadId } = await createChatThread(user.id, { type: 'admin' });
    await writeMessages(user.id, threadId, 54);
    const ids = await messageIdsOf(threadId);
    const adminCookie = await signedInAdmin();

    const view = await app.inject({
      method: 'GET',
      url: `/api/chat/admin/threads/${threadId}`,
      headers: { cookie: adminCookie },
    });
    expect(view.statusCode).toBe(200);
    expect(view.json().messages.map((m: { id: number }) => m.id)).toEqual(ids.slice(5));

    const older = await getMessages(adminCookie, threadId, view.json().nextCursor);

    expect(older.statusCode).toBe(200);
    expect(older.json().messages.map((m: { id: number }) => m.id)).toEqual(ids.slice(0, 5));
    expect(older.json().nextCursor).toBeNull();
  });

  // a chat with the bot is the customer's alone, as in the admin view of a chat
  it('does not show an admin a chat with the bot', async () => {
    const { cookie } = await signedInUser();
    const threadId = (await getCurrent(cookie)).json().thread.id as string;

    const res = await getMessages(await signedInAdmin(), threadId);

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ errorCode: 'CHAT_THREAD_FORBIDDEN' });
  });
});
