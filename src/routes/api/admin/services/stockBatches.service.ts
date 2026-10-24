import { Prisma } from '@prisma/client';

import { tx } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { decodeCursor, encodeCursor } from '@helpers/codeCursor.js';
import { decimalToNumber } from '@helpers/safeNormalizer.js';
import { shopCurrency } from '@routes/api/payments/providers/index.js';
import { BadRequestError } from '@utils/errors.js';

import { utcTime } from './helpers/accountingSql.helper.js';

import type {
  AdminReportSortOrder,
  AdminStockBatchDto,
  AdminStockBatchesQueryDto,
  AdminStockBatchesSortBy,
  GetAdminStockBatchesResponseDto,
} from 'types/dto/admin.dto.js';
import type { StockSourceName } from 'types/dto/products.dto.js';
import type { ProductId, UserId } from 'types/ids.js';
import type { Role } from 'types/user.js';
import { isDbYear } from '@helpers/dbDate.js';

// the batches of the stock for an admin: what each came in with, what is left of it, what the
// paid orders took and what was written off, the delivery it came with (its line in the admin
// log) and whether it is over by the day of the shop. A page at a time, sorted the way the admin
// asks; equal values go by id

type BatchRow = {
  id: number;
  deliveryId: string;
  source: StockSourceName;
  supplierBatchNumber: string | null;
  productId: number;
  productName: string;
  productDeleted: boolean;
  unitCost: Prisma.Decimal;
  quantity: number;
  remaining: number;
  sold: number;
  writtenOff: number;
  value: Prisma.Decimal;
  expiresAt: string | null;
  expired: boolean;
  supplier: string | null;
  document: string | null;
  note: string | null;
  actorId: number | null;
  actorRole: Role | null;
  createdAt: Date;
};

// the expression of each sort and the kind of its value in a cursor; a batch without an end
// comes after the ones that end, whichever way
const SORTS: Record<AdminStockBatchesSortBy, { sql: string; kind: 'time' | 'day' | 'number' }> = {
  createdAt: { sql: 'b."createdAt"', kind: 'time' },
  expiresAt: { sql: 'b."expiresAt"', kind: 'day' },
  remaining: { sql: 'b.remaining', kind: 'number' },
  unitCost: { sql: 'b."unitCost"', kind: 'number' },
  value: { sql: '(b.remaining * b."unitCost")', kind: 'number' },
};

