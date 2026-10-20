import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { prisma } from '@db/client.js';

import { inRolledBackTx, type Actor, type DbSession } from '../../helpers/db.js';
import { changedRows } from '../../helpers/dbOrders.js';
import { closeSessions, createUser, type TestUser } from '../../helpers/factories.js';

// the chats of the shop: a user or a guest talks to the bot in a chat of their own, a user asks
// for an admin and the chat becomes one an admin answers; an admin closes it. One open chat per
// user or guest, a chat belongs to its user or guest for good, a closed chat is history: it opens
// no more and takes no new message. A message is read by the other side, its text never changes

let user: TestUser;
let other: TestUser;
let admin: TestUser;
let otherAdmin: TestUser;

beforeAll(async () => {
  user = await createUser();
  other = await createUser();
  admin = await createUser({ role: 'ADMIN' });
  otherAdmin = await createUser({ role: 'ADMIN' });
});

afterAll(async () => {
  try {
    await closeSessions([user.id, other.id, admin.id, otherAdmin.id]);
  } finally {
    await prisma.$disconnect();
  }
});

const asUser = (who: TestUser = user): Actor => ({ role: 'USER', userId: who.id });
const asAdmin = (who: TestUser = admin): Actor => ({ role: 'ADMIN', userId: who.id });
const asGuest = (guestId: string = randomUUID()): Actor => ({ role: 'GUEST', guestId });

type Owner = { userId: number } | { guestId: string };

const ownerActor = (owner: Owner): Actor =>
  'userId' in owner ? { role: 'USER', userId: owner.userId } : asGuest(owner.guestId);

// a chat of the user or the guest, the way the app opens one: a bot chat, or a chat that asked for
// an admin and waits for one
async function chatOf(db: DbSession, owner: Owner, type: 'bot' | 'admin' = 'bot') {
  await db.as(ownerActor(owner));
  const id = randomUUID();
  const waiting = type === 'admin';
  await db.rows(
    `insert into cartlify.chat_threads (id, "userId", "guestId", type, "adminRequestedAt", "adminUnreadSince")
     values ($1::uuid, $2, $3::uuid, $4::cartlify."ChatType", $5, $5) returning id`,
    id,
    'userId' in owner ? owner.userId : null,
    'guestId' in owner ? owner.guestId : null,
    type,
    waiting ? new Date() : null,
  );
  return id;
}

// what closing does, the fields of closeAdminChatThread
const closeChat = async (db: DbSession, threadId: string) => {
  await db.as(asAdmin());
  await db.rows(
    `update cartlify.chat_threads
     set status = 'closed', "unreadCount" = 0, "adminRequestedAt" = null, "adminUnreadSince" = null
     where id = $1::uuid returning id`,
    threadId,
  );
};

const writeMessage = (
  db: DbSession,
  threadId: string,
  senderType: 'user' | 'guest' | 'bot' | 'admin',
  senderId: number | null,
  content = 'Where is my order?',
) =>
  db.attempt<{ id: number }>(
    `insert into cartlify.chat_messages ("threadId", "senderType", "senderId", content)
     values ($1::uuid, $2::cartlify."ChatMessageSenderType", $3, $4) returning id`,
    threadId,
    senderType,
    senderId,
    content,
  );

const updateChat = (db: DbSession, set: string, threadId: string, ...values: unknown[]) =>
  db.attempt(
    `update cartlify.chat_threads set ${set} where id = $1::uuid returning id`,
    threadId,
    ...values,
  );

const chatsSeen = async (db: DbSession, ids: string[]) =>
  (
    await db.rows<{ id: string }>(
      'select id::text as id from cartlify.chat_threads where id = any($1::uuid[]) order by id',
      ids,
    )
  ).map((row) => row.id);

describe('chats: reading', () => {
  it('shows a user and a guest their own chats, an admin every chat', async () => {
    const guestId = randomUUID();

    const { ids, seen } = await inRolledBackTx(async (db) => {
      const own = await chatOf(db, { userId: user.id });
      const foreign = await chatOf(db, { userId: other.id });
      const guests = await chatOf(db, { guestId });
      const ids = { own, foreign, guests };
      const all = [own, foreign, guests];

      const seen: Record<string, string[]> = {};
      for (const [who, actor] of [
        ['user', asUser()],
        ['guest', asGuest(guestId)],
        ['another guest', asGuest()],
        ['admin', asAdmin()],
      ] as const) {
        await db.as(actor);
        seen[who] = await chatsSeen(db, all);
      }
      return { ids, seen };
    });

    expect(seen).toEqual({
      user: [ids.own],
      guest: [ids.guests],
      'another guest': [],
      admin: [ids.own, ids.foreign, ids.guests].sort(),
    });
  });
});

