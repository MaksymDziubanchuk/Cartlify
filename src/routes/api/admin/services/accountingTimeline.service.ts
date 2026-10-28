import { Prisma } from '@prisma/client';

import { tx } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import env from '@config/env.js';
import { toCsv, type CsvColumn } from '@helpers/csv.js';
import { shopCurrency } from '@routes/api/payments/providers/index.js';
import { BadRequestError } from '@utils/errors.js';

import { sortRows } from './helpers/accountingReport.helper.js';
import {
  csvFileName,
  deliveryCsvColumns,
  moneyCsvColumns,
  summaryCsvColumns,
} from './helpers/accountingCsv.helper.js';
import {
  NOT_CANCELLED,
  assertCategory,
  deliveryMoneyOf,
  deliveryOfStepsSql,
  isWholeShop,
  moneyOf,
  scopeCtes,
  summaryOf,
  type DeliveryColumns,
  type MoneyColumns,
  type ReportScope,
} from './helpers/accountingSql.helper.js';

import type {
  AdminReportStep,
  AdminReportStepRowDto,
  AdminReportSortOrder,
  AdminTimelineSortBy,
  GetAdminReportTimelineResponseDto,
} from 'types/dto/admin.dto.js';
import type { Role } from 'types/user.js';
import type { UserId } from 'types/ids.js';

// the money of a period step by step: the days, the weeks from monday or the months of the
// calendar of the shop (SHOP_TIME_ZONE), the first and the last step cut to the period. Without
// a start the period is the step of its end and the eleven before it

export const MAX_REPORT_STEPS = 400;

const LABEL: Record<AdminReportStep, string> = {
  day: 'YYYY-MM-DD',
  week: 'YYYY-MM-DD',
  month: 'YYYY-MM',
};

type Step = { label: string; from: Date; to: Date };

export type AccountingTimelineArgs = ReportScope & {
  actorId: UserId;
  actorRole: Role;
  from?: Date | undefined;
  to: Date;
  step: AdminReportStep;
  sortBy: AdminTimelineSortBy;
  sortOrder: AdminReportSortOrder;
};

// the steps of the period by the calendar of the shop, from the start of the step of its start;
// each step is cut to the period. Without a start the period is the step of its last moment and
// the eleven before it: an end at the start of a month ends the month before it. At most one step
// over the limit is made, a typo in a year asks for millions of days
async function stepsOf(db: Prisma.TransactionClient, args: AccountingTimelineArgs) {
  const zone = env.SHOP_TIME_ZONE;
  const interval = `1 ${args.step}`;
  const from = args.from ? args.from.toISOString() : null;

  return db.$queryRaw<Step[]>`
    with bounds as (
      select coalesce(
               ${from}::timestamptz,
               (date_trunc(
                  ${args.step},
                  (${args.to.toISOString()}::timestamptz - interval '1 microsecond') at time zone ${zone}
                ) - ${interval}::interval * 11) at time zone ${zone}
             ) as f,
             ${args.to.toISOString()}::timestamptz as t
    ),
    series as (
      select gs as local_start
      from bounds,
           generate_series(
             date_trunc(${args.step}, bounds.f at time zone ${zone}),
             bounds.t at time zone ${zone},
             ${interval}::interval
           ) as gs
      where gs < bounds.t at time zone ${zone}
      limit ${MAX_REPORT_STEPS + 1}
    )
    select to_char(s.local_start, ${LABEL[args.step]}) as label,
           greatest(b.f, s.local_start at time zone ${zone}) as "from",
           least(b.t, (s.local_start + ${interval}::interval) at time zone ${zone}) as "to"
    from series as s, bounds as b
    order by s.local_start
  `;
}

type StepMoney = MoneyColumns & { n: bigint };

