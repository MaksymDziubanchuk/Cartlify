import { UserId, ProductId, CategoryId } from 'types/ids.js';

export interface AdminStatsQueryDto {
  from?: string;
  to?: string;
  range?: '7d' | '30d';
}

export interface AdminStatsQueryNormalizedDto {
  from: Date;
  to: Date;
}

export interface AdminStatsUsersDto {
  total: number;
  new7d: number;
  new30d: number;
  verifiedRate: number;
}

export type OrderStatus = 'pending' | 'paid' | 'shipped' | 'delivered' | 'cancelled';

export interface AdminStatsOrdersByStatus {
  pending: number;
  paid: number;
  shiped: number;
  delivered: number;
  canceled: number;
}

export interface AdminStatsOrdersRevenue {
  total: number;
  last7d: number;
  last30d: number;
}

export interface AdminStatsOrdersDto {
  total: number;
  byStatus: AdminStatsOrdersByStatus;
  revenue: AdminStatsOrdersRevenue;
  averageOrderValue: number;
}

export interface AdminTopProductRevenue {
  id: ProductId;
  name: string;
  revenue: number;
}

export interface AdminTopCategoryRevenue {
  categoryId: CategoryId;
  categoryName: string;
  revenue: number;
}

export interface AdminStatsProductsDto {
  total: number;
  topProductsByRevenue: AdminTopProductRevenue[];
  topCategoriesByRevenue: AdminTopCategoryRevenue[];
}

export interface AdminStatsReviewsDto {
  total: number;
  avgRating: number;
  negativeCount: number;
}

export interface GetAdminStatsResponseDto {
  users: AdminStatsUsersDto;
  orders: AdminStatsOrdersDto;
  products: AdminStatsProductsDto;
  reviews: AdminStatsReviewsDto;
  generatedAt: string;
}

export interface SetProductPopularityInputDto {
  productId: ProductId;
  popularity: number;
  actorId: UserId;
}

export interface SetProductPopularityParamsDto {
  productId: ProductId;
}

export interface SetProductPopularityBodyDto {
  popularity: number;
}

export interface SetProductPopularityResponseDto {
  productId: ProductId;
  popularity: number;
}

export type ChatStatus = 'open' | 'closed';
export type ChatType = 'bot' | 'admin';

export interface GetAdminChatsQueryDto {
  status?: ChatStatus;
  page?: number;
  limit?: number;
}

export interface AdminChatsDto {
  status?: ChatStatus;
  type?: ChatType;
  page: number;
  limit: number;
  offset: number;
}

export interface AdminChatItemDto {
  id: string;
  userId: UserId;
  type: ChatType;
  status: ChatStatus;
  lastMessageAt: string;
}

export interface GetAdminChatsResponseDto {
  items: AdminChatItemDto[];
  total: number;
  page: number;
  limit: number;
}
