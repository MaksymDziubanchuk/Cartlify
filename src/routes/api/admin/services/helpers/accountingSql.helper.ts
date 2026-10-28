import { Prisma } from '@prisma/client';

import { NotFoundError } from '@utils/errors.js';

import { marginPercentOf, money } from './accountingReport.helper.js';

import type {
  AdminDeliveryMoneyDto,
  AdminMoneyBreakdownDto,
  AdminMoneySummaryDto,
} from 'types/dto/admin.dto.js';

// the sql the reports of the accounting share. A report reads the products of its scope: all of
// them, the ids asked for, the products of a category with its whole branch or its own only. The
// money of a period [from, to) comes from where the database keeps it:
//  - a sale: the items of the orders paid in the period (orders.paidAt) and not cancelled, its cost
//    from the batches it took (order_batch_allocations). An order cancelled later is no sale of its
//    period any more: the report of the period changes with the cancel;
//  - a cancel: the paid orders cancelled in the period (orders.cancelledAt), told apart and in no
//    margin: the sale is gone from the period it was paid in;
//  - a write-off: the lines STOCK_WRITE_OFF of the admin log, the batches with their costs;
//  - a purchase: the batches taken in during the period;
//  - the stock: what the batches have left now;
//  - the delivery (of no product): what the orders paid in the period and not cancelled paid for it
//    (order_deliveries of the orders by paidAt), what went back with the cancels (by cancelledAt,
//    told apart), what the sends the shop owes the carriers for cost (order_shipments by
//    shippedAt; a send of a cancelled order the carrier was paid for is spent all the same)

// the orders that are sales: paid and not cancelled
export const NOT_CANCELLED = Prisma.sql`o."cancelledAt" is null`;

export type ReportScope = {
  productIds?: number[] | undefined;
  categoryId?: number | undefined;
  // with the whole branch of the category, or its own products only
  branch: boolean;
};

// a report is of the whole shop: no product and no category asked for. The delivery belongs to no
// product, so only such a report has it
export const isWholeShop = (scope: ReportScope) =>
  scope.productIds === undefined && scope.categoryId === undefined;

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

  // a sale is an order paid in the period and not cancelled, a cancel one cancelled in the period
  const orderLines = (column: 'paidAt' | 'cancelledAt', name: string) => {
    const time = Prisma.raw(`o."${column}"`);
    const sales = column === 'paidAt' ? Prisma.sql`and ${NOT_CANCELLED}` : Prisma.empty;
    return Prisma.sql`
      ${Prisma.raw(name)} as (
        select oi."productId" as pid,
               sum(oi.quantity)::bigint as units,
               sum(oi."totalPrice") as revenue
        from cartlify.orders as o
        join cartlify.order_items as oi on oi."orderId" = o.id
        where ${inPeriod(time)} ${sales} and oi."productId" in (select id from scope)
        group by oi."productId"
      ),
      ${Prisma.raw(`${name}_cost`)} as (
        select a."productId" as pid, sum(a.quantity * b."unitCost") as cost
        from cartlify.order_batch_allocations as a
        join cartlify.orders as o on o.id = a."orderId"
        join cartlify.product_batches as b on b.id = a."batchId"
        where ${inPeriod(time)} ${sales} and a."productId" in (select id from scope)
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
             r.sold_revenue - r.sold_cost as sold_margin,
             case when r.sold_revenue = 0 then null
                  else round((r.sold_revenue - r.sold_cost) * 100 / r.sold_revenue, 2)
             end as sold_margin_percent,
             -- the margin of the sales less what was written off
             r.sold_revenue - r.sold_cost - r.written_value as margin_after_write_offs
      from raw_rows as r
      -- a product of the scope with nothing in the period and nothing left is no line of a report
      where r.sold_units <> 0 or r.cancelled_units <> 0 or r.written_units <> 0
         or r.bought_units <> 0 or r.stock_units <> 0
    )
  `;
}

export type DeliveryColumns = {
  paid_orders: bigint | number;
  paid_revenue: Prisma.Decimal | string | number;
  refunded_orders: bigint | number;
  refunded_revenue: Prisma.Decimal | string | number;
  sends: bigint | number;
  ship_cost: Prisma.Decimal | string | number;
  sends_without_cost: bigint | number;
};

