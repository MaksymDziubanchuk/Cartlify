import { Prisma } from '@prisma/client';

import { STOCK_LOG_EVENTS } from '@config/journalEvents.js';
import { HIDDEN_ID, hiddenAccount, hiddenText } from '@helpers/rootHidden.js';

import {
  type ColumnFilter,
  columnFiltersSql,
  filterValuesOf,
  groupJournal,
  groupJournalCsv,
  type GroupsArgs,
  groupsArgsOf,
  type GroupsDef,
  type GroupsQuery,
  type JournalArgs,
  journalArgsOf,
  journalCsv,
  type JournalDef,
  type JournalQuery,
  listJournal,
  rootNotPickedSql,
  timeGroupKeys,
} from './helpers/journal.helper.js';

import type {
  AdminStockLogItemDto,
  AdminStockLogQueryDto,
  GetAdminStockLogResponseDto,
} from 'types/dto/admin.dto.js';
import type { UserId } from 'types/ids.js';
import type { Role } from 'types/user.js';

// the stock log for admin and root (GET /api/admin/stock-log): a line for every change of the
// quantity of a variant, with the product and the variant, how much it changed and what the stock
// was after it, the event that made it (a delivery, a write-off, a sale at the payment of an order,
// the units back at the cancel of a paid order), the operation it belongs to (the id of a delivery,
// of a write-off or the order), who did it (none for the work of the system) and from which address
// and browser. The journal engine gives it its sorts, its period, its events and columns
// (journal.helper.ts); the filters are the product, the variant and the operation ids, and one for
// every other column (STOCK_FILTERS) with the statement and the category; the page gives the sum of
// the changes of its filters, and the lines group by their keys with it (GET
// /api/admin/stock-log/groups). The policies
// let every admin read it (stock_log_select). An admin sees the same lines as root with the same
// filters, and not who root is: in the lines root wrote the account, the address and the browser
// are hidden

export type StockLogArgs = JournalArgs & {
  productId?: number | undefined;
  variantId?: number | undefined;
  deliveryId?: string | undefined;
  writeOffId?: string | undefined;
  orderId?: number | undefined;
  // the lines of the units of a statement of return
  returnId?: number | undefined;
  // the values of the filters of the other columns, by the names of STOCK_FILTERS
  filterValues: Record<string, unknown>;
};

type StockRow = {
  id: number;
  createdAt: Date;
  actorId: number | null;
  actorRole: Role | null;
  actorName: string | null;
  actorEmail: string | null;
  actorRoleNow: Role | null;
  actorDeleted: boolean | null;
  productId: number;
  productName: string;
  variantId: number;
  variantPosition: number;
  variantSku: string | null;
  variantName: string;
  event: string;
  quantityChange: number;
  stockAfter: number;
  deliveryId: string | null;
  writeOffId: string | null;
  orderId: number | null;
  returnItemId: number | null;
  ip: string | null;
  userAgent: string | null;
  meta: unknown;
};

const l = (column: string) => Prisma.raw(`l."${column}"`);

// a line root wrote, or whose account is root's now: what an admin does not see of it
const ROOT_ACTOR = Prisma.sql`(l."actorRole" = 'ROOT'::cartlify."Role" OR a.role = 'ROOT'::cartlify."Role")`;

const STOCK_SORTS = {
  id: { sql: Prisma.sql`l.id`, kind: 'number' },
  createdAt: { sql: l('createdAt'), kind: 'date' },
  actorId: { sql: l('actorId'), kind: 'number' },
  actorRole: { sql: Prisma.sql`l."actorRole"::text`, kind: 'text' },
  productId: { sql: l('productId'), kind: 'number' },
  variantId: { sql: l('variantId'), kind: 'number' },
  event: { sql: l('event'), kind: 'text' },
  quantityChange: { sql: l('quantityChange'), kind: 'number' },
  stockAfter: { sql: l('stockAfter'), kind: 'number' },
  deliveryId: { sql: Prisma.sql`l."deliveryId"::text`, kind: 'text' },
  writeOffId: { sql: Prisma.sql`l."writeOffId"::text`, kind: 'text' },
  orderId: { sql: l('orderId'), kind: 'number' },
  returnItemId: { sql: l('returnItemId'), kind: 'number' },
  ip: { sql: l('ip'), kind: 'text' },
  userAgent: { sql: l('userAgent'), kind: 'text' },
} as const;

