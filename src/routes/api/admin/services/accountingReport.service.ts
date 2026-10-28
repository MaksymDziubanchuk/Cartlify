import { Prisma } from '@prisma/client';

import { tx } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { shopCurrency } from '@routes/api/payments/providers/index.js';

import { STOCK_SOURCES, money, summarizeWriteOffs } from './helpers/accountingReport.helper.js';
import {
  NOT_CANCELLED,
  assertCategory,
  deliveryMoneyOf,
  deliveryOfPeriodSql,
  isWholeShop,
  scopeCtes,
  summaryOf,
  utcTime,
  type DeliveryColumns,
  type ReportScope,
} from './helpers/accountingSql.helper.js';

import type {
  AdminAccountingDto,
  AdminMoneySummaryDto,
  AdminSalesDto,
  GetAdminAccountingResponseDto,
} from 'types/dto/admin.dto.js';

// the accounting of a period [from, to), of the products of the scope (all of them, the ids asked
// for, a category with its branch or its own products only):
//  - a sale counts from the time it was paid (orders.paidAt), at the prices it was paid with, and
//    costs what the batches it took cost (order_batch_allocations); an order cancelled later is no
//    sale any more, the report of the period it was paid in changes with the cancel;
//  - a cancel is told apart at the time of the cancel (orders.cancelledAt), in no margin;
//  - what came in is the batches taken in during the period, by source;
//  - what was written off is in the lines of the admin log (STOCK_WRITE_OFF), at the costs of the
//    batches it took;
//  - the stock is what the batches have left now, whatever the period;
//  - the delivery is of the whole shop, of no product: what the orders paid in the period paid for
//    it, what went back with the cancels, what the sends cost (by the time they were sent). A report
//    of some products or of a category has none.
// Everything is read from one snapshot, in the money of the shop

type Totals = { orders: number; units: bigint | number; revenue: Prisma.Decimal | null };

type Period = { from: Date; to: Date };

// the orders with a time in the period, their items and the cost of what they took: the sales
// (paid in the period and not cancelled) or the cancels (cancelled in it)
async function ordersOf(
  db: Prisma.TransactionClient,
  scope: Prisma.Sql,
  { from, to }: Period,
  column: 'paidAt' | 'cancelledAt',
) {
  const time = Prisma.raw(`o."${column}"`);
  const sales = column === 'paidAt' ? Prisma.sql`and ${NOT_CANCELLED}` : Prisma.empty;

  const [totals] = await db.$queryRaw<Totals[]>`
    ${scope}
    select count(distinct o.id)::int as orders,
           coalesce(sum(oi.quantity), 0)::bigint as units,
           coalesce(sum(oi."totalPrice"), 0) as revenue
    from cartlify.orders as o
    join cartlify.order_items as oi on oi."orderId" = o.id
    where ${time} >= ${utcTime(from)} and ${time} < ${utcTime(to)} ${sales}
      and oi."productId" in (select id from scope)
  `;
  const [cost] = await db.$queryRaw<{ cost: Prisma.Decimal | null }[]>`
    ${scope}
    select coalesce(sum(a.quantity * b."unitCost"), 0) as cost
    from cartlify.order_batch_allocations as a
    join cartlify.orders as o on o.id = a."orderId"
    join cartlify.product_batches as b on b.id = a."batchId"
    where ${time} >= ${utcTime(from)} and ${time} < ${utcTime(to)} ${sales}
      and a."productId" in (select id from scope)
  `;

  return {
    orders: totals?.orders ?? 0,
    units: Number(totals?.units ?? 0),
    revenue: new Prisma.Decimal(totals?.revenue ?? 0),
    cost: new Prisma.Decimal(cost?.cost ?? 0),
  };
}

