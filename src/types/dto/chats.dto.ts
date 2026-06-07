import type { UserId } from 'types/ids.js';
import type { Role } from 'types/user.js';

export type ChatStatus = 'open' | 'closed';
export type ChatType = 'bot' | 'admin';
export type ChatSenderType = 'user' | 'admin' | 'bot' | 'guest';
export type AdminChatQueue = 'waiting' | 'active';

// common

export interface ChatThreadIdParamsDto {
    threadId: string;
}

export interface ChatThreadItemDto {
    id: string;
    userId: UserId | null;
    guestId: string | null;
    type: ChatType;
    status: ChatStatus;
    lastMessageAt: Date;
    unreadCount: number;
    adminRequestedAt: Date | null;
    adminUnreadSince: Date | null;
    lastMessagePreview: string | null;
    createdAt: Date;
    updatedAt: Date;
}

export interface ChatMessageItemDto {
    id: number;
    threadId: string;
    senderId: number | null;
    senderType: ChatSenderType;
    content: string;
    isRead: boolean;
    createdAt: Date;
}

// GET /thread/current

export interface GetCurrentChatDto {
    actorId: UserId;
    actorRole: Role;
}

export interface CurrentChatWsDto {
    url: string;
    threadId: string;
}

export interface CurrentChatResponseDto {
    thread: ChatThreadItemDto;
    messages: ChatMessageItemDto[];
    ws: CurrentChatWsDto;
}

// GET /admin/threads

export interface AdminChatThreadsQueryDto {
    page?: number;
    limit?: number;
    queue?: AdminChatQueue;
}

export interface FindAdminChatThreadsDto {
    actorId: UserId;
    actorRole: Role;
    page: number;
    limit: number;
    queue: AdminChatQueue;
}
export interface AdminChatThreadsResponseDto {
    items: ChatThreadItemDto[];
    page: number;
    limit: number;
    total: number;
}

// GET /admin/threads/:threadId

export interface FindAdminChatThreadDto extends ChatThreadIdParamsDto {
    actorId: UserId;
    actorRole: Role;
}

export interface AdminChatThreadResponseDto {
    thread: ChatThreadItemDto;
    messages: ChatMessageItemDto[];
    previousThreads: ChatThreadItemDto[];
}

// PATCH /admin/threads/:threadId/close

export interface CloseChatThreadDto extends ChatThreadIdParamsDto {
    actorId: UserId;
    actorRole: Role;
}

export interface CloseChatThreadResponseDto {
    thread: ChatThreadItemDto;
}

// WS /ws

export type ChatWsClientEventType =
    | 'thread:join'
    | 'message:send'
    | 'thread:read'
    | 'typing:start'
    | 'typing:stop';

export type ChatWsServerEventType =
    | 'connection:ready'
    | 'thread:joined'
    | 'message:new'
    | 'admin:requested'
    | 'thread:closed'
    | 'thread:read'
    | 'typing:start'
    | 'typing:stop'
    | 'error';

export interface ThreadJoinWsDto {
    type: 'thread:join';
    payload: {
        threadId: string;
    };
}

export interface MessageSendWsDto {
    type: 'message:send';
    payload: {
        threadId: string;
        content: string;
    };
}

export interface TypingStartWsDto {
    type: 'typing:start';
    payload: {
        threadId: string;
    };
}

export interface TypingStopWsDto {
    type: 'typing:stop';
    payload: {
        threadId: string;
    };
}

export type ChatWsClientEventDto =
    | ThreadJoinWsDto
    | MessageSendWsDto
    | ThreadReadWsDto
    | TypingStartWsDto
    | TypingStopWsDto;


export interface ThreadReadWsDto {
    type: 'thread:read';
    payload: {
        threadId: string;
    };
}