// the delivery of one period [from, to): a row of DeliveryColumns. The income is of the orders
// paid in the period and not cancelled, the refund (told apart) of the ones cancelled in it; both
// count the orders that paid for the delivery (a price above 0). The sends are the ones the shop
// owes the carriers for (expense), the ones without a cost written counted apart
export function deliveryOfPeriodSql(from: Date, to: Date): Prisma.Sql {
  const inPeriod = (column: Prisma.Sql) =>
    Prisma.sql`${column} >= ${utcTime(from)} and ${column} < ${utcTime(to)}`;

  return Prisma.sql`
    select
      (select count(*) from cartlify.orders as o
         join cartlify.order_deliveries as d on d."orderId" = o.id
         where ${inPeriod(Prisma.sql`o."paidAt"`)} and ${NOT_CANCELLED}
           and d.price > 0)::bigint as paid_orders,
      (select coalesce(sum(d.price), 0) from cartlify.orders as o
         join cartlify.order_deliveries as d on d."orderId" = o.id
         where ${inPeriod(Prisma.sql`o."paidAt"`)} and ${NOT_CANCELLED}) as paid_revenue,
      (select count(*) from cartlify.orders as o
         join cartlify.order_deliveries as d on d."orderId" = o.id
         where ${inPeriod(Prisma.sql`o."cancelledAt"`)} and d.price > 0)::bigint as refunded_orders,
      (select coalesce(sum(d.price), 0) from cartlify.orders as o
         join cartlify.order_deliveries as d on d."orderId" = o.id
         where ${inPeriod(Prisma.sql`o."cancelledAt"`)}) as refunded_revenue,
      (select count(*) from cartlify.order_shipments as s
         where s.expense and ${inPeriod(Prisma.sql`s."shippedAt"`)})::bigint as sends,
      (select coalesce(sum(s.cost), 0) from cartlify.order_shipments as s
         where s.expense and ${inPeriod(Prisma.sql`s."shippedAt"`)}) as ship_cost,
      (select count(*) from cartlify.order_shipments as s
         where s.expense and s.cost is null
           and ${inPeriod(Prisma.sql`s."shippedAt"`)})::bigint as sends_without_cost
  `;
}

// the delivery of every step of a timeline, a row each by its number n (DeliveryColumns and n):
// the same counts as deliveryOfPeriodSql for the steps [from, to) given
export function deliveryOfStepsSql(steps: { from: Date; to: Date }[]): Prisma.Sql {
  const froms = steps.map((step) => step.from.toISOString());
  const tos = steps.map((step) => step.to.toISOString());

  return Prisma.sql`
    with steps as (
      select x.f at time zone 'UTC' as f, x.t at time zone 'UTC' as t, x.n
      from unnest(${froms}::timestamptz[], ${tos}::timestamptz[]) with ordinality as x(f, t, n)
    ),
    paid as (
      select b.n, count(*) filter (where d.price > 0)::bigint as orders, sum(d.price) as revenue
      from steps as b
      join cartlify.orders as o on o."paidAt" >= b.f and o."paidAt" < b.t and ${NOT_CANCELLED}
      join cartlify.order_deliveries as d on d."orderId" = o.id
      group by b.n
    ),
    refunded as (
      select b.n, count(*) filter (where d.price > 0)::bigint as orders, sum(d.price) as revenue
      from steps as b
      join cartlify.orders as o on o."cancelledAt" >= b.f and o."cancelledAt" < b.t
      join cartlify.order_deliveries as d on d."orderId" = o.id
      group by b.n
    ),
    sent as (
      select b.n, count(*)::bigint as sends, sum(s.cost) as cost,
             count(*) filter (where s.cost is null)::bigint as without_cost
      from steps as b
      join cartlify.order_shipments as s on s.expense and s."shippedAt" >= b.f and s."shippedAt" < b.t
      group by b.n
    )
    select b.n,
           coalesce(paid.orders, 0)::bigint as paid_orders,
           coalesce(paid.revenue, 0) as paid_revenue,
           coalesce(refunded.orders, 0)::bigint as refunded_orders,
           coalesce(refunded.revenue, 0) as refunded_revenue,
           coalesce(sent.sends, 0)::bigint as sends,
           coalesce(sent.cost, 0) as ship_cost,
           coalesce(sent.without_cost, 0)::bigint as sends_without_cost
    from steps as b
    left join paid on paid.n = b.n
    left join refunded on refunded.n = b.n
    left join sent on sent.n = b.n
    order by b.n
  `;
}

