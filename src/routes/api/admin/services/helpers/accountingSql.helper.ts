import { Prisma } from '@prisma/client';

import { NotFoundError } from '@utils/errors.js';

import { marginPercentOf, money } from './accountingReport.helper.js';

import type {
  AdminDeliveryMoneyDto,
  AdminMoneyBreakdownDto,
  AdminMoneySummaryDto,
  AdminPaymentsMoneyDto,
} from 'types/dto/admin.dto.js';

// the sql the reports of the accounting share. A report reads the variants of its scope: all of
// them, those of the products asked for, the variants asked for, the variants of the products of
// a category with its whole branch or its own only. The money of a period [from, to) comes from the
// money journal (money_log), by the time its lines were written, and every event goes to the period
// it happened in: the journal only grows, so the period of a month is never changed by what happens
// after it. The money journal writes no currency where the shop has one (null is the money of the
// shop).
//  - a sale: the orders whose payment was written in the period (the part goods of money.payment),
//    cancelled later or not; the items of the order share it by variant, its cost from the batches
//    it took (order_batch_allocations);
//  - a return: the parts goods of the money of the statements (the transfers, the money sent
//    outside the app, and with the opposite sign their failures), shared by variant by the rows
//    they name in their meta, written with the line; and the cost of the units that came back (the
//    lines stock.return of the stock log, by the item of the statement), booked when the money of
//    the units has gone back and the units are in, the later of the two: a refund before the goods
//    arrive, goods before the refund or goods that come in parts change no period that is over. The
//    part a transfer covered with money already sent another way is no return of its own: the
//    goods are. The sales less the returns are the net;
//  - a write-off: the lines stock.write_off and stock.return_write_off of the stock log (a line for
//    each variant), the batches with their costs;
//  - a purchase: the batches taken in during the period;
//  - the stock: from the stock log, the units and their cost at the start of the period, what came
//    in (deliveries, returns), what went out (sales, write-offs, returns written off at once) and
//    the stock at the end of the period; apart, the units sold whose goods are on their way back;
//  - the delivery (of no product): the parts delivery of the payments, what went back with the
//    returns (their parts delivery), the way back the buyers owed and the transfers kept (the parts
//    deduction, an income), the one the shop paid back to buyers (the parts way_back of the
//    transfers and of the money outside the app, an expense), what the sends the shop owes the
//    carriers for cost
//    (money.shipping_cost with its corrections, only of a send of order_shipments.expense) and the
//    parcels back the shop paid for (money.return_parcel_cost with its corrections). The sends and
//    the parcels are counted by the time they went (shippedAt);
//  - the payments past the statements (of no product): what the bank took for the disputes and gave
//    back, the refunds made by hand in the dashboard of the provider (by what root or the system
//    decided they were), what the transfers of statements took of both as money the buyer had back
//    (the parts covered: that money is in the returns), and the payments the orders could not take
//    with every movement of such a payment after it

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

type Period = { from: Date; to: Date };

// the steps of a report as the cte "steps": the bounds as the columns keep them (utc without a
// zone), f taken in and t left out, numbered n from 1 in their order. A period is one step
function stepsCte(steps: Period[]): Prisma.Sql {
  const froms = steps.map((step) => step.from.toISOString());
  const tos = steps.map((step) => step.to.toISOString());

  return Prisma.sql`
    steps as (
      select x.f at time zone 'UTC' as f, x.t at time zone 'UTC' as t, x.n
      from unnest(${froms}::timestamptz[], ${tos}::timestamptz[]) with ordinality as x(f, t, n)
    )`;
}