describe('chats: opening one', () => {
  it.each([
    ['a user of another user', () => asUser(), () => ({ userId: other.id, guestId: null })],
    ['a guest of another guest', () => asGuest(), () => ({ userId: null, guestId: randomUUID() })],
    ['an admin of a user', () => asAdmin(), () => ({ userId: user.id, guestId: null })],
  ])('refuses %s', async (_case, actor, owner) => {
    const outcome = await inRolledBackTx(async (db) => {
      await db.as(actor());
      const { userId, guestId } = owner();
      return db.attempt(
        `insert into cartlify.chat_threads (id, "userId", "guestId", type)
         values ($1::uuid, $2, $3::uuid, 'bot') returning id`,
        randomUUID(),
        userId,
        guestId,
      );
    });

    expect(outcome.ok).toBe(false);
  });

  it('keeps one open chat per user, a closed one aside', async () => {
    const { second, afterClose } = await inRolledBackTx(async (db) => {
      const first = await chatOf(db, { userId: user.id });
      await db.as(asUser());
      const second = await db.attempt(
        `insert into cartlify.chat_threads (id, "userId", type) values ($1::uuid, $2, 'bot') returning id`,
        randomUUID(),
        user.id,
      );
      await db.as(asUser());
      await updateChat(db, `status = 'closed'`, first);
      await db.as(asUser());
      const afterClose = await db.attempt(
        `insert into cartlify.chat_threads (id, "userId", type) values ($1::uuid, $2, 'bot') returning id`,
        randomUUID(),
        user.id,
      );
      return { second, afterClose };
    });

    expect(second.ok).toBe(false);
    expect(changedRows(afterClose)).toBe(true);
  });
});

describe('chats: changing one', () => {
  it('lets a user ask for an admin, the way the app passes a bot chat on', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      const threadId = await chatOf(db, { userId: user.id });
      await db.as(asUser());
      return updateChat(
        db,
        `type = 'admin', "adminRequestedAt" = now(), "adminUnreadSince" = now()`,
        threadId,
      );
    });

    expect(changedRows(outcome)).toBe(true);
  });

  it('lets an admin close a chat with an admin', async () => {
    const status = await inRolledBackTx(async (db) => {
      const threadId = await chatOf(db, { userId: user.id }, 'admin');
      await closeChat(db, threadId);
      const [row] = await db.rows<{ status: string }>(
        'select status::text as status from cartlify.chat_threads where id = $1::uuid',
        threadId,
      );
      return row!.status;
    });

    expect(status).toBe('closed');
  });

  // a chat holds what one person said: in the hands of another user it shows them all of it
  it.each([
    ['the user', () => asUser()],
    ['an admin', () => asAdmin()],
  ])('does not let %s give a chat to another user', async (_who, actor) => {
    const outcome = await inRolledBackTx(async (db) => {
      const threadId = await chatOf(db, { userId: user.id }, 'admin');
      await db.as(actor());
      return updateChat(db, '"userId" = $2', threadId, other.id);
    });

    expect(changedRows(outcome)).toBe(false);
  });

  // a closed chat is history; a user who needs help again starts a new one
  it.each([
    ['the user', () => asUser()],
    ['an admin', () => asAdmin()],
  ])('does not let %s open a closed chat again', async (_who, actor) => {
    const outcome = await inRolledBackTx(async (db) => {
      const threadId = await chatOf(db, { userId: user.id }, 'admin');
      await closeChat(db, threadId);
      await db.as(actor());
      return updateChat(
        db,
        `status = 'open', "adminRequestedAt" = now(), "adminUnreadSince" = now()`,
        threadId,
      );
    });

    expect(changedRows(outcome)).toBe(false);
  });

  // the admin queue goes by adminRequestedAt: an earlier time would put a chat before the ones
  // that waited longer
  it('does not let a user move an own request ahead in the admin queue', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      const threadId = await chatOf(db, { userId: user.id }, 'admin');
      await db.as(asUser());
      return updateChat(db, `"adminRequestedAt" = now() - interval '1 day'`, threadId);
    });

    expect(changedRows(outcome)).toBe(false);
  });

  it('does not let a user open a chat that asked for an admin earlier than now', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      await db.as(asUser());
      return db.attempt(
        `insert into cartlify.chat_threads (id, "userId", type, "adminRequestedAt", "adminUnreadSince")
         values ($1::uuid, $2, 'admin', now() - interval '1 day', now()) returning id`,
        randomUUID(),
        user.id,
      );
    });

    expect(outcome.ok).toBe(false);
  });

  // a message of the waiting user changes the chat, its request keeps its time
  it('lets a chat that waits for an admin change otherwise, its request time as it was', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      const threadId = await chatOf(db, { userId: user.id }, 'admin');
      await db.as(asUser());
      return updateChat(
        db,
        `"lastMessagePreview" = 'Any news?', "lastMessageAt" = now(), "unreadCount" = "unreadCount" + 1`,
        threadId,
      );
    });

    expect(changedRows(outcome)).toBe(true);
  });

  it('does not let another user change a chat', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      const threadId = await chatOf(db, { userId: user.id });
      await db.as(asUser(other));
      return updateChat(db, `"lastMessagePreview" = 'Taken over'`, threadId);
    });

    expect(changedRows(outcome)).toBe(false);
  });

  it.each([
    ['the user', () => asUser()],
    ['an admin', () => asAdmin()],
  ])('lets %s delete no chat', async (_who, actor) => {
    const outcome = await inRolledBackTx(async (db) => {
      const threadId = await chatOf(db, { userId: user.id });
      await db.as(actor());
      return db.attempt(
        'delete from cartlify.chat_threads where id = $1::uuid returning id',
        threadId,
      );
    });

    expect(changedRows(outcome)).toBe(false);
  });
});

