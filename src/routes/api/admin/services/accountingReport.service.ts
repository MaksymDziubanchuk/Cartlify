import { Prisma } from '@prisma/client';

import { tx } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { shopCurrency } from '@routes/api/payments/providers/index.js';

import {
  RETURN_KINDS,
  STOCK_SOURCES,
  money,
  summarizeWriteOffs,
} from './helpers/accountingReport.helper.js';
import {
  LOG_BATCHES,
  MONEY_SUMS,
  assertCategory,
  deliveryMoneyOf,
  deliveryOfPeriodSql,
  isWholeShop,
  moneyOf,
  productRowsCtes,
  scopeCtes,
  summaryOf,
  utcTime,
  type DeliveryColumns,
  type MoneyColumns,
  type ReportScope,
} from './helpers/accountingSql.helper.js';

import type {
  AdminAccountingDto,
  AdminMoneySummaryDto,
  GetAdminAccountingResponseDto,
} from 'types/dto/admin.dto.js';

// the accounting of a period [from, to), of the variants of the scope (all of them, the products
// or the variants asked for, a category with its branch or its own products only). Every event is
// in the period it happened in, and a period is never changed by what happens after it:
//  - a sale counts from the time it was paid (orders.paidAt), at the prices it was paid with, and
//    costs what the batches it took cost (order_batch_allocations), cancelled later or not;
//  - a return counts from the time its money went back (return_items.refundedAt): the money of the
//    units, and what the units that came back cost (the lines stock.return of the stock log); told
//    apart by the kind of the statement. The sales less the returns are the net;
//  - what came in is the batches taken in during the period, by source;
//  - what was written off is in the lines of the stock log (stock.write_off, of the variant, and
//    stock.return_write_off, of the goods that came back and went out at once), at the costs of the
//    batches it took;
//  - the stock is read from the stock log: at the start of the period, what came in, what went
//    out, at the end; apart, the units sold whose goods are on their way back;
//  - the delivery is of the whole shop, of no product: what the orders paid in the period paid for
//    it, what went back with the returns, what the sends cost (by the time they were sent). A
//    report of some products or variants or of a category has none.
// Everything is read from one snapshot, in the money of the shop

type Period = { from: Date; to: Date };

// the money of the variants of the scope, added up: one row of MoneyColumns
async function totalsOf(db: Prisma.TransactionClient, scope: ReportScope, { from, to }: Period) {
  const [row] = await db.$queryRaw<MoneyColumns[]>`
    ${productRowsCtes(scope, from, to)}
    select ${MONEY_SUMS} from report_rows
  `;
  return row!;
}

// how many orders were paid in the period, of the scope
async function paidOrdersOf(db: Prisma.TransactionClient, scope: Prisma.Sql, { from, to }: Period) {
  const [row] = await db.$queryRaw<{ orders: number }[]>`
    ${scope}
    select count(distinct o.id)::int as orders
    from cartlify.orders as o
    join cartlify.order_items as oi on oi."orderId" = o.id
    where o."paidAt" >= ${utcTime(from)} and o."paidAt" < ${utcTime(to)}
      and oi."variantId" in (select id from scope)
  `;
  return row?.orders ?? 0;
}

type ReturnKindRow = {
  kind: string;
  orders: number;
  units: bigint;
  revenue: Prisma.Decimal;
  cost: Prisma.Decimal | null;
};

// the kind of a statement: one of withdrawal is the right of withdrawal whatever reason an admin
// gave it (a parcel refused is its own kind), any other is the reason an admin gave
const KIND_OF_STATEMENT = Prisma.sql`case
      when r.basis = 'withdrawal' and r.reason is distinct from 'refused' then 'withdrawal'
      else coalesce(r.reason::text, 'withdrawal')
    end`;