// the delivery of a row as the answers give it: the decimals, not the floats; the result is the
// income less what the carriers cost (the refund is told apart: the income has no cancelled order)
export function deliveryMoneyOf(row: DeliveryColumns): AdminDeliveryMoneyDto {
  const paid = dec(row.paid_revenue);
  const cost = dec(row.ship_cost);

  return {
    income: { orders: Number(row.paid_orders), revenue: money(paid) },
    refunded: { orders: Number(row.refunded_orders), revenue: money(dec(row.refunded_revenue)) },
    shipping: {
      sends: Number(row.sends),
      cost: money(cost),
      withoutCost: Number(row.sends_without_cost),
    },
    result: money(paid.minus(cost)),
  };
}

// the money of a period in three parts, the same for every report and for the statistics: what came
// in (the items, the delivery, together), what went out (what the items sold cost, the units written
// off, the sends the shop owes the carriers for, together), and what each income left (the items
// less their cost, the delivery less the sends, all the income less all the expenses). The delivery
// is of the whole shop: without it (a report of some products) its parts are none and the totals
// are of the items
export function summaryOf(parts: {
  itemsRevenue: Prisma.Decimal.Value;
  itemsCost: Prisma.Decimal.Value;
  writeOffs: Prisma.Decimal.Value;
  delivery: DeliveryColumns | null;
}): AdminMoneySummaryDto {
  const items = dec(parts.itemsRevenue);
  const cost = dec(parts.itemsCost);
  const writtenOff = dec(parts.writeOffs);
  const delivery = parts.delivery ? dec(parts.delivery.paid_revenue) : null;
  const shipping = parts.delivery ? dec(parts.delivery.ship_cost) : null;

  const income = items.plus(delivery ?? 0);
  const expenses = cost.plus(writtenOff).plus(shipping ?? 0);

  return {
    income: {
      items: money(items),
      delivery: delivery === null ? null : money(delivery),
      total: money(income),
    },
    expenses: {
      costOfGoods: money(cost),
      writeOffs: money(writtenOff),
      shipping: shipping === null ? null : money(shipping),
      total: money(expenses),
    },
    margin: {
      items: money(items.minus(cost)),
      delivery: delivery === null || shipping === null ? null : money(delivery.minus(shipping)),
      total: money(income.minus(expenses)),
    },
  };
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

const dec = (value: Prisma.Decimal.Value | undefined) => new Prisma.Decimal(value ?? 0);

// the money of a row as the answers give it; the percents come from the decimals, not the floats.
// The sales are the orders paid in the period and not cancelled, the cancellations are told apart
// and in no margin; the write-offs come off the margin of the sales, shown apart to look into
export function moneyOf(row: MoneyColumns): AdminMoneyBreakdownDto {
  const soldRevenue = dec(row.sold_revenue);
  const soldCost = dec(row.sold_cost);
  const soldMargin = soldRevenue.minus(soldCost);
  const writtenOff = dec(row.written_value);
  const afterWriteOffs = soldMargin.minus(writtenOff);

  return {
    sales: {
      units: Number(row.sold_units),
      revenue: money(soldRevenue),
      cost: money(soldCost),
      margin: money(soldMargin),
      marginPercent: marginPercentOf(soldMargin, soldRevenue),
    },
    cancellations: {
      units: Number(row.cancelled_units),
      revenue: money(dec(row.cancelled_revenue)),
      cost: money(dec(row.cancelled_cost)),
    },
    writeOffs: { units: Number(row.written_units), value: money(writtenOff) },
    afterWriteOffs: {
      margin: money(afterWriteOffs),
      marginPercent: marginPercentOf(afterWriteOffs, soldRevenue),
    },
    purchases: { units: Number(row.bought_units), value: money(dec(row.bought_value)) },
    stock: { units: Number(row.stock_units ?? 0), value: money(dec(row.stock_value)) },
  };
}
