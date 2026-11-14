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
  paymentsMoneyOf,
  paymentsOfPeriodSql,
  productRowsCtes,
  scopeCtes,
  stepMoneyOfScopeCtes,
  summaryOf,
  utcTime,
  type DeliveryColumns,
  type MoneyColumns,
  type PaymentsColumns,
  type ReportScope,
} from './helpers/accountingSql.helper.js';

import type {
  AdminAccountingDto,
  AdminMoneySummaryDto,
  GetAdminAccountingResponseDto,
} from 'types/dto/admin.dto.js';

// the accounting of a period [from, to), of the variants of the scope (all of them, the products
// or the variants asked for, a category with its branch or its own products only). The money comes
// from the money journal by the time of its lines (accountingSql.helper.ts): every event is in the
// period it happened in, and a period is never changed by what happens after it:
//  - a sale counts from the time it was paid (the lines of the payment), at the prices it was paid
//    with, and costs what the batches it took cost (order_batch_allocations), cancelled later or
//    not;
//  - a return counts from the time its money was written (the parts goods of the transfers and of
//    the money sent outside the app; a failure gives it back in its own period): the money of the
//    units, and what the units that came back cost (the lines stock.return of the stock log, when
//    the money and the goods are both back); told apart by the kind of the statement. The sales less
//    the returns are the net;
//  - what came in is the batches taken in during the period, by source;
//  - what was written off is in the lines of the stock log (stock.write_off, of the variant, and
//    stock.return_write_off, of the goods that came back and went out at once), at the costs of the
//    batches it took;
//  - the stock is read from the stock log: at the start of the period, what came in, what went
//    out, at the end; apart, the units sold whose goods are on their way back;
//  - the delivery is of the whole shop, of no product: what the orders paid in the period paid for
//    it, what went back with the returns, what the sends and the parcels back cost. A report of
//    some products or variants or of a category has none;
//  - so are the payments past the statements: the disputes, the refunds made by hand, the payments
//    the orders could not take.
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

// how many orders were paid in the period (the part goods of the payment written in it), of the
// scope
async function paidOrdersOf(db: Prisma.TransactionClient, scope: Prisma.Sql, { from, to }: Period) {
  const [row] = await db.$queryRaw<{ orders: number }[]>`
    ${scope}
    select count(distinct l."orderId")::int as orders
    from cartlify.money_log as l
    join cartlify.order_items as oi on oi."orderId" = l."orderId"
    where l.event = 'money.payment' and l.part = 'goods'::cartlify."MoneyPart"
      and l."createdAt" >= ${utcTime(from)} and l."createdAt" < ${utcTime(to)}
      and oi."variantId" in (select id from scope)
  `;
  return row?.orders ?? 0;
}

type ReturnKindRow = {
  kind: string;
  units: bigint;
  revenue: Prisma.Decimal;
  cost: Prisma.Decimal | null;
};

// the kind of a statement: one of withdrawal is the right of withdrawal whatever reason an admin
// gave it (a parcel refused is its own kind), any other is the reason an admin gave
const KIND_OF_STATEMENT = Prisma.sql`case
      when x.rid is null then 'other'
      when r.basis = 'withdrawal' and r.reason is distinct from 'refused' then 'withdrawal'
      else coalesce(r.reason::text, 'withdrawal')
    end`;

// the returns of the period, of the scope, by the kind of the statement: the money of the rows the
// lines of the money of the statements name (a failure below 0), and the cost of the units that came
// back, booked when the money has gone back and the units are in, the later of the two (the same
// ctes as the rows of the report, so the kinds add up); money already with the buyer for goods, of no
// statement, is of the kind other. orders counts the orders of the statements
// whose money went back in the period, less what failed in it
async function returnsByKindOf(
  db: Prisma.TransactionClient,
  scope: ReportScope,
  { from, to }: Period,
) {
  const ctes = stepMoneyOfScopeCtes(scope, [{ from, to }]);
  const money = await db.$queryRaw<Omit<ReturnKindRow, 'cost'>[]>`
    ${ctes}
    select ${KIND_OF_STATEMENT} as kind,
           sum(x.units)::bigint as units,
           sum(x.revenue) as revenue
    from returned_by_return as x
    left join cartlify.returns as r on r.id = x.rid
    group by 1
  `;
  const costs = await db.$queryRaw<{ kind: string; cost: Prisma.Decimal | null }[]>`
    ${ctes}
    select ${KIND_OF_STATEMENT} as kind, sum(x.cost) as cost
    from returned_cost_by_return as x
    join cartlify.returns as r on r.id = x.rid
    group by 1
  `;
  const [all] = await db.$queryRaw<{ orders: number }[]>`
    ${ctes}
    select count(distinct r."orderId")::int as orders
    from (
      select rid from returned_by_return group by rid having sum(revenue) > 0
    ) as x
    join cartlify.returns as r on r.id = x.rid
  `;

  // a kind has its money in the period of the refund and its cost in the period of the later of
  // the refund and the goods: it may have only one of them in this period
  const kinds = new Set([...money.map((row) => row.kind), ...costs.map((row) => row.kind)]);
  const rows: ReturnKindRow[] = [...kinds].map((kind) => {
    const one = money.find((row) => row.kind === kind);
    return {
      kind,
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
  const [payments] = await db.$queryRaw<PaymentsColumns[]>(
    paymentsOfPeriodSql(period.from, period.to),
  );

  return summaryOf({
    itemsRevenue: new Prisma.Decimal(totals.sold_revenue).minus(totals.returned_revenue),
    itemsCost: new Prisma.Decimal(totals.sold_cost).minus(totals.returned_cost),
    writeOffs: totals.written_value,
    delivery: delivery ?? null,
    payments: payments ?? null,
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
      const returns = await returnsByKindOf(db, dto, dto);

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
      const [payments] = isWholeShop(dto)
        ? await db.$queryRaw<PaymentsColumns[]>(paymentsOfPeriodSql(from, to))
        : [];

      return {
        totals,
        salesOrders,
        returns,
        purchases,
        writeOffLines,
        returnWriteOffs,
        delivery,
        payments,
      };
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
      payments: read.payments ?? null,
    }),
    purchases: {
      units: read.purchases.reduce((sum, line) => sum + Number(line.units), 0),
      value: money(purchasesValue),
      bySource,
    },
    writeOffs,
    stock: breakdown.stock,
    delivery: read.delivery ? deliveryMoneyOf(read.delivery) : null,
    payments: read.payments ? paymentsMoneyOf(read.payments) : null,
  };
}

// the sales of the accounting report have no percent
function withoutPercent(sales: ReturnType<typeof moneyOf>['sales']) {
  const { marginPercent: _percent, ...rest } = sales;
  return rest;
}
