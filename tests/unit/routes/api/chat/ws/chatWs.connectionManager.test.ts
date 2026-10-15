import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import type WebSocket from 'ws';

type Manager =
  (typeof import('@routes/api/chat/ws/chatWs.connectionManager.js'))['chatWsConnectionManager'];

// only the identity of a socket matters to the manager
const socket = () => ({}) as WebSocket;

let manager: Manager;

// the manager is a module singleton, every test gets a fresh one
beforeEach(async () => {
  jest.resetModules();
  ({ chatWsConnectionManager: manager } = await import(
    '@routes/api/chat/ws/chatWs.connectionManager.js'
  ));
});

describe('chatWsConnectionManager', () => {
  it('registers a socket with the actor who opened it', () => {
    const ws = socket();
    const id = manager.add({ socket: ws, actorId: 3, actorRole: 'USER' });

    expect(manager.getSocket(id)).toBe(ws);
    expect(manager.getContext(id)).toEqual({
      socketId: id,
      actorId: 3,
      actorRole: 'USER',
      joinedThreads: new Set(),
    });
  });

  it('gives every connection its own id, also two tabs of the same user', () => {
    const first = manager.add({ socket: socket(), actorId: 3, actorRole: 'USER' });
    const second = manager.add({ socket: socket(), actorId: 3, actorRole: 'USER' });

    expect(first).not.toBe(second);
  });

  it('knows nothing about an id it never gave', () => {
    expect(manager.getSocket('missing')).toBeNull();
    expect(manager.getContext('missing')).toBeNull();
  });

  it('counts admin and root connections as admins, users and guests not', () => {
    const admin = socket();
    const root = socket();

    manager.add({ socket: admin, actorId: 1, actorRole: 'ADMIN' });
    manager.add({ socket: root, actorId: 2, actorRole: 'ROOT' });
    manager.add({ socket: socket(), actorId: 3, actorRole: 'USER' });
    manager.add({
      socket: socket(),
      actorId: 'a4b8f9e2-0c1d-4e5f-8a9b-0c1d2e3f4a5b',
      actorRole: 'GUEST',
    });

    expect(manager.getAdminSockets()).toEqual([admin, root]);
  });

  it('lists the sockets joined to a thread, once each', () => {
    const a = socket();
    const b = socket();
    const idA = manager.add({ socket: a, actorId: 3, actorRole: 'USER' });
    const idB = manager.add({ socket: b, actorId: 1, actorRole: 'ADMIN' });

    manager.joinThread(idA, 'thread-1');
    manager.joinThread(idA, 'thread-1');
    manager.joinThread(idB, 'thread-1');

    expect(manager.getThreadSockets('thread-1')).toEqual([a, b]);
    expect(manager.getContext(idA)?.joinedThreads).toEqual(new Set(['thread-1']));
  });

  it('has no sockets for a thread nobody joined', () => {
    expect(manager.getThreadSockets('thread-x')).toEqual([]);
  });

  it('ignores a join from a socket that is not registered', () => {
    manager.joinThread('missing', 'thread-1');

    expect(manager.getThreadSockets('thread-1')).toEqual([]);
  });

  it('removes a socket from one thread and keeps it in the others', () => {
    const ws = socket();
    const id = manager.add({ socket: ws, actorId: 3, actorRole: 'USER' });

    manager.joinThread(id, 'thread-1');
    manager.joinThread(id, 'thread-2');
    manager.leaveThread(id, 'thread-1');

    expect(manager.getThreadSockets('thread-1')).toEqual([]);
    expect(manager.getThreadSockets('thread-2')).toEqual([ws]);
    expect(manager.getContext(id)?.joinedThreads).toEqual(new Set(['thread-2']));
  });

  it('forgets a closed connection everywhere: threads, admins and lookups', () => {
    const ws = socket();
    const id = manager.add({ socket: ws, actorId: 1, actorRole: 'ADMIN' });

    manager.joinThread(id, 'thread-1');
    manager.remove(id);

    expect(manager.getSocket(id)).toBeNull();
    expect(manager.getContext(id)).toBeNull();
    expect(manager.getThreadSockets('thread-1')).toEqual([]);
    expect(manager.getAdminSockets()).toEqual([]);
  });

  it('lets a closed connection be removed twice, close and error both fire', () => {
    const id = manager.add({ socket: socket(), actorId: 3, actorRole: 'USER' });

    manager.remove(id);

    expect(() => manager.remove(id)).not.toThrow();
  });

  it('detaches every socket from a removed thread but keeps the connections', () => {
    const a = socket();
    const idA = manager.add({ socket: a, actorId: 3, actorRole: 'USER' });
    const idB = manager.add({ socket: socket(), actorId: 1, actorRole: 'ADMIN' });

    manager.joinThread(idA, 'thread-1');
    manager.joinThread(idA, 'thread-2');
    manager.joinThread(idB, 'thread-1');
    manager.removeThread('thread-1');

    expect(manager.getThreadSockets('thread-1')).toEqual([]);
    expect(manager.getContext(idA)?.joinedThreads).toEqual(new Set(['thread-2']));
    expect(manager.getContext(idB)?.joinedThreads).toEqual(new Set());
    expect(manager.getSocket(idA)).toBe(a);
  });
});