// the money of the variants of the scope in each step, after scopeCtes and stepsCte: the cte
// "step_money" has a row for each step n and variant pid that has some (MoneyColumns without the
// stock), and "returned_by_return" and "returned_cost_by_return" the returns by statement (rid) for
// the kinds of a statement.
//  - the sale: the order whose part goods of its payment was written in the step, its items by
//    variant at their prices, its cost from the batches it took;
//  - the return: the rows a part goods of the money of the statements names in its meta (a transfer
//    or money sent outside the app, units and money above 0; its failure, below 0), in the step its
//    line was written. Money already with the buyer is the return of its items when it is decided,
//    in the step of its own line (a refund made by hand, what a bank
//    took, by the shares of the decision; money, no units, of no statement), so the part covered of a
//    later transfer takes its money off the statement (the units stay), a failure of the refund made
//    by hand takes the shares off in its step and money sent another way after it gives them back;
//    the money the buyer gave back outside the app comes off the statement in its step;
//  - the cost of the units back, by the item of a statement: the units whose money has gone back
//    and that are back in the stock, as many as the fewer of the two, at the cost of the units that
//    came back (their batches); a step books what it adds to that. So the cost waits for the later
//    of the money and the goods, a failure gives it back, and goods that come in parts (the row
//    of a statement is parted) are booked as they come;
//  - the write-offs and the purchases by the time of their lines and batches
function stepMoneyCtes(): Prisma.Sql {
  return Prisma.sql`
    bounds as (
      select max(t) as t from steps
    ),
    paid as (
      select b.n, l."orderId" as order_id
      from steps as b
      join cartlify.money_log as l on l."createdAt" >= b.f and l."createdAt" < b.t
      where l.event = 'money.payment' and l.part = 'goods'::cartlify."MoneyPart"
    ),
    sold as (
      select p.n, oi."variantId" as pid,
             sum(oi.quantity)::bigint as units,
             sum(oi."totalPrice") as revenue
      from paid as p
      join cartlify.order_items as oi on oi."orderId" = p.order_id
      where oi."variantId" in (select id from scope)
      group by p.n, oi."variantId"
    ),
    sold_cost as (
      select p.n, a."variantId" as pid, sum(a.quantity * pb."unitCost") as cost
      from paid as p
      join cartlify.order_batch_allocations as a on a."orderId" = p.order_id
      join cartlify.product_batches as pb on pb.id = a."batchId"
      where a."variantId" in (select id from scope)
      group by p.n, a."variantId"
    ),
    goods_moves as (
      select l."createdAt" as at, l."returnId" as rid, ri."orderItemId" as oiid,
             (g.value ->> 'variantId')::int as pid,
             (-sign(l.amount))::int * (g.value ->> 'quantity')::int as units,
             -sign(l.amount) * (g.value ->> 'amount')::numeric as revenue
      from cartlify.money_log as l
      cross join lateral jsonb_array_elements(
        case when jsonb_typeof(l.meta) = 'array' then l.meta else '[]'::jsonb end
      ) as g(value)
      join cartlify.return_items as ri on ri.id = (g.value ->> 'returnItemId')::int
      where l.purpose = 'return'::cartlify."MoneyPurpose"
        and l.part = 'goods'::cartlify."MoneyPart"
        and l.event in ('money.refund', 'money.refund_failed', 'money.outside')
        and l."createdAt" < (select t from bounds)
        and (g.value ->> 'variantId')::int in (select id from scope)
      union all
      -- the money the parts covered took for the items: already the return of the items, by the
      -- decision on the money they name
      select l."createdAt", l."returnId", ri."orderItemId", oi."variantId", 0,
             -sign(l.amount) * (c.value ->> 'amount')::numeric
      from cartlify.money_log as l
      cross join lateral jsonb_array_elements(
        case when jsonb_typeof(l.meta) = 'array' then l.meta else '[]'::jsonb end
      ) as c(value)
      join cartlify.return_items as ri on ri.id = (c.value ->> 'returnItemId')::int
      join cartlify.order_items as oi on oi.id = (c.value ->> 'orderItemId')::int
      where l.purpose = 'return'::cartlify."MoneyPurpose"
        and l.part = 'covered'::cartlify."MoneyPart"
        and l.event in ('money.refund', 'money.refund_failed', 'money.outside')
        and coalesce(c.value ->> 'orderItemId', '') <> ''
        and l."createdAt" < (select t from bounds)
        and oi."variantId" in (select id from scope)
      union all
      -- the shares of the decisions on money given back by hand or taken by a bank, in the step of
      -- the line; the failure of a refund made by hand takes them off, money sent another way after
      -- it gives them back
      select e.at, null::int, (s.value ->> 'orderItemId')::int, (s.value ->> 'variantId')::int, 0,
             e.sign * (s.value ->> 'amount')::numeric
      from (
        select d."createdAt" as at, d.meta, 1 as sign
        from cartlify.money_log as d
        where d."moneyUse" is not null
          and ((d.event = 'money.refund' and d.purpose = 'hand'::cartlify."MoneyPurpose")
               or d.event = 'money.dispute_withdrawn')
        union all
        select x."createdAt", d.meta, case when x.event = 'money.refund_failed' then -1 else 1 end
        from cartlify.money_log as x
        join cartlify.money_log as d on d.id = x."coversId"
        where x.event in ('money.refund_failed', 'money.outside')
          and x.purpose = 'hand'::cartlify."MoneyPurpose"
          and d."moneyUse" is not null
      ) as e
      cross join lateral jsonb_array_elements(
        case when jsonb_typeof(e.meta) = 'array' then e.meta else '[]'::jsonb end
      ) as s(value)
      where coalesce(s.value ->> 'orderItemId', '') <> ''
        and e.at < (select t from bounds)
        and (s.value ->> 'variantId')::int in (select id from scope)
      union all
      -- the money the buyer gave back outside the app for rows of a statement
      select l."createdAt", l."returnId", ri."orderItemId", (g.value ->> 'variantId')::int, 0,
             -(g.value ->> 'amount')::numeric
      from cartlify.money_log as l
      cross join lateral jsonb_array_elements(
        case when jsonb_typeof(l.meta) = 'array' then l.meta else '[]'::jsonb end
      ) as g(value)
      join cartlify.return_items as ri on ri.id = (g.value ->> 'returnItemId')::int
      where l.event = 'money.received'
        and l.purpose = 'return'::cartlify."MoneyPurpose"
        and l."createdAt" < (select t from bounds)
        and (g.value ->> 'variantId')::int in (select id from scope)
      union all
      -- what the buyer gave back of the share of an item that was overpaid, and what root gave up of
      -- it: no more a return of the goods, in the step of the line
      select l."createdAt", null::int, (g.value ->> 'orderItemId')::int, (g.value ->> 'variantId')::int,
             0, -(g.value ->> 'amount')::numeric
      from cartlify.money_log as l
      cross join lateral jsonb_array_elements(
        case when jsonb_typeof(l.meta) = 'array' then l.meta else '[]'::jsonb end
      ) as g(value)
      where l.event in ('money.received', 'money.share_moved')
        and l.purpose in ('hand'::cartlify."MoneyPurpose", 'dispute'::cartlify."MoneyPurpose")
        and coalesce(g.value ->> 'orderItemId', '') <> ''
        and l."createdAt" < (select t from bounds)
        and (g.value ->> 'variantId')::int in (select id from scope)
    ),
    returned_by_return as (
      select b.n, m.pid, m.rid, sum(m.units)::bigint as units, sum(m.revenue) as revenue
      from steps as b
      join goods_moves as m on m.at >= b.f and m.at < b.t
      group by b.n, m.pid, m.rid
    ),
    backs as (
      select l."createdAt" as at, ri."returnId" as rid, ri."orderItemId" as oiid,
             l."variantId" as pid,
             (e->>'quantity')::int as qty,
             (e->>'quantity')::int * (e->>'unitCost')::numeric as cost
      from cartlify.stock_log as l
      ${LOG_BATCHES}
      join cartlify.return_items as ri on ri.id = l."returnItemId"
      where l.event = 'stock.return'
        and l."createdAt" < (select t from bounds)
        and l."variantId" in (select id from scope)
    ),
    pair_moves as (
      select at, rid, oiid, pid, units as money_units, 0 as stock_units, 0::numeric as stock_cost
      from goods_moves
      union all
      select at, rid, oiid, pid, 0, qty, cost
      from backs
    ),
    active as (
      select distinct b.n, x.rid, x.oiid, x.pid
      from steps as b
      join pair_moves as x on x.at >= b.f and x.at < b.t
    ),
    pair_bounds as (
      select a.n, a.pid, a.rid,
             coalesce(sum(x.money_units) filter (where x.at < b.f), 0) as m_from,
             coalesce(sum(x.money_units), 0) as m_to,
             coalesce(sum(x.stock_units) filter (where x.at < b.f), 0) as s_from,
             coalesce(sum(x.stock_units), 0) as s_to,
             coalesce(sum(x.stock_cost) filter (where x.at < b.f), 0) as c_from,
             coalesce(sum(x.stock_cost), 0) as c_to
      from active as a
      join steps as b on b.n = a.n
      join pair_moves as x on x.rid = a.rid and x.oiid = a.oiid and x.at < b.t
      group by a.n, a.pid, a.rid, a.oiid
    ),
    returned_cost_by_return as (
      select n, pid, rid,
             sum(
               case when s_to > 0 then least(greatest(m_to, 0), s_to) * c_to / s_to else 0 end
               - case when s_from > 0 then least(greatest(m_from, 0), s_from) * c_from / s_from
                      else 0 end
             ) as cost
      from pair_bounds
      group by n, pid, rid
    ),
    returned as (
      select n, pid, sum(units)::bigint as units, sum(revenue) as revenue
      from returned_by_return
      group by n, pid
    ),
    returned_cost as (
      select n, pid, sum(cost) as cost
      from returned_cost_by_return
      group by n, pid
    ),
    written as (
      select b.n, l."variantId" as pid,
             sum((e->>'quantity')::int)::bigint as units,
             sum((e->>'quantity')::int * (e->>'unitCost')::numeric) as value
      from steps as b
      join cartlify.stock_log as l on l."createdAt" >= b.f and l."createdAt" < b.t
      ${LOG_BATCHES}
      where ${WRITE_OFF_EVENTS}
        and l."variantId" in (select id from scope)
      group by b.n, l."variantId"
    ),
    bought as (
      select b.n, pb."variantId" as pid,
             sum(pb.quantity)::bigint as units,
             sum(pb.quantity * pb."unitCost") as value
      from steps as b
      join cartlify.product_batches as pb on pb."createdAt" >= b.f and pb."createdAt" < b.t
      where pb."variantId" in (select id from scope)
      group by b.n, pb."variantId"
    ),
    step_money as (
      select k.n, k.pid,
             coalesce(sold.units, 0)::bigint as sold_units,
             coalesce(sold.revenue, 0) as sold_revenue,
             coalesce(sold_cost.cost, 0) as sold_cost,
             coalesce(returned.units, 0)::bigint as returned_units,
             coalesce(returned.revenue, 0) as returned_revenue,
             coalesce(returned_cost.cost, 0) as returned_cost,
             coalesce(written.units, 0)::bigint as written_units,
             coalesce(written.value, 0) as written_value,
             coalesce(bought.units, 0)::bigint as bought_units,
             coalesce(bought.value, 0) as bought_value
      from (
        select n, pid from sold
        union select n, pid from sold_cost
        union select n, pid from returned
        union select n, pid from returned_cost
        union select n, pid from written
        union select n, pid from bought
      ) as k
      left join sold on sold.n = k.n and sold.pid = k.pid
      left join sold_cost on sold_cost.n = k.n and sold_cost.pid = k.pid
      left join returned on returned.n = k.n and returned.pid = k.pid
      left join returned_cost on returned_cost.n = k.n and returned_cost.pid = k.pid
      left join written on written.n = k.n and written.pid = k.pid
      left join bought on bought.n = k.n and bought.pid = k.pid
    )`;
}

