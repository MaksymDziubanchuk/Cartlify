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
  // the totals of the orders, the delivery included
  revenue: AdminStatsOrdersRevenueDto;
  // the delivery alone, part of the revenue
  deliveryRevenue: AdminStatsOrdersRevenueDto;
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
  // the income, the expenses and the margins of the period, the same as the report of the
  // accounting of the whole shop for it
  money: AdminMoneySummaryDto;
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

// the delivery of the orders in a period, apart from the products: what buyers paid for it, what
// went back with a cancel, what the shop paid the carriers; it is of no product, so a report of
// some products has none
export interface AdminDeliveryMoneyDto {
  // the delivery of the orders paid in the period and not cancelled (orders that paid for it)
  income: { orders: number; revenue: number };
  // told apart: the delivery of the paid orders cancelled in the period, by cancelledAt; it went
  // back, and the income of the period they were paid in has it no more
  refunded: { orders: number; revenue: number };
  // the sends the shop owes the carriers for, by the time they were sent (shippedAt); the ones
  // without a cost written count apart
  shipping: { sends: number; cost: number; withoutCost: number };
  // the income less what the carriers cost
  result: number;
}

// the money of a period in three parts; the delivery and the sends are of the whole shop, none for
// a report of some products or of a category, and the totals are of the items then
export interface AdminMoneySummaryDto {
  // the orders paid in the period and not cancelled: their items, their delivery, together
  income: { items: number; delivery: number | null; total: number };
  // what the items sold cost (their batches), the units written off, the sends the shop owes the
  // carriers for, together
  expenses: { costOfGoods: number; writeOffs: number; shipping: number | null; total: number };
  // the items less their cost, the delivery less the sends, all the income less all the expenses
  margin: { items: number; delivery: number | null; total: number };
}

export interface GetAdminAccountingResponseDto {
  period: AdminStatsPeriodDto;
  currency: string;
  // the orders paid in the period and not cancelled
  sales: AdminSalesDto;
  // told apart and in no margin: the orders cancelled in the period, their payments went back
  cancellations: Omit<AdminSalesDto, 'margin'>;
  // the income, the expenses and the margins of the period
  summary: AdminMoneySummaryDto;
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
  // the delivery of all orders; none when the report is of some products or of a category
  delivery: AdminDeliveryMoneyDto | null;
}

// the money of a product, a category or a step of time in a period
export interface AdminMoneyBreakdownDto {
  // the orders paid in the period and not cancelled; the percent is of the revenue, none without
  sales: Omit<AdminSalesDto, 'orders'> & { marginPercent: number | null };
  // told apart and in no margin: the orders cancelled in the period
  cancellations: Omit<AdminSalesDto, 'orders' | 'margin'>;
  writeOffs: AdminUnitsValueDto;
  // the margin of the sales less the write-offs, the percent of the revenue of the sales
  afterWriteOffs: { margin: number; marginPercent: number | null };
  purchases: AdminUnitsValueDto;
  stock: AdminUnitsValueDto;
}

export type AdminReportFormat = 'json' | 'csv';
export type AdminReportSortOrder = 'asc' | 'desc';

// the products and the categories sort by the money of the sales, the margin after the
// write-offs, the write-offs, the purchases, the stock
export type AdminReportSortBy =
  | 'revenue'
  | 'margin'
  | 'marginPercent'
  | 'units'
  | 'marginAfterWriteOffs'
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
  | 'period'
  | 'revenue'
  | 'margin'
  | 'units'
  | 'marginAfterWriteOffs'
  | 'marginTotal'
  | 'writeOffs'
  | 'purchases';

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
  // the delivery of the step; none when the report is of some products or of a category
  delivery: AdminDeliveryMoneyDto | null;
  // the income, the expenses and the margins of the step
  summary: AdminMoneySummaryDto;
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

// THE JOURNALS (the admin log, the log of prices, of logins and of consents): the same query for
// each. A journal sorts by any simple column, reads a period, takes some events and some columns
export interface AdminLogQueryDto {
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
  from?: string;
  to?: string;
  // the columns of the answer through commas, all unless given
  columns?: string;
  // the events through commas, all unless given
  events?: string;
  limit?: number;
  cursor?: string;
  format?: 'json' | 'csv';
}

// the account of a line; none of its data for an admin when it is root, the role stays
export interface AdminLogAccountDto {
  id: UserId | null;
  name: string | null;
  email: string | null;
  role: Role;
}

// a page of a journal: the lines with the columns asked for
export interface AdminLogPageDto<Item> {
  items: Partial<Item>[];
  limit: number;
  total: number;
  nextCursor: string | null;
}

// THE ADMIN LOG: who did what to what, from which address and browser
export interface AdminAuditLogQueryDto extends AdminLogQueryDto {
  actorId?: number;
  // the lines written with this role
  actorRole?: 'USER' | 'ADMIN' | 'ROOT';
  entityType?: string;
  entityId?: number;
  // a few actions separated by commas
  actions?: string;
  // the lines with a change of this field
  field?: string;
}