// the rows of the statements whose money went back in the period, of the scope, by the kind of
// the statement. The cost of the units that came back is booked in the period the money has gone
// back and the units are in, the later of the two (the same rule as in the rows of the report, so
// the kinds add up)
async function returnsByKindOf(
  db: Prisma.TransactionClient,
  scope: Prisma.Sql,
  { from, to }: Period,
) {
  const money = await db.$queryRaw<Omit<ReturnKindRow, 'cost'>[]>`
    ${scope}
    select ${KIND_OF_STATEMENT} as kind,
           count(distinct r."orderId")::int as orders,
           sum(ri.quantity)::bigint as units,
           sum(ri.amount) as revenue
    from cartlify.return_items as ri
    join cartlify.returns as r on r.id = ri."returnId"
    join cartlify.order_items as oi on oi.id = ri."orderItemId"
    where ri.money = 'refunded'
      and ri."refundedAt" >= ${utcTime(from)} and ri."refundedAt" < ${utcTime(to)}
      and oi."variantId" in (select id from scope)
    group by 1
  `;
  const costs = await db.$queryRaw<{ kind: string; cost: Prisma.Decimal | null }[]>`
    ${scope}
    select ${KIND_OF_STATEMENT} as kind,
           sum((e->>'quantity')::int * (e->>'unitCost')::numeric) as cost
    from cartlify.return_items as ri
    join cartlify.returns as r on r.id = ri."returnId"
    join cartlify.order_items as oi on oi.id = ri."orderItemId"
    join cartlify.stock_log as l on l."returnItemId" = ri.id and l.event = 'stock.return'
    ${LOG_BATCHES}
    where ri.money = 'refunded'
      and greatest(ri."refundedAt", l."createdAt") >= ${utcTime(from)}
      and greatest(ri."refundedAt", l."createdAt") < ${utcTime(to)}
      and oi."variantId" in (select id from scope)
    group by 1
  `;
  const [all] = await db.$queryRaw<{ orders: number }[]>`
    ${scope}
    select count(distinct r."orderId")::int as orders
    from cartlify.return_items as ri
    join cartlify.returns as r on r.id = ri."returnId"
    join cartlify.order_items as oi on oi.id = ri."orderItemId"
    where ri.money = 'refunded'
      and ri."refundedAt" >= ${utcTime(from)} and ri."refundedAt" < ${utcTime(to)}
      and oi."variantId" in (select id from scope)
  `;

  // a kind has its money in the period of the refund and its cost in the period of the later of
  // the refund and the goods: it may have only one of them in this period
  const kinds = new Set([...money.map((row) => row.kind), ...costs.map((row) => row.kind)]);
  const rows: ReturnKindRow[] = [...kinds].map((kind) => {
    const one = money.find((row) => row.kind === kind);
    return {
      kind,
      orders: one?.orders ?? 0,
      units: one?.units ?? 0n,
      revenue: one?.revenue ?? new Prisma.Decimal(0),
      cost: costs.find((row) => row.kind === kind)?.cost ?? null,
    };
  });

  return { rows, orders: all?.orders ?? 0 };
}

// the lines of the stock log of the units written off in the period, of the variants of the scope
const writeOffLinesOf = (db: Prisma.TransactionClient, scope: Prisma.Sql, { from, to }: Period) =>
  db.$queryRaw<{ meta: unknown }[]>`
    ${scope}
    select l.meta
    from cartlify.stock_log as l
    where l.event = 'stock.write_off'
      and l."createdAt" >= ${utcTime(from)} and l."createdAt" < ${utcTime(to)}
      and l."variantId" in (select id from scope)
    order by l.id
  `;

// the units that came back with a statement and went out of the stock at once, in the period
async function returnWriteOffsOf(
  db: Prisma.TransactionClient,
  scope: Prisma.Sql,
  { from, to }: Period,
) {
  const [row] = await db.$queryRaw<{ units: bigint | null; value: Prisma.Decimal | null }[]>`
    ${scope}
    select sum((e->>'quantity')::int)::bigint as units,
           sum((e->>'quantity')::int * (e->>'unitCost')::numeric) as value
    from cartlify.stock_log as l
    ${LOG_BATCHES}
    where l.event = 'stock.return_write_off'
      and l."createdAt" >= ${utcTime(from)} and l."createdAt" < ${utcTime(to)}
      and l."variantId" in (select id from scope)
  `;
  return { units: Number(row?.units ?? 0), value: new Prisma.Decimal(row?.value ?? 0) };
}

// the income, the expenses and the margins of the whole shop in a period, read in the transaction
// given: the statistics read them in their own snapshot, so their numbers are the ones of the report
export async function shopMoneyOf(
  db: Prisma.TransactionClient,
  period: Period,
): Promise<AdminMoneySummaryDto> {
  const totals = await totalsOf(db, { branch: true } satisfies ReportScope, period);
  const [delivery] = await db.$queryRaw<DeliveryColumns[]>(
    deliveryOfPeriodSql(period.from, period.to),
  );

  return summaryOf({
    itemsRevenue: new Prisma.Decimal(totals.sold_revenue).minus(totals.returned_revenue),
    itemsCost: new Prisma.Decimal(totals.sold_cost).minus(totals.returned_cost),
    writeOffs: totals.written_value,
    delivery: delivery ?? null,
  });
}