type StockItem = Partial<AdminStockLogItemDto> & Record<string, unknown>;

const STOCK_DEF: JournalDef<StockRow, StockItem> = {
  fileName: 'stock-log',
  from: Prisma.sql`cartlify.stock_log AS l
    LEFT JOIN cartlify.users AS a ON a.id = l."actorId"
    JOIN cartlify.products AS p ON p.id = l."productId"
    JOIN cartlify.product_variants AS v ON v.id = l."variantId"`,
  select: Prisma.sql`
    l.id, l."createdAt", l."actorId", l."actorRole", a.name AS "actorName",
    a.email AS "actorEmail", a.role AS "actorRoleNow", (a."deletedAt" IS NOT NULL) AS "actorDeleted",
    l."productId", p.name AS "productName", l."variantId", v.position AS "variantPosition",
    v.sku AS "variantSku", cartlify.variant_display_name(l."variantId") AS "variantName",
    l.event, l."quantityChange", l."stockAfter", l."deliveryId"::text AS "deliveryId",
    l."writeOffId"::text AS "writeOffId", l."orderId", l."returnItemId", l.ip, l."userAgent",
    l.meta`,
  createdAt: l('createdAt'),
  event: l('event'),
  columns: [
    'id',
    'createdAt',
    'actorId',
    'actor',
    'actorRole',
    'productId',
    'product',
    'variantId',
    'variant',
    'event',
    'quantityChange',
    'stockAfter',
    'deliveryId',
    'writeOffId',
    'orderId',
    'returnItemId',
    'ip',
    'userAgent',
    'changes',
  ],
  sorts: STOCK_SORTS,
  events: STOCK_LOG_EVENTS,
  reason: 'ADMIN_STOCK_LOG_UNEXPECTED',
  rootLine: ROOT_ACTOR,
  // the sum of the changes of the lines of the filters
  sums: {
    sql: (where) => Prisma.sql`
      SELECT jsonb_build_object('quantityChange', COALESCE(SUM(l."quantityChange"), 0)) AS sums
      FROM cartlify.stock_log AS l
        LEFT JOIN cartlify.users AS a ON a.id = l."actorId"
        JOIN cartlify.products AS p ON p.id = l."productId"
        JOIN cartlify.product_variants AS v ON v.id = l."variantId"
      ${where}`,
    of: (raw) => ({
      quantityChange: Number((raw as { quantityChange?: number } | null)?.quantityChange ?? 0),
    }),
  },
  itemOf: (row, viewer) => {
    // root, whoever it is now: an admin sees the role of it and nothing else
    const isRoot = row.actorRole === 'ROOT' || row.actorRoleNow === 'ROOT';
    const hideActor = viewer !== 'ROOT' && isRoot;

    // a deleted account keeps its lines, not its address; the work of the system has no account
    const email = row.actorDeleted ? null : row.actorEmail;
    const changes = Array.isArray(row.meta) ? (row.meta as unknown[]) : [];

    return {
      id: row.id,
      createdAt: row.createdAt.toISOString(),
      actorId: row.actorId === null ? null : hideActor ? HIDDEN_ID : (row.actorId as UserId),
      actor:
        row.actorId === null || row.actorRoleNow === null
          ? null
          : hideActor
            ? hiddenAccount(row.actorName, email)
            : {
                id: row.actorId as UserId,
                name: row.actorName,
                email,
                role: row.actorRoleNow,
              },
      actorRole: row.actorRole,
      productId: row.productId,
      product: { id: row.productId, name: row.productName },
      variantId: row.variantId,
      variant: {
        id: row.variantId,
        position: row.variantPosition,
        name: row.variantName,
        sku: row.variantSku,
      },
      event: row.event,
      quantityChange: row.quantityChange,
      stockAfter: row.stockAfter,
      deliveryId: row.deliveryId,
      writeOffId: row.writeOffId,
      orderId: row.orderId,
      returnItemId: row.returnItemId,
      ip: hideActor ? hiddenText(row.ip) : row.ip,
      userAgent: hideActor ? hiddenText(row.userAgent) : row.userAgent,
      changes: changes as never[],
    };
  },
  csv: {
    id: [{ header: 'id', kind: 'number', value: (row) => row.id as number }],
    createdAt: [{ header: 'createdAt', kind: 'text', value: (row) => row.createdAt as string }],
    actorId: [{ header: 'actorId', kind: 'number', value: (row) => row.actorId as number | null }],
    actor: [
      {
        header: 'actorName',
        kind: 'text',
        value: (row) => (row.actor as AdminStockLogItemDto['actor'])?.name ?? null,
      },
      {
        header: 'actorEmail',
        kind: 'text',
        value: (row) => (row.actor as AdminStockLogItemDto['actor'])?.email ?? null,
      },
    ],
    actorRole: [
      { header: 'actorRole', kind: 'text', value: (row) => row.actorRole as string | null },
    ],
    productId: [{ header: 'productId', kind: 'number', value: (row) => row.productId as number }],
    product: [
      {
        header: 'productName',
        kind: 'text',
        value: (row) => (row.product as { name: string }).name,
      },
    ],
    variantId: [{ header: 'variantId', kind: 'number', value: (row) => row.variantId as number }],
    variant: [
      {
        header: 'variantName',
        kind: 'text',
        value: (row) => (row.variant as { name: string }).name,
      },
      {
        header: 'variantSku',
        kind: 'text',
        value: (row) => (row.variant as { sku: string | null }).sku,
      },
    ],
    event: [{ header: 'event', kind: 'text', value: (row) => row.event as string }],
    quantityChange: [
      {
        header: 'quantityChange',
        kind: 'number',
        value: (row) => row.quantityChange as number,
      },
    ],
    stockAfter: [
      { header: 'stockAfter', kind: 'number', value: (row) => row.stockAfter as number },
    ],
    deliveryId: [
      { header: 'deliveryId', kind: 'text', value: (row) => row.deliveryId as string | null },
    ],
    writeOffId: [
      { header: 'writeOffId', kind: 'text', value: (row) => row.writeOffId as string | null },
    ],
    orderId: [{ header: 'orderId', kind: 'number', value: (row) => row.orderId as number | null }],
    returnItemId: [
      {
        header: 'returnItemId',
        kind: 'number',
        value: (row) => row.returnItemId as number | null,
      },
    ],
    ip: [{ header: 'ip', kind: 'text', value: (row) => row.ip as string | null }],
    userAgent: [
      { header: 'userAgent', kind: 'text', value: (row) => row.userAgent as string | null },
    ],
    changes: [{ header: 'changes', kind: 'text', value: (row) => JSON.stringify(row.changes) }],
  },
};

