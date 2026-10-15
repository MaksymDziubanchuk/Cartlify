import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import WebSocket from 'ws';

type Broadcaster =
  (typeof import('@routes/api/chat/ws/chatWs.broadcaster.js'))['chatWsBroadcaster'];
type Manager =
  (typeof import('@routes/api/chat/ws/chatWs.connectionManager.js'))['chatWsConnectionManager'];

type FakeSocket = { readyState: number; send: jest.Mock<(data: string) => void> };

const fakeSocket = (readyState: number = WebSocket.OPEN): FakeSocket => ({
  readyState,
  send: jest.fn<(data: string) => void>(),
});

// what a socket received, parsed back from json
const received = (ws: FakeSocket) => ws.send.mock.calls.map(([data]) => JSON.parse(data));

let broadcaster: Broadcaster;
let manager: Manager;

const connect = (ws: FakeSocket, actorRole: 'GUEST' | 'USER' | 'ADMIN' | 'ROOT' = 'USER') =>
  manager.add({ socket: ws as unknown as WebSocket, actorId: 3, actorRole });

// the broadcaster reads the manager singleton, both come fresh from one module registry
beforeEach(async () => {
  jest.resetModules();
  ({ chatWsBroadcaster: broadcaster } = await import('@routes/api/chat/ws/chatWs.broadcaster.js'));
  ({ chatWsConnectionManager: manager } = await import(
    '@routes/api/chat/ws/chatWs.connectionManager.js'
  ));
});

describe('chatWsBroadcaster', () => {
  it('sends an event to one socket as json', () => {
    const ws = fakeSocket();
    const id = connect(ws);

    broadcaster.sendToSocket(id, { type: 'connection:ready', payload: { socketId: id } });

    expect(received(ws)).toEqual([{ type: 'connection:ready', payload: { socketId: id } }]);
  });

  it.each([
    ['still connecting', WebSocket.CONNECTING],
    ['closing', WebSocket.CLOSING],
    ['closed', WebSocket.CLOSED],
  ])('sends nothing to a socket that is %s', (_case, readyState) => {
    const ws = fakeSocket(readyState);

    broadcaster.sendToSocket(connect(ws), { type: 'connection:ready' });

    expect(ws.send).not.toHaveBeenCalled();
  });

  it('does nothing for a socket id that is not registered', () => {
    expect(() => broadcaster.sendToSocket('missing', { type: 'connection:ready' })).not.toThrow();
  });

  it('sends a thread event to every open socket in the thread and to nobody else', () => {
    const inThread = fakeSocket();
    const closedInThread = fakeSocket(WebSocket.CLOSED);
    const elsewhere = fakeSocket();

    manager.joinThread(connect(inThread), 'thread-1');
    manager.joinThread(connect(closedInThread), 'thread-1');
    manager.joinThread(connect(elsewhere), 'thread-2');

    broadcaster.broadcastToThread('thread-1', { type: 'message:new', payload: { id: 9 } });

    expect(received(inThread)).toEqual([{ type: 'message:new', payload: { id: 9 } }]);
    expect(closedInThread.send).not.toHaveBeenCalled();
    expect(elsewhere.send).not.toHaveBeenCalled();
  });

  it('sends an admin event to admins and root only', () => {
    const admin = fakeSocket();
    const root = fakeSocket();
    const user = fakeSocket();
    const guest = fakeSocket();

    connect(admin, 'ADMIN');
    connect(root, 'ROOT');
    connect(user, 'USER');
    connect(guest, 'GUEST');

    broadcaster.broadcastToAdmins({ type: 'admin:requested', payload: { thread: { id: 't' } } });

    expect(received(admin)).toHaveLength(1);
    expect(received(root)).toHaveLength(1);
    expect(user.send).not.toHaveBeenCalled();
    expect(guest.send).not.toHaveBeenCalled();
  });

  it('wraps an error code into an error event', () => {
    const ws = fakeSocket();

    broadcaster.sendError(connect(ws), { code: 'THREAD_NOT_JOINED' });

    expect(received(ws)).toEqual([{ type: 'error', payload: { code: 'THREAD_NOT_JOINED' } }]);
  });

  it('stops sending to a socket once the connection is removed', () => {
    const ws = fakeSocket();
    const id = connect(ws);

    manager.joinThread(id, 'thread-1');
    manager.remove(id);
    broadcaster.broadcastToThread('thread-1', { type: 'message:new' });
    broadcaster.sendToSocket(id, { type: 'connection:ready' });

    expect(ws.send).not.toHaveBeenCalled();
  });
});