export async function buildAccountingReport(
  dto: AdminAccountingDto,
): Promise<GetAdminAccountingResponseDto> {
  const { from, to } = dto;
  const scope = scopeCtes(dto);
  const zero = new Prisma.Decimal(0);

  const read = await tx(
    async (db) => {
      await setUserContext(db, { userId: dto.actorId, role: dto.actorRole });
      await assertCategory(db, dto.categoryId);

      const totals = await totalsOf(db, dto, dto);
      const salesOrders = await paidOrdersOf(db, scope, dto);
      const returns = await returnsByKindOf(db, scope, dto);

      const purchases = await db.$queryRaw<
        { source: string; units: bigint; value: Prisma.Decimal }[]
      >`
        ${scope}
        select b.source::text as source,
               sum(b.quantity)::bigint as units,
               sum(b.quantity * b."unitCost") as value
        from cartlify.product_batches as b
        where b."createdAt" >= ${utcTime(from)} and b."createdAt" < ${utcTime(to)}
          and b."variantId" in (select id from scope)
        group by b.source
      `;

      const writeOffLines = await writeOffLinesOf(db, scope, dto);
      const returnWriteOffs = await returnWriteOffsOf(db, scope, dto);

      const [delivery] = isWholeShop(dto)
        ? await db.$queryRaw<DeliveryColumns[]>(deliveryOfPeriodSql(from, to))
        : [];

      return { totals, salesOrders, returns, purchases, writeOffLines, returnWriteOffs, delivery };
    },
    // the sections come from one snapshot of the tables
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 15_000 },
  );

  const { totals } = read;
  const breakdown = moneyOf(totals);
  const writeOffs = summarizeWriteOffs(
    read.writeOffLines.map((line) => line.meta),
    read.returnWriteOffs,
  );

  const bySource = Object.fromEntries(
    STOCK_SOURCES.map((source) => {
      const row = read.purchases.find((line) => line.source === source);
      return [
        source,
        {
          units: Number(row?.units ?? 0),
          value: money(new Prisma.Decimal(row?.value ?? 0)),
        },
      ];
    }),
  ) as GetAdminAccountingResponseDto['purchases']['bySource'];
  const purchasesValue = read.purchases.reduce(
    (sum, line) => sum.plus(new Prisma.Decimal(line.value)),
    zero,
  );

  // the kinds of a return, each once, the ones without a return as zeros
  const byKind = Object.fromEntries(
    RETURN_KINDS.map((kind) => {
      const row = read.returns.rows.find((line) => line.kind === kind);
      return [
        kind,
        {
          units: Number(row?.units ?? 0),
          revenue: money(new Prisma.Decimal(row?.revenue ?? 0)),
          cost: money(new Prisma.Decimal(row?.cost ?? 0)),
        },
      ];
    }),
  ) as GetAdminAccountingResponseDto['returns']['byKind'];

  return {
    period: { from, to },
    currency: shopCurrency(),
    sales: { orders: read.salesOrders, ...withoutPercent(breakdown.sales) },
    returns: { orders: read.returns.orders, ...breakdown.returns, byKind },
    net: breakdown.net,
    summary: summaryOf({
      itemsRevenue: new Prisma.Decimal(totals.sold_revenue).minus(totals.returned_revenue),
      itemsCost: new Prisma.Decimal(totals.sold_cost).minus(totals.returned_cost),
      writeOffs: totals.written_value,
      delivery: read.delivery ?? null,
    }),
    purchases: {
      units: read.purchases.reduce((sum, line) => sum + Number(line.units), 0),
      value: money(purchasesValue),
      bySource,
    },
    writeOffs,
    stock: breakdown.stock,
    delivery: read.delivery ? deliveryMoneyOf(read.delivery) : null,
  };
}

// the sales of the accounting report have no percent
function withoutPercent(sales: ReturnType<typeof moneyOf>['sales']) {
  const { marginPercent: _percent, ...rest } = sales;
  return rest;
}
