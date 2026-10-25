import { Prisma } from '@prisma/client';

import { NotFoundError } from '@utils/errors.js';

import { marginPercentOf, money } from './accountingReport.helper.js';

import type { AdminMoneyBreakdownDto } from 'types/dto/admin.dto.js';

// the sql the reports of the accounting share. A report reads the products of its scope: all of
// them, the ids asked for, the products of a category with its whole branch or its own only. The
// money of a period [from, to) comes from where the database keeps it:
//  - a sale: the items of the orders paid in the period (orders.paidAt), its cost from the batches
//    it took (order_batch_allocations);
//  - a cancel: the paid orders cancelled in the period (orders.cancelledAt);
//  - a write-off: the lines STOCK_WRITE_OFF of the admin log, the batches with their costs;
//  - a purchase: the batches taken in during the period;
//  - the stock: what the batches have left now

export type ReportScope = {
  productIds?: number[] | undefined;
  categoryId?: number | undefined;
  // with the whole branch of the category, or its own products only
  branch: boolean;
};

// the time of a period bound as the columns keep it: utc without a zone
export const utcTime = (date: Date) =>
  Prisma.sql`(${date.toISOString()}::timestamptz at time zone 'UTC')`;

// a category asked for has to be there
export async function assertCategory(db: Prisma.TransactionClient, categoryId?: number) {
  if (categoryId === undefined) return;

  const [row] = await db.$queryRaw<{ id: number }[]>`
    select id from cartlify.categories where id = ${categoryId}::int
  `;
  if (!row) throw new NotFoundError('CATEGORY_NOT_FOUND', { categoryId });
}

// the start of a query: the category and its branch (tree), the products of the scope (scope).
// A query goes on with more ctes after it, the first ones are recursive
export function scopeCtes(scope: ReportScope): Prisma.Sql {
  const ids = scope.productIds ?? null;
  const categoryId = scope.categoryId ?? null;

  return Prisma.sql`
    with recursive tree as (
      select c.id from cartlify.categories as c where c.id = ${categoryId}::int
      union all
      select c.id
      from cartlify.categories as c
      join tree as t on c."parentId" = t.id
      where ${scope.branch}::boolean
    ),
    scope as (
      select p.id, p.name, p."categoryId", p."deletedAt"
      from cartlify.products as p
      where (${ids}::int[] is null or p.id = any(${ids}::int[]))
        and (${categoryId}::int is null or p."categoryId" in (select id from tree))
    )
  `;
}

// the money of every product of the scope in the period, a row each in the cte "report_rows"; the
// margin is of the sales, the write-offs are a column of their own
export function productRowsCtes(scope: ReportScope, from: Date, to: Date): Prisma.Sql {
  const inPeriod = (column: Prisma.Sql) =>
    Prisma.sql`${column} >= ${utcTime(from)} and ${column} < ${utcTime(to)}`;

  const orderLines = (column: 'paidAt' | 'cancelledAt', name: string) => {
    const time = Prisma.raw(`o."${column}"`);
    return Prisma.sql`
      ${Prisma.raw(name)} as (
        select oi."productId" as pid,
               sum(oi.quantity)::bigint as units,
               sum(oi."totalPrice") as revenue
        from cartlify.orders as o
        join cartlify.order_items as oi on oi."orderId" = o.id
        where ${inPeriod(time)} and oi."productId" in (select id from scope)
        group by oi."productId"
      ),
      ${Prisma.raw(`${name}_cost`)} as (
        select a."productId" as pid, sum(a.quantity * b."unitCost") as cost
        from cartlify.order_batch_allocations as a
        join cartlify.orders as o on o.id = a."orderId"
        join cartlify.product_batches as b on b.id = a."batchId"
        where ${inPeriod(time)} and a."productId" in (select id from scope)
        group by a."productId"
      )
    `;
  };

  return Prisma.sql`
    ${scopeCtes(scope)},
    ${orderLines('paidAt', 'sold')},
    ${orderLines('cancelledAt', 'cancelled')},
    written as (
      select l."entityId" as pid,
             sum((e->>'quantity')::int)::bigint as units,
             sum((e->>'quantity')::int * (e->>'unitCost')::numeric) as value
      from cartlify.admin_audit_log as l
      cross join lateral jsonb_array_elements(l.meta) as c
      cross join lateral jsonb_array_elements(
        case when c->>'field' = 'batches' and jsonb_typeof(c->'new') = 'array'
             then c->'new' else '[]'::jsonb end
      ) as e
      where l.action = 'STOCK_WRITE_OFF'::cartlify."AdminAuditAction"
        and l."entityType" = 'product'::cartlify."AdminAuditEntityType"
        and ${inPeriod(Prisma.sql`l."createdAt"`)}
        and l."entityId" in (select id from scope)
      group by l."entityId"
    ),
    bought as (
      select b."productId" as pid,
             sum(b.quantity)::bigint as units,
             sum(b.quantity * b."unitCost") as value
      from cartlify.product_batches as b
      where ${inPeriod(Prisma.sql`b."createdAt"`)} and b."productId" in (select id from scope)
      group by b."productId"
    ),
    left_now as (
      select b."productId" as pid,
             sum(b.remaining)::bigint as units,
             sum(b.remaining * b."unitCost") as value
      from cartlify.product_batches as b
      where b."productId" in (select id from scope)
      group by b."productId"
    ),
    raw_rows as (
      select s.id, s.name, s."categoryId", s."deletedAt",
             coalesce(sold.units, 0) as sold_units,
             coalesce(sold.revenue, 0) as sold_revenue,
             coalesce(sold_cost.cost, 0) as sold_cost,
             coalesce(cancelled.units, 0) as cancelled_units,
             coalesce(cancelled.revenue, 0) as cancelled_revenue,
             coalesce(cancelled_cost.cost, 0) as cancelled_cost,
             coalesce(written.units, 0) as written_units,
             coalesce(written.value, 0) as written_value,
             coalesce(bought.units, 0) as bought_units,
             coalesce(bought.value, 0) as bought_value,
             coalesce(left_now.units, 0) as stock_units,
             coalesce(left_now.value, 0) as stock_value
      from scope as s
      left join sold on sold.pid = s.id
      left join sold_cost on sold_cost.pid = s.id
      left join cancelled on cancelled.pid = s.id
      left join cancelled_cost on cancelled_cost.pid = s.id
      left join written on written.pid = s.id
      left join bought on bought.pid = s.id
      left join left_now on left_now.pid = s.id
    ),
    report_rows as (
      select r.*,
             r.sold_units - r.cancelled_units as net_units,
             r.sold_revenue - r.cancelled_revenue as net_revenue,
             r.sold_cost - r.cancelled_cost as net_cost,
             (r.sold_revenue - r.cancelled_revenue) - (r.sold_cost - r.cancelled_cost) as net_margin,
             case when r.sold_revenue - r.cancelled_revenue = 0 then null
                  else round(
                    ((r.sold_revenue - r.cancelled_revenue) - (r.sold_cost - r.cancelled_cost))
                      * 100 / (r.sold_revenue - r.cancelled_revenue),
                    2
                  )
             end as net_margin_percent
      from raw_rows as r
      -- a product of the scope with nothing in the period and nothing left is no line of a report
      where r.sold_units <> 0 or r.cancelled_units <> 0 or r.written_units <> 0
         or r.bought_units <> 0 or r.stock_units <> 0
    )
  `;
}

