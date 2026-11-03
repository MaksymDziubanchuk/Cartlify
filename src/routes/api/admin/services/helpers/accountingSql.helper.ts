import { Prisma } from '@prisma/client';

import { NotFoundError } from '@utils/errors.js';

import { marginPercentOf, money } from './accountingReport.helper.js';

import type {
  AdminDeliveryMoneyDto,
  AdminMoneyBreakdownDto,
  AdminMoneySummaryDto,
} from 'types/dto/admin.dto.js';

// the sql the reports of the accounting share. A report reads the variants of its scope: all of
// them, those of the products asked for, the variants asked for, the variants of the products of
// a category with its whole branch or its own only. The money of a period [from, to) comes from
// where the database keeps it, by variant, and every event goes to the period it happened in: the
// period of a month is never changed by what happens after it.
//  - a sale: the items of the orders paid in the period (orders.paidAt), cancelled or not, its cost
//    from the batches it took (order_batch_allocations);
//  - a return: the rows of the statements whose money went back in the period (return_items.
//    refundedAt), the money of the units, and the cost of the units that came back (the lines
//    stock.return of the stock log, by the row), booked when the money has gone back and the units
//    are in, the later of the two: a refund before the goods arrive, or goods before the refund,
//    changes no period that is over. The sales less the returns are the net;
//  - a write-off: the lines stock.write_off and stock.return_write_off of the stock log (a line for
//    each variant), the batches with their costs;
//  - a purchase: the batches taken in during the period;
//  - the stock: from the stock log, the units and their cost at the start of the period, what came
//    in (deliveries, returns), what went out (sales, write-offs, returns written off at once) and
//    the stock at the end of the period; apart, the units sold whose goods are on their way back;
//  - the delivery (of no product): what the orders paid in the period paid for it (order_deliveries
//    by paidAt), what went back with the returns (return_items.deliveryShare by refundedAt), what
//    the sends the shop owes the carriers for cost (order_shipments by shippedAt; a send of a
//    cancelled order the carrier was paid for is spent all the same), the parcels back the shop
//    paid for (return_shipments by shippedAt, the time the admin gave), the cost of the way back
//    the buyers owed and the transfers took off (return_items.shippingDeduction by refundedAt, an
//    income) and the one root paid back to buyers outside the app (returns.shippingReimbursed by
//    shippingReimbursedAt, an expense)

export type ReportScope = {
  // the variants of these products
  productIds?: number[] | undefined;
  // only these variants (both filters given: the variants of those products that are among these)
  variantIds?: number[] | undefined;
  categoryId?: number | undefined;
  // with the whole branch of the category, or its own products only
  branch: boolean;
};

// a report is of the whole shop: no product, no variant and no category asked for. The delivery
// belongs to no product, so only such a report has it
export const isWholeShop = (scope: ReportScope) =>
  scope.productIds === undefined &&
  scope.variantIds === undefined &&
  scope.categoryId === undefined;

// the time of a period bound as the columns keep it: utc without a zone
export const utcTime = (date: Date) =>
  Prisma.sql`(${date.toISOString()}::timestamptz at time zone 'UTC')`;

// the batches in the meta of a line l of the stock log, a row each (e: quantity and unitCost)
export const LOG_BATCHES = Prisma.sql`
      cross join lateral jsonb_array_elements(l.meta) as c
      cross join lateral jsonb_array_elements(
        case when c->>'field' = 'batches' and jsonb_typeof(c->'new') = 'array'
             then c->'new' else '[]'::jsonb end
      ) as e`;

// the lines of the stock log of units written off: out of the stock for good, also the goods that
// came back with a statement and were written off at once
export const WRITE_OFF_EVENTS = Prisma.sql`l.event in ('stock.write_off', 'stock.return_write_off')`;

// what a line of the stock log does to the stock: units in above 0, out below 0
export const LOG_SIGN = Prisma.sql`
  case when l.event in ('stock.delivery', 'stock.return') then 1
       when l.event in ('stock.sale', 'stock.write_off', 'stock.return_write_off') then -1
       else 0 end`;

