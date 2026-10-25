import { Prisma } from '@prisma/client';

import { tx } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { toCsv, type CsvColumn } from '@helpers/csv.js';
import { shopCurrency } from '@routes/api/payments/providers/index.js';

import { sortRows } from './helpers/accountingReport.helper.js';
import { csvFileName, moneyCsvColumns } from './helpers/accountingCsv.helper.js';
import {
  MONEY_SUMS,
  assertCategory,
  moneyOf,
  productRowsCtes,
  type MoneyColumns,
  type ReportScope,
} from './helpers/accountingSql.helper.js';

import type {
  AdminReportCategoryRowDto,
  AdminReportSortBy,
  AdminReportSortOrder,
  AdminStatsDto,
  GetAdminReportCategoriesResponseDto,
} from 'types/dto/admin.dto.js';
import type { CategoryId } from 'types/ids.js';

// the money of each category in a period: with its whole branch (the default), or its own
// products only; every category, or the one asked for. A tree has its parents, so the rows of a
// branch are not added up: a parent has the money of its children in it already

type CategoryRow = MoneyColumns & { id: number; name: string; parentId: number | null };

export type AccountingCategoriesArgs = AdminStatsDto &
  ReportScope & { sortBy: AdminReportSortBy; sortOrder: AdminReportSortOrder };

async function readCategories(
  args: AccountingCategoriesArgs,
): Promise<AdminReportCategoryRowDto[]> {
  const categoryId = args.categoryId ?? null;

  const rows = await tx(
    async (db) => {
      await setUserContext(db, { userId: args.actorId, role: args.actorRole });
      await assertCategory(db, args.categoryId);

      return db.$queryRaw<CategoryRow[]>`
        ${productRowsCtes(args, args.from, args.to)},
        closure as (
          select c.id as ancestor, c.id as descendant from cartlify.categories as c
          union all
          select cl.ancestor, c.id
          from closure as cl
          join cartlify.categories as c on c."parentId" = cl.descendant
          where ${args.branch}::boolean
        ),
        picked as (
          select c.id, c.name, c."parentId"
          from cartlify.categories as c
          where ${categoryId}::int is null or c.id = ${categoryId}::int
        )
        select p.id, p.name, p."parentId", ${MONEY_SUMS}
        from picked as p
        left join closure as cl on cl.ancestor = p.id
        left join report_rows as r on r."categoryId" = cl.descendant
        group by p.id, p.name, p."parentId"
      `;
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 15_000 },
  );

  return rows.map((row) => ({
    id: row.id as CategoryId,
    name: row.name,
    parentId: row.parentId as CategoryId | null,
    ...moneyOf(row),
  }));
}

// the value of a sort of a row of money; none comes last whichever way
const SORT_VALUE: Record<
  AdminReportSortBy,
  (row: AdminReportCategoryRowDto) => number | string | null
> = {
  revenue: (row) => row.net.revenue,
  margin: (row) => row.net.margin,
  marginPercent: (row) => row.net.marginPercent,
  units: (row) => row.net.units,
  writeOffs: (row) => row.writeOffs.value,
  purchases: (row) => row.purchases.value,
  stockValue: (row) => row.stock.value,
  stockUnits: (row) => row.stock.units,
  name: (row) => row.name,
};

export async function reportCategories(
  args: AccountingCategoriesArgs,
): Promise<GetAdminReportCategoriesResponseDto> {
  const rows = await readCategories(args);

  return {
    period: { from: args.from, to: args.to },
    currency: shopCurrency(),
    items: sortRows(rows, SORT_VALUE[args.sortBy], args.sortOrder),
  };
}

const CATEGORY_CSV: CsvColumn<AdminReportCategoryRowDto>[] = [
  { header: 'id', kind: 'number', value: (row) => row.id },
  { header: 'name', kind: 'text', value: (row) => row.name },
  { header: 'parent_id', kind: 'number', value: (row) => row.parentId },
  ...moneyCsvColumns<AdminReportCategoryRowDto>((row) => row, { stock: true }),
];

export async function reportCategoriesCsv(args: AccountingCategoriesArgs) {
  const { items } = await reportCategories(args);

  return {
    fileName: csvFileName('categories', args.from, args.to),
    body: toCsv(CATEGORY_CSV, items),
  };
}