// the sums of the rows: the money of a product, of a category or of a whole report
export const MONEY_SUMS = Prisma.sql`
  coalesce(sum(sold_units), 0)::bigint as sold_units,
  coalesce(sum(sold_revenue), 0) as sold_revenue,
  coalesce(sum(sold_cost), 0) as sold_cost,
  coalesce(sum(cancelled_units), 0)::bigint as cancelled_units,
  coalesce(sum(cancelled_revenue), 0) as cancelled_revenue,
  coalesce(sum(cancelled_cost), 0) as cancelled_cost,
  coalesce(sum(written_units), 0)::bigint as written_units,
  coalesce(sum(written_value), 0) as written_value,
  coalesce(sum(bought_units), 0)::bigint as bought_units,
  coalesce(sum(bought_value), 0) as bought_value,
  coalesce(sum(stock_units), 0)::bigint as stock_units,
  coalesce(sum(stock_value), 0) as stock_value
`;

export type MoneyColumns = {
  sold_units: bigint | number;
  sold_revenue: Prisma.Decimal | string | number;
  sold_cost: Prisma.Decimal | string | number;
  cancelled_units: bigint | number;
  cancelled_revenue: Prisma.Decimal | string | number;
  cancelled_cost: Prisma.Decimal | string | number;
  written_units: bigint | number;
  written_value: Prisma.Decimal | string | number;
  bought_units: bigint | number;
  bought_value: Prisma.Decimal | string | number;
  stock_units?: bigint | number;
  stock_value?: Prisma.Decimal | string | number;
};

const dec = (value: Prisma.Decimal | string | number | undefined) => new Prisma.Decimal(value ?? 0);

// the money of a row as the answers give it; the percent comes from the decimals, not the floats
export function moneyOf(row: MoneyColumns): AdminMoneyBreakdownDto {
  const soldRevenue = dec(row.sold_revenue);
  const soldCost = dec(row.sold_cost);
  const cancelledRevenue = dec(row.cancelled_revenue);
  const cancelledCost = dec(row.cancelled_cost);
  const netRevenue = soldRevenue.minus(cancelledRevenue);
  const netCost = soldCost.minus(cancelledCost);
  const netMargin = netRevenue.minus(netCost);

  return {
    sales: {
      units: Number(row.sold_units),
      revenue: money(soldRevenue),
      cost: money(soldCost),
      margin: money(soldRevenue.minus(soldCost)),
    },
    cancellations: {
      units: Number(row.cancelled_units),
      revenue: money(cancelledRevenue),
      cost: money(cancelledCost),
    },
    net: {
      units: Number(row.sold_units) - Number(row.cancelled_units),
      revenue: money(netRevenue),
      cost: money(netCost),
      margin: money(netMargin),
      marginPercent: marginPercentOf(netMargin, netRevenue),
    },
    writeOffs: { units: Number(row.written_units), value: money(dec(row.written_value)) },
    purchases: { units: Number(row.bought_units), value: money(dec(row.bought_value)) },
    stock: { units: Number(row.stock_units ?? 0), value: money(dec(row.stock_value)) },
  };
}
