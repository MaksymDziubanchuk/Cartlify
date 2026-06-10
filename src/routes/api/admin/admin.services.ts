import { tx } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { InternalError } from '@utils/errors.js';
import type {
  AdminStatsDto,
  AdminStatsOrdersByStatusDto,
  AdminStatsOrdersDto,
  AdminStatsOrdersRevenueDto,
  AdminStatsPeriodDto,
  AdminStatsProductsDto,
  AdminStatsReviewsDto,
  AdminStatsUsersDto,
  AdminTopCategoryRevenueDto,
  AdminTopProductRevenueDto,
  GetAdminStatsResponseDto,
} from 'types/dto/admin.dto.js';

type AdminStatsViewRow = {
  period: unknown;
  users: unknown;
  orders: unknown;
  products: unknown;
  reviews: unknown;
  createdAt: Date | string;
};

type JsonRecord = Record<string, unknown>;

function invalidStatsViewShape(field: string): never {
  throw new InternalError({
    field,
    reason: 'INVALID_ADMIN_STATS_VIEW_SHAPE',
  });
}

function toRecord(value: unknown, field: string): JsonRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    invalidStatsViewShape(field);
  }

  return value as JsonRecord;
}

function toArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) {
    invalidStatsViewShape(field);
  }

  return value;
}

function toNumber(value: unknown, field: string): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);

    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  invalidStatsViewShape(field);
}

function toDate(value: unknown, field: string): Date {
  if (value instanceof Date) {
    return value;
  }

  if (typeof value === 'string') {
    const date = new Date(value);

    if (!Number.isNaN(date.getTime())) {
      return date;
    }
  }

  invalidStatsViewShape(field);
}

function parsePeriod(value: unknown): AdminStatsPeriodDto {
  const period = toRecord(value, 'period');

  return {
    from: toDate(period.from, 'period.from'),
    to: toDate(period.to, 'period.to'),
  };
}

function parseUsers(value: unknown): AdminStatsUsersDto {
  const users = toRecord(value, 'users');

  return {
    total: toNumber(users.total, 'users.total'),
    newInPeriod: toNumber(users.newInPeriod, 'users.newInPeriod'),
    new7d: toNumber(users.new7d, 'users.new7d'),
    new30d: toNumber(users.new30d, 'users.new30d'),
    verifiedTotal: toNumber(users.verifiedTotal, 'users.verifiedTotal'),
    verifiedRate: toNumber(users.verifiedRate, 'users.verifiedRate'),
  };
}

function parseOrdersByStatus(value: unknown): AdminStatsOrdersByStatusDto {
  const byStatus = toRecord(value, 'orders.byStatus');

  return {
    pending: toNumber(byStatus.pending, 'orders.byStatus.pending'),
    unconfirmed: toNumber(byStatus.unconfirmed, 'orders.byStatus.unconfirmed'),
    waiting: toNumber(byStatus.waiting, 'orders.byStatus.waiting'),
    paid: toNumber(byStatus.paid, 'orders.byStatus.paid'),
    shipped: toNumber(byStatus.shipped, 'orders.byStatus.shipped'),
    delivered: toNumber(byStatus.delivered, 'orders.byStatus.delivered'),
    cancelled: toNumber(byStatus.cancelled, 'orders.byStatus.cancelled'),
  };
}

function parseOrdersRevenue(value: unknown): AdminStatsOrdersRevenueDto {
  const revenue = toRecord(value, 'orders.revenue');

  return {
    total: toNumber(revenue.total, 'orders.revenue.total'),
    inPeriod: toNumber(revenue.inPeriod, 'orders.revenue.inPeriod'),
    last7d: toNumber(revenue.last7d, 'orders.revenue.last7d'),
    last30d: toNumber(revenue.last30d, 'orders.revenue.last30d'),
  };
}

function parseOrders(value: unknown): AdminStatsOrdersDto {
  const orders = toRecord(value, 'orders');

  return {
    total: toNumber(orders.total, 'orders.total'),
    confirmedTotal: toNumber(orders.confirmedTotal, 'orders.confirmedTotal'),
    pendingCartsTotal: toNumber(orders.pendingCartsTotal, 'orders.pendingCartsTotal'),
    byStatus: parseOrdersByStatus(orders.byStatus),
    revenue: parseOrdersRevenue(orders.revenue),
    averageOrderValue: toNumber(orders.averageOrderValue, 'orders.averageOrderValue'),
    itemsSold: toNumber(orders.itemsSold, 'orders.itemsSold'),
  };
}

