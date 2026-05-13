import type { UserId } from 'types/ids.js';

export type ChatStatus = 'open' | 'closed';
export type ChatType = 'bot' | 'admin';

export interface ChatsGetQueryDto {
    page?: number;
    limit?: number;
    status?: ChatStatus;
    type?: ChatType;
}

export interface ChatItemDto {
    id: string;
    type: ChatType;
    status: ChatStatus;
    lastMessageAt: string;
    unreadCount?: number;
    lastMessagePreview?: string;
}

export interface ChatsGetResponseDto {
    items: ChatItemDto[];
    page?: number;
    limit?: number;
    total?: number;
}