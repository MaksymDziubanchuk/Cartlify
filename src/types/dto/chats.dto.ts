import type { UserId } from 'types/ids.js';

export type ChatStatus = 'open' | 'closed';
export type ChatType = 'bot' | 'admin';
export type ChatSenderType = 'guest' | 'user' | 'admin' | 'root';

export interface GetChatThreadsQueryDto {
    page?: number;
    limit?: number;
    status?: ChatStatus;
    type?: ChatType;
}

export interface FindChatThreadsDto {
    page: number;
    limit: number;
    status?: ChatStatus;
    type?: ChatType;
}

export interface ChatThreadIdParamsDto {
    threadId: string;
}

export interface GetChatMessagesQueryDto {
    page?: number;
    limit?: number;
}

export interface FindChatMessagesDto extends ChatThreadIdParamsDto {
    page: number;
    limit: number;
}

export interface CreateChatThreadBodyDto {
    type: ChatType;
    content?: string;
}

export interface CreateChatThreadDto extends CreateChatThreadBodyDto { }

export interface CreateChatMessageBodyDto {
    content: string;
}

export interface CreateChatMessageDto
    extends ChatThreadIdParamsDto,
    CreateChatMessageBodyDto { }

export interface ChatThreadItemDto {
    id: string;
    type: ChatType;
    status: ChatStatus;
    lastMessageAt: Date | null;
    unreadCount: number;
    lastMessagePreview: string | null;
}

export interface ChatMessageItemDto {
    id: string;
    threadId: string;
    senderId: string | number | null;
    senderType: ChatSenderType;
    content: string;
    isRead: boolean;
    createdAt: Date;
}

export interface GetChatThreadsResponseDto {
    items: ChatThreadItemDto[];
    page: number;
    limit: number;
    total: number;
}

export interface GetChatMessagesResponseDto {
    items: ChatMessageItemDto[];
    page: number;
    limit: number;
    total: number;
}

export type CreateChatThreadResponseDto = ChatThreadItemDto;

export type CreateChatMessageResponseDto = ChatMessageItemDto;