const NUMBER = /^\d+(\.\d+)?$/;
// a day of the calendar: 2026-02-30 has the shape and is none, the database would refuse it
const isDay = (v: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(v) &&
  !Number.isNaN(Date.parse(`${v}T00:00:00.000Z`)) &&
  new Date(`${v}T00:00:00.000Z`).toISOString().startsWith(v);

type Cursor = { id: number; v: string | null; s: string };

export type StockBatchesArgs = {
  actorId: UserId;
  actorRole: Role;
  productId?: number | undefined;
  deliveryId?: string | undefined;
  source?: StockSourceName | undefined;
  inStock?: boolean | undefined;
  expired?: boolean | undefined;
  expiresBy?: string | undefined;
  sortBy: AdminStockBatchesSortBy;
  sortOrder: AdminReportSortOrder;
  limit: number;
  cursor?: string | undefined;
};

// a last day the database has no date for (the year 0) is a bad request, not a server error
const expiresByOf = (value: string | undefined): string | undefined => {
  if (value !== undefined && !isDbYear(new Date(value))) {
    throw new BadRequestError('EXPIRES_BY_INVALID', { expiresBy: value });
  }
  return value;
};

export const stockBatchesArgsOf = (
  query: AdminStockBatchesQueryDto,
  actor: { id: UserId; role: Role },
): StockBatchesArgs => ({
  actorId: actor.id,
  actorRole: actor.role,
  productId: query.productId,
  deliveryId: query.deliveryId?.toLowerCase(),
  source: query.source,
  inStock: query.inStock,
  expired: query.expired,
  expiresBy: expiresByOf(query.expiresBy),
  sortBy: query.sortBy ?? 'createdAt',
  sortOrder: query.sortOrder ?? 'desc',
  limit: query.limit ?? 20,
  cursor: query.cursor,
});

// a cursor comes back from the client: it has to be one of this order, with a value that fits it
function readCursor(text: string, args: StockBatchesArgs): Cursor {
  const cursor = decodeCursor(text) as unknown as Partial<Cursor>;
  const { kind } = SORTS[args.sortBy];
  const v = cursor.v;
  const fits =
    cursor.s === `${args.sortBy}:${args.sortOrder}` &&
    (kind === 'time'
      ? typeof v === 'string' && !Number.isNaN(Date.parse(v))
      : kind === 'day'
        ? v === null || (typeof v === 'string' && isDay(v))
        : typeof v === 'string' && NUMBER.test(v));
  if (!fits) throw new BadRequestError('CURSOR_INVALID');

  return cursor as Cursor;
}

// the filters, the same for a page and for the total
function filtersOf(args: StockBatchesArgs): Prisma.Sql {
  const parts: Prisma.Sql[] = [Prisma.sql`true`];

  if (args.productId !== undefined) parts.push(Prisma.sql`b."productId" = ${args.productId}::int`);
  if (args.deliveryId !== undefined) {
    parts.push(Prisma.sql`b."deliveryId" = ${args.deliveryId}::uuid`);
  }
  if (args.source !== undefined) {
    parts.push(Prisma.sql`b.source = ${args.source}::cartlify."StockSource"`);
  }
  if (args.inStock === true) parts.push(Prisma.sql`b.remaining > 0`);
  if (args.inStock === false) parts.push(Prisma.sql`b.remaining = 0`);
  // the day of the shop comes with the context of the transaction
  if (args.expired === true) parts.push(Prisma.sql`b."expiresAt" < cartlify.shop_today()`);
  if (args.expired === false) {
    parts.push(Prisma.sql`(b."expiresAt" is null or b."expiresAt" >= cartlify.shop_today())`);
  }
  if (args.expiresBy !== undefined) {
    parts.push(Prisma.sql`b."expiresAt" <= ${args.expiresBy}::date`);
  }

  return Prisma.join(parts, ' and ');
}

function valueOf(kind: 'time' | 'day' | 'number', v: string | null): Prisma.Sql {
  if (kind === 'time') return utcTime(new Date(v!));
  if (kind === 'day') return Prisma.sql`${v}::date`;
  return Prisma.sql`${v}::numeric`;
}

function afterCursor(cursor: Cursor | null, args: StockBatchesArgs): Prisma.Sql {
  if (!cursor) return Prisma.sql`true`;

  const { sql, kind } = SORTS[args.sortBy];
  const col = Prisma.raw(sql);
  const op = Prisma.raw(args.sortOrder === 'desc' ? '<' : '>');

  // the batches without an end come after every end, in the order of their ids
  if (kind === 'day') {
    if (cursor.v === null) return Prisma.sql`(${col} is null and b.id ${op} ${cursor.id})`;
    const value = valueOf(kind, cursor.v);
    return Prisma.sql`(${col} ${op} ${value} or (${col} = ${value} and b.id ${op} ${cursor.id}) or ${col} is null)`;
  }

  const value = valueOf(kind, cursor.v);
  return Prisma.sql`(${col} ${op} ${value} or (${col} = ${value} and b.id ${op} ${cursor.id}))`;
}

function orderOf(args: StockBatchesArgs): Prisma.Sql {
  const { sql, kind } = SORTS[args.sortBy];
  const dir = args.sortOrder === 'desc' ? 'desc' : 'asc';

  return Prisma.raw(`${sql} ${dir}${kind === 'day' ? ' nulls last' : ''}, b.id ${dir}`);
}

function cursorOf(row: BatchRow, args: StockBatchesArgs): string {
  const s = `${args.sortBy}:${args.sortOrder}`;
  const v =
    args.sortBy === 'createdAt'
      ? row.createdAt.toISOString()
      : args.sortBy === 'expiresAt'
        ? row.expiresAt
        : args.sortBy === 'remaining'
          ? String(row.remaining)
          : args.sortBy === 'unitCost'
            ? row.unitCost.toString()
            : row.value.toString();

  return encodeCursor({ id: row.id, v, s } as never);
}

// what a delivery named, from the line the database wrote for the batch
const deliveryField = (field: string) =>
  Prisma.raw(
    `(select c->>'new' from jsonb_array_elements(l.meta) as c where c->>'field' = '${field}' limit 1)`,
  );

const toItem = (row: BatchRow): AdminStockBatchDto => ({
  id: row.id,
  deliveryId: row.deliveryId,
  source: row.source,
  supplierBatchNumber: row.supplierBatchNumber,
  product: { id: row.productId as ProductId, name: row.productName, deleted: row.productDeleted },
  unitCost: decimalToNumber(row.unitCost),
  quantity: row.quantity,
  remaining: row.remaining,
  sold: row.sold,
  writtenOff: row.writtenOff,
  value: decimalToNumber(row.value),
  expiresAt: row.expiresAt,
  expired: row.expired,
  supplier: row.supplier,
  document: row.document,
  note: row.note,
  receivedBy:
    row.actorId === null ? null : { id: row.actorId as UserId, role: row.actorRole as Role },
  createdAt: row.createdAt,
});

export async function listStockBatches(
  args: StockBatchesArgs,
): Promise<GetAdminStockBatchesResponseDto> {
  const cursor = args.cursor ? readCursor(args.cursor, args) : null;
  const where = filtersOf(args);

  const { rows, total } = await tx(
    async (db) => {
      await setUserContext(db, { userId: args.actorId, role: args.actorRole });

      const rows = await db.$queryRaw<BatchRow[]>`
        select
          b.id,
          b."deliveryId"::text as "deliveryId",
          b.source::text as source,
          b."supplierBatchNumber",
          b."productId",
          p.name as "productName",
          p."deletedAt" is not null as "productDeleted",
          b."unitCost",
          b.quantity,
          b.remaining,
          s.sold,
          (b.quantity - b.remaining - s.sold)::int as "writtenOff",
          (b.remaining * b."unitCost") as value,
          to_char(b."expiresAt", 'YYYY-MM-DD') as "expiresAt",
          coalesce(b."expiresAt" < cartlify.shop_today(), false) as expired,
          d.supplier,
          d.document,
          d.note,
          d."actorId",
          d."actorRole",
          b."createdAt"
        from cartlify.product_batches as b
        join cartlify.products as p on p.id = b."productId"
        -- the units of the paid orders; a cancel put its units back into the batch
        cross join lateral (
          select coalesce(sum(a.quantity), 0)::int as sold
          from cartlify.order_batch_allocations as a
          join cartlify.orders as o on o.id = a."orderId"
          where a."batchId" = b.id and o.status <> 'cancelled'::cartlify."OrderStatus"
        ) as s
        left join lateral (
          select
            l."actorId",
            l."actorRole"::text as "actorRole",
            ${deliveryField('supplier')} as supplier,
            ${deliveryField('document')} as document,
            ${deliveryField('note')} as note
          from cartlify.admin_audit_log as l
          where l."entityType" = 'product'
            and l."entityId" = b."productId"
            and l.action = 'STOCK_DELIVERY'
            and l.meta @> jsonb_build_array(
              jsonb_build_object('field', 'batch', 'new', jsonb_build_object('id', b.id))
            )
          order by l.id
          limit 1
        ) as d on true
        where ${where} and ${afterCursor(cursor, args)}
        order by ${orderOf(args)}
        limit ${args.limit + 1}
      `;
      const [count] = await db.$queryRaw<{ total: number }[]>`
        select count(*)::int as total from cartlify.product_batches as b where ${where}
      `;

      return { rows, total: count!.total };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 15_000 },
  );

  const hasNext = rows.length > args.limit;
  const pageRows = hasNext ? rows.slice(0, args.limit) : rows;

  return {
    currency: shopCurrency(),
    items: pageRows.map(toItem),
    limit: args.limit,
    nextCursor: hasNext ? cursorOf(pageRows.at(-1)!, args) : null,
    total,
  };
}