// the money of each step: the products of the scope, a step by its number
async function moneyOfSteps(db: Prisma.TransactionClient, scope: ReportScope, steps: Step[]) {
  const froms = steps.map((step) => step.from.toISOString());
  const tos = steps.map((step) => step.to.toISOString());

  const inStep = (column: Prisma.Sql) => Prisma.sql`${column} >= b.f and ${column} < b.t`;

  // a sale is an order paid in the step and not cancelled, a cancel one cancelled in it
  const orderLines = (column: 'paidAt' | 'cancelledAt', name: string) => {
    const time = Prisma.raw(`o."${column}"`);
    const sales = column === 'paidAt' ? Prisma.sql`and ${NOT_CANCELLED}` : Prisma.empty;
    return Prisma.sql`
      ${Prisma.raw(name)} as (
        select b.n, sum(oi.quantity)::bigint as units, sum(oi."totalPrice") as revenue
        from steps as b
        join cartlify.orders as o on ${inStep(time)} ${sales}
        join cartlify.order_items as oi on oi."orderId" = o.id
        where oi."productId" in (select id from scope)
        group by b.n
      ),
      ${Prisma.raw(`${name}_cost`)} as (
        select b.n, sum(a.quantity * pb."unitCost") as cost
        from steps as b
        join cartlify.orders as o on ${inStep(time)} ${sales}
        join cartlify.order_batch_allocations as a on a."orderId" = o.id
        join cartlify.product_batches as pb on pb.id = a."batchId"
        where a."productId" in (select id from scope)
        group by b.n
      )
    `;
  };

  return db.$queryRaw<StepMoney[]>`
    ${scopeCtes(scope)},
    steps as (
      select x.f at time zone 'UTC' as f, x.t at time zone 'UTC' as t, x.n
      from unnest(${froms}::timestamptz[], ${tos}::timestamptz[]) with ordinality as x(f, t, n)
    ),
    ${orderLines('paidAt', 'sold')},
    ${orderLines('cancelledAt', 'cancelled')},
    written as (
      select b.n,
             sum((e->>'quantity')::int)::bigint as units,
             sum((e->>'quantity')::int * (e->>'unitCost')::numeric) as value
      from steps as b
      join cartlify.admin_audit_log as l on ${inStep(Prisma.sql`l."createdAt"`)}
      cross join lateral jsonb_array_elements(l.meta) as c
      cross join lateral jsonb_array_elements(
        case when c->>'field' = 'batches' and jsonb_typeof(c->'new') = 'array'
             then c->'new' else '[]'::jsonb end
      ) as e
      where l.action = 'STOCK_WRITE_OFF'::cartlify."AdminAuditAction"
        and l."entityType" = 'product'::cartlify."AdminAuditEntityType"
        and l."entityId" in (select id from scope)
      group by b.n
    ),
    bought as (
      select b.n, sum(pb.quantity)::bigint as units, sum(pb.quantity * pb."unitCost") as value
      from steps as b
      join cartlify.product_batches as pb on ${inStep(Prisma.sql`pb."createdAt"`)}
      where pb."productId" in (select id from scope)
      group by b.n
    )
    select b.n,
           coalesce(sold.units, 0)::bigint as sold_units,
           coalesce(sold.revenue, 0) as sold_revenue,
           coalesce(sold_cost.cost, 0) as sold_cost,
           coalesce(cancelled.units, 0)::bigint as cancelled_units,
           coalesce(cancelled.revenue, 0) as cancelled_revenue,
           coalesce(cancelled_cost.cost, 0) as cancelled_cost,
           coalesce(written.units, 0)::bigint as written_units,
           coalesce(written.value, 0) as written_value,
           coalesce(bought.units, 0)::bigint as bought_units,
           coalesce(bought.value, 0) as bought_value
    from steps as b
    left join sold on sold.n = b.n
    left join sold_cost on sold_cost.n = b.n
    left join cancelled on cancelled.n = b.n
    left join cancelled_cost on cancelled_cost.n = b.n
    left join written on written.n = b.n
    left join bought on bought.n = b.n
    order by b.n
  `;
}