export interface AdminAuditLogItemDto {
  id: number;
  createdAt: string;
  actorId: UserId | null;
  // the account that did it; a deleted one has no email
  actor: AdminLogAccountDto;
  // the role it had when it did it
  actorRole: Role;
  action: string;
  // what made the line, finer than the action
  event: string;
  entityType: string;
  entityId: number | null;
  ip: string | null;
  userAgent: string | null;
  changes: Array<{ field: string; old: unknown; new: unknown }>;
}

export type GetAdminAuditLogResponseDto = AdminLogPageDto<AdminAuditLogItemDto>;

// THE LOG OF PRICES: every change of the price of every product
export interface AdminPriceLogQueryDto extends AdminLogQueryDto {
  productId?: number;
  actorId?: number;
  mode?: 'fixed' | 'percent';
}

export interface AdminPriceLogItemDto {
  id: number;
  createdAt: string;
  productId: number;
  product: { id: number; name: string };
  actorId: UserId | null;
  actor: AdminLogAccountDto;
  event: string;
  oldPrice: number;
  newPrice: number;
  mode: 'fixed' | 'percent';
  value: number;
  endsAt: string | null;
}

export type GetAdminPriceLogResponseDto = AdminLogPageDto<AdminPriceLogItemDto>;

// THE LOG OF LOGINS: who came in, how, from where
export interface AdminLoginLogQueryDto extends AdminLogQueryDto {
  userId?: number;
  // the roles of the accounts through commas
  roles?: string;
  // a part of the email
  email?: string;
}

export interface AdminLoginLogItemDto {
  id: number;
  createdAt: string;
  userId: UserId | null;
  user: AdminLogAccountDto & { deleted: boolean };
  email: string | null;
  role: Role;
  ipAddress: string | null;
  userAgent: string | null;
  event: string;
}

export type GetAdminLoginLogResponseDto = AdminLogPageDto<AdminLoginLogItemDto>;

// THE LOG OF CONSENTS: who agreed to which version, where
export interface AdminConsentLogQueryDto extends AdminLogQueryDto {
  userId?: number;
  documentId?: number;
  orderId?: number;
  kind?: 'terms' | 'contract';
}

export interface AdminConsentLogItemDto {
  id: number;
  createdAt: string;
  userId: UserId | null;
  user: AdminLogAccountDto & { deleted: boolean };
  documentId: number;
  document: { kind: 'terms' | 'contract'; version: number; title: string };
  orderId: number | null;
  ip: string | null;
  userAgent: string | null;
  event: string;
}

export type GetAdminConsentLogResponseDto = AdminLogPageDto<AdminConsentLogItemDto>;

// the events each journal writes, for the checkboxes of a page
export interface GetAdminLogEventsResponseDto {
  auditLog: string[];
  priceLog: string[];
  loginLog: string[];
  consentLog: string[];
}

// ALERTS: what waits for the work of an admin, each kind with how many there are
export type AdminAlertKind =
  | 'paid_orders_waiting'
  | 'shipped_orders_waiting'
  | 'pickup_not_collected'
  | 'shipped_without_cost'
  | 'out_of_stock'
  | 'low_stock'
  | 'products_without_shipping_data'
  | 'expiring_batches'
  | 'expired_batches'
  | 'chats_waiting'
  | 'refunded_payments'
  | 'worker_stalled'
  | 'admin_actions';

export type AdminAlertThresholdUnit = 'days' | 'units' | 'seconds' | 'hours';

// the threshold of a kind: the one the admin set (custom) or the one the server gives
export interface AdminAlertThresholdDto {
  value: number;
  default: number;
  min: number;
  max: number;
  unit: AdminAlertThresholdUnit;
  custom: boolean;
}

// the request to the list of the app that shows the cases of a kind: its path and query
export interface AdminAlertListDto {
  path: string;
  query: Record<string, string>;
}

export interface AdminAlertDto {
  kind: AdminAlertKind;
  // whether the actor follows the kind (the subscriptions)
  subscribed: boolean;
  // the cases that wait, without the ones the actor put aside
  count: number;
  // the cases that wait the actor put aside
  dismissed: number;
  // the threshold the kind is counted with, null for a kind without one
  threshold: number | null;
  list: AdminAlertListDto | null;
}

export interface GetAdminAlertsQueryDto {
  // true: only the kinds the actor follows
  subscribed?: boolean;
}

export interface GetAdminAlertsResponseDto {
  alerts: AdminAlertDto[];
  total: number;
  // false while redis is down: the cases put aside are counted with the rest
  dismissalsAvailable: boolean;
  generatedAt: string;
}

export interface AdminAlertSubscriptionDto {
  kind: AdminAlertKind;
  subscribed: boolean;
  threshold: AdminAlertThresholdDto | null;
}

export interface AdminAlertThresholdBodyDto {
  value: number;
}

export interface AdminAlertDismissalParamsDto {
  kind: string;
  id: string;
}

export interface AdminAlertDismissalDto {
  kind: AdminAlertKind;
  id: string;
  dismissed: boolean;
}

export interface AdminAlertDismissalItemDto {
  kind: AdminAlertKind;
  id: string;
  dismissedAt: string;
}

export interface AdminAlertKindParamsDto {
  kind: string;
}
