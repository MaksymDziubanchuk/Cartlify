import { Prisma } from '@prisma/client';

import { PRICE_LOG_EVENTS } from '@config/journalEvents.js';
import { HIDDEN_ID, hiddenAccount } from '@helpers/rootHidden.js';

import {
  journalArgsOf,
  journalCsv,
  listJournal,
  type JournalArgs,
  type JournalDef,
  type JournalQuery,
} from './helpers/journal.helper.js';

import type {
  AdminPriceLogItemDto,
  AdminPriceLogQueryDto,
  GetAdminPriceLogResponseDto,
} from 'types/dto/admin.dto.js';
import type { UserId } from 'types/ids.js';
import type { Role } from 'types/user.js';

// the log of prices for admin and root (GET /api/admin/price-log): every change of the price of
// every product, with the event that made it: a new price of one product, of many in one request,
// of a selection, the start of a sale and its end. The policies let every admin read it. An admin
// does not see who root is in it: the lines root wrote lose the account (the role stays)

export type PriceLogArgs = JournalArgs & {
  productId?: number | undefined;
  filterActorId?: number | undefined;
  mode?: string | undefined;
};

type PriceRow = {
  id: number;
  createdAt: Date;
  productId: number;
  productName: string;
  actorId: number;
  actorName: string | null;
  actorEmail: string;
  actorRoleNow: Role;
  actorDeleted: boolean;
  event: string;
  oldPrice: Prisma.Decimal;
  newPrice: Prisma.Decimal;
  mode: string;
  value: Prisma.Decimal;
  endsAt: Date | null;
};

const col = (column: string) => Prisma.raw(`l."${column}"`);

const PRICE_SORTS = {
  id: { sql: Prisma.sql`l.id`, kind: 'number' },
  createdAt: { sql: col('createdAt'), kind: 'date' },
  productId: { sql: col('productId'), kind: 'number' },
  actorId: { sql: col('actorId'), kind: 'number' },
  event: { sql: col('event'), kind: 'text' },
  oldPrice: { sql: col('oldPrice'), kind: 'number' },
  newPrice: { sql: col('newPrice'), kind: 'number' },
  mode: { sql: Prisma.sql`l.mode::text`, kind: 'text' },
  value: { sql: col('value'), kind: 'number' },
  endsAt: { sql: col('endsAt'), kind: 'date' },
} as const;

type PriceItem = Partial<AdminPriceLogItemDto> & Record<string, unknown>;

const number = (value: Prisma.Decimal | number) => Number(value);

const PRICE_DEF: JournalDef<PriceRow, PriceItem> = {
  fileName: 'price-log',
  from: Prisma.sql`cartlify.product_price_change_logs AS l
    JOIN cartlify.users AS a ON a.id = l."actorId"
    JOIN cartlify.products AS p ON p.id = l."productId"`,
  select: Prisma.sql`
    l.id, l."createdAt", l."productId", p.name AS "productName", l."actorId",
    a.name AS "actorName", a.email AS "actorEmail", a.role AS "actorRoleNow",
    (a."deletedAt" IS NOT NULL) AS "actorDeleted", l.event, l."oldPrice", l."newPrice",
    l.mode::text AS mode, l.value, l."endsAt"`,
  createdAt: col('createdAt'),
  event: col('event'),
  columns: [
    'id',
    'createdAt',
    'productId',
    'product',
    'actorId',
    'actor',
    'event',
    'oldPrice',
    'newPrice',
    'mode',
    'value',
    'endsAt',
  ],
  sorts: PRICE_SORTS,
  events: PRICE_LOG_EVENTS,
  reason: 'ADMIN_PRICE_LOG_UNEXPECTED',
  itemOf: (row, viewer) => {
    const hide = viewer !== 'ROOT' && row.actorRoleNow === 'ROOT';

    return {
      id: row.id,
      createdAt: row.createdAt.toISOString(),
      productId: row.productId,
      product: { id: row.productId, name: row.productName },
      actorId: hide ? HIDDEN_ID : (row.actorId as UserId),
      actor: hide
        ? hiddenAccount(row.actorName, row.actorDeleted ? null : row.actorEmail)
        : {
            id: row.actorId as UserId,
            name: row.actorName,
            email: row.actorDeleted ? null : row.actorEmail,
            role: row.actorRoleNow,
          },
      event: row.event,
      oldPrice: number(row.oldPrice),
      newPrice: number(row.newPrice),
      mode: row.mode,
      value: number(row.value),
      endsAt: row.endsAt ? row.endsAt.toISOString() : null,
    } as PriceItem;
  },
  csv: {
    id: [{ header: 'id', kind: 'number', value: (row) => row.id as number }],
    createdAt: [{ header: 'createdAt', kind: 'text', value: (row) => row.createdAt as string }],
    productId: [{ header: 'productId', kind: 'number', value: (row) => row.productId as number }],
    product: [
      {
        header: 'productName',
        kind: 'text',
        value: (row) => (row.product as { name: string }).name,
      },
    ],
    actorId: [{ header: 'actorId', kind: 'number', value: (row) => row.actorId as number | null }],
    actor: [
      {
        header: 'actorName',
        kind: 'text',
        value: (row) => (row.actor as { name: string | null }).name,
      },
      {
        header: 'actorEmail',
        kind: 'text',
        value: (row) => (row.actor as { email: string | null }).email,
      },
    ],
    event: [{ header: 'event', kind: 'text', value: (row) => row.event as string }],
    oldPrice: [{ header: 'oldPrice', kind: 'money', value: (row) => row.oldPrice as number }],
    newPrice: [{ header: 'newPrice', kind: 'money', value: (row) => row.newPrice as number }],
    mode: [{ header: 'mode', kind: 'text', value: (row) => row.mode as string }],
    value: [{ header: 'value', kind: 'money', value: (row) => row.value as number }],
    endsAt: [{ header: 'endsAt', kind: 'text', value: (row) => row.endsAt as string | null }],
  },
};

export function priceLogArgsOf(
  query: AdminPriceLogQueryDto,
  actor: { id: UserId; role: Role },
): PriceLogArgs {
  return {
    ...journalArgsOf(PRICE_DEF, query as JournalQuery, actor),
    productId: query.productId,
    filterActorId: query.actorId,
    mode: query.mode,
  };
}

function filtersOf(args: PriceLogArgs): Prisma.Sql[] {
  const parts: Prisma.Sql[] = [];
  if (args.productId !== undefined) parts.push(Prisma.sql`l."productId" = ${args.productId}`);
  if (args.filterActorId !== undefined) parts.push(Prisma.sql`l."actorId" = ${args.filterActorId}`);
  if (args.mode !== undefined)
    parts.push(Prisma.sql`l.mode = ${args.mode}::cartlify."PriceChangeMode"`);

  return parts;
}

export const listPriceLog = (args: PriceLogArgs) =>
  listJournal(PRICE_DEF, args, filtersOf(args)) as Promise<GetAdminPriceLogResponseDto>;

export const priceLogCsv = (args: PriceLogArgs) => journalCsv(PRICE_DEF, args, filtersOf(args));