const SORT_VALUE: Record<
  AdminTimelineSortBy,
  (row: AdminReportStepRowDto & { id: number }) => number
> = {
  period: (row) => row.id,
  revenue: (row) => row.sales.revenue,
  margin: (row) => row.sales.margin,
  units: (row) => row.sales.units,
  marginAfterWriteOffs: (row) => row.afterWriteOffs.margin,
  marginTotal: (row) => row.summary.margin.total,
  writeOffs: (row) => row.writeOffs.value,
  purchases: (row) => row.purchases.value,
};

export async function reportTimeline(
  args: AccountingTimelineArgs,
): Promise<GetAdminReportTimelineResponseDto> {
  const { steps, money, delivery } = await tx(
    async (db) => {
      await setUserContext(db, { userId: args.actorId, role: args.actorRole });
      await assertCategory(db, args.categoryId);

      const steps = await stepsOf(db, args);
      if (steps.length > MAX_REPORT_STEPS) {
        throw new BadRequestError('REPORT_PERIOD_TOO_LONG', { maxSteps: MAX_REPORT_STEPS });
      }

      const money = steps.length ? await moneyOfSteps(db, args, steps) : [];
      // the delivery is of the whole shop: a report of some products or of a category has none
      const delivery =
        steps.length && isWholeShop(args)
          ? await db.$queryRaw<(DeliveryColumns & { n: bigint })[]>(deliveryOfStepsSql(steps))
          : [];

      return { steps, money, delivery };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 15_000 },
  );

  // the step number keeps the order of time for the sorts that go by money
  const rows = steps.map((step, index) => {
    const columns = money[index]!;
    const { sales, cancellations, writeOffs, afterWriteOffs, purchases } = moneyOf(columns);
    const stepDelivery = delivery[index] ?? null;
    return {
      id: index,
      label: step.label,
      period: { from: step.from, to: step.to },
      sales,
      cancellations,
      writeOffs,
      afterWriteOffs,
      purchases,
      delivery: stepDelivery ? deliveryMoneyOf(stepDelivery) : null,
      summary: summaryOf({
        itemsRevenue: columns.sold_revenue,
        itemsCost: columns.sold_cost,
        writeOffs: columns.written_value,
        delivery: stepDelivery,
      }),
    };
  });

  const sorted = sortRows(rows, SORT_VALUE[args.sortBy], args.sortOrder);

  return {
    period: { from: steps[0]?.from ?? args.from ?? args.to, to: args.to },
    currency: shopCurrency(),
    step: args.step,
    timeZone: env.SHOP_TIME_ZONE,
    items: sorted.map((row) => ({
      label: row.label,
      period: row.period,
      sales: row.sales,
      cancellations: row.cancellations,
      writeOffs: row.writeOffs,
      afterWriteOffs: row.afterWriteOffs,
      purchases: row.purchases,
      delivery: row.delivery,
      summary: row.summary,
    })),
  };
}

type StepCsvRow = GetAdminReportTimelineResponseDto['items'][number];

const TIMELINE_CSV: CsvColumn<StepCsvRow>[] = [
  { header: 'step', kind: 'text', value: (row) => row.label },
  { header: 'from', kind: 'text', value: (row) => row.period.from.toISOString() },
  { header: 'to', kind: 'text', value: (row) => row.period.to.toISOString() },
  ...moneyCsvColumns<StepCsvRow>((row) => row, { stock: false }),
  ...deliveryCsvColumns<StepCsvRow>((row) => row.delivery),
  ...summaryCsvColumns<StepCsvRow>((row) => row.summary),
];

export async function reportTimelineCsv(args: AccountingTimelineArgs) {
  const report = await reportTimeline(args);

  return {
    fileName: csvFileName('timeline', report.period.from, report.period.to),
    body: toCsv(TIMELINE_CSV, report.items),
  };
}
