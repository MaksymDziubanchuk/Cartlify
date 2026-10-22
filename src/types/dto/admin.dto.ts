import type { CategoryId, ProductId, UserId } from 'types/ids.js';
import type { Role } from 'types/user.js';
import type { OrderStatus } from './orders.dto.js';
import type { StockSourceName, WriteOffReason } from './products.dto.js';

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
// GET /admin/reports/accounting: the money of a period, the products asked for or all of them
export interface AdminAccountingQueryDto extends AdminStatsQueryDto {
  // ids of products through commas
  productIds?: string;
  categoryId?: number;
  // the category with its whole branch (true by default), or its own products only
  branch?: boolean;
}

export interface AdminAccountingDto extends AdminStatsDto {
  productIds?: number[];
  categoryId?: number;
  branch: boolean;
}

export interface AdminUnitsValueDto {
  units: number;
  value: number;
}

export interface AdminSalesDto {
  orders: number;
  units: number;
  revenue: number;
  cost: number;
  margin: number;
}

export interface GetAdminAccountingResponseDto {
  period: AdminStatsPeriodDto;
  currency: string;
  // the orders paid in the period, the cancelled ones among them too
  sales: AdminSalesDto;
  // the orders cancelled in the period: their payments went back
  cancellations: Omit<AdminSalesDto, 'margin'>;
  net: { revenue: number; cost: number; margin: number };
  // the batches taken in during the period, at their costs
  purchases: AdminUnitsValueDto & {
    bySource: Record<'supplier' | 'surplus' | 'customer_return', AdminUnitsValueDto>;
  };
  // the units written off in the period, at the costs of their batches
  writeOffs: AdminUnitsValueDto & {
    byReason: Record<
      'damaged' | 'defective' | 'expired' | 'shortage' | 'returned_to_supplier' | 'other',
      AdminUnitsValueDto
    >;
  };
  // what the batches have left now, at their costs
  stock: AdminUnitsValueDto;
}

// the money of a product, a category or a step of time in a period
export interface AdminMoneyBreakdownDto {
  sales: Omit<AdminSalesDto, 'orders'>;
  cancellations: Omit<AdminSalesDto, 'orders' | 'margin'>;
  // the sales less the cancellations; the percent is of the revenue, none without a revenue
  net: Omit<AdminSalesDto, 'orders'> & { marginPercent: number | null };
  writeOffs: AdminUnitsValueDto;
  purchases: AdminUnitsValueDto;
  stock: AdminUnitsValueDto;
}

export type AdminReportFormat = 'json' | 'csv';
export type AdminReportSortOrder = 'asc' | 'desc';

// the products and the categories sort by the net money, the write-offs, the purchases, the stock
export type AdminReportSortBy =
  | 'revenue'
  | 'margin'
  | 'marginPercent'
  | 'units'
  | 'writeOffs'
  | 'purchases'
  | 'stockValue'
  | 'stockUnits'
  | 'name';

export interface AdminReportScopeQueryDto extends AdminStatsQueryDto {
  categoryId?: number;
  // the category with its whole branch (true by default), or its own products only
  branch?: boolean;
  format?: AdminReportFormat;
}

export interface AdminReportProductsQueryDto extends AdminReportScopeQueryDto {
  sortBy?: AdminReportSortBy;
  sortOrder?: AdminReportSortOrder;
  limit?: number;
  cursor?: string;
}

export type AdminReportCategoriesQueryDto = Omit<AdminReportProductsQueryDto, 'limit' | 'cursor'>;

export type AdminReportStep = 'day' | 'week' | 'month';
export type AdminTimelineSortBy =
  'period' | 'revenue' | 'margin' | 'units' | 'writeOffs' | 'purchases';

export interface AdminReportTimelineQueryDto extends AdminReportScopeQueryDto {
  productIds?: string;
  step?: AdminReportStep;
  sortBy?: AdminTimelineSortBy;
  sortOrder?: AdminReportSortOrder;
}

export interface AdminReportProductRowDto extends AdminMoneyBreakdownDto {
  id: ProductId;
  name: string;
  deleted: boolean;
  category: { id: CategoryId; name: string };
}

