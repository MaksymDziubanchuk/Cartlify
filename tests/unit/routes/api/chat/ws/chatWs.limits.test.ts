import { describe, expect, it } from '@jest/globals';

import { SocketLimits, limitKindOf } from '@routes/api/chat/ws/chatWs.limits.js';

describe('limitKindOf', () => {
  it.each([
    ['message:send', 'messages'],
    ['typing:start', 'typingStart'],
    ['typing:stop', 'typingStop'],
    ['thread:join', null],
    ['thread:read', null],
    ['anything else', null],
  ])('counts %s toward %s', (type, kind) => {
    expect(limitKindOf(type)).toBe(kind);
  });
});

describe('SocketLimits', () => {
  it('lets 5 messages through in 10 seconds and refuses the sixth', () => {
    const limits = new SocketLimits();
    const allowed = [0, 1, 2, 3, 4, 5].map((i) => limits.allow('messages', 1_000 + i));

    expect(allowed).toEqual([true, true, true, true, true, false]);
  });

  it('starts the count over once the window is over', () => {
    const limits = new SocketLimits();
    for (let i = 0; i < 5; i += 1) limits.allow('messages', 1_000);

    expect(limits.allow('messages', 11_000)).toBe(true);
  });

  it('counts each kind on its own', () => {
    const limits = new SocketLimits();
    expect(limits.allow('typingStart', 0)).toBe(true);

    expect(limits.allow('typingStart', 500)).toBe(false);
    expect(limits.allow('messages', 500)).toBe(true);
    expect(limits.allow('typingStart', 1_000)).toBe(true);
  });

  // a person types a letter and stops: the start and the stop come within a second
  it('lets a start of typing and its stop through in the same second', () => {
    const limits = new SocketLimits();

    expect(limits.allow('typingStart', 0)).toBe(true);
    expect(limits.allow('typingStop', 300)).toBe(true);
  });

  it('refuses a second stop of typing in a second', () => {
    const limits = new SocketLimits();
    limits.allow('typingStop', 0);

    expect(limits.allow('typingStop', 900)).toBe(false);
    expect(limits.allow('typingStop', 1_000)).toBe(true);
  });
});
