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
  paymentsCsvColumns,
  summaryCsvColumns,
} from './helpers/accountingCsv.helper.js';
import {
  assertCategory,
  deliveryMoneyOf,
  deliveryOfStepsSql,
  isWholeShop,
  moneyOf,
  paymentsMoneyOf,
  paymentsOfStepsSql,
  stepMoneyOfScopeCtes,
  summaryOf,
  type DeliveryColumns,
  type MoneyColumns,
  type PaymentsColumns,
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

// the money of a period step by step (sales, returns, net, write-offs, purchases; the stock is of the
// reports by product and by category; the delivery and the payments past the statements of the
// whole shop): the days, the weeks from monday or the months of the calendar of the shop
// (SHOP_TIME_ZONE), the first and the last step cut to the period. Without a start the period is
// the step of its end and the eleven before it. A step counts its money the way the report of the
// accounting counts a period (accountingSql.helper.ts)

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
// over the limit is made, a typo in a year asks for millions of days: the series stops there itself
// (a function in FROM is made whole before the limit is read)
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
             least(
               bounds.t at time zone ${zone},
               date_trunc(${args.step}, bounds.f at time zone ${zone})
                 + ${interval}::interval * ${MAX_REPORT_STEPS + 1}::int
             ),
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

// the money of each step: the variants of the scope added up, a step by its number
async function moneyOfSteps(db: Prisma.TransactionClient, scope: ReportScope, steps: Step[]) {
  return db.$queryRaw<StepMoney[]>`
    ${stepMoneyOfScopeCtes(scope, steps)}
    select b.n,
           coalesce(sum(m.sold_units), 0)::bigint as sold_units,
           coalesce(sum(m.sold_revenue), 0) as sold_revenue,
           coalesce(sum(m.sold_cost), 0) as sold_cost,
           coalesce(sum(m.returned_units), 0)::bigint as returned_units,
           coalesce(sum(m.returned_revenue), 0) as returned_revenue,
           coalesce(sum(m.returned_cost), 0) as returned_cost,
           coalesce(sum(m.written_units), 0)::bigint as written_units,
           coalesce(sum(m.written_value), 0) as written_value,
           coalesce(sum(m.bought_units), 0)::bigint as bought_units,
           coalesce(sum(m.bought_value), 0) as bought_value
    from steps as b
    left join step_money as m on m.n = b.n
    group by b.n
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
  const { steps, money, delivery, payments } = await tx(
    async (db) => {
      await setUserContext(db, { userId: args.actorId, role: args.actorRole });
      await assertCategory(db, args.categoryId);

      const steps = await stepsOf(db, args);
      if (steps.length > MAX_REPORT_STEPS) {
        throw new BadRequestError('REPORT_PERIOD_TOO_LONG', { maxSteps: MAX_REPORT_STEPS });
      }

      const money = steps.length ? await moneyOfSteps(db, args, steps) : [];
      // the delivery is of the whole shop: a report of some products, variants or of a category has none
      const delivery =
        steps.length && isWholeShop(args)
          ? await db.$queryRaw<(DeliveryColumns & { n: bigint })[]>(deliveryOfStepsSql(steps))
          : [];
      // so are the payments past the statements
      const payments =
        steps.length && isWholeShop(args)
          ? await db.$queryRaw<(PaymentsColumns & { n: bigint })[]>(paymentsOfStepsSql(steps))
          : [];

      return { steps, money, delivery, payments };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 15_000 },
  );

  // the step number keeps the order of time for the sorts that go by money
  const rows = steps.map((step, index) => {
    const columns = money[index]!;
    const { sales, returns, net, writeOffs, afterWriteOffs, purchases } = moneyOf(columns);
    const stepDelivery = delivery[index] ?? null;
    const stepPayments = payments[index] ?? null;
    return {
      id: index,
      label: step.label,
      period: { from: step.from, to: step.to },
      sales,
      returns,
      net,
      writeOffs,
      afterWriteOffs,
      purchases,
      delivery: stepDelivery ? deliveryMoneyOf(stepDelivery) : null,
      payments: stepPayments ? paymentsMoneyOf(stepPayments) : null,
      summary: summaryOf({
        itemsRevenue: new Prisma.Decimal(columns.sold_revenue).minus(columns.returned_revenue),
        itemsCost: new Prisma.Decimal(columns.sold_cost).minus(columns.returned_cost),
        writeOffs: columns.written_value,
        delivery: stepDelivery,
        payments: stepPayments,
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
      returns: row.returns,
      net: row.net,
      writeOffs: row.writeOffs,
      afterWriteOffs: row.afterWriteOffs,
      purchases: row.purchases,
      delivery: row.delivery,
      payments: row.payments,
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
  ...paymentsCsvColumns<StepCsvRow>((row) => row.payments),
  ...summaryCsvColumns<StepCsvRow>((row) => row.summary),
];

export async function reportTimelineCsv(args: AccountingTimelineArgs) {
  const report = await reportTimeline(args);

  return {
    fileName: csvFileName('timeline', report.period.from, report.period.to),
    body: toCsv(TIMELINE_CSV, report.items),
  };
}