export interface GetAdminReportProductsResponseDto {
  period: AdminStatsPeriodDto;
  currency: string;
  items: AdminReportProductRowDto[];
  // of every product of the filter, not only of the page
  totals: AdminMoneyBreakdownDto;
  limit: number;
  nextCursor: string | null;
}

export interface AdminReportCategoryRowDto extends AdminMoneyBreakdownDto {
  id: CategoryId;
  name: string;
  parentId: CategoryId | null;
}

export interface GetAdminReportCategoriesResponseDto {
  period: AdminStatsPeriodDto;
  currency: string;
  items: AdminReportCategoryRowDto[];
}

export interface AdminReportStepRowDto extends Omit<AdminMoneyBreakdownDto, 'stock'> {
  // the day or the monday of the week (yyyy-mm-dd), the month (yyyy-mm), by the shop calendar
  label: string;
  period: AdminStatsPeriodDto;
}

export interface GetAdminReportTimelineResponseDto {
  period: AdminStatsPeriodDto;
  currency: string;
  step: AdminReportStep;
  timeZone: string;
  items: AdminReportStepRowDto[];
}

// the batches of the stock: GET /api/admin/stock/batches
export type AdminStockBatchesSortBy =
  'createdAt' | 'expiresAt' | 'remaining' | 'unitCost' | 'value';

export interface AdminStockBatchesQueryDto {
  productId?: number;
  deliveryId?: string;
  source?: StockSourceName;
  // true: the batches with units left, false: the empty ones
  inStock?: boolean;
  // true: the batches whose last good day is behind the day of the shop, false: the others
  expired?: boolean;
  // the batches whose last good day comes by this day (yyyy-mm-dd)
  expiresBy?: string;
  sortBy?: AdminStockBatchesSortBy;
  sortOrder?: AdminReportSortOrder;
  limit?: number;
  cursor?: string;
}

export interface AdminStockProductDto {
  id: ProductId;
  name: string;
  // removed from the catalog
  deleted: boolean;
}

export interface AdminStockBatchDto {
  id: number;
  deliveryId: string;
  source: StockSourceName;
  supplierBatchNumber: string | null;
  product: AdminStockProductDto;
  unitCost: number;
  quantity: number;
  remaining: number;
  // the units of the paid orders that were not cancelled
  sold: number;
  writtenOff: number;
  // what is left at its cost
  value: number;
  expiresAt: string | null;
  expired: boolean;
  // what the delivery named, from its line in the admin log
  supplier: string | null;
  document: string | null;
  note: string | null;
  receivedBy: { id: UserId; role: Role } | null;
  createdAt: Date;
}

export interface GetAdminStockBatchesResponseDto {
  currency: string;
  items: AdminStockBatchDto[];
  limit: number;
  nextCursor: string | null;
  // the batches of the filters, not only of the page
  total: number;
}

// the journal of the stock: GET /api/admin/stock/movements
export type AdminStockMovementKind = 'delivery' | 'writeOff' | 'sale' | 'cancel';

export interface AdminStockMovementsQueryDto {
  productId?: number;
  batchId?: number;
  orderId?: number;
  deliveryId?: string;
  writeOffId?: string;
  // one kind or several through commas
  kind?: string;
  from?: string;
  to?: string;
  sortOrder?: AdminReportSortOrder;
  limit?: number;
  cursor?: string;
}

export interface AdminStockMovementBatchDto {
  batchId: number;
  quantity: number;
  unitCost: number;
}

export interface AdminStockMovementDto {
  kind: AdminStockMovementKind;
  at: Date;
  product: AdminStockProductDto;
  // the change of the stock: units in are above 0, units out below
  quantity: number;
  // the same at the cost of the batches
  value: number;
  batches: AdminStockMovementBatchDto[];
  orderId: number | null;
  deliveryId: string | null;
  writeOffId: string | null;
  source: StockSourceName | null;
  reason: WriteOffReason | null;
  supplier: string | null;
  document: string | null;
  note: string | null;
  // the admin of a delivery or a write-off
  actor: { id: UserId; role: Role } | null;
}

export interface GetAdminStockMovementsResponseDto {
  currency: string;
  items: AdminStockMovementDto[];
  limit: number;
  nextCursor: string | null;
  total: number;
}
