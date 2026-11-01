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
  AdminStockMovementBatchDto,
  AdminStockMovementDto,
  AdminStockMovementKind,
  AdminStockMovementsQueryDto,
  GetAdminStockMovementsResponseDto,
} from 'types/dto/admin.dto.js';
import type { StockSourceName, WriteOffReason } from 'types/dto/products.dto.js';
import type { ProductId, UserId } from 'types/ids.js';
import type { Role } from 'types/user.js';
import { isDbYear } from '@helpers/dbDate.js';

// the journal of the stock for an admin, every step of a variant in one list, read from the stock
// log (one line for each variant for each change): a delivery, a write-off, a sale (the units a
// paid order took at the payment) and a cancel (the same units the cancel of the paid order put
// back, at the cancel). Each step names its variant with its product. Sorted by the time of the
// step; the steps of one time go by kind, then by the line of the log

type MovementRow = {
  kind: AdminStockMovementKind;
  at: Date;
  rank: number;
  a: number;
  b: number;
  variantId: number;
  productId: number;
  productName: string;
  productDeleted: boolean;
  variantPosition: number;
  variantName: string;
  variantSku: string | null;
  variantDeleted: boolean;
  quantity: number;
  value: Prisma.Decimal;
  batches: { batchId: number; quantity: number; unitCost: number | string }[];
  orderId: number | null;
  deliveryId: string | null;
  writeOffId: string | null;
  source: StockSourceName | null;
  reason: WriteOffReason | null;
  supplier: string | null;
  document: string | null;
  note: string | null;
  actorId: number | null;
  actorRole: Role | null;
};

// the place after the last row of a page: its time, the rank of its kind and its keys
type Cursor = { id: number; v: string; k: number; b: number; s: string };

export type StockMovementsArgs = {
  actorId: UserId;
  actorRole: Role;
  productId?: number | undefined;
  variantId?: number | undefined;
  batchId?: number | undefined;
  orderId?: number | undefined;
  deliveryId?: string | undefined;
  writeOffId?: string | undefined;
  kinds?: AdminStockMovementKind[] | undefined;
  from?: Date | undefined;
  to?: Date | undefined;
  sortOrder: AdminReportSortOrder;
  limit: number;
  cursor?: string | undefined;
};

// a period [from, to): either end can be left out; one that ends before it starts is refused, as
// the period of the reports (the admin log reads its period the same way)
export function periodOf(query: { from?: string | undefined; to?: string | undefined }) {
  const from = query.from === undefined ? undefined : new Date(query.from);
  const to = query.to === undefined ? undefined : new Date(query.to);
  for (const [field, date] of [
    ['from', from],
    ['to', to],
  ] as const) {
    if (date && (Number.isNaN(date.getTime()) || !isDbYear(date))) {
      throw new BadRequestError('INVALID_STATS_PERIOD', { field, reason: 'INVALID_DATE' });
    }
  }
  if (from && to && from > to) {
    throw new BadRequestError('INVALID_STATS_PERIOD', {
      from: from.toISOString(),
      to: to.toISOString(),
      reason: 'FROM_AFTER_TO',
    });
  }

  return { from, to };
}

export function stockMovementsArgsOf(
  query: AdminStockMovementsQueryDto,
  actor: { id: UserId; role: Role },
): StockMovementsArgs {
  const kinds = query.kind
    ? ([...new Set(query.kind.split(','))] as AdminStockMovementKind[])
    : undefined;

  return {
    actorId: actor.id,
    actorRole: actor.role,
    productId: query.productId,
    variantId: query.variantId,
    batchId: query.batchId,
    orderId: query.orderId,
    deliveryId: query.deliveryId?.toLowerCase(),
    writeOffId: query.writeOffId?.toLowerCase(),
    kinds,
    ...periodOf(query),
    sortOrder: query.sortOrder ?? 'desc',
    limit: query.limit ?? 20,
    cursor: query.cursor,
  };
}