describe('chat messages: writing', () => {
  it('lets a user write in an own chat, and the bot answer in a bot chat', async () => {
    const { mine, bot } = await inRolledBackTx(async (db) => {
      const threadId = await chatOf(db, { userId: user.id });
      await db.as(asUser());
      return {
        mine: await writeMessage(db, threadId, 'user', user.id),
        bot: await writeMessage(db, threadId, 'bot', null, 'The order is on its way.'),
      };
    });

    expect(changedRows(mine)).toBe(true);
    expect(changedRows(bot)).toBe(true);
  });

  it.each([
    ['in the name of another user', 'user', () => other.id],
    ['as an admin', 'admin', () => user.id],
  ] as const)('does not let a user write %s', async (_case, senderType, senderIdOf) => {
    const outcome = await inRolledBackTx(async (db) => {
      const threadId = await chatOf(db, { userId: user.id }, 'admin');
      await db.as(asUser());
      return writeMessage(db, threadId, senderType, senderIdOf());
    });

    expect(outcome.ok).toBe(false);
  });

  it('does not let a user write in the chat of another user', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      const threadId = await chatOf(db, { userId: other.id });
      await db.as(asUser());
      return writeMessage(db, threadId, 'user', user.id);
    });

    expect(outcome.ok).toBe(false);
  });

  it('does not let the bot answer in a chat with an admin', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      const threadId = await chatOf(db, { userId: user.id }, 'admin');
      await db.as(asUser());
      return writeMessage(db, threadId, 'bot', null, 'I am the bot.');
    });

    expect(outcome.ok).toBe(false);
  });

  it('lets a guest write in an own bot chat', async () => {
    const guestId = randomUUID();

    const outcome = await inRolledBackTx(async (db) => {
      const threadId = await chatOf(db, { guestId });
      await db.as(asGuest(guestId));
      return writeMessage(db, threadId, 'guest', null);
    });

    expect(changedRows(outcome)).toBe(true);
  });

  it('lets an admin answer in a chat with an admin, only in their own name', async () => {
    const { own, foreign } = await inRolledBackTx(async (db) => {
      const threadId = await chatOf(db, { userId: user.id }, 'admin');
      await db.as(asAdmin());
      return {
        own: await writeMessage(db, threadId, 'admin', admin.id, 'Let me check.'),
        foreign: await writeMessage(db, threadId, 'admin', otherAdmin.id, 'Let me check.'),
      };
    });

    expect(changedRows(own)).toBe(true);
    expect(foreign.ok).toBe(false);
  });

  it('does not let an admin write in a chat with the bot', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      const threadId = await chatOf(db, { userId: user.id });
      await db.as(asAdmin());
      return writeMessage(db, threadId, 'admin', admin.id, 'Let me check.');
    });

    expect(outcome.ok).toBe(false);
  });

  // a closed chat is history
  it.each([
    ['the user', () => asUser(), 'user' as const, () => user.id],
    ['an admin', () => asAdmin(), 'admin' as const, () => admin.id],
  ])('takes no message from %s into a closed chat', async (_who, actor, senderType, senderIdOf) => {
    const outcome = await inRolledBackTx(async (db) => {
      const threadId = await chatOf(db, { userId: user.id }, 'admin');
      await closeChat(db, threadId);
      await db.as(actor());
      return writeMessage(db, threadId, senderType, senderIdOf());
    });

    expect(outcome.ok).toBe(false);
  });
});

