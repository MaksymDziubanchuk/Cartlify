import type { FastifyInstance } from 'fastify';
import type WebSocket from 'ws';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { startApp, stopApp } from '../../../helpers/app.js';

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

beforeAll(async () => {
  app = await startApp();
});

afterAll(async () => {
  for (const socket of opened) socket.terminate();

  await stopApp();
});

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