// a cursor comes back from the client: it has to be one of this order, with values that fit it
function readCursor(text: string, sortOrder: AdminReportSortOrder): Cursor {
  const cursor = decodeCursor(text) as unknown as Partial<Cursor>;
  const fits =
    cursor.s === `at:${sortOrder}` &&
    typeof cursor.v === 'string' &&
    !Number.isNaN(Date.parse(cursor.v)) &&
    (cursor.k === 0 || cursor.k === 1 || cursor.k === 2) &&
    Number.isInteger(cursor.b) &&
    cursor.b! >= 0;
  if (!fits) throw new BadRequestError('CURSOR_INVALID');

  return cursor as Cursor;
}

// a field the database wrote in the meta of a line of the stock log: [{ field, old, new }]
const metaText = (field: string) =>
  Prisma.raw(
    `(select c->>'new' from jsonb_array_elements(l.meta) as c where c->>'field' = '${field}' limit 1)`,
  );
const metaJson = (field: string) =>
  Prisma.raw(
    `(select c->'new' from jsonb_array_elements(l.meta) as c where c->>'field' = '${field}' limit 1)`,
  );

// every step of the stock: one row for each line of the stock log. A delivery and a write-off name
// the admin who did them; a sale is the work of the system and a cancel is told apart by its
// order, so those two have no actor
const MOVEMENTS = Prisma.sql`
  movements as (
    select
      case l.event
        when 'stock.delivery' then 'delivery'
        when 'stock.write_off' then 'writeOff'
        when 'stock.sale' then 'sale'
        else 'cancel'
      end as kind,
      l."createdAt" as at,
      case l.event when 'stock.sale' then 1 when 'stock.cancel_return' then 2 else 0 end as rank,
      l.id as a,
      0 as b,
      l."variantId",
      ${metaJson('batches')} as batches,
      l."orderId",
      l."deliveryId"::text as "deliveryId",
      l."writeOffId"::text as "writeOffId",
      ${metaText('source')} as source,
      ${metaText('reason')} as reason,
      ${metaText('supplier')} as supplier,
      ${metaText('document')} as document,
      ${metaText('note')} as note,
      case when l.event in ('stock.delivery', 'stock.write_off') then l."actorId" end as "actorId",
      case when l.event in ('stock.delivery', 'stock.write_off') then l."actorRole"::text end
        as "actorRole"
    from cartlify.stock_log as l
  )
`;

// the filters, the same for a page and for the total
function filtersOf(args: StockMovementsArgs): Prisma.Sql {
  const parts: Prisma.Sql[] = [Prisma.sql`true`];

  if (args.productId !== undefined) parts.push(Prisma.sql`v."productId" = ${args.productId}::int`);
  if (args.variantId !== undefined) parts.push(Prisma.sql`m."variantId" = ${args.variantId}::int`);
  if (args.batchId !== undefined) {
    parts.push(
      Prisma.sql`m.batches @> jsonb_build_array(jsonb_build_object('batchId', ${args.batchId}::int))`,
    );
  }
  if (args.orderId !== undefined) parts.push(Prisma.sql`m."orderId" = ${args.orderId}::int`);
  if (args.deliveryId !== undefined) {
    parts.push(Prisma.sql`m."deliveryId" = ${args.deliveryId}::text`);
  }
  if (args.writeOffId !== undefined) {
    parts.push(Prisma.sql`m."writeOffId" = ${args.writeOffId}::text`);
  }
  if (args.kinds !== undefined) parts.push(Prisma.sql`m.kind = any(${args.kinds}::text[])`);
  if (args.from !== undefined) parts.push(Prisma.sql`m.at >= ${utcTime(args.from)}`);
  if (args.to !== undefined) parts.push(Prisma.sql`m.at < ${utcTime(args.to)}`);

  return Prisma.join(parts, ' and ');
}

function afterCursor(cursor: Cursor | null, sortOrder: AdminReportSortOrder): Prisma.Sql {
  if (!cursor) return Prisma.sql`true`;

  const op = Prisma.raw(sortOrder === 'desc' ? '<' : '>');
  return Prisma.sql`(m.at, m.rank, m.a, m.b) ${op} (${utcTime(new Date(cursor.v))}, ${cursor.k}::int, ${cursor.id}::int, ${cursor.b}::int)`;
}