// the lines of the admin log of the units written off in the period, of the products of the scope
const writeOffLinesOf = (db: Prisma.TransactionClient, scope: Prisma.Sql, { from, to }: Period) =>
  db.$queryRaw<{ meta: unknown }[]>`
    ${scope}
    select l.meta
    from cartlify.admin_audit_log as l
    where l.action = 'STOCK_WRITE_OFF'::cartlify."AdminAuditAction"
      and l."createdAt" >= ${utcTime(from)} and l."createdAt" < ${utcTime(to)}
      and l."entityType" = 'product'::cartlify."AdminAuditEntityType"
      and l."entityId" in (select id from scope)
    order by l.id
  `;

// the income, the expenses and the margins of the whole shop in a period, read in the transaction
// given: the statistics read them in their own snapshot, so their numbers are the ones of the report
export async function shopMoneyOf(
  db: Prisma.TransactionClient,
  period: Period,
): Promise<AdminMoneySummaryDto> {
  const scope = scopeCtes({ branch: true } satisfies ReportScope);
  const sales = await ordersOf(db, scope, period, 'paidAt');
  const writeOffs = summarizeWriteOffs(
    (await writeOffLinesOf(db, scope, period)).map((line) => line.meta),
  );
  const [delivery] = await db.$queryRaw<DeliveryColumns[]>(
    deliveryOfPeriodSql(period.from, period.to),
  );

  return summaryOf({
    itemsRevenue: sales.revenue,
    itemsCost: sales.cost,
    writeOffs: writeOffs.value,
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

      const sales = await ordersOf(db, scope, dto, 'paidAt');
      const cancellations = await ordersOf(db, scope, dto, 'cancelledAt');

      const purchases = await db.$queryRaw<
        { source: string; units: bigint; value: Prisma.Decimal }[]
      >`
        ${scope}
        select b.source::text as source,
               sum(b.quantity)::bigint as units,
               sum(b.quantity * b."unitCost") as value
        from cartlify.product_batches as b
        where b."createdAt" >= ${utcTime(from)} and b."createdAt" < ${utcTime(to)}
          and b."productId" in (select id from scope)
        group by b.source
      `;

      const writeOffLines = await writeOffLinesOf(db, scope, dto);

      const [stock] = await db.$queryRaw<{ units: bigint; value: Prisma.Decimal | null }[]>`
        ${scope}
        select coalesce(sum(b.remaining), 0)::bigint as units,
               coalesce(sum(b.remaining * b."unitCost"), 0) as value
        from cartlify.product_batches as b
        where b."productId" in (select id from scope)
      `;

      const [delivery] = isWholeShop(dto)
        ? await db.$queryRaw<DeliveryColumns[]>(deliveryOfPeriodSql(from, to))
        : [];

      return { sales, cancellations, purchases, writeOffLines, stock, delivery };
    },
    // the sections come from one snapshot of the tables
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 15_000 },
  );

  const { sales, cancellations } = read;
  const salesDto: AdminSalesDto = {
    orders: sales.orders,
    units: sales.units,
    revenue: money(sales.revenue),
    cost: money(sales.cost),
    margin: money(sales.revenue.minus(sales.cost)),
  };
  const writeOffs = summarizeWriteOffs(read.writeOffLines.map((line) => line.meta));

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

  return {
    period: { from, to },
    currency: shopCurrency(),
    sales: salesDto,
    cancellations: {
      orders: cancellations.orders,
      units: cancellations.units,
      revenue: money(cancellations.revenue),
      cost: money(cancellations.cost),
    },
    summary: summaryOf({
      itemsRevenue: sales.revenue,
      itemsCost: sales.cost,
      writeOffs: writeOffs.value,
      delivery: read.delivery ?? null,
    }),
    purchases: {
      units: read.purchases.reduce((sum, line) => sum + Number(line.units), 0),
      value: money(purchasesValue),
      bySource,
    },
    writeOffs,
    stock: {
      units: Number(read.stock?.units ?? 0),
      value: money(new Prisma.Decimal(read.stock?.value ?? 0)),
    },
    delivery: read.delivery ? deliveryMoneyOf(read.delivery) : null,
  };
}