export function stockLogArgsOf(
  query: AdminStockLogQueryDto,
  actor: { id: UserId; role: Role },
): StockLogArgs {
  return {
    ...journalArgsOf(STOCK_DEF, query as JournalQuery, actor),
    productId: query.productId,
    variantId: query.variantId,
    deliveryId: query.deliveryId?.toLowerCase(),
    writeOffId: query.writeOffId?.toLowerCase(),
    orderId: query.orderId,
    returnId: query.returnId,
    filterValues: filterValuesOf(STOCK_FILTERS, query as Record<string, unknown>),
  };
}

// the filters of the other columns, each by the name of its parameter
export const STOCK_FILTERS: Record<string, ColumnFilter> = {
  actorId: { kind: 'id', sql: l('actorId') },
  actorRole: { kind: 'enum', sql: l('actorRole'), type: 'Role' },
  returnItemId: { kind: 'id', sql: l('returnItemId') },
  categoryId: { kind: 'id', sql: Prisma.sql`p."categoryId"` },
  quantityFrom: { kind: 'atLeast', sql: l('quantityChange') },
  quantityTo: { kind: 'atMost', sql: l('quantityChange') },
  stockAfterFrom: { kind: 'atLeast', sql: l('stockAfter') },
  stockAfterTo: { kind: 'atMost', sql: l('stockAfter') },
  ip: { kind: 'text', sql: l('ip'), rootHidden: true },
  userAgent: { kind: 'contains', sql: l('userAgent'), rootHidden: true },
};

