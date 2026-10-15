import { randomUUID } from 'node:crypto';
import { describe, expect, it } from '@jest/globals';

import { ChatWsParseError } from '@routes/api/chat/ws/chatWs.errors.js';
import { parseChatWsEvent } from '@routes/api/chat/ws/chatWs.parser.js';

import { thrownBy } from '../../../../../helpers/errors.js';

const threadId = randomUUID();

// the ws package hands every message over as a buffer
const frame = (event: unknown) => Buffer.from(JSON.stringify(event));

const parseError = (raw: unknown) => {
  const err = thrownBy(() => parseChatWsEvent(raw));

  expect(err).toBeInstanceOf(ChatWsParseError);
  return (err as ChatWsParseError).code;
};

describe('parseChatWsEvent', () => {
  it.each(['thread:join', 'thread:read', 'typing:start', 'typing:stop'])(
    'reads a %s event',
    (type) => {
      expect(parseChatWsEvent(frame({ type, payload: { threadId } }))).toEqual({
        type,
        payload: { threadId },
      });
    },
  );

  it('reads a message and trims its text', () => {
    const event = {
      type: 'message:send',
      payload: { threadId, content: '  Is the mug in stock?  ' },
    };

    expect(parseChatWsEvent(frame(event))).toEqual({
      type: 'message:send',
      payload: { threadId, content: 'Is the mug in stock?' },
    });
  });

  it('drops fields the event does not define', () => {
    const event = { type: 'thread:join', payload: { threadId, role: 'ADMIN' }, extra: true };

    expect(parseChatWsEvent(frame(event))).toEqual({ type: 'thread:join', payload: { threadId } });
  });

  it('reads an event that came as an array buffer or in fragments', () => {
    const bytes = frame({ type: 'thread:read', payload: { threadId } });
    const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length);
    const fragments = [bytes.subarray(0, 10), bytes.subarray(10)];

    expect(parseChatWsEvent(arrayBuffer).type).toBe('thread:read');
    expect(parseChatWsEvent(fragments).type).toBe('thread:read');
  });

  it('accepts a thread id in upper case', () => {
    const upper = threadId.toUpperCase();

    expect(parseChatWsEvent(frame({ type: 'thread:join', payload: { threadId: upper } }))).toEqual({
      type: 'thread:join',
      payload: { threadId: upper },
    });
  });

  describe('message length', () => {
    const send = (content: string) =>
      frame({ type: 'message:send', payload: { threadId, content } });

    it('accepts a message of exactly 2000 characters', () => {
      expect(parseChatWsEvent(send('a'.repeat(2000))).type).toBe('message:send');
    });

    it('rejects a message of 2001 characters', () => {
      expect(parseError(send('a'.repeat(2001)))).toBe('MESSAGE_TOO_LONG');
    });

    // three bytes a character in utf-8: the byte limit of a frame must not cut a legal message
    it('accepts a full-length message written in characters that take several bytes', () => {
      expect(parseChatWsEvent(send('€'.repeat(2000))).type).toBe('message:send');
    });

    it.each([
      ['empty', ''],
      ['only spaces and new lines', ' \n\t '],
    ])('rejects a message that is %s', (_case, content) => {
      expect(parseError(send(content))).toBe('EMPTY_MESSAGE_CONTENT');
    });

    it('rejects a message that is not text', () => {
      expect(parseError(frame({ type: 'message:send', payload: { threadId, content: 42 } }))).toBe(
        'INVALID_MESSAGE_CONTENT',
      );
    });

    // postgres text cannot hold a zero byte: the insert would fail with a server error
    it('rejects a message with a zero character, which the database cannot store', () => {
      expect(parseError(send('hello\u0000there'))).toBe('INVALID_MESSAGE_CONTENT');
    });

    // trim() does not remove a zero character, one at the edge would still reach the database
    it('rejects a zero character at the edge of the message too', () => {
      expect(parseError(send('hello\u0000'))).toBe('INVALID_MESSAGE_CONTENT');
    });

    it('keeps other control characters, tabs, new lines and emoji, which the database stores', () => {
      const content = 'line one\n\tline two \u0001 ✓ 😀';

      expect(parseChatWsEvent(send(content))).toEqual({
        type: 'message:send',
        payload: { threadId, content },
      });
    });
  });

  describe('frame size', () => {
    const big = (size: number) => Buffer.alloc(size, 0x20);

    it.each([
      ['a buffer', big(8001)],
      ['an array buffer', new ArrayBuffer(8001)],
      ['fragments', [big(4000), big(4001)]],
    ])('rejects a frame over 8000 bytes that came as %s', (_case, raw) => {
      expect(parseError(raw)).toBe('WS_PAYLOAD_TOO_LARGE');
    });

    it('lets a frame of exactly 8000 bytes through to the json check', () => {
      expect(parseError(big(8000))).toBe('INVALID_JSON');
    });
  });

  it.each([
    ['a string', 'text'],
    ['a number', 42],
    ['null', null],
    ['an array with something other than buffers', [Buffer.from('{}'), 'x']],
  ])('rejects a raw message that is %s', (_case, raw) => {
    expect(parseError(raw)).toBe('INVALID_RAW_MESSAGE');
  });

  it('rejects a frame that is not json', () => {
    expect(parseError(Buffer.from('{type: thread:join'))).toBe('INVALID_JSON');
  });

  it.each([
    ['an array', []],
    ['a string', 'thread:join'],
    ['null', null],
  ])('rejects an event that is %s', (_case, event) => {
    expect(parseError(frame(event))).toBe('INVALID_EVENT');
  });

  it.each([
    ['an unknown type', { type: 'thread:delete', payload: { threadId } }],
    ['no type', { payload: { threadId } }],
  ])('rejects an event with %s', (_case, event) => {
    expect(parseError(frame(event))).toBe('UNKNOWN_EVENT_TYPE');
  });

  it.each(['thread:join', 'message:send', 'thread:read', 'typing:start', 'typing:stop'])(
    'rejects a %s event without a payload object',
    (type) => {
      expect(parseError(frame({ type, payload: [threadId] }))).toBe('INVALID_PAYLOAD');
      expect(parseError(frame({ type }))).toBe('INVALID_PAYLOAD');
    },
  );

  it.each([
    ['missing', undefined],
    ['a number', 7],
    ['not a uuid', 'thread-7'],
    ['a uuid with extra text', `${threadId}x`],
  ])('rejects a thread id that is %s', (_case, id) => {
    expect(parseError(frame({ type: 'thread:join', payload: { threadId: id } }))).toBe(
      'INVALID_THREAD_ID',
    );
  });

  it('checks the thread id of a message before its text', () => {
    expect(
      parseError(frame({ type: 'message:send', payload: { threadId: 'x', content: '' } })),
    ).toBe('INVALID_THREAD_ID');
  });
});
