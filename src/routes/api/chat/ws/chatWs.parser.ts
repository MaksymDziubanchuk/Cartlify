import type {
    ChatWsClientEventDto,
    MessageSendWsDto,
    ThreadJoinWsDto,
    ThreadReadWsDto,
    TypingStartWsDto,
    TypingStopWsDto,
} from 'types/dto/chats.dto.js';

import { ChatWsParseError } from './chatWs.errors.js';

const UUID_REGEX =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const MAX_MESSAGE_LENGTH = 2000;
const MAX_RAW_EVENT_LENGTH = 8000;

// validate raw message size
function assertRawSize(raw: unknown): void {
    if (Buffer.isBuffer(raw) && raw.length > MAX_RAW_EVENT_LENGTH) {
        throw new ChatWsParseError('WS_PAYLOAD_TOO_LARGE');
    }

    if (raw instanceof ArrayBuffer && raw.byteLength > MAX_RAW_EVENT_LENGTH) {
        throw new ChatWsParseError('WS_PAYLOAD_TOO_LARGE');
    }

    if (Array.isArray(raw) && raw.every(Buffer.isBuffer)) {
        const size = raw.reduce((total, item) => total + item.length, 0);

        if (size > MAX_RAW_EVENT_LENGTH) {
            throw new ChatWsParseError('WS_PAYLOAD_TOO_LARGE');
        }
    }
}

// convert raw ws data to string
function rawToString(raw: unknown): string {
    assertRawSize(raw);

    if (Buffer.isBuffer(raw)) return raw.toString('utf8');

    if (raw instanceof ArrayBuffer) {
        return Buffer.from(raw).toString('utf8');
    }

    if (Array.isArray(raw) && raw.every(Buffer.isBuffer)) {
        return Buffer.concat(raw).toString('utf8');
    }

    throw new ChatWsParseError('INVALID_RAW_MESSAGE');
}

// check plain object
function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// validate thread id
function assertThreadId(value: unknown): string {
    if (typeof value !== 'string' || !UUID_REGEX.test(value)) {
        throw new ChatWsParseError('INVALID_THREAD_ID');
    }

    return value;
}

// validate message content
function assertContent(value: unknown): string {
    if (typeof value !== 'string') {
        throw new ChatWsParseError('INVALID_MESSAGE_CONTENT');
    }

    const content = value.trim();

    if (!content) {
        throw new ChatWsParseError('EMPTY_MESSAGE_CONTENT');
    }

    if (content.length > MAX_MESSAGE_LENGTH) {
        throw new ChatWsParseError('MESSAGE_TOO_LONG');
    }

    return content;
}

// parse thread join event
function parseThreadJoin(payload: unknown): ThreadJoinWsDto {
    if (!isRecord(payload)) {
        throw new ChatWsParseError('INVALID_PAYLOAD');
    }

    return {
        type: 'thread:join',
        payload: {
            threadId: assertThreadId(payload.threadId),
        },
    };
}

// parse message send event
function parseMessageSend(payload: unknown): MessageSendWsDto {
    if (!isRecord(payload)) {
        throw new ChatWsParseError('INVALID_PAYLOAD');
    }

    return {
        type: 'message:send',
        payload: {
            threadId: assertThreadId(payload.threadId),
            content: assertContent(payload.content),
        },
    };
}

// parse thread read event
function parseThreadRead(payload: unknown): ThreadReadWsDto {
    if (!isRecord(payload)) {
        throw new ChatWsParseError('INVALID_PAYLOAD');
    }

    return {
        type: 'thread:read',
        payload: {
            threadId: assertThreadId(payload.threadId),
        },
    };
}

// parse typing start event
function parseTypingStart(payload: unknown): TypingStartWsDto {
    if (!isRecord(payload)) {
        throw new ChatWsParseError('INVALID_PAYLOAD');
    }

    return {
        type: 'typing:start',
        payload: {
            threadId: assertThreadId(payload.threadId),
        },
    };
}

// parse typing stop event
function parseTypingStop(payload: unknown): TypingStopWsDto {
    if (!isRecord(payload)) {
        throw new ChatWsParseError('INVALID_PAYLOAD');
    }

    return {
        type: 'typing:stop',
        payload: {
            threadId: assertThreadId(payload.threadId),
        },
    };
}

// parse client ws event
export function parseChatWsEvent(raw: unknown): ChatWsClientEventDto {
    let parsed: unknown;

    try {
        parsed = JSON.parse(rawToString(raw));
    } catch (err) {
        if (err instanceof ChatWsParseError) throw err;

        throw new ChatWsParseError('INVALID_JSON');
    }

    if (!isRecord(parsed)) {
        throw new ChatWsParseError('INVALID_EVENT');
    }

    switch (parsed.type) {
        case 'thread:join':
            return parseThreadJoin(parsed.payload);

        case 'message:send':
            return parseMessageSend(parsed.payload);

        case 'thread:read':
            return parseThreadRead(parsed.payload);

        case 'typing:start':
            return parseTypingStart(parsed.payload);

        case 'typing:stop':
            return parseTypingStop(parsed.payload);

        default:
            throw new ChatWsParseError('UNKNOWN_EVENT_TYPE');
    }
}