// a category asked for has to be there
export async function assertCategory(db: Prisma.TransactionClient, categoryId?: number) {
  if (categoryId === undefined) return;

  const [row] = await db.$queryRaw<{ id: number }[]>`
    select id from cartlify.categories where id = ${categoryId}::int
  `;
  if (!row) throw new NotFoundError('CATEGORY_NOT_FOUND', { categoryId });
}

// the start of a query: the category and its branch (tree), the variants of the scope (scope: the
// id of the variant, its product with the name and the category, the place and the article number
// of the variant). A query goes on with more ctes after it, the first ones are recursive
export function scopeCtes(scope: ReportScope): Prisma.Sql {
  const productIds = scope.productIds ?? null;
  const variantIds = scope.variantIds ?? null;
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
      select v.id, v."productId", p.name, p."categoryId", p."deletedAt",
             v."deletedAt" as "variantDeletedAt", v.position, v.sku
      from cartlify.product_variants as v
      join cartlify.products as p on p.id = v."productId"
      where (${productIds}::int[] is null or p.id = any(${productIds}::int[]))
        and (${variantIds}::int[] is null or v.id = any(${variantIds}::int[]))
        and (${categoryId}::int is null or p."categoryId" in (select id from tree))
    )
  `;
}

// the rows of products: the variants of a product that have a line, added up. The product has its
// name, category and removal once whichever variant says it; the margin and its percent come from
// the sums, not from the percents of the variants
const PRODUCT_ROWS = Prisma.sql`
      select v."productId" as id,
             min(v.name) as name,
             min(v."categoryId") as "categoryId",
             max(v."deletedAt") as "deletedAt",
             sum(v.sold_units)::bigint as sold_units,
             sum(v.sold_revenue) as sold_revenue,
             sum(v.sold_cost) as sold_cost,
             sum(v.returned_units)::bigint as returned_units,
             sum(v.returned_revenue) as returned_revenue,
             sum(v.returned_cost) as returned_cost,
             sum(v.written_units)::bigint as written_units,
             sum(v.written_value) as written_value,
             sum(v.bought_units)::bigint as bought_units,
             sum(v.bought_value) as bought_value,
             sum(v.stock_open_units)::bigint as stock_open_units,
             sum(v.stock_open_value) as stock_open_value,
             sum(v.stock_in_units)::bigint as stock_in_units,
             sum(v.stock_in_value) as stock_in_value,
             sum(v.stock_out_units)::bigint as stock_out_units,
             sum(v.stock_out_value) as stock_out_value,
             sum(v.stock_units)::bigint as stock_units,
             sum(v.stock_value) as stock_value,
             sum(v.way_units)::bigint as way_units,
             sum(v.way_value) as way_value,
             sum(v.sold_revenue) - sum(v.sold_cost) as sold_margin,
             case when sum(v.sold_revenue) = 0 then null
                  else round((sum(v.sold_revenue) - sum(v.sold_cost)) * 100 / sum(v.sold_revenue), 2)
             end as sold_margin_percent,
             sum(v.sold_revenue) - sum(v.returned_revenue)
               - (sum(v.sold_cost) - sum(v.returned_cost)) - sum(v.written_value)
               as margin_after_write_offs
      from variant_rows as v
      group by v."productId"`;

// What a row of a report is: a variant, or a product (the money of all its variants of the scope
// added up). The categories and the steps of time add up the variants, so they read the rows of
// variants; the report by product sums them by product, the report by variant lists them
export type ReportRows = 'variant' | 'product';

// the money of every variant of the scope in the period, a row each in the cte "report_rows" (the
// money of every product of the scope, a row each, with rows = 'product'); the sales and their
// margin are of the orders paid, the returns come off them into the net, the write-offs are a
// column of their own
export function productRowsCtes(
  scope: ReportScope,
  from: Date,
  to: Date,
  rows: ReportRows = 'variant',
): Prisma.Sql {
  const inPeriod = (column: Prisma.Sql) =>
    Prisma.sql`${column} >= ${utcTime(from)} and ${column} < ${utcTime(to)}`;

  return Prisma.sql`
    ${scopeCtes(scope)},
    sold as (
      select oi."variantId" as pid,
             sum(oi.quantity)::bigint as units,
             sum(oi."totalPrice") as revenue
      from cartlify.orders as o
      join cartlify.order_items as oi on oi."orderId" = o.id
      where ${inPeriod(Prisma.sql`o."paidAt"`)} and oi."variantId" in (select id from scope)
      group by oi."variantId"
    ),
    sold_cost as (
      select a."variantId" as pid, sum(a.quantity * b."unitCost") as cost
      from cartlify.order_batch_allocations as a
      join cartlify.orders as o on o.id = a."orderId"
      join cartlify.product_batches as b on b.id = a."batchId"
      where ${inPeriod(Prisma.sql`o."paidAt"`)} and a."variantId" in (select id from scope)
      group by a."variantId"
    ),
    refunded as (
      select ri.id, ri.quantity, ri.amount, oi."variantId" as pid
      from cartlify.return_items as ri
      join cartlify.order_items as oi on oi.id = ri."orderItemId"
      where ri.money = 'refunded' and ${inPeriod(Prisma.sql`ri."refundedAt"`)}
        and oi."variantId" in (select id from scope)
    ),
    returned as (
      select pid, sum(quantity)::bigint as units, sum(amount) as revenue
      from refunded
      group by pid
    ),
    returned_cost as (
      select oi."variantId" as pid,
             sum((e->>'quantity')::int * (e->>'unitCost')::numeric) as cost
      from cartlify.return_items as ri
      join cartlify.order_items as oi on oi.id = ri."orderItemId"
      join cartlify.stock_log as l on l."returnItemId" = ri.id and l.event = 'stock.return'
      ${LOG_BATCHES}
      where ri.money = 'refunded'
        and ${inPeriod(Prisma.sql`greatest(ri."refundedAt", l."createdAt")`)}
        and oi."variantId" in (select id from scope)
      group by oi."variantId"
    ),
    written as (
      select l."variantId" as pid,
             sum((e->>'quantity')::int)::bigint as units,
             sum((e->>'quantity')::int * (e->>'unitCost')::numeric) as value
      from cartlify.stock_log as l
      ${LOG_BATCHES}
      where ${WRITE_OFF_EVENTS}
        and ${inPeriod(Prisma.sql`l."createdAt"`)}
        and l."variantId" in (select id from scope)
      group by l."variantId"
    ),
    bought as (
      select b."variantId" as pid,
             sum(b.quantity)::bigint as units,
             sum(b.quantity * b."unitCost") as value
      from cartlify.product_batches as b
      where ${inPeriod(Prisma.sql`b."createdAt"`)} and b."variantId" in (select id from scope)
      group by b."variantId"
    ),
    moves as (
      select l."variantId" as pid, l."createdAt" as at, ${LOG_SIGN} as sign,
             (e->>'quantity')::int as qty, (e->>'unitCost')::numeric as cost
      from cartlify.stock_log as l
      ${LOG_BATCHES}
      where l."createdAt" < ${utcTime(to)} and l."variantId" in (select id from scope)
    ),
    turnover as (
      select pid,
             coalesce(sum(sign * qty) filter (where at < ${utcTime(from)}), 0)::bigint as open_units,
             coalesce(sum(sign * qty * cost) filter (where at < ${utcTime(from)}), 0) as open_value,
             coalesce(sum(qty) filter (where at >= ${utcTime(from)} and sign > 0), 0)::bigint as in_units,
             coalesce(sum(qty * cost) filter (where at >= ${utcTime(from)} and sign > 0), 0) as in_value,
             coalesce(sum(qty) filter (where at >= ${utcTime(from)} and sign < 0), 0)::bigint as out_units,
             coalesce(sum(qty * cost) filter (where at >= ${utcTime(from)} and sign < 0), 0) as out_value
      from moves
      where sign <> 0
      group by pid
    ),
    on_the_way as (
      select oi."variantId" as pid,
             sum(ri.quantity)::bigint as units,
             sum(ri.quantity * coalesce(unit.cost, 0)) as value
      from cartlify.return_items as ri
      join cartlify.order_items as oi on oi.id = ri."orderItemId"
      left join lateral (
        select sum(a.quantity * b."unitCost") / nullif(sum(a.quantity), 0) as cost
        from cartlify.order_batch_allocations as a
        join cartlify.product_batches as b on b.id = a."batchId"
        where a."orderId" = oi."orderId" and a."variantId" = oi."variantId"
      ) as unit on true
      where ri."createdAt" < ${utcTime(to)}
        and (ri.goods = 'expected' or ri."goodsSetAt" >= ${utcTime(to)})
        and oi."variantId" in (select id from scope)
      group by oi."variantId"
    ),
    raw_rows as (
      select s.id, s."productId", s.name, s."categoryId", s."deletedAt", s."variantDeletedAt",
             s.position, s.sku, cartlify.variant_display_name(s.id) as variant_name,
             coalesce(sold.units, 0) as sold_units,
             coalesce(sold.revenue, 0) as sold_revenue,
             coalesce(sold_cost.cost, 0) as sold_cost,
             coalesce(returned.units, 0) as returned_units,
             coalesce(returned.revenue, 0) as returned_revenue,
             coalesce(returned_cost.cost, 0) as returned_cost,
             coalesce(written.units, 0) as written_units,
             coalesce(written.value, 0) as written_value,
             coalesce(bought.units, 0) as bought_units,
             coalesce(bought.value, 0) as bought_value,
             coalesce(turnover.open_units, 0) as stock_open_units,
             coalesce(turnover.open_value, 0) as stock_open_value,
             coalesce(turnover.in_units, 0) as stock_in_units,
             coalesce(turnover.in_value, 0) as stock_in_value,
             coalesce(turnover.out_units, 0) as stock_out_units,
             coalesce(turnover.out_value, 0) as stock_out_value,
             coalesce(turnover.open_units + turnover.in_units - turnover.out_units, 0) as stock_units,
             coalesce(turnover.open_value + turnover.in_value - turnover.out_value, 0) as stock_value,
             coalesce(on_the_way.units, 0) as way_units,
             coalesce(on_the_way.value, 0) as way_value
      from scope as s
      left join sold on sold.pid = s.id
      left join sold_cost on sold_cost.pid = s.id
      left join returned on returned.pid = s.id
      left join returned_cost on returned_cost.pid = s.id
      left join written on written.pid = s.id
      left join bought on bought.pid = s.id
      left join turnover on turnover.pid = s.id
      left join on_the_way on on_the_way.pid = s.id
    ),
    variant_rows as (
      select r.*,
             r.sold_revenue - r.sold_cost as sold_margin,
             case when r.sold_revenue = 0 then null
                  else round((r.sold_revenue - r.sold_cost) * 100 / r.sold_revenue, 2)
             end as sold_margin_percent,
             -- the margin of the net (the sales less the returns) less what was written off
             r.sold_revenue - r.returned_revenue - (r.sold_cost - r.returned_cost) - r.written_value
               as margin_after_write_offs
      from raw_rows as r
      -- a variant of the scope with nothing in the period and nothing in the stock is no line of a report
      where r.sold_units <> 0 or r.returned_units <> 0 or r.written_units <> 0
         or r.bought_units <> 0 or r.stock_open_units <> 0 or r.stock_in_units <> 0
         or r.stock_out_units <> 0 or r.stock_units <> 0 or r.way_units <> 0
    ),
    report_rows as (
      ${rows === 'product' ? PRODUCT_ROWS : Prisma.sql`select * from variant_rows`}
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
  // the parcels the shop paid to carry goods back from buyers
  return_sends: bigint | number;
  return_ship_cost: Prisma.Decimal | string | number;
  return_sends_without_cost: bigint | number;
  // the cost of the way back taken off the transfers (an income), and paid back to buyers (spent)
  return_ship_deducted: Prisma.Decimal | string | number;
  return_ship_reimbursed: Prisma.Decimal | string | number;
};

