import type { CategoryId, ProductId, UserId } from 'types/ids.js';
import type { Role } from 'types/user.js';
import type { OrderStatus } from './orders.dto.js';

export type AdminRevenueOrderStatus = Extract<OrderStatus, 'paid' | 'shipped' | 'delivered'>;

// stats query
export interface AdminStatsQueryDto {
  from?: string;
  to?: string;
}

// normalized service input
export interface AdminStatsDto {
  from: Date;
  to: Date;
  actorId: UserId;
  actorRole: Role;
}

// response period
export interface AdminStatsPeriodDto {
  from: Date;
  to: Date;
}

// users
export interface AdminStatsUsersDto {
  total: number;
  newInPeriod: number;
  new7d: number;
  new30d: number;
  verifiedTotal: number;
  verifiedRate: number;
}

// orders
export interface AdminStatsOrdersByStatusDto {
  pending: number;
  unconfirmed: number;
  waiting: number;
  paid: number;
  shipped: number;
  delivered: number;
  cancelled: number;
}

export interface AdminStatsOrdersRevenueDto {
  total: number;
  inPeriod: number;
  last7d: number;
  last30d: number;
}

export interface AdminStatsOrdersDto {
  total: number;
  confirmedTotal: number;
  pendingCartsTotal: number;
  byStatus: AdminStatsOrdersByStatusDto;
  revenue: AdminStatsOrdersRevenueDto;
  averageOrderValue: number;
  itemsSold: number;
}

// products
export interface AdminTopProductRevenueDto {
  id: ProductId;
  name: string;
  revenue: number;
  quantitySold: number;
}

export interface AdminTopCategoryRevenueDto {
  id: CategoryId;
  name: string;
  revenue: number;
  quantitySold: number;
}

export interface AdminStatsProductsDto {
  total: number;
  activeTotal: number;
  deletedTotal: number;
  outOfStockTotal: number;
  topProductsByRevenue: AdminTopProductRevenueDto[];
  topCategoriesByRevenue: AdminTopCategoryRevenueDto[];
}

// reviews
export interface AdminStatsReviewsDto {
  total: number;
  ratedTotal: number;
  newInPeriod: number;
  avgRating: number;
  negativeCount: number;
}

// GET /admin/stats
export interface GetAdminStatsResponseDto {
  period: AdminStatsPeriodDto;
  users: AdminStatsUsersDto;
  orders: AdminStatsOrdersDto;
  products: AdminStatsProductsDto;
  reviews: AdminStatsReviewsDto;
  createdAt: Date;
}