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
  // what went back with the returns (the units and their part of the delivery), by the time the
  // money went back
  returned: AdminStatsOrdersRevenueDto;
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

// the product and the variant of a line of the top of variants, as the accounting names them
export interface AdminTopVariantRevenueDto {
  product: { id: ProductId; name: string; deleted: boolean };
  variant: { id: number; position: number; name: string; sku: string | null; deleted: boolean };
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
  // products of the catalog none of whose variants in sale has a free unit
  outOfStockTotal: number;
  // the products of the most money, the sales of all the variants of a product together
  topProductsByRevenue: AdminTopProductRevenueDto[];
  // the variants of the most money, each with its product
  topVariantsByRevenue: AdminTopVariantRevenueDto[];
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
// GET /admin/reports/accounting: the money of a period, the products or the variants asked for or
// all of them
export interface AdminAccountingQueryDto extends AdminStatsQueryDto {
  // ids of products through commas: the money of all their variants
  productIds?: string;
  // ids of variants through commas
  variantIds?: string;
  categoryId?: number;
  // the category with its whole branch (true by default), or its own products only
  branch?: boolean;
}

export interface AdminAccountingDto extends AdminStatsDto {
  productIds?: number[];
  variantIds?: number[];
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

// the delivery of the orders in a period, apart from the products, from the money journal: what
// buyers paid for it, what went back with the returns, what the shop paid the carriers; it is of no
// product, so a report of some products has none
export interface AdminDeliveryMoneyDto {
  // the delivery of the payments written in the period, cancelled later or not (orders that paid
  // for it)
  income: { orders: number; revenue: number };
  // the delivery that went back with the money of the statements written in the period (the
  // transfers and the money sent outside the app, less their failures); the income of the period
  // the order was paid in keeps it
  refunded: { orders: number; revenue: number };
  // the sends the shop owes the carriers for, by the time they were sent (shippedAt); the cost is
  // the lines of their costs with the corrections, by the time they were written; the ones without
  // a cost count apart
  shipping: { sends: number; cost: number; withoutCost: number };
  // the parcels the shop paid to carry goods back from buyers, by the time they were sent (the time
  // the admin gave), the cost as for the sends; the ones without a cost count apart. deducted: the
  // cost of the way back the buyers owed, taken off the transfers in the period (an income);
  // reimbursed: the cost of the way back root paid back to buyers outside the app in the period
  // (spent)
  returnShipping: {
    sends: number;
    cost: number;
    withoutCost: number;
    deducted: number;
    reimbursed: number;
  };
  // the income less what went back and less what the carriers cost, the parcels back too
  result: number;
}

// the money the payments moved past the statements in a period, of the whole shop: a report of some
// products has none. result is what each left the money of the shop, below 0 the shop is without it
export interface AdminPaymentsMoneyDto {
  // what the bank took for the disputes of the payments of orders and gave back; used, what the
  // transfers of statements took of the money of lost disputes as money the buyer had back (the
  // returns count it)
  disputes: {
    withdrawn: number;
    reinstated: number;
    used: number;
    // what the bank took for a dispute lost that root has not said what it was for yet
    undecided: number;
    result: number;
  };
  // the refunds made by hand in the dashboard of the provider for the payments of orders (less the
  // failures, with the money sent outside the app after one), by what root or the system decided
  // they were: a compensation, coverage of what a statement owes, not decided yet; used, what the
  // transfers of statements took of them
  handRefunds: {
    refunded: number;
    compensations: number;
    coverage: number;
    undecided: number;
    used: number;
    result: number;
  };
  // the payments the orders could not take, and what of them went back in any way (our refunds, by
  // hand, outside the app, by the bank); a result that is not 0 is money of buyers still at the shop
  latePayments: { received: number; refunded: number; result: number };
  // the compensations root gave by the button of the app (less the failures, with the money sent
  // outside the app after one)
  compensations: { given: number; result: number };
  // the money the shop got back outside the app: from buyers, from carriers
  received: { buyers: number; carriers: number; result: number };
}

// the money of a period in three parts; the delivery, the sends and the other refunds are of the
// whole shop, none for a report of some products or of a category, and the totals are of the items
// then
export interface AdminMoneySummaryDto {
  // the items of the orders paid in the period less the returns, the delivery less what went back,
  // together
  income: { items: number; delivery: number | null; total: number };
  // what the items kept cost (their batches, less the units that came back), the units written
  // off, the sends the shop owes the carriers for, what the disputes and the refunds made by hand
  // cost past the statements (otherRefunds), together
  expenses: {
    costOfGoods: number;
    writeOffs: number;
    shipping: number | null;
    otherRefunds: number | null;
    total: number;
  };
  // the items less their cost, the delivery less the sends, all the income less all the expenses
  margin: { items: number; delivery: number | null; total: number };
}

// the sales less the returns: what the items of the period earned
export interface AdminNetDto {
  units: number;
  revenue: number;
  cost: number;
  margin: number;
  marginPercent: number | null;
}

// the stock of the variants of a report, read from the stock log: at the start of the period, what
// came in (deliveries, returns), what went out (sales, write-offs, goods written off at once with a
// return), at the end; apart, the units sold whose goods are on their way back (the statement is
// there, the goods are not in), at their cost
export interface AdminStockTurnoverDto {
  opening: AdminUnitsValueDto;
  received: AdminUnitsValueDto;
  left: AdminUnitsValueDto;
  closing: AdminUnitsValueDto;
  onTheWayBack: AdminUnitsValueDto;
}

export type AdminReturnKind =
  | 'withdrawal'
  | 'refused'
  | 'defect'
  | 'wrong_item'
  | 'damaged'
  | 'goodwill'
  | 'shop_cancel'
  | 'other';

// the units, the money and the cost of the units that came back
export interface AdminReturnsDto {
  units: number;
  revenue: number;
  cost: number;
}

export interface GetAdminAccountingResponseDto {
  period: AdminStatsPeriodDto;
  currency: string;
  // the orders paid in the period, cancelled later or not
  sales: AdminSalesDto;
  // the rows of the statements whose money went back in the period; orders counts the orders they
  // belong to; byKind tells the right of withdrawal from the reasons an admin gave
  returns: AdminReturnsDto & { orders: number; byKind: Record<AdminReturnKind, AdminReturnsDto> };
  // the sales less the returns
  net: AdminNetDto;
  // the income, the expenses and the margins of the period
  summary: AdminMoneySummaryDto;
  // the batches taken in during the period, at their costs
  purchases: AdminUnitsValueDto & {
    bySource: Record<'supplier' | 'surplus' | 'customer_return', AdminUnitsValueDto>;
  };
  // the units written off in the period, at the costs of their batches; customer_return is the
  // goods that came back with a statement and went out at once
  writeOffs: AdminUnitsValueDto & {
    byReason: Record<
      | 'damaged'
      | 'defective'
      | 'expired'
      | 'shortage'
      | 'returned_to_supplier'
      | 'other'
      | 'customer_return',
      AdminUnitsValueDto
    >;
  };
  // the stock at its costs: at the start of the period, what came in and went out, at the end
  stock: AdminStockTurnoverDto;
  // the delivery of all orders; none when the report is of some products or of a category
  delivery: AdminDeliveryMoneyDto | null;
  // the money the payments moved past the statements; none as the delivery
  payments: AdminPaymentsMoneyDto | null;
}

// the money of a product, a category or a step of time in a period
export interface AdminMoneyBreakdownDto {
  // the orders paid in the period; the percent is of the revenue, none without
  sales: Omit<AdminSalesDto, 'orders'> & { marginPercent: number | null };
  // the rows of the statements whose money went back in the period
  returns: AdminReturnsDto;
  // the sales less the returns
  net: AdminNetDto;
  writeOffs: AdminUnitsValueDto;
  // the margin of the net less the write-offs, the percent of the revenue of the net
  afterWriteOffs: { margin: number; marginPercent: number | null };
  purchases: AdminUnitsValueDto;
  stock: AdminStockTurnoverDto;
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
  // only these products / only these variants, ids through commas (both: the variants of those
  // products that are among these)
  productIds?: string;
  variantIds?: string;
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
  variantIds?: string;
  step?: AdminReportStep;
  sortBy?: AdminTimelineSortBy;
  sortOrder?: AdminReportSortOrder;
}

// a row of the report by product is a product: the money of all its variants added up
export interface AdminReportProductRowDto extends AdminMoneyBreakdownDto {
  product: AdminStockProductDto;
  category: { id: CategoryId; name: string };
}

// a row of the report by variant is a variant, named with its product
export interface AdminReportVariantRowDto extends AdminMoneyBreakdownDto {
  product: AdminStockProductDto;
  variant: AdminStockVariantDto;
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

export interface GetAdminReportVariantsResponseDto {
  period: AdminStatsPeriodDto;
  currency: string;
  items: AdminReportVariantRowDto[];
  // of every variant of the filter, not only of the page: the totals of the report by product
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
  // the money the payments moved past the statements in the step; none as the delivery
  payments: AdminPaymentsMoneyDto | null;
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
  // the batches of all the variants of the product
  productId?: number;
  // the batches of the variant
  variantId?: number;
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

// the variant a line of the stock is about, as it is now
export interface AdminStockVariantDto {
  id: number;
  position: number;
  name: string;
  sku: string | null;
  // taken out of sale (so is every variant of a product removed from the catalog)
  deleted: boolean;
}

export interface AdminStockBatchDto {
  id: number;
  deliveryId: string;
  source: StockSourceName;
  supplierBatchNumber: string | null;
  product: AdminStockProductDto;
  variant: AdminStockVariantDto;
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
export type AdminStockMovementKind = 'delivery' | 'writeOff' | 'sale' | 'return' | 'returnWriteOff';

export interface AdminStockMovementsQueryDto {
  // the steps of all the variants of the product
  productId?: number;
  // the steps of the variant
  variantId?: number;
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
  variant: AdminStockVariantDto;
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

// THE JOURNALS (the admin log, the log of prices, of logins, of consents, the stock log and the
// money log): the same query for each. A journal sorts by any simple column, reads a period, takes some events and some columns
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

// the address (as it is) and a part of the browser of the request a line was written in
export interface AdminLogRequestFiltersDto {
  ip?: string;
  userAgent?: string;
}

// the lines of a journal taken together by up to three keys (GET /api/admin/<journal>/groups): the
// filters of the journal, the keys through commas, a sort by a key, the count or a sum, a page by
// an offset
export interface AdminLogGroupsQueryDto {
  groupBy: string;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
  format?: 'csv';
}

export interface AdminLogGroupsDto<Group> {
  items: Group[];
  total: number;
  limit: number;
  offset: number;
}

// THE ADMIN LOG: who did what to what, from which address and browser
export interface AdminAuditLogQueryDto extends AdminLogQueryDto, AdminLogRequestFiltersDto {
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

// THE LOG OF PRICES: every change of the price of every variant
export interface AdminPriceLogQueryDto extends AdminLogQueryDto {
  productId?: number;
  variantId?: number;
  actorId?: number;
  mode?: 'fixed' | 'percent';
  // the bounds of the old and the new price, taken in; the end of a sale, from taken in, to left out
  oldPriceFrom?: number;
  oldPriceTo?: number;
  newPriceFrom?: number;
  newPriceTo?: number;
  endsFrom?: string;
  endsTo?: string;
}

export interface AdminPriceLogItemDto {
  id: number;
  createdAt: string;
  productId: number;
  product: { id: number; name: string };
  variantId: number;
  // the variant as it is now: its place, its name and its article number
  variant: { id: number; position: number; name: string; sku: string | null };
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

// THE STOCK LOG: every change of the quantity of a variant
export interface AdminStockLogQueryDto extends AdminLogQueryDto, AdminLogRequestFiltersDto {
  productId?: number;
  variantId?: number;
  actorId?: number;
  actorRole?: 'USER' | 'ADMIN' | 'ROOT';
  // the lines of the units of a statement of return, of one of its rows
  returnId?: number;
  returnItemId?: number;
  // the lines of the products of a category (its own products, not of its children)
  categoryId?: number;
  // the bounds of the change and of the stock after it, taken in
  quantityFrom?: number;
  quantityTo?: number;
  stockAfterFrom?: number;
  stockAfterTo?: number;
  // the lines of one delivery, one write-off, one order
  deliveryId?: string;
  writeOffId?: string;
  orderId?: number;
}

export interface AdminStockLogItemDto {
  id: number;
  createdAt: string;
  // who did it; none for the work of the system (the sale at the payment of an order)
  actorId: UserId | null;
  actor: AdminLogAccountDto | null;
  // the role it had when it did it
  actorRole: Role | null;
  productId: number;
  product: { id: number; name: string };
  variantId: number;
  // the variant as it is now: its place, its name and its article number
  variant: { id: number; position: number; name: string; sku: string | null };
  // what made the line: a delivery, a write-off, a sale, the units back at a cancel
  event: string;
  // units in above 0, out below 0
  quantityChange: number;
  stockAfter: number;
  // the operation the line belongs to; at most one of the three
  deliveryId: string | null;
  writeOffId: string | null;
  orderId: number | null;
  // the row of the statement of return the units came back with (stock.return, stock.return_write_off)
  returnItemId: number | null;
  ip: string | null;
  userAgent: string | null;
  // what the change was made of: the batches with their costs, the reason, the supplier
  changes: Array<{ field: string; old: unknown; new: unknown }>;
}

export type GetAdminStockLogResponseDto = AdminLogPageDto<AdminStockLogItemDto> & {
  // the sum of the changes of the lines of the filters
  sums: { quantityChange: number };
};

export type AdminStockLogGroupDto = Record<string, string | number | null> & {
  count: number;
  quantityChange: number;
};

// THE MONEY LOG: every movement of money, a line for each part of it
export type AdminMoneyPurpose =
  'order' | 'return' | 'late_payment' | 'hand' | 'dispute' | 'shipping' | 'compensation';
export type AdminMoneyPart = 'goods' | 'delivery' | 'deduction' | 'way_back' | 'covered' | 'whole';
export type AdminMoneyState = 'in_transit' | 'sent';

export interface AdminMoneyLogQueryDto extends AdminLogQueryDto {
  orderId?: number;
  // the buyer the money is of
  userId?: number;
  returnId?: number;
  disputeId?: number;
  // the id of the payment at the provider
  paymentId?: string;
  purpose?: AdminMoneyPurpose;
  // where a refund stands
  state?: AdminMoneyState;
  actorId?: number;
  actorRole?: 'USER' | 'ADMIN' | 'ROOT';
  part?: AdminMoneyPart;
  currency?: string;
  // the bounds of the sum with its sign, taken in
  amountFrom?: number;
  amountTo?: number;
  orderShipmentId?: number;
  coversId?: number;
  provider?: string;
  refundId?: string;
  transferKey?: string;
  stripeTxId?: string;
  // a part of the reference of the bank
  bankReference?: string;
  byDashboard?: boolean;
  failure?: string;
  method?: 'bank_transfer' | 'cash' | 'other';
  moneyUse?: 'goods' | 'compensation' | 'loss';
  // a part of the note
  note?: string;
  // the time of the state of a refund and the day money really moved: from taken in, to left out
  stateFrom?: string;
  stateTo?: string;
  happenedFrom?: string;
  happenedTo?: string;
  ip?: string;
  userAgent?: string;
}

export interface AdminMoneyLogItemDto {
  id: number;
  createdAt: string;
  // who did it; none for the work of the system (the webhook, the worker)
  actorId: UserId | null;
  actor: AdminLogAccountDto | null;
  actorRole: Role | null;
  event: string;
  purpose: AdminMoneyPurpose;
  part: AdminMoneyPart;
  // above 0 to the shop, below 0 from it
  amount: number;
  currency: string | null;
  orderId: number | null;
  // the buyer the money is of; a deleted account has no email
  userId: UserId | null;
  user: (AdminLogAccountDto & { deleted: boolean }) | null;
  returnId: number | null;
  orderShipmentId: number | null;
  disputeId: number | null;
  // the line this one reverses, corrects or uses
  coversId: number | null;
  provider: string | null;
  paymentId: string | null;
  refundId: string | null;
  // our key of the request to the provider
  transferKey: string | null;
  stripeTxId: string | null;
  bankReference: string | null;
  byDashboard: boolean;
  // where a refund stands and since when
  state: AdminMoneyState | null;
  stateAt: string | null;
  // why a refund failed, and the words of the provider
  failure: string | null;
  failureText: string | null;
  // money sent outside the app: how, the note, the day it really happened
  method: string | null;
  note: string | null;
  happenedAt: string | null;
  // what root or the system decided money given back by hand or taken by a bank was for
  moneyUse: string | null;
  ip: string | null;
  userAgent: string | null;
  // what the line is made of: the rows of a statement a transfer pays, the reason of a late payment
  meta: Array<Record<string, unknown>>;
}

export type GetAdminMoneyLogResponseDto = AdminLogPageDto<AdminMoneyLogItemDto> & {
  // the sums of the lines of the filters, one for each currency
  sums: { currency: string | null; amount: number }[];
};

export type AdminMoneyLogGroupDto = Record<string, string | number | null> & {
  count: number;
  amount: number;
};

// THE LOG OF LOGINS: who came in, how, from where
export interface AdminLoginLogQueryDto extends AdminLogQueryDto, AdminLogRequestFiltersDto {
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
export interface AdminConsentLogQueryDto extends AdminLogQueryDto, AdminLogRequestFiltersDto {
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
  stockLog: string[];
  moneyLog: string[];
}

// ALERTS: what waits for the work of an admin, each kind with how many there are
export type AdminAlertKind =
  | 'paid_orders_waiting'
  | 'shipped_orders_waiting'
  | 'pickup_not_collected'
  | 'shipped_without_cost'
  | 'shipped_without_tracking'
  | 'out_of_stock'
  | 'low_stock'
  | 'products_without_shipping_data'
  | 'variants_missing_required'
  | 'products_hidden_from_buyers'
  | 'expiring_batches'
  | 'expired_batches'
  | 'chats_waiting'
  | 'late_refunds'
  | 'late_refunds_in_transit'
  | 'late_refunds_failed'
  | 'return_refunds_in_transit'
  | 'return_refunds_failed'
  | 'hand_refunds_in_transit'
  | 'hand_refunds_failed'
  | 'dispute_refunds_in_transit'
  | 'dispute_refunds_failed'
  | 'compensation_refunds_in_transit'
  | 'compensation_refunds_failed'
  | 'bank_money_to_decide'
  | 'returns_money_short'
  | 'returns_money_overpaid'
  | 'disputes_to_answer'
  | 'disputes_lost'
  | 'returns_manual_check'
  | 'returns_proof_waiting'
  | 'returns_goods_not_sent'
  | 'returns_money_late'
  | 'returns_goods_late'
  | 'worker_stalled'
  | 'shop_settings_incomplete'
  | 'shop_locale_missing'
  | 'newsletter_undelivered'
  | 'newsletter_rejected'
  | 'newsletter_complaints'
  | 'newsletter_running_long'
  | 'newsletter_starting_soon'
  | 'newsletter_cancelled_by_limit'
  | 'newsletter_sending_halted'
  | 'hand_refunds_to_explain'
  | 'hand_refunds_to_decide'
  | 'fraud_warnings'
  | 'fraud_warnings_shipped'
  | 'payment_reviews'
  | 'admin_actions';

export type AdminAlertThresholdUnit =
  'days' | 'units' | 'seconds' | 'hours' | 'percent' | 'permille';

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
  // when the thing the alert tells of last happened, for a kind that is an event (the stop of the
  // sending worker); null for the others, and while it has not happened
  occurredAt: string | null;
}

export interface GetAdminAlertsQueryDto {
  // true: only the kinds the actor follows
  subscribed?: boolean;
  // only these kinds, through commas
  kinds?: string;
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
