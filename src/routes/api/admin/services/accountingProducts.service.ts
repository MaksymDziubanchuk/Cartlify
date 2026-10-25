import { Prisma } from '@prisma/client';

import { tx } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { decodeCursor, encodeCursor } from '@helpers/codeCursor.js';
import { toCsv, type CsvColumn } from '@helpers/csv.js';
import { shopCurrency } from '@routes/api/payments/providers/index.js';
import { BadRequestError } from '@utils/errors.js';

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
  AdminReportProductRowDto,
  AdminReportSortBy,
  AdminReportSortOrder,
  AdminStatsDto,
  GetAdminReportProductsResponseDto,
} from 'types/dto/admin.dto.js';
import type { CategoryId, ProductId } from 'types/ids.js';

// the money of each product of the scope in a period, sorted the way the admin asks, a page at a
// time with its cursor; the totals are of every product of the scope. The csv file has every
// product and the totals last

type ProductRow = MoneyColumns & {
  id: number;
  name: string;
  categoryId: number;
  categoryName: string;
  deleted: boolean;
  net_revenue: Prisma.Decimal;
  net_margin: Prisma.Decimal;
  net_margin_percent: Prisma.Decimal | null;
  net_units: bigint;
};

// the column of each sort in the rows of the report; the percent is none without a revenue,
// such rows come last whichever way
const SORTS: Record<AdminReportSortBy, { column: string; kind: 'number' | 'text' | 'nullable' }> = {
  revenue: { column: 'net_revenue', kind: 'number' },
  margin: { column: 'net_margin', kind: 'number' },
  marginPercent: { column: 'net_margin_percent', kind: 'nullable' },
  units: { column: 'net_units', kind: 'number' },
  writeOffs: { column: 'written_value', kind: 'number' },
  purchases: { column: 'bought_value', kind: 'number' },
  stockValue: { column: 'stock_value', kind: 'number' },
  stockUnits: { column: 'stock_units', kind: 'number' },
  name: { column: 'name', kind: 'text' },
};

type Cursor = { id: number; v: string | null; s: string; g?: 1 };

const NUMBER = /^-?\d+(\.\d+)?$/;

// a cursor comes back from the client: it has to be one of this sort, with a value that fits it
function readCursor(text: string, sortKey: string, kind: 'number' | 'text' | 'nullable'): Cursor {
  const cursor = decodeCursor(text) as unknown as Partial<Cursor>;
  const nullGroup = kind === 'nullable' && cursor.g === 1 && cursor.v === null;
  const fits =
    cursor.s === sortKey &&
    (nullGroup ||
      (kind === 'text'
        ? typeof cursor.v === 'string'
        : typeof cursor.v === 'string' && NUMBER.test(cursor.v)));
  if (!fits) throw new BadRequestError('CURSOR_INVALID');

  return cursor as Cursor;
}

function cursorWhere(
  cursor: Cursor | null,
  sortBy: AdminReportSortBy,
  order: AdminReportSortOrder,
) {
  if (!cursor) return Prisma.sql`true`;

  const { column, kind } = SORTS[sortBy];
  const col = Prisma.raw(`r.${column}`);
  const op = Prisma.raw(order === 'desc' ? '<' : '>');
  const value = kind === 'text' ? Prisma.sql`${cursor.v}::text` : Prisma.sql`${cursor.v}::numeric`;

  if (kind === 'nullable') {
    if (cursor.g === 1) return Prisma.sql`(${col} is null and r.id ${op} ${cursor.id})`;
    return Prisma.sql`((${col} is not null and (${col} ${op} ${value} or (${col} = ${value} and r.id ${op} ${cursor.id}))) or ${col} is null)`;
  }

  return Prisma.sql`(${col} ${op} ${value} or (${col} = ${value} and r.id ${op} ${cursor.id}))`;
}

function orderBy(sortBy: AdminReportSortBy, order: AdminReportSortOrder) {
  const { column, kind } = SORTS[sortBy];
  const dir = order === 'desc' ? 'desc' : 'asc';
  const nullsLast = kind === 'nullable' ? `r.${column} is null, ` : '';

  return Prisma.raw(`${nullsLast}r.${column} ${dir}, r.id ${dir}`);
}