// a delivery and a cancel bring units in, a write-off and a sale take them out
const SIGNED = Prisma.raw(`case when m.kind in ('delivery', 'cancel') then 1 else -1 end`);

const toBatch = (line: MovementRow['batches'][number]): AdminStockMovementBatchDto => ({
  batchId: line.batchId,
  quantity: line.quantity,
  unitCost: Number(line.unitCost),
});

const toItem = (row: MovementRow): AdminStockMovementDto => ({
  kind: row.kind,
  at: row.at,
  product: { id: row.productId as ProductId, name: row.productName, deleted: row.productDeleted },
  variant: {
    id: row.variantId,
    position: row.variantPosition,
    name: row.variantName,
    sku: row.variantSku,
    deleted: row.variantDeleted,
  },
  quantity: row.quantity,
  value: decimalToNumber(row.value),
  batches: row.batches.map(toBatch),
  orderId: row.orderId,
  deliveryId: row.deliveryId,
  writeOffId: row.writeOffId,
  source: row.source,
  reason: row.reason,
  supplier: row.supplier,
  document: row.document,
  note: row.note,
  actor: row.actorId === null ? null : { id: row.actorId as UserId, role: row.actorRole as Role },
});

export async function listStockMovements(
  args: StockMovementsArgs,
): Promise<GetAdminStockMovementsResponseDto> {
  const cursor = args.cursor ? readCursor(args.cursor, args.sortOrder) : null;
  const where = filtersOf(args);
  const dir = Prisma.raw(args.sortOrder === 'desc' ? 'desc' : 'asc');

  const { rows, total } = await tx(
    async (db) => {
      await setUserContext(db, { userId: args.actorId, role: args.actorRole });

      const rows = await db.$queryRaw<MovementRow[]>`
        with ${MOVEMENTS}
        select
          m.kind, m.at, m.rank, m.a, m.b,
          m."variantId",
          v."productId",
          p.name as "productName",
          p."deletedAt" is not null as "productDeleted",
          v.position as "variantPosition",
          cartlify.variant_display_name(m."variantId") as "variantName",
          v.sku as "variantSku",
          v."deletedAt" is not null as "variantDeleted",
          (${SIGNED} * q.units)::int as quantity,
          (${SIGNED} * q.value) as value,
          m.batches,
          m."orderId", m."deliveryId", m."writeOffId", m.source, m.reason,
          m.supplier, m.document, m.note, m."actorId", m."actorRole"
        from movements as m
        join cartlify.product_variants as v on v.id = m."variantId"
        join cartlify.products as p on p.id = v."productId"
        cross join lateral (
          select
            coalesce(sum((x->>'quantity')::int), 0) as units,
            coalesce(sum((x->>'quantity')::int * (x->>'unitCost')::numeric), 0) as value
          from jsonb_array_elements(m.batches) as x
        ) as q
        where ${where} and ${afterCursor(cursor, args.sortOrder)}
        order by m.at ${dir}, m.rank ${dir}, m.a ${dir}, m.b ${dir}
        limit ${args.limit + 1}
      `;
      const [count] = await db.$queryRaw<{ total: number }[]>`
        with ${MOVEMENTS}
        select count(*)::int as total
        from movements as m
        join cartlify.product_variants as v on v.id = m."variantId"
        where ${where}
      `;

      return { rows, total: count!.total };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 15_000 },
  );

  const hasNext = rows.length > args.limit;
  const pageRows = hasNext ? rows.slice(0, args.limit) : rows;
  const last = pageRows.at(-1);

  return {
    currency: shopCurrency(),
    items: pageRows.map(toItem),
    limit: args.limit,
    nextCursor:
      hasNext && last
        ? encodeCursor({
            id: last.a,
            v: last.at.toISOString(),
            k: last.rank,
            b: last.b,
            s: `at:${args.sortOrder}`,
          } as never)
        : null,
    total,
  };
}