describe('chat messages: reading and marks', () => {
  // a chat with a message of the user and an answer of the admin
  async function talk(db: DbSession) {
    const threadId = await chatOf(db, { userId: user.id }, 'admin');
    await db.as(asUser());
    const question = (await writeMessage(db, threadId, 'user', user.id)) as {
      ok: true;
      rows: { id: number }[];
    };
    await db.as(asAdmin());
    const answer = (await writeMessage(db, threadId, 'admin', admin.id, 'On its way.')) as {
      ok: true;
      rows: { id: number }[];
    };
    return { threadId, question: question.rows[0]!.id, answer: answer.rows[0]!.id };
  }

  const markRead = (db: DbSession, messageId: number) =>
    db.attempt(
      'update cartlify.chat_messages set "isRead" = true where id = $1 returning id',
      messageId,
    );

  it('shows the messages of a chat to its user and to an admin, not to another user', async () => {
    const seen = await inRolledBackTx(async (db) => {
      const { threadId } = await talk(db);
      const count = async (actor: Actor) => {
        await db.as(actor);
        const [row] = await db.rows<{ n: number }>(
          'select count(*)::int as n from cartlify.chat_messages where "threadId" = $1::uuid',
          threadId,
        );
        return row!.n;
      };
      return {
        user: await count(asUser()),
        admin: await count(asAdmin()),
        other: await count(asUser(other)),
      };
    });

    expect(seen).toEqual({ user: 2, admin: 2, other: 0 });
  });

  it('lets each side mark the message of the other side read, not its own', async () => {
    const marks = await inRolledBackTx(async (db) => {
      const { question, answer } = await talk(db);
      await db.as(asUser());
      const userReadsAnswer = await markRead(db, answer);
      const userReadsOwn = await markRead(db, question);
      await db.as(asAdmin());
      const adminReadsQuestion = await markRead(db, question);
      const adminReadsOwn = await markRead(db, answer);
      return [userReadsAnswer, userReadsOwn, adminReadsQuestion, adminReadsOwn].map(changedRows);
    });

    expect(marks).toEqual([true, false, true, false]);
  });

  it.each([
    ['the user', () => asUser(), 'question' as const],
    ['an admin', () => asAdmin(), 'answer' as const],
  ])('lets %s change the text of no message, also an own one', async (_who, actor, which) => {
    const outcome = await inRolledBackTx(async (db) => {
      const messages = await talk(db);
      await db.as(actor());
      return db.attempt(
        `update cartlify.chat_messages set content = 'Rewritten', "isRead" = true where id = $1 returning id`,
        messages[which],
      );
    });

    expect(changedRows(outcome)).toBe(false);
  });

  it.each([
    ['the user', () => asUser()],
    ['an admin', () => asAdmin()],
  ])('lets %s delete no message', async (_who, actor) => {
    const outcome = await inRolledBackTx(async (db) => {
      const { threadId } = await talk(db);
      await db.as(actor());
      return db.attempt(
        'delete from cartlify.chat_messages where "threadId" = $1::uuid returning id',
        threadId,
      );
    });

    expect(changedRows(outcome)).toBe(false);
  });
});