const cursorOf = (row: ProductRow, sortBy: AdminReportSortBy, sortKey: string): string => {
  const { kind } = SORTS[sortBy];
  if (kind === 'text') return encodeCursor({ id: row.id, v: row.name, s: sortKey } as never);

  const raw = (row as Record<string, unknown>)[SORTS[sortBy].column];
  if (raw === null) return encodeCursor({ id: row.id, v: null, s: sortKey, g: 1 } as never);

  return encodeCursor({ id: row.id, v: String(raw), s: sortKey } as never);
};

const toItem = (row: ProductRow): AdminReportProductRowDto => ({
  id: row.id as ProductId,
  name: row.name,
  deleted: row.deleted,
  category: { id: row.categoryId as CategoryId, name: row.categoryName },
  ...moneyOf(row),
});

export type AccountingProductsArgs = AdminStatsDto &
  ReportScope & {
    sortBy: AdminReportSortBy;
    sortOrder: AdminReportSortOrder;
    limit: number;
    cursor?: string | undefined;
  };

async function readRows(
  args: AccountingProductsArgs,
  page: { limit?: number; cursor?: Cursor | null },
) {
  const ctes = productRowsCtes(args, args.from, args.to);

  return tx(
    async (db) => {
      await setUserContext(db, { userId: args.actorId, role: args.actorRole });
      await assertCategory(db, args.categoryId);

      const rows = await db.$queryRaw<ProductRow[]>`
        ${ctes}
        select r.*, c.name as "categoryName",
               r."deletedAt" is not null as deleted
        from report_rows as r
        join cartlify.categories as c on c.id = r."categoryId"
        where ${cursorWhere(page.cursor ?? null, args.sortBy, args.sortOrder)}
        order by ${orderBy(args.sortBy, args.sortOrder)}
        ${page.limit ? Prisma.sql`limit ${page.limit + 1}` : Prisma.empty}
      `;
      const [totals] = await db.$queryRaw<MoneyColumns[]>`
        ${ctes}
        select ${MONEY_SUMS} from report_rows
      `;

      return { rows, totals: totals! };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 15_000 },
  );
}

export async function reportProducts(
  args: AccountingProductsArgs,
): Promise<GetAdminReportProductsResponseDto> {
  const sortKey = `${args.sortBy}:${args.sortOrder}`;
  const cursor = args.cursor ? readCursor(args.cursor, sortKey, SORTS[args.sortBy].kind) : null;

  const { rows, totals } = await readRows(args, { limit: args.limit, cursor });
  const hasNext = rows.length > args.limit;
  const pageRows = hasNext ? rows.slice(0, args.limit) : rows;

  return {
    period: { from: args.from, to: args.to },
    currency: shopCurrency(),
    items: pageRows.map(toItem),
    totals: moneyOf(totals),
    limit: args.limit,
    nextCursor: hasNext ? cursorOf(pageRows.at(-1)!, args.sortBy, sortKey) : null,
  };
}

type CsvRow = {
  id: number | null;
  name: string;
  category: string | null;
  deleted: boolean | null;
} & {
  money: ReturnType<typeof moneyOf>;
};

const PRODUCT_CSV: CsvColumn<CsvRow>[] = [
  { header: 'id', kind: 'number', value: (row) => row.id },
  { header: 'name', kind: 'text', value: (row) => row.name },
  { header: 'category', kind: 'text', value: (row) => row.category },
  {
    header: 'deleted',
    kind: 'text',
    value: (row) => (row.deleted === null ? null : row.deleted ? 'yes' : 'no'),
  },
  ...moneyCsvColumns<CsvRow>((row) => row.money, { stock: true }),
];

// every product of the scope sorted, the totals last
export async function reportProductsCsv(args: AccountingProductsArgs) {
  const { rows, totals } = await readRows(args, {});

  const lines: CsvRow[] = [
    ...rows.map((row) => ({
      id: row.id,
      name: row.name,
      category: row.categoryName,
      deleted: row.deleted,
      money: moneyOf(row),
    })),
    { id: null, name: 'Total', category: null, deleted: null, money: moneyOf(totals) },
  ];

  return { fileName: csvFileName('products', args.from, args.to), body: toCsv(PRODUCT_CSV, lines) };
}