function parseTopProductRevenue(value: unknown): AdminTopProductRevenueDto {
  const product = toRecord(value, 'products.topProductsByRevenue.item');

  const name = product.name;

  if (typeof name !== 'string') {
    invalidStatsViewShape('products.topProductsByRevenue.name');
  }

  return {
    id: toNumber(product.id, 'products.topProductsByRevenue.id'),
    name,
    revenue: toNumber(product.revenue, 'products.topProductsByRevenue.revenue'),
    quantitySold: toNumber(product.quantitySold, 'products.topProductsByRevenue.quantitySold'),
  };
}

function parseTopCategoryRevenue(value: unknown): AdminTopCategoryRevenueDto {
  const category = toRecord(value, 'products.topCategoriesByRevenue.item');

  const name = category.name;

  if (typeof name !== 'string') {
    invalidStatsViewShape('products.topCategoriesByRevenue.name');
  }

  return {
    id: toNumber(category.id, 'products.topCategoriesByRevenue.id'),
    name,
    revenue: toNumber(category.revenue, 'products.topCategoriesByRevenue.revenue'),
    quantitySold: toNumber(category.quantitySold, 'products.topCategoriesByRevenue.quantitySold'),
  };
}

function parseProducts(value: unknown): AdminStatsProductsDto {
  const products = toRecord(value, 'products');

  return {
    total: toNumber(products.total, 'products.total'),
    activeTotal: toNumber(products.activeTotal, 'products.activeTotal'),
    deletedTotal: toNumber(products.deletedTotal, 'products.deletedTotal'),
    outOfStockTotal: toNumber(products.outOfStockTotal, 'products.outOfStockTotal'),
    topProductsByRevenue: toArray(
      products.topProductsByRevenue,
      'products.topProductsByRevenue',
    ).map(parseTopProductRevenue),
    topCategoriesByRevenue: toArray(
      products.topCategoriesByRevenue,
      'products.topCategoriesByRevenue',
    ).map(parseTopCategoryRevenue),
  };
}

function parseReviews(value: unknown): AdminStatsReviewsDto {
  const reviews = toRecord(value, 'reviews');

  return {
    total: toNumber(reviews.total, 'reviews.total'),
    ratedTotal: toNumber(reviews.ratedTotal, 'reviews.ratedTotal'),
    newInPeriod: toNumber(reviews.newInPeriod, 'reviews.newInPeriod'),
    avgRating: toNumber(reviews.avgRating, 'reviews.avgRating'),
    negativeCount: toNumber(reviews.negativeCount, 'reviews.negativeCount'),
  };
}

function mapStatsViewRow(row: AdminStatsViewRow): GetAdminStatsResponseDto {
  return {
    period: parsePeriod(row.period),
    users: parseUsers(row.users),
    orders: parseOrders(row.orders),
    products: parseProducts(row.products),
    reviews: parseReviews(row.reviews),
    createdAt: toDate(row.createdAt, 'createdAt'),
  };
}

async function showAllStats({
  from,
  to,
  actorId,
  actorRole,
}: AdminStatsDto): Promise<GetAdminStatsResponseDto> {
  const rows = await tx(async (db) => {
    // set rls context for security_invoker view
    await setUserContext(db, {
      userId: actorId,
      role: actorRole,
    });

    // set stats period used by cartlify.admin_stats_view
    await db.$executeRaw`
      SELECT set_config('cartlify.stats_from', ${from.toISOString()}, true)
    `;

    await db.$executeRaw`
      SELECT set_config('cartlify.stats_to', ${to.toISOString()}, true)
    `;

    // read single json-shaped stats row
    return db.$queryRaw<AdminStatsViewRow[]>`
      SELECT
        period,
        users,
        orders,
        products,
        reviews,
        "createdAt"
      FROM cartlify.admin_stats_view
      LIMIT 1
    `;
  });

  const row = rows[0];

  if (!row) {
    throw new InternalError({
      reason: 'ADMIN_STATS_VIEW_RETURNED_NO_ROWS',
    });
  }

  return mapStatsViewRow(row);
}

export const adminServices = {
  showAllStats,
};