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
  type ReportRows,
  type ReportScope,
} from './helpers/accountingSql.helper.js';

import type {
  AdminReportProductRowDto,
  AdminReportSortBy,
  AdminReportSortOrder,
  AdminReportVariantRowDto,
  AdminStatsDto,
  GetAdminReportProductsResponseDto,
  GetAdminReportVariantsResponseDto,
} from 'types/dto/admin.dto.js';
import type { CategoryId, ProductId } from 'types/ids.js';

// The money of each product of the scope in a period, or of each variant of it, sorted the way the
// admin asks, a page at a time with its cursor. A row of the report by product is a product: the
// money of all its variants of the scope added up; a row of the report by variant is a variant,
// named with its product. Both read the same rows of variants (accountingSql.helper.ts), so the
// rows of a product are the sums of the rows of its variants and the totals are equal. The totals
// are of every row of the scope. The csv file has every row and the totals last

// a row of the report: the id is the id of the product, or of the variant
type Row = MoneyColumns & {
  id: number;
  // the name of the product
  name: string;
  categoryId: number;
  categoryName: string;
  deleted: boolean;
  sold_margin: Prisma.Decimal;
  sold_margin_percent: Prisma.Decimal | null;
  margin_after_write_offs: Prisma.Decimal;
};

type VariantRow = Row & {
  productId: number;
  variant_name: string;
  position: number;
  sku: string | null;
  variantDeleted: boolean;
};

// the column of each sort in the rows of the report; the percent is none without a revenue,
// such rows come last whichever way. The name is the name of the product, or of the variant
const SORTS: Record<AdminReportSortBy, { column: string; kind: 'number' | 'text' | 'nullable' }> = {
  revenue: { column: 'sold_revenue', kind: 'number' },
  margin: { column: 'sold_margin', kind: 'number' },
  marginPercent: { column: 'sold_margin_percent', kind: 'nullable' },
  units: { column: 'sold_units', kind: 'number' },
  marginAfterWriteOffs: { column: 'margin_after_write_offs', kind: 'number' },
  writeOffs: { column: 'written_value', kind: 'number' },
  purchases: { column: 'bought_value', kind: 'number' },
  stockValue: { column: 'stock_value', kind: 'number' },
  stockUnits: { column: 'stock_units', kind: 'number' },
  name: { column: 'name', kind: 'text' },
};

const sortOf = (rows: ReportRows, sortBy: AdminReportSortBy) =>
  rows === 'variant' && sortBy === 'name'
    ? { column: 'variant_name', kind: 'text' as const }
    : SORTS[sortBy];

// the rows are part of the key of a cursor: the cursor of the report by product names the id of a
// product and does not continue the report by variant, nor the other way round
const sortKeyOf = (rows: ReportRows, sortBy: AdminReportSortBy, sortOrder: AdminReportSortOrder) =>
  `${rows}:${sortBy}:${sortOrder}`;

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
  rows: ReportRows,
  sortBy: AdminReportSortBy,
  order: AdminReportSortOrder,
) {
  if (!cursor) return Prisma.sql`true`;

  const { column, kind } = sortOf(rows, sortBy);
  const col = Prisma.raw(`r.${column}`);
  const op = Prisma.raw(order === 'desc' ? '<' : '>');
  const value = kind === 'text' ? Prisma.sql`${cursor.v}::text` : Prisma.sql`${cursor.v}::numeric`;

  if (kind === 'nullable') {
    if (cursor.g === 1) return Prisma.sql`(${col} is null and r.id ${op} ${cursor.id})`;
    return Prisma.sql`((${col} is not null and (${col} ${op} ${value} or (${col} = ${value} and r.id ${op} ${cursor.id}))) or ${col} is null)`;
  }

  return Prisma.sql`(${col} ${op} ${value} or (${col} = ${value} and r.id ${op} ${cursor.id}))`;
}

function orderBy(rows: ReportRows, sortBy: AdminReportSortBy, order: AdminReportSortOrder) {
  const { column, kind } = sortOf(rows, sortBy);
  const dir = order === 'desc' ? 'desc' : 'asc';
  const nullsLast = kind === 'nullable' ? `r.${column} is null, ` : '';

  return Prisma.raw(`${nullsLast}r.${column} ${dir}, r.id ${dir}`);
}

const cursorOf = (
  row: Row,
  rows: ReportRows,
  sortBy: AdminReportSortBy,
  sortKey: string,
): string => {
  const { column, kind } = sortOf(rows, sortBy);
  if (kind === 'text') {
    return encodeCursor({
      id: row.id,
      v: String((row as Record<string, unknown>)[column]),
      s: sortKey,
    } as never);
  }

  const raw = (row as Record<string, unknown>)[column];
  if (raw === null) return encodeCursor({ id: row.id, v: null, s: sortKey, g: 1 } as never);

  return encodeCursor({ id: row.id, v: String(raw), s: sortKey } as never);
};

const productItemOf = (row: Row): AdminReportProductRowDto => ({
  product: { id: row.id as ProductId, name: row.name, deleted: row.deleted },
  category: { id: row.categoryId as CategoryId, name: row.categoryName },
  ...moneyOf(row),
});