// the delivery of one period [from, to): a row of DeliveryColumns. The income is of the orders
// paid in the period, cancelled or not; the refund (told apart) is the delivery that went back with
// the returns in it, by the time the money went back; both count the orders that paid for the
// delivery (a price above 0). The sends are the ones the shop owes the carriers for (expense), the
// ones without a cost written counted apart, and the parcels back the same way
export function deliveryOfPeriodSql(from: Date, to: Date): Prisma.Sql {
  const inPeriod = (column: Prisma.Sql) =>
    Prisma.sql`${column} >= ${utcTime(from)} and ${column} < ${utcTime(to)}`;

  return Prisma.sql`
    select
      (select count(*) from cartlify.orders as o
         join cartlify.order_deliveries as d on d."orderId" = o.id
         where ${inPeriod(Prisma.sql`o."paidAt"`)} and d.price > 0)::bigint as paid_orders,
      (select coalesce(sum(d.price), 0) from cartlify.orders as o
         join cartlify.order_deliveries as d on d."orderId" = o.id
         where ${inPeriod(Prisma.sql`o."paidAt"`)}) as paid_revenue,
      (select count(distinct r."orderId") from cartlify.return_items as ri
         join cartlify.returns as r on r.id = ri."returnId"
         where ri.money = 'refunded' and ri."deliveryShare" > 0
           and ${inPeriod(Prisma.sql`ri."refundedAt"`)})::bigint as refunded_orders,
      (select coalesce(sum(ri."deliveryShare"), 0) from cartlify.return_items as ri
         where ri.money = 'refunded' and ${inPeriod(Prisma.sql`ri."refundedAt"`)}) as refunded_revenue,
      (select count(*) from cartlify.order_shipments as s
         where s.expense and ${inPeriod(Prisma.sql`s."shippedAt"`)})::bigint as sends,
      (select coalesce(sum(s.cost), 0) from cartlify.order_shipments as s
         where s.expense and ${inPeriod(Prisma.sql`s."shippedAt"`)}) as ship_cost,
      (select count(*) from cartlify.order_shipments as s
         where s.expense and s.cost is null
           and ${inPeriod(Prisma.sql`s."shippedAt"`)})::bigint as sends_without_cost,
      (select count(*) from cartlify.return_shipments as s
         where ${inPeriod(Prisma.sql`s."shippedAt"`)})::bigint as return_sends,
      (select coalesce(sum(s.cost), 0) from cartlify.return_shipments as s
         where ${inPeriod(Prisma.sql`s."shippedAt"`)}) as return_ship_cost,
      (select count(*) from cartlify.return_shipments as s
         where s.cost is null
           and ${inPeriod(Prisma.sql`s."shippedAt"`)})::bigint as return_sends_without_cost,
      (select coalesce(sum(ri."shippingDeduction"), 0) from cartlify.return_items as ri
         where ri.money = 'refunded'
           and ${inPeriod(Prisma.sql`ri."refundedAt"`)}) as return_ship_deducted,
      (select coalesce(sum(r."shippingReimbursed"), 0) from cartlify.returns as r
         where ${inPeriod(Prisma.sql`r."shippingReimbursedAt"`)}) as return_ship_reimbursed
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
      join cartlify.orders as o on o."paidAt" >= b.f and o."paidAt" < b.t
      join cartlify.order_deliveries as d on d."orderId" = o.id
      group by b.n
    ),
    refunded as (
      select b.n, count(distinct r."orderId") filter (where ri."deliveryShare" > 0)::bigint as orders,
             sum(ri."deliveryShare") as revenue, sum(ri."shippingDeduction") as deducted
      from steps as b
      join cartlify.return_items as ri on ri.money = 'refunded'
        and ri."refundedAt" >= b.f and ri."refundedAt" < b.t
      join cartlify.returns as r on r.id = ri."returnId"
      group by b.n
    ),
    sent as (
      select b.n, count(*)::bigint as sends, sum(s.cost) as cost,
             count(*) filter (where s.cost is null)::bigint as without_cost
      from steps as b
      join cartlify.order_shipments as s on s.expense and s."shippedAt" >= b.f and s."shippedAt" < b.t
      group by b.n
    ),
    back as (
      select b.n, count(*)::bigint as sends, sum(s.cost) as cost,
             count(*) filter (where s.cost is null)::bigint as without_cost
      from steps as b
      join cartlify.return_shipments as s on s."shippedAt" >= b.f and s."shippedAt" < b.t
      group by b.n
    ),
    reimbursed as (
      select b.n, sum(r."shippingReimbursed") as amount
      from steps as b
      join cartlify.returns as r
        on r."shippingReimbursedAt" >= b.f and r."shippingReimbursedAt" < b.t
      group by b.n
    )
    select b.n,
           coalesce(paid.orders, 0)::bigint as paid_orders,
           coalesce(paid.revenue, 0) as paid_revenue,
           coalesce(refunded.orders, 0)::bigint as refunded_orders,
           coalesce(refunded.revenue, 0) as refunded_revenue,
           coalesce(sent.sends, 0)::bigint as sends,
           coalesce(sent.cost, 0) as ship_cost,
           coalesce(sent.without_cost, 0)::bigint as sends_without_cost,
           coalesce(back.sends, 0)::bigint as return_sends,
           coalesce(back.cost, 0) as return_ship_cost,
           coalesce(back.without_cost, 0)::bigint as return_sends_without_cost,
           coalesce(refunded.deducted, 0) as return_ship_deducted,
           coalesce(reimbursed.amount, 0) as return_ship_reimbursed
    from steps as b
    left join paid on paid.n = b.n
    left join refunded on refunded.n = b.n
    left join sent on sent.n = b.n
    left join back on back.n = b.n
    left join reimbursed on reimbursed.n = b.n
    order by b.n
  `;
}

