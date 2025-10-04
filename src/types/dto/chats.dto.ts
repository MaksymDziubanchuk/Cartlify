import type { UserId } from 'types/ids.js';

export type ChatStatus = 'open' | 'closed';
export type ChatType = 'bot' | 'admin';

export interface GetChatsQueryDto {
  page?: number;
  limit?: number;
  status?: ChatStatus;
  type?: ChatType;
}

export interface FindChatsDto {
  userId: UserId;
  page: number;
  limit: number;
  status?: ChatStatus;
  type?: ChatType;
}

export interface ChatItemDto {
  id: string;
  type: ChatType;
  status: ChatStatus;
  lastMessageAt: Date;
  unreadCount?: number;
  lastMessagePreview?: string;
}

export interface GetChatsResponseDto {
  items: ChatItemDto[];
  page?: number;
  limit?: number;
  total?: number;
}