const variantItemOf = (row: VariantRow): AdminReportVariantRowDto => ({
  product: { id: row.productId as ProductId, name: row.name, deleted: row.deleted },
  variant: {
    id: row.id,
    position: row.position,
    name: row.variant_name,
    sku: row.sku,
    deleted: row.variantDeleted,
  },
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
  rows: ReportRows,
  args: AccountingProductsArgs,
  page: { limit?: number; cursor?: Cursor | null },
) {
  const ctes = productRowsCtes(args, args.from, args.to, rows);
  // the variant of a row of the report by variant: its product and its own columns
  const variantColumns =
    rows === 'variant'
      ? Prisma.sql`, r."variantDeletedAt" is not null as "variantDeleted"`
      : Prisma.empty;

  return tx(
    async (db) => {
      await setUserContext(db, { userId: args.actorId, role: args.actorRole });
      await assertCategory(db, args.categoryId);

      const found = await db.$queryRaw<Row[]>`
        ${ctes}
        select r.*, c.name as "categoryName",
               r."deletedAt" is not null as deleted${variantColumns}
        from report_rows as r
        join cartlify.categories as c on c.id = r."categoryId"
        where ${cursorWhere(page.cursor ?? null, rows, args.sortBy, args.sortOrder)}
        order by ${orderBy(rows, args.sortBy, args.sortOrder)}
        ${page.limit ? Prisma.sql`limit ${page.limit + 1}` : Prisma.empty}
      `;
      const [totals] = await db.$queryRaw<MoneyColumns[]>`
        ${ctes}
        select ${MONEY_SUMS} from report_rows
      `;

      return { rows: found, totals: totals! };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 15_000 },
  );
}

// one page of a report with its cursor; the rows of a variant report carry the variant
async function page(rows: ReportRows, args: AccountingProductsArgs) {
  const sortKey = sortKeyOf(rows, args.sortBy, args.sortOrder);
  const cursor = args.cursor
    ? readCursor(args.cursor, sortKey, sortOf(rows, args.sortBy).kind)
    : null;

  const { rows: found, totals } = await readRows(rows, args, { limit: args.limit, cursor });
  const hasNext = found.length > args.limit;
  const pageRows = hasNext ? found.slice(0, args.limit) : found;

  return {
    pageRows,
    totals,
    nextCursor: hasNext ? cursorOf(pageRows.at(-1)!, rows, args.sortBy, sortKey) : null,
  };
}

export async function reportProducts(
  args: AccountingProductsArgs,
): Promise<GetAdminReportProductsResponseDto> {
  const { pageRows, totals, nextCursor } = await page('product', args);

  return {
    period: { from: args.from, to: args.to },
    currency: shopCurrency(),
    items: pageRows.map(productItemOf),
    totals: moneyOf(totals),
    limit: args.limit,
    nextCursor,
  };
}

export async function reportVariants(
  args: AccountingProductsArgs,
): Promise<GetAdminReportVariantsResponseDto> {
  const { pageRows, totals, nextCursor } = await page('variant', args);

  return {
    period: { from: args.from, to: args.to },
    currency: shopCurrency(),
    items: (pageRows as VariantRow[]).map(variantItemOf),
    totals: moneyOf(totals),
    limit: args.limit,
    nextCursor,
  };
}

type CsvRow = {
  productId: number | null;
  productName: string;
  variantId: number | null;
  variantName: string | null;
  sku: string | null;
  category: string | null;
  // the product is removed from the catalog
  deleted: boolean | null;
  // the variant is taken out of sale (all variants of a removed product are)
  variantDeleted: boolean | null;
} & {
  money: ReturnType<typeof moneyOf>;
};

const yesNo = (value: boolean | null) => (value === null ? null : value ? 'yes' : 'no');

const PRODUCT_CSV: CsvColumn<CsvRow>[] = [
  { header: 'product_id', kind: 'number', value: (row) => row.productId },
  { header: 'product_name', kind: 'text', value: (row) => row.productName },
  { header: 'category', kind: 'text', value: (row) => row.category },
  { header: 'deleted', kind: 'text', value: (row) => yesNo(row.deleted) },
  ...moneyCsvColumns<CsvRow>((row) => row.money, { stock: true }),
];

const VARIANT_CSV: CsvColumn<CsvRow>[] = [
  { header: 'product_id', kind: 'number', value: (row) => row.productId },
  { header: 'product_name', kind: 'text', value: (row) => row.productName },
  { header: 'variant_id', kind: 'number', value: (row) => row.variantId },
  { header: 'variant_name', kind: 'text', value: (row) => row.variantName },
  { header: 'sku', kind: 'text', value: (row) => row.sku },
  { header: 'category', kind: 'text', value: (row) => row.category },
  { header: 'deleted', kind: 'text', value: (row) => yesNo(row.deleted) },
  { header: 'variant_deleted', kind: 'text', value: (row) => yesNo(row.variantDeleted) },
  ...moneyCsvColumns<CsvRow>((row) => row.money, { stock: true }),
];

// every row of the scope sorted, the totals last
async function csvOf(rows: ReportRows, args: AccountingProductsArgs) {
  const { rows: found, totals } = await readRows(rows, args, {});

  const lines: CsvRow[] = [
    ...found.map((row) => {
      const variant = row as VariantRow;
      return {
        productId: rows === 'variant' ? variant.productId : row.id,
        productName: row.name,
        variantId: rows === 'variant' ? row.id : null,
        variantName: rows === 'variant' ? variant.variant_name : null,
        sku: rows === 'variant' ? variant.sku : null,
        category: row.categoryName,
        deleted: row.deleted,
        variantDeleted: rows === 'variant' ? variant.variantDeleted : null,
        money: moneyOf(row),
      };
    }),
    {
      productId: null,
      productName: 'Total',
      variantId: null,
      variantName: null,
      sku: null,
      category: null,
      deleted: null,
      variantDeleted: null,
      money: moneyOf(totals),
    },
  ];

  return {
    fileName: csvFileName(rows === 'variant' ? 'variants' : 'products', args.from, args.to),
    body: toCsv(rows === 'variant' ? VARIANT_CSV : PRODUCT_CSV, lines),
  };
}

export const reportProductsCsv = (args: AccountingProductsArgs) => csvOf('product', args);

export const reportVariantsCsv = (args: AccountingProductsArgs) => csvOf('variant', args);
