import type { FastifyInstance } from 'fastify';
import type WebSocket from 'ws';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import env from '@config/env.js';
import { prisma } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';

import { accessCookie, sessionCookie, signIn } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf } from '../../../helpers/csrf.js';
import { closeSessions, createUser } from '../../../helpers/factories.js';

// WEB_ORIGIN from tests/setup/integration.setup.ts
const WEB_ORIGIN = 'https://shop.example.com';

let app: FastifyInstance;
const opened: WebSocket[] = [];

// injectWS builds the upgrade request by hand and gives it no socket address,
// which the rate limit needs to tell clients apart; a real connection always has one
const upgradeRequest = (headers: Record<string, string>) =>
  ({ headers, socket: { remoteAddress: '127.0.0.1' } }) as never;

// opens a socket and resolves with the first event the server sends,
// the listener is set before the handshake ends so that the event cannot be missed
async function connect(headers: Record<string, string>) {
  let firstEvent: Promise<{ type: string }> | undefined;

  const socket = await app.injectWS('/api/chat/ws', upgradeRequest(headers), {
    onInit: (ws: WebSocket) => {
      firstEvent = new Promise((resolve) =>
        ws.once('message', (raw) => resolve(JSON.parse(String(raw)))),
      );
    },
  });
  opened.push(socket);

  return { socket, firstEvent: await firstEvent! };
}

const userIds: number[] = [];

beforeAll(async () => {
  app = await startApp();
});

afterAll(async () => {
  for (const socket of opened) socket.terminate();

  try {
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

// the code and the reason the server closes a socket with
const closeOf = (socket: WebSocket) =>
  new Promise<{ code: number; reason: string }>((resolve) =>
    socket.once('close', (code, reason) => resolve({ code, reason: String(reason) })),
  );

const send = (socket: WebSocket, event: unknown) => socket.send(JSON.stringify(event));

describe('GET /api/chat/ws', () => {
  it('opens the socket for a page of the frontend', async () => {
    const { firstEvent } = await connect({ origin: WEB_ORIGIN });

    expect(firstEvent.type).toBe('connection:ready');
  });

  it('opens the socket for a client that sends no Origin header', async () => {
    const { firstEvent } = await connect({});

    expect(firstEvent.type).toBe('connection:ready');
  });

  it.each(['https://evil.test', 'https://shop.example.com.evil.test', 'null'])(
    'refuses the handshake from %s',
    async (origin) => {
      await expect(app.injectWS('/api/chat/ws', upgradeRequest({ origin }))).rejects.toThrow(
        'Unexpected server response: 403',
      );
    },
  );

  it('issues no guest cookie to a refused page', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/chat/ws',
      headers: { origin: 'https://evil.test' },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 403, errorCode: 'ORIGIN_NOT_ALLOWED' });
    expect(res.headers['set-cookie']).toBeUndefined();
  });
});

describe('the limits of a socket', () => {
  // ws gathers a frame in memory before the app sees it: the default allows 100 MB
  it('closes the socket on a frame over 16 KB before the app reads it', async () => {
    const { socket } = await connect({});
    const closed = closeOf(socket);

    socket.send('x'.repeat(16_385));

    expect((await closed).code).toBe(1009);
  });

  // each message is a write to the database and a turn of the paid model of the bot
  it('closes the socket of a client that sends more than 5 messages in 10 seconds', async () => {
    const { socket } = await connect({});
    const closed = closeOf(socket);

    for (let i = 0; i < 6; i += 1) {
      send(socket, { type: 'message:send', payload: { threadId: '1', content: `hi ${i}` } });
    }

    expect(await closed).toEqual({ code: 1008, reason: 'TOO_MANY_MESSAGES' });
  });

  it('closes the socket of a client that types more than once a second', async () => {
    const { socket } = await connect({});
    const closed = closeOf(socket);

    send(socket, { type: 'typing:start', payload: { threadId: '1' } });
    send(socket, { type: 'typing:start', payload: { threadId: '1' } });

    expect(await closed).toEqual({ code: 1008, reason: 'TOO_MANY_MESSAGES' });
  });
});

describe('the session of a socket', () => {
  // the answer of a handshake becomes the socket: the cookies of a renewed session never reach the
  // browser, the next request came with the used refresh token and closed every session. The
  // frontend renews the session with POST /api/auth/refresh and connects again
  it('refuses a handshake with only a refresh cookie and leaves the session as it was', async () => {
    const user = await createUser();
    userIds.push(user.id);
    const session = await signIn(app, await getCsrf(app), user);

    await expect(
      app.injectWS('/api/chat/ws', upgradeRequest({ cookie: sessionCookie({ refreshToken: session.refreshToken }) })),
    ).rejects.toThrow('Unexpected server response: 401');

    // the refresh token still opens the session
    const refreshed = await app.inject({
      method: 'GET',
      url: '/api/users/me',
      headers: { cookie: sessionCookie({ refreshToken: session.refreshToken }) },
    });
    expect(refreshed.statusCode).toBe(200);
  });

  // a socket would outlive a role taken away or a logout by hours
  it('closes the socket when its access token runs out', async () => {
    const user = await createUser();
    userIds.push(user.id);
    const ttl = env.JWT_ACCESS_TTL_SHORT;
    env.JWT_ACCESS_TTL_SHORT = 1;
    const cookie = accessCookie(user);
    env.JWT_ACCESS_TTL_SHORT = ttl;

    const { socket, firstEvent } = await connect({ cookie });
    expect(firstEvent.type).toBe('connection:ready');

    expect(await closeOf(socket)).toEqual({ code: 4401, reason: 'SESSION_EXPIRED' });
  });

  // root took the role away; the access token of the admin still names the old one for minutes
  it('closes the socket of an admin whose role was taken away on the next step', async () => {
    const admin = await createUser({ role: 'ADMIN' });
    userIds.push(admin.id);
    const { socket } = await connect({ cookie: accessCookie(admin) });
    // root takes the role, the way POST /api/root/admins/:id/demote does
    await prisma.$transaction(async (tx) => {
      await setUserContext(tx, { userId: admin.id, role: 'ROOT' });
      await tx.user.update({ where: { id: admin.id }, data: { role: 'USER' } });
    });
    const closed = closeOf(socket);

    send(socket, { type: 'thread:join', payload: { threadId: '1' } });

    expect(await closed).toEqual({ code: 4401, reason: 'ROLE_CHANGED' });
  });
});