const numberKey = (sql: Prisma.Sql) => ({ sql: () => sql, kind: 'number' as const });

// the keys the lines group by; root is one group of the hidden id for an admin
export const STOCK_GROUPS: GroupsDef = {
  fileName: 'stock-log-groups',
  reason: 'STOCK_LOG_GROUPS_FAILED',
  keys: {
    event: { sql: () => l('event'), kind: 'text' },
    actorRole: { sql: () => Prisma.sql`l."actorRole"::text`, kind: 'text' },
    actorId: {
      sql: (viewer) =>
        viewer === 'ROOT'
          ? l('actorId')
          : Prisma.sql`CASE WHEN ${ROOT_ACTOR} THEN ${HIDDEN_ID} ELSE l."actorId" END`,
      kind: 'number',
    },
    productId: numberKey(l('productId')),
    variantId: numberKey(l('variantId')),
    categoryId: numberKey(Prisma.sql`p."categoryId"`),
    orderId: numberKey(l('orderId')),
    deliveryId: { sql: () => Prisma.sql`l."deliveryId"::text`, kind: 'text' },
    writeOffId: { sql: () => Prisma.sql`l."writeOffId"::text`, kind: 'text' },
    ...timeGroupKeys(l('createdAt')),
  },
  sums: {
    quantityChange: { sql: Prisma.sql`COALESCE(SUM(l."quantityChange"), 0)::int`, kind: 'number' },
  },
};

function filtersOf(args: StockLogArgs): Prisma.Sql[] {
  const parts: Prisma.Sql[] = [];
  if (args.productId !== undefined) parts.push(Prisma.sql`l."productId" = ${args.productId}::int`);
  if (args.variantId !== undefined) parts.push(Prisma.sql`l."variantId" = ${args.variantId}::int`);
  if (args.deliveryId !== undefined) {
    parts.push(Prisma.sql`l."deliveryId" = ${args.deliveryId}::uuid`);
  }
  if (args.writeOffId !== undefined) {
    parts.push(Prisma.sql`l."writeOffId" = ${args.writeOffId}::uuid`);
  }
  if (args.orderId !== undefined) parts.push(Prisma.sql`l."orderId" = ${args.orderId}::int`);
  if (args.returnId !== undefined) {
    parts.push(Prisma.sql`l."returnItemId" IN (
      SELECT ri.id FROM cartlify.return_items AS ri WHERE ri."returnId" = ${args.returnId}::int
    )`);
  }
  parts.push(...columnFiltersSql(STOCK_DEF, STOCK_FILTERS, args.filterValues, args.actorRole));
  // a filter of a person picks none of the lines of root for an admin (journal.helper.ts)
  parts.push(
    ...rootNotPickedSql(
      args.actorRole,
      args.filterValues.actorId !== undefined || args.filterValues.actorRole !== undefined,
      ROOT_ACTOR,
    ),
  );

  return parts;
}

export const listStockLog = (args: StockLogArgs) =>
  listJournal(STOCK_DEF, args, filtersOf(args)) as Promise<GetAdminStockLogResponseDto>;

export const stockLogCsv = (args: StockLogArgs) => journalCsv(STOCK_DEF, args, filtersOf(args));

export const stockGroupsArgsOf = (query: GroupsQuery) => groupsArgsOf(STOCK_GROUPS, query);

export const listStockGroups = (args: StockLogArgs, groups: GroupsArgs) =>
  groupJournal(STOCK_DEF, STOCK_GROUPS, args, groups, filtersOf(args));

export const stockGroupsCsv = (args: StockLogArgs, groups: GroupsArgs) =>
  groupJournalCsv(STOCK_DEF, STOCK_GROUPS, args, groups, filtersOf(args));
