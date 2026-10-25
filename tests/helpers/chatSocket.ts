import type { FastifyInstance } from 'fastify';
import type WebSocket from 'ws';

// an event of the chat socket, the way the server sends it
export type ChatEvent = { type: string; payload?: any };

const WAIT_MS = 10_000;

// injectWS builds the upgrade request by hand and gives it no socket address,
// which the rate limit needs to tell clients apart; a real connection always has one
const upgradeRequest = (headers: Record<string, string>) =>
  ({ headers, socket: { remoteAddress: '127.0.0.1' } }) as never;

// a chat socket of a test: every event the server sends is kept, the test takes the ones it
// waits for in any order; each event is taken once
export type ChatSocket = {
  socket: WebSocket;
  events: ChatEvent[];
  send: (event: unknown) => void;
  // the first event not taken yet that matches, now or when it comes; the wait is 10 s unless given
  take: (
    type: string,
    match?: (event: ChatEvent) => boolean,
    waitMs?: number,
  ) => Promise<ChatEvent>;
  // joins the thread and waits for the server to confirm it
  join: (threadId: string) => Promise<void>;
};

const sockets: WebSocket[] = [];

export async function openChatSocket(
  app: FastifyInstance,
  headers: Record<string, string>,
): Promise<ChatSocket> {
  const events: ChatEvent[] = [];
  const taken = new Set<number>();
  const waiters = new Set<() => void>();

  const socket = await app.injectWS('/api/chat/ws', upgradeRequest(headers), {
    onInit: (ws: WebSocket) => {
      ws.on('message', (raw) => {
        events.push(JSON.parse(String(raw)) as ChatEvent);
        waiters.forEach((check) => check());
      });
    },
  });
  sockets.push(socket);

  const take: ChatSocket['take'] = (type, match = () => true, waitMs = WAIT_MS) =>
    new Promise((resolve, reject) => {
      const check = () => {
        const index = events.findIndex((e, n) => !taken.has(n) && e.type === type && match(e));
        if (index < 0) return;

        taken.add(index);
        waiters.delete(check);
        clearTimeout(timer);
        resolve(events[index]!);
      };

      const timer = setTimeout(() => {
        waiters.delete(check);
        reject(new Error(`no ${type} event came; the socket got ${JSON.stringify(events)}`));
      }, waitMs);

      waiters.add(check);
      check();
    });

  const chat: ChatSocket = {
    socket,
    events,
    send: (event) => socket.send(JSON.stringify(event)),
    take,
    join: async (threadId) => {
      chat.send({ type: 'thread:join', payload: { threadId } });
      await take('thread:joined', (e) => e.payload?.threadId === threadId);
    },
  };

  await take('connection:ready');
  return chat;
}

// every socket a test file opened, in afterAll
export function closeChatSockets(): void {
  for (const socket of sockets.splice(0)) socket.terminate();
}