// the delivery of a row as the answers give it: the decimals, not the floats; the result is the
// income less what went back with the returns and less what the carriers cost, the parcels back
// too, with the way back the buyers owed and less the one paid back to them
export function deliveryMoneyOf(row: DeliveryColumns): AdminDeliveryMoneyDto {
  const paid = dec(row.paid_revenue);
  const refunded = dec(row.refunded_revenue);
  const cost = dec(row.ship_cost);
  const backCost = dec(row.return_ship_cost);
  const deducted = dec(row.return_ship_deducted);
  const reimbursed = dec(row.return_ship_reimbursed);

  return {
    income: { orders: Number(row.paid_orders), revenue: money(paid) },
    refunded: { orders: Number(row.refunded_orders), revenue: money(refunded) },
    shipping: {
      sends: Number(row.sends),
      cost: money(cost),
      withoutCost: Number(row.sends_without_cost),
    },
    returnShipping: {
      sends: Number(row.return_sends),
      cost: money(backCost),
      withoutCost: Number(row.return_sends_without_cost),
      deducted: money(deducted),
      reimbursed: money(reimbursed),
    },
    result: money(
      paid.minus(refunded).minus(cost).minus(backCost).plus(deducted).minus(reimbursed),
    ),
  };
}

// the money of a period in three parts, the same for every report and for the statistics: what came
// in (the items less the returns, the delivery less what went back, together), what went out (what
// the items kept cost, the units written off, the sends and the parcels back the shop owes the
// carriers for, together),
// and what each income left (the items less their cost, the delivery less the sends, all the income
// less all the expenses). The delivery is of the whole shop: without it (a report of some products)
// its parts are none and the totals are of the items
export function summaryOf(parts: {
  itemsRevenue: Prisma.Decimal.Value;
  itemsCost: Prisma.Decimal.Value;
  writeOffs: Prisma.Decimal.Value;
  delivery: DeliveryColumns | null;
}): AdminMoneySummaryDto {
  const items = dec(parts.itemsRevenue);
  const cost = dec(parts.itemsCost);
  const writtenOff = dec(parts.writeOffs);
  // the delivery the buyers paid less what went back, with the way back they owed
  const delivery = parts.delivery
    ? dec(parts.delivery.paid_revenue)
        .minus(dec(parts.delivery.refunded_revenue))
        .plus(dec(parts.delivery.return_ship_deducted))
    : null;
  // the sends to the buyers and the parcels back are the one expense of the carriers, the way back
  // paid back to the buyers too
  const shipping = parts.delivery
    ? dec(parts.delivery.ship_cost)
        .plus(dec(parts.delivery.return_ship_cost))
        .plus(dec(parts.delivery.return_ship_reimbursed))
    : null;

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
  coalesce(sum(returned_units), 0)::bigint as returned_units,
  coalesce(sum(returned_revenue), 0) as returned_revenue,
  coalesce(sum(returned_cost), 0) as returned_cost,
  coalesce(sum(written_units), 0)::bigint as written_units,
  coalesce(sum(written_value), 0) as written_value,
  coalesce(sum(bought_units), 0)::bigint as bought_units,
  coalesce(sum(bought_value), 0) as bought_value,
  coalesce(sum(stock_open_units), 0)::bigint as stock_open_units,
  coalesce(sum(stock_open_value), 0) as stock_open_value,
  coalesce(sum(stock_in_units), 0)::bigint as stock_in_units,
  coalesce(sum(stock_in_value), 0) as stock_in_value,
  coalesce(sum(stock_out_units), 0)::bigint as stock_out_units,
  coalesce(sum(stock_out_value), 0) as stock_out_value,
  coalesce(sum(stock_units), 0)::bigint as stock_units,
  coalesce(sum(stock_value), 0) as stock_value,
  coalesce(sum(way_units), 0)::bigint as way_units,
  coalesce(sum(way_value), 0) as way_value
`;

type Num = bigint | number;
type Dec = Prisma.Decimal | string | number;

export type MoneyColumns = {
  sold_units: Num;
  sold_revenue: Dec;
  sold_cost: Dec;
  returned_units: Num;
  returned_revenue: Dec;
  returned_cost: Dec;
  written_units: Num;
  written_value: Dec;
  bought_units: Num;
  bought_value: Dec;
  // the stock, from the stock log: at the start of the period, what came in, what went out, at the
  // end; the goods on their way back (the steps of a timeline have none of it)
  stock_open_units?: Num;
  stock_open_value?: Dec;
  stock_in_units?: Num;
  stock_in_value?: Dec;
  stock_out_units?: Num;
  stock_out_value?: Dec;
  stock_units?: Num;
  stock_value?: Dec;
  way_units?: Num;
  way_value?: Dec;
};

const dec = (value: Prisma.Decimal.Value | undefined) => new Prisma.Decimal(value ?? 0);

const unitsValue = (units: Num | undefined, value: Dec | undefined) => ({
  units: Number(units ?? 0),
  value: money(dec(value)),
});

// the money of a row as the answers give it; the percents come from the decimals, not the floats.
// The sales are the orders paid in the period, the returns the money that went back in it, the net
// the one less the other; the write-offs come off the margin of the net, shown apart to look into
export function moneyOf(row: MoneyColumns): AdminMoneyBreakdownDto {
  const soldRevenue = dec(row.sold_revenue);
  const soldCost = dec(row.sold_cost);
  const soldMargin = soldRevenue.minus(soldCost);

  const returnedRevenue = dec(row.returned_revenue);
  const returnedCost = dec(row.returned_cost);

  const netRevenue = soldRevenue.minus(returnedRevenue);
  const netCost = soldCost.minus(returnedCost);
  const netMargin = netRevenue.minus(netCost);

  const writtenOff = dec(row.written_value);
  const afterWriteOffs = netMargin.minus(writtenOff);

  return {
    sales: {
      units: Number(row.sold_units),
      revenue: money(soldRevenue),
      cost: money(soldCost),
      margin: money(soldMargin),
      marginPercent: marginPercentOf(soldMargin, soldRevenue),
    },
    returns: {
      units: Number(row.returned_units),
      revenue: money(returnedRevenue),
      cost: money(returnedCost),
    },
    net: {
      units: Number(row.sold_units) - Number(row.returned_units),
      revenue: money(netRevenue),
      cost: money(netCost),
      margin: money(netMargin),
      marginPercent: marginPercentOf(netMargin, netRevenue),
    },
    writeOffs: { units: Number(row.written_units), value: money(writtenOff) },
    afterWriteOffs: {
      margin: money(afterWriteOffs),
      marginPercent: marginPercentOf(afterWriteOffs, netRevenue),
    },
    purchases: { units: Number(row.bought_units), value: money(dec(row.bought_value)) },
    stock: {
      opening: unitsValue(row.stock_open_units, row.stock_open_value),
      received: unitsValue(row.stock_in_units, row.stock_in_value),
      left: unitsValue(row.stock_out_units, row.stock_out_value),
      closing: unitsValue(row.stock_units, row.stock_value),
      onTheWayBack: unitsValue(row.way_units, row.way_value),
    },
  };
}