// the money of the variants of the scope in each of the steps, a step by its number (the start of
// a query: the ctes of scopeCtes, the steps and the money of the steps, see stepMoneyCtes)
export function stepMoneyOfScopeCtes(scope: ReportScope, steps: Period[]): Prisma.Sql {
  return Prisma.sql`
    ${scopeCtes(scope)},
    ${stepsCte(steps)},
    ${stepMoneyCtes()}
  `;
}

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
  return Prisma.sql`
    ${stepMoneyOfScopeCtes(scope, [{ from, to }])},
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
             coalesce(m.sold_units, 0) as sold_units,
             coalesce(m.sold_revenue, 0) as sold_revenue,
             coalesce(m.sold_cost, 0) as sold_cost,
             coalesce(m.returned_units, 0) as returned_units,
             coalesce(m.returned_revenue, 0) as returned_revenue,
             coalesce(m.returned_cost, 0) as returned_cost,
             coalesce(m.written_units, 0) as written_units,
             coalesce(m.written_value, 0) as written_value,
             coalesce(m.bought_units, 0) as bought_units,
             coalesce(m.bought_value, 0) as bought_value,
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
      left join step_money as m on m.pid = s.id
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

// the columns of DeliveryColumns in their order
const DELIVERY_COLUMNS = Prisma.sql`paid_orders, paid_revenue, refunded_orders, refunded_revenue,
  sends, ship_cost, sends_without_cost, return_sends, return_ship_cost, return_sends_without_cost,
  return_ship_deducted, return_ship_reimbursed`;

// the delivery of one period [from, to): a row of DeliveryColumns, the one step of
// deliveryOfStepsSql
export function deliveryOfPeriodSql(from: Date, to: Date): Prisma.Sql {
  return Prisma.sql`
    select ${DELIVERY_COLUMNS} from (${deliveryOfStepsSql([{ from, to }])}) as d
  `;
}

// the delivery of every step of a timeline, a row each by its number n (DeliveryColumns and n),
// from the money journal by the time of its lines. The income is the parts delivery of the
// payments written in the step (orders: the ones that paid for it, a delivery that cost nothing
// writes no part), cancelled later or not; the refund, told apart, is the parts delivery of the
// money of the statements (the transfers and the money sent outside the app, less their failures;
// orders: the ones whose delivery went back in the step), the deduction the parts the transfers
// kept for the way back, the way back paid back the parts way_back. The sends are the ones the shop
// owes the carriers for (expense) by the time they went, their cost the lines of the costs with
// the corrections by the time they were written; a send without a line, or whose lines come to 0,
// has no cost. The parcels back the same way
export function deliveryOfStepsSql(steps: Period[]): Prisma.Sql {
  const inStep = (column: Prisma.Sql) => Prisma.sql`${column} >= b.f and ${column} < b.t`;

  return Prisma.sql`
    with ${stepsCte(steps)},
    paid as (
      select b.n, count(distinct l."orderId")::bigint as orders, sum(l.amount) as revenue
      from steps as b
      join cartlify.money_log as l on ${inStep(Prisma.sql`l."createdAt"`)}
      where l.event = 'money.payment' and l.part = 'delivery'::cartlify."MoneyPart"
      group by b.n
    ),
    refunds as (
      select b.n, l."orderId",
             -sum(l.amount) filter (where l.part = 'delivery'::cartlify."MoneyPart") as delivery,
             sum(l.amount) filter (where l.part = 'deduction'::cartlify."MoneyPart") as deducted
      from steps as b
      join cartlify.money_log as l on ${inStep(Prisma.sql`l."createdAt"`)}
      where l.purpose = 'return'::cartlify."MoneyPurpose"
        and l.part in ('delivery'::cartlify."MoneyPart", 'deduction'::cartlify."MoneyPart")
        and l.event in ('money.refund', 'money.refund_failed', 'money.outside')
      group by b.n, l."orderId"
    ),
    refunded as (
      select n,
             count(*) filter (where delivery > 0)::bigint as orders,
             coalesce(sum(delivery), 0) as revenue,
             coalesce(sum(deducted), 0) as deducted
      from refunds
      group by n
    ),
    reimbursed as (
      select b.n, -sum(l.amount) as amount
      from steps as b
      join cartlify.money_log as l on ${inStep(Prisma.sql`l."createdAt"`)}
      where l.purpose = 'return'::cartlify."MoneyPurpose" and l.part = 'way_back'::cartlify."MoneyPart"
        and l.event in ('money.refund', 'money.refund_failed', 'money.outside')
      group by b.n
    ),
    send_cost as (
      select b.n, -sum(l.amount) as cost
      from steps as b
      join cartlify.money_log as l on ${inStep(Prisma.sql`l."createdAt"`)}
      join cartlify.order_shipments as s on s.id = l."orderShipmentId"
      where l.purpose = 'shipping'::cartlify."MoneyPurpose" and s."returnId" is null and s.expense
        and l.event <> 'money.received'
      group by b.n
    ),
    back_cost as (
      select b.n, -sum(l.amount) as cost
      from steps as b
      join cartlify.money_log as l on ${inStep(Prisma.sql`l."createdAt"`)}
      where l.purpose = 'shipping'::cartlify."MoneyPurpose" and l."returnId" is not null
        and l."orderShipmentId" is not null
      group by b.n
    ),
    sent as (
      select b.n, count(*)::bigint as sends,
             count(*) filter (where coalesce(c.cost, 0) = 0)::bigint as without_cost
      from steps as b
      join cartlify.order_shipments as s
        on s."returnId" is null and s.expense and ${inStep(Prisma.sql`s."shippedAt"`)}
      left join lateral (
        select -sum(l.amount) as cost
        from cartlify.money_log as l
        where l."orderId" = s."orderId" and l."orderShipmentId" = s.id
          and l.purpose = 'shipping'::cartlify."MoneyPurpose" and l.event <> 'money.received'
      ) as c on true
      group by b.n
    ),
    back as (
      select b.n, count(*)::bigint as sends,
             count(*) filter (where coalesce(c.cost, 0) = 0)::bigint as without_cost
      from steps as b
      -- the parcels of the statements the shop pays the carrier for: the ones an admin recorded
      -- (the shop sent for the goods, or sent the goods not accepted back) and any with a cost; a
      -- parcel the buyer told of and paid is none of the shop
      join cartlify.order_shipments as s
        on s."returnId" is not null and ${inStep(Prisma.sql`s."shippedAt"`)}
      left join lateral (
        select -sum(l.amount) as cost
        from cartlify.money_log as l
        where l."returnId" = s."returnId" and l."orderShipmentId" = s.id
          and l.purpose = 'shipping'::cartlify."MoneyPurpose"
      ) as c on true
      where c.cost is not null
        or s.direction = 'to_buyer'::cartlify."ShipmentDirection"
        or exists (
          select 1 from cartlify.users as u
          where u.id = s."recordedById" and u.role in ('ADMIN'::cartlify."Role", 'ROOT'::cartlify."Role")
        )
      group by b.n
    )
    select b.n,
           coalesce(paid.orders, 0)::bigint as paid_orders,
           coalesce(paid.revenue, 0) as paid_revenue,
           coalesce(refunded.orders, 0)::bigint as refunded_orders,
           coalesce(refunded.revenue, 0) as refunded_revenue,
           coalesce(sent.sends, 0)::bigint as sends,
           coalesce(send_cost.cost, 0) as ship_cost,
           coalesce(sent.without_cost, 0)::bigint as sends_without_cost,
           coalesce(back.sends, 0)::bigint as return_sends,
           coalesce(back_cost.cost, 0) as return_ship_cost,
           coalesce(back.without_cost, 0)::bigint as return_sends_without_cost,
           coalesce(refunded.deducted, 0) as return_ship_deducted,
           coalesce(reimbursed.amount, 0) as return_ship_reimbursed
    from steps as b
    left join paid on paid.n = b.n
    left join refunded on refunded.n = b.n
    left join reimbursed on reimbursed.n = b.n
    left join send_cost on send_cost.n = b.n
    left join back_cost on back_cost.n = b.n
    left join sent on sent.n = b.n
    left join back on back.n = b.n
    order by b.n
  `;
}

export type PaymentsColumns = {
  // what the bank took for the disputes (above 0) and gave back
  dispute_withdrawn: Prisma.Decimal | string | number;
  dispute_reinstated: Prisma.Decimal | string | number;
  // what the transfers of statements took of the money of lost disputes as money the buyer had back
  dispute_used: Prisma.Decimal | string | number;
  // what the bank took for a dispute lost that root has not said what it was for yet
  dispute_undecided: Prisma.Decimal | string | number;
  // what went out by hand in the dashboard of the provider (less the failures, with the money sent
  // outside the app after one), by what root or the system decided it was
  hand_compensations: Prisma.Decimal | string | number;
  hand_coverage: Prisma.Decimal | string | number;
  hand_undecided: Prisma.Decimal | string | number;
  // what the transfers of statements took of the refunds by hand as money the buyer had back
  hand_used: Prisma.Decimal | string | number;
  // the payments the orders could not take, and what of them went back in any way
  late_received: Prisma.Decimal | string | number;
  late_refunded: Prisma.Decimal | string | number;
  // the compensations root gave by the button of the app (less their failures, with the money sent
  // outside the app after one)
  compensations_given: Prisma.Decimal | string | number;
  // the money the shop got back outside the app: from buyers for rows of statements, from carriers
  // for the sends they lost
  received_buyers: Prisma.Decimal | string | number;
  received_carriers: Prisma.Decimal | string | number;
  // for the expenses of the summary: what the decisions on the money of disputes and of refunds by
  // hand gave the goods (the report by product counts it as their return) and the delivery, and
  // what the parts covered took of each for the delivery (the delivery report counts it then)
  dispute_goods: Prisma.Decimal | string | number;
  dispute_delivery_used: Prisma.Decimal | string | number;
  hand_delivery: Prisma.Decimal | string | number;
  hand_delivery_used: Prisma.Decimal | string | number;
  // what root did with what was overpaid: what it gave up of the shares of the goods (a loss or a
  // compensation now, no more their return), and what the buyer gave back of a share of the delivery
  shares_moved_goods: Prisma.Decimal | string | number;
  received_share_delivery: Prisma.Decimal | string | number;
};

// the columns of PaymentsColumns in their order
const PAYMENTS_COLUMNS = Prisma.sql`dispute_withdrawn, dispute_reinstated, dispute_used,
  dispute_undecided, hand_compensations, hand_coverage, hand_undecided, hand_used, late_received,
  late_refunded, compensations_given, received_buyers, received_carriers, dispute_goods,
  dispute_delivery_used, hand_delivery, hand_delivery_used, shares_moved_goods,
  received_share_delivery`;

// the payments past the statements of one period [from, to): a row of PaymentsColumns, the one
// step of paymentsOfStepsSql
export function paymentsOfPeriodSql(from: Date, to: Date): Prisma.Sql {
  return Prisma.sql`
    select ${PAYMENTS_COLUMNS} from (${paymentsOfStepsSql([{ from, to }])}) as p
  `;
}

// the payments past the statements of every step, a row each by its number n (PaymentsColumns and
// n), from the money journal by the time of its lines. A payment the order could not take
// (money.late_payment) is a section of its own: every line of it is there, our refunds of it, the
// ones made by hand, the money sent outside the app and what the bank took for a dispute of it. The
// disputes and the refunds by hand are those of the payments of orders; a failure and the money
// sent outside the app after it take the decision of the refund they name. A part covered of a
// transfer of a statement names the money it took (its failure names the part): that money is
// counted as used by the source it came from. A decision on money of a past period is told in that
// period (its sum stays, only what it was for is known now). The compensations of the app and the
// money the shop got back outside the app (from buyers, from carriers) are sections of their own
export function paymentsOfStepsSql(steps: Period[]): Prisma.Sql {
  return Prisma.sql`
    with ${stepsCte(steps)},
    late as (
      select distinct l."paymentId" as payment_id
      from cartlify.money_log as l
      where l.event = 'money.late_payment'
    ),
    lines as (
      select b.n, l.event, l.purpose, l.part, l.amount, l."coversId", l."moneyUse", l.meta,
             l."disputeId",
             coalesce(l."paymentId" in (select payment_id from late), false) as is_late
      from steps as b
      join cartlify.money_log as l on l."createdAt" >= b.f and l."createdAt" < b.t
      where l.purpose in (
              'late_payment'::cartlify."MoneyPurpose",
              'hand'::cartlify."MoneyPurpose",
              'dispute'::cartlify."MoneyPurpose",
              'compensation'::cartlify."MoneyPurpose"
            )
         or (l.purpose = 'return'::cartlify."MoneyPurpose"
             and l.part = 'covered'::cartlify."MoneyPart")
         or l.event = 'money.received'
    ),
    disputes as (
      select n,
             -sum(amount) filter (where event = 'money.dispute_withdrawn') as withdrawn,
             sum(amount) filter (where event = 'money.dispute_reinstated') as reinstated,
             -sum(amount) filter (
               where event = 'money.dispute_withdrawn' and "moneyUse" is null
                 and exists (
                   select 1 from cartlify.payment_disputes as pd
                   where pd.id = lines."disputeId" and pd.status = 'lost'::cartlify."DisputeStatus"
                 )
             ) as undecided,
             sum((
               select coalesce(sum((e.value ->> 'amount')::numeric), 0)
               from jsonb_array_elements(coalesce(meta, '[]'::jsonb)) as e (value)
               where coalesce(e.value ->> 'orderItemId', '') <> ''
             )) filter (where event = 'money.dispute_withdrawn' and "moneyUse" is not null) as goods
      from lines
      where purpose = 'dispute'::cartlify."MoneyPurpose" and not is_late
      group by n
    ),
    hand as (
      -- what each line gave back, the decision of the refund it is of, and the part of it the
      -- decision gave the goods and the delivery (with the sign of the line)
      select x.n, -x.amount as amount,
             case when x.event = 'money.refund' then x."moneyUse" else c."moneyUse" end as hand_use,
             sign(-x.amount) * least(
               abs(x.amount),
               coalesce((
                 select sum(coalesce((e.value ->> 'amount')::numeric, (e.value ->> 'delivery')::numeric))
                 from jsonb_array_elements(
                   case when x.event = 'money.refund' then x.meta else c.meta end
                 ) as e (value)
               ), 0)
             ) as shared,
             sign(-x.amount) * least(
               abs(x.amount),
               coalesce((
                 select sum((e.value ->> 'delivery')::numeric)
                 from jsonb_array_elements(
                   case when x.event = 'money.refund' then x.meta else c.meta end
                 ) as e (value)
               ), 0)
             ) as delivery
      from lines as x
      left join cartlify.money_log as c on c.id = x."coversId"
      where x.purpose = 'hand'::cartlify."MoneyPurpose" and not x.is_late
        and x.event not in ('money.received', 'money.share_moved')
    ),
    hands as (
      select n,
             sum(amount - shared) filter (where hand_use = 'compensation'::cartlify."MoneyUse")
               as compensations,
             sum(shared) filter (where hand_use is not null) as coverage,
             sum(amount) filter (where hand_use is null) as undecided,
             sum(delivery) filter (where hand_use is not null) as delivery
      from hand
      group by n
    ),
    used as (
      select x.n,
             sum(x.amount) filter (where s.purpose = 'dispute'::cartlify."MoneyPurpose") as dispute,
             sum(x.amount) filter (where s.purpose = 'hand'::cartlify."MoneyPurpose") as hand,
             sum(x.amount) filter (
               where s.purpose = 'dispute'::cartlify."MoneyPurpose"
                 and coalesce((case when x.event = 'money.refund_failed' then p.meta else x.meta end) -> 0 ->> 'orderItemId', '') = ''
             ) as dispute_delivery,
             sum(x.amount) filter (
               where s.purpose = 'hand'::cartlify."MoneyPurpose"
                 and coalesce((case when x.event = 'money.refund_failed' then p.meta else x.meta end) -> 0 ->> 'orderItemId', '') = ''
             ) as hand_delivery
      from lines as x
      left join cartlify.money_log as p on p.id = x."coversId"
      join cartlify.money_log as s
        on s.id = case when x.event = 'money.refund_failed' then p."coversId" else x."coversId" end
      where x.purpose = 'return'::cartlify."MoneyPurpose"
        and x.part = 'covered'::cartlify."MoneyPart"
      group by x.n
    ),
    lates as (
      select n,
             sum(amount) filter (where event = 'money.late_payment') as received,
             -sum(amount) filter (where event <> 'money.late_payment') as refunded
      from lines
      where is_late
      group by n
    ),
    comps as (
      select n, -sum(amount) as given
      from lines
      where purpose = 'compensation'::cartlify."MoneyPurpose"
      group by n
    ),
    receipts as (
      select n,
             sum(amount) filter (where purpose <> 'shipping'::cartlify."MoneyPurpose") as buyers,
             sum(amount) filter (where purpose = 'shipping'::cartlify."MoneyPurpose") as carriers
      from lines
      where event = 'money.received'
      group by n
    ),
    shares as (
      select n,
             sum((
               select coalesce(sum((e.value ->> 'amount')::numeric), 0)
               from jsonb_array_elements(coalesce(meta, '[]'::jsonb)) as e (value)
               where coalesce(e.value ->> 'orderItemId', '') <> ''
             )) filter (where event = 'money.share_moved') as moved_goods,
             sum(amount) filter (
               where event = 'money.received' and coalesce(meta -> 0 ->> 'orderItemId', '') = ''
             ) as received_delivery
      from lines
      where event in ('money.received', 'money.share_moved')
        and purpose in ('hand'::cartlify."MoneyPurpose", 'dispute'::cartlify."MoneyPurpose")
      group by n
    )
    select b.n,
           coalesce(disputes.withdrawn, 0) as dispute_withdrawn,
           coalesce(disputes.reinstated, 0) as dispute_reinstated,
           coalesce(used.dispute, 0) as dispute_used,
           coalesce(disputes.undecided, 0) as dispute_undecided,
           coalesce(hands.compensations, 0) as hand_compensations,
           coalesce(hands.coverage, 0) as hand_coverage,
           coalesce(hands.undecided, 0) as hand_undecided,
           coalesce(used.hand, 0) as hand_used,
           coalesce(lates.received, 0) as late_received,
           coalesce(lates.refunded, 0) as late_refunded,
           coalesce(comps.given, 0) as compensations_given,
           coalesce(receipts.buyers, 0) as received_buyers,
           coalesce(receipts.carriers, 0) as received_carriers,
           coalesce(disputes.goods, 0) as dispute_goods,
           coalesce(used.dispute_delivery, 0) as dispute_delivery_used,
           coalesce(hands.delivery, 0) as hand_delivery,
           coalesce(used.hand_delivery, 0) as hand_delivery_used,
           coalesce(shares.moved_goods, 0) as shares_moved_goods,
           coalesce(shares.received_delivery, 0) as received_share_delivery
    from steps as b
    left join disputes on disputes.n = b.n
    left join hands on hands.n = b.n
    left join used on used.n = b.n
    left join lates on lates.n = b.n
    left join comps on comps.n = b.n
    left join receipts on receipts.n = b.n
    left join shares on shares.n = b.n
    order by b.n
  `;
}

// the payments past the statements of a row as the answers give them: the decimals, not the
// floats. What each left is its effect on the money of the shop: below 0 the shop is without it
export function paymentsMoneyOf(row: PaymentsColumns): AdminPaymentsMoneyDto {
  const withdrawn = dec(row.dispute_withdrawn);
  const reinstated = dec(row.dispute_reinstated);
  const disputeUsed = dec(row.dispute_used);
  const compensations = dec(row.hand_compensations);
  const coverage = dec(row.hand_coverage);
  const undecided = dec(row.hand_undecided);
  const handUsed = dec(row.hand_used);
  const handRefunded = compensations.plus(coverage).plus(undecided);
  const received = dec(row.late_received);
  const lateRefunded = dec(row.late_refunded);
  const given = dec(row.compensations_given);
  const fromBuyers = dec(row.received_buyers);
  const fromCarriers = dec(row.received_carriers);

  return {
    disputes: {
      withdrawn: money(withdrawn),
      reinstated: money(reinstated),
      used: money(disputeUsed),
      undecided: money(dec(row.dispute_undecided)),
      result: money(reinstated.minus(withdrawn).plus(disputeUsed)),
    },
    handRefunds: {
      refunded: money(handRefunded),
      compensations: money(compensations),
      coverage: money(coverage),
      undecided: money(undecided),
      used: money(handUsed),
      result: money(handUsed.minus(handRefunded)),
    },
    latePayments: {
      received: money(received),
      refunded: money(lateRefunded),
      result: money(received.minus(lateRefunded)),
    },
    // what went out, below 0 for the shop (never -0)
    compensations: { given: money(given), result: money(new Prisma.Decimal(0).minus(given)) },
    received: {
      buyers: money(fromBuyers),
      carriers: money(fromCarriers),
      result: money(fromBuyers.plus(fromCarriers)),
    },
  };
}

// what the disputes, the refunds by hand and the compensations cost the shop in the period past the
// returns of the goods and the delivery: what the bank kept and what went out by hand, less what
// the decisions gave the goods (the report by product counts it as their return, in the period of
// the line) and less what the parts covered took for the delivery (the delivery report counts it
// when a statement takes it), with what went out as compensations, less what carriers paid the
// shop. The money buyers gave back is in the report by product (it comes off their returns), but for
// what they gave back of a share of the delivery; what root gave up of an overpaid share of the
// goods is no more their return but a loss or a compensation
const otherRefundsOf = (row: PaymentsColumns) =>
  dec(row.dispute_withdrawn)
    .minus(dec(row.dispute_reinstated))
    .minus(dec(row.dispute_goods))
    .minus(dec(row.dispute_delivery_used))
    .plus(dec(row.hand_compensations))
    .plus(dec(row.hand_delivery))
    .plus(dec(row.hand_undecided))
    .minus(dec(row.hand_delivery_used))
    .plus(dec(row.compensations_given))
    .minus(dec(row.received_carriers))
    .plus(dec(row.shares_moved_goods))
    .minus(dec(row.received_share_delivery));

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
// carriers for, what the disputes and the refunds made by hand cost past the statements, together),
// and what each income left (the items less their cost, the delivery less the sends, all the income
// less all the expenses). The delivery and the payments are of the whole shop: without them (a
// report of some products) their parts are none and the totals are of the items. A payment the order
// could not take is the money of the buyer until it goes back, never an income
export function summaryOf(parts: {
  itemsRevenue: Prisma.Decimal.Value;
  itemsCost: Prisma.Decimal.Value;
  writeOffs: Prisma.Decimal.Value;
  delivery: DeliveryColumns | null;
  payments: PaymentsColumns | null;
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

  const otherRefunds = parts.payments ? otherRefundsOf(parts.payments) : null;

  const income = items.plus(delivery ?? 0);
  const expenses = cost
    .plus(writtenOff)
    .plus(shipping ?? 0)
    .plus(otherRefunds ?? 0);

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
      otherRefunds: otherRefunds === null ? null : money(otherRefunds),
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
