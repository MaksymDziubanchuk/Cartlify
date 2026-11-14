import { Prisma } from '@prisma/client';

import { MONEY_LOG_EVENTS } from '@config/journalEvents.js';
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
  AdminMoneyLogItemDto,
  AdminMoneyLogQueryDto,
  AdminMoneyPart,
  AdminMoneyPurpose,
  AdminMoneyState,
  GetAdminMoneyLogResponseDto,
} from 'types/dto/admin.dto.js';
import type { UserId } from 'types/ids.js';
import type { Role } from 'types/user.js';

// the money log for admin and root (GET /api/admin/money-log): a line for every part of every
// movement of money (money_log, written only by the functions of the database in the transaction
// that moved it): the payment of an order, a payment the order could not take, a refund and where
// it stands, its failure, the money sent outside the app, the way back paid to the buyer, what the
// shop paid a carrier, what a dispute took and gave back, a correction. Each line has every field
// it was written with: the sum with its sign, what it is about (the order, the buyer, the
// statement, the parcel, the send, the dispute, the line it covers), the payment and the refund at
// the provider, our key of the request, the state of a refund, the reason of a failure, the way and
// the note of money outside the app, and who did it (none for the work of the system) from which
// address and browser. The journal engine gives it its sorts, its period, its events and columns
// (journal.helper.ts); the filters are the order, the buyer, the statement, the dispute, the
// payment, the purpose and the state, and one for every other column (MONEY_FILTERS); the page
// gives the sums of its filters by currency, and the lines group by their keys with their sums
// (GET /api/admin/money-log/groups). The policies let every admin read every line (money_log_select). An
// admin sees the same lines as root with the same filters, and not who root is: in the lines root
// wrote the account, the address and the browser are hidden, and the account of root as a buyer

export type MoneyLogArgs = JournalArgs & {
  orderId?: number | undefined;
  userId?: number | undefined;
  returnId?: number | undefined;
  disputeId?: number | undefined;
  paymentId?: string | undefined;
  purpose?: AdminMoneyPurpose | undefined;
  state?: AdminMoneyState | undefined;
  // the values of the filters of the other columns, by the names of MONEY_FILTERS
  filterValues: Record<string, unknown>;
};

export type MoneyRow = {
  id: number;
  createdAt: Date;
  actorId: number | null;
  actorRole: Role | null;
  actorName: string | null;
  actorEmail: string | null;
  actorRoleNow: Role | null;
  actorDeleted: boolean | null;
  event: string;
  purpose: AdminMoneyPurpose;
  part: AdminMoneyPart;
  amount: Prisma.Decimal | number;
  currency: string | null;
  orderId: number | null;
  userId: number | null;
  userName: string | null;
  userEmail: string | null;
  userRoleNow: Role | null;
  userDeleted: boolean | null;
  returnId: number | null;
  orderShipmentId: number | null;
  disputeId: number | null;
  coversId: number | null;
  provider: string | null;
  paymentId: string | null;
  refundId: string | null;
  transferKey: string | null;
  stripeTxId: string | null;
  bankReference: string | null;
  byDashboard: boolean;
  state: AdminMoneyState | null;
  stateAt: Date | null;
  failure: string | null;
  failureText: string | null;
  method: string | null;
  note: string | null;
  happenedAt: Date | null;
  moneyUse: string | null;
  ip: string | null;
  userAgent: string | null;
  meta: unknown;
};

const l = (column: string) => Prisma.raw(`l."${column}"`);
const text = (column: string) => Prisma.raw(`l."${column}"::text`);

const MONEY_SORTS = {
  id: { sql: Prisma.sql`l.id`, kind: 'number' },
  createdAt: { sql: l('createdAt'), kind: 'date' },
  actorId: { sql: l('actorId'), kind: 'number' },
  actorRole: { sql: text('actorRole'), kind: 'text' },
  event: { sql: l('event'), kind: 'text' },
  purpose: { sql: text('purpose'), kind: 'text' },
  part: { sql: text('part'), kind: 'text' },
  amount: { sql: l('amount'), kind: 'number' },
  currency: { sql: l('currency'), kind: 'text' },
  orderId: { sql: l('orderId'), kind: 'number' },
  userId: { sql: l('userId'), kind: 'number' },
  returnId: { sql: l('returnId'), kind: 'number' },
  orderShipmentId: { sql: l('orderShipmentId'), kind: 'number' },
  disputeId: { sql: l('disputeId'), kind: 'number' },
  coversId: { sql: l('coversId'), kind: 'number' },
  provider: { sql: text('provider'), kind: 'text' },
  paymentId: { sql: l('paymentId'), kind: 'text' },
  refundId: { sql: l('refundId'), kind: 'text' },
  transferKey: { sql: l('transferKey'), kind: 'text' },
  stripeTxId: { sql: l('stripeTxId'), kind: 'text' },
  bankReference: { sql: l('bankReference'), kind: 'text' },
  byDashboard: { sql: l('byDashboard'), kind: 'boolean' },
  state: { sql: text('state'), kind: 'text' },
  stateAt: { sql: l('stateAt'), kind: 'date' },
  failure: { sql: text('failure'), kind: 'text' },
  failureText: { sql: l('failureText'), kind: 'text' },
  method: { sql: text('method'), kind: 'text' },
  note: { sql: l('note'), kind: 'text' },
  happenedAt: { sql: l('happenedAt'), kind: 'date' },
  moneyUse: { sql: text('moneyUse'), kind: 'text' },
  ip: { sql: l('ip'), kind: 'text' },
  userAgent: { sql: l('userAgent'), kind: 'text' },
} as const;

type MoneyItem = Partial<AdminMoneyLogItemDto> & Record<string, unknown>;

const iso = (value: Date | null) => (value === null ? null : value.toISOString());

// a line as admin or root reads it. Root, whoever it is now, is hidden from an admin: as the
// account that wrote the line (with the address and the browser of its request) and as the buyer
// the money is of; the role stays, and what the line says of the money stays
export function moneyLogItemOf(row: MoneyRow, viewer: Role): MoneyItem {
  const hideActor = viewer !== 'ROOT' && (row.actorRole === 'ROOT' || row.actorRoleNow === 'ROOT');
  const hideUser = viewer !== 'ROOT' && row.userRoleNow === 'ROOT';

  // a deleted account keeps its lines, not its address; the work of the system has no account
  const actorEmail = row.actorDeleted ? null : row.actorEmail;
  const userEmail = row.userDeleted ? null : row.userEmail;
  const userDeleted = row.userDeleted ?? false;

  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    actorId: row.actorId === null ? null : hideActor ? HIDDEN_ID : (row.actorId as UserId),
    actor:
      row.actorId === null || row.actorRoleNow === null
        ? null
        : hideActor
          ? hiddenAccount(row.actorName, actorEmail)
          : {
              id: row.actorId as UserId,
              name: row.actorName,
              email: actorEmail,
              role: row.actorRoleNow,
            },
    actorRole: row.actorRole,
    event: row.event,
    purpose: row.purpose,
    part: row.part,
    amount: Number(row.amount),
    currency: row.currency,
    orderId: row.orderId,
    userId: row.userId === null ? null : hideUser ? HIDDEN_ID : (row.userId as UserId),
    user:
      row.userId === null || row.userRoleNow === null
        ? null
        : hideUser
          ? { ...hiddenAccount(row.userName, userEmail), deleted: userDeleted }
          : {
              id: row.userId as UserId,
              name: row.userName,
              email: userEmail,
              role: row.userRoleNow,
              deleted: userDeleted,
            },
    returnId: row.returnId,
    orderShipmentId: row.orderShipmentId,
    disputeId: row.disputeId,
    coversId: row.coversId,
    provider: row.provider,
    paymentId: row.paymentId,
    refundId: row.refundId,
    transferKey: row.transferKey,
    stripeTxId: row.stripeTxId,
    bankReference: row.bankReference,
    byDashboard: row.byDashboard,
    state: row.state,
    stateAt: iso(row.stateAt),
    failure: row.failure,
    failureText: row.failureText,
    method: row.method,
    note: row.note,
    happenedAt: iso(row.happenedAt),
    moneyUse: row.moneyUse,
    ip: hideActor ? hiddenText(row.ip) : row.ip,
    userAgent: hideActor ? hiddenText(row.userAgent) : row.userAgent,
    meta: Array.isArray(row.meta) ? (row.meta as Array<Record<string, unknown>>) : [],
  };
}

type Csv = JournalDef<MoneyRow, MoneyItem>['csv'][string];

const numberColumn = (name: string): Csv => [
  { header: name, kind: 'number', value: (row) => row[name] as number | null },
];
const textColumn = (name: string): Csv => [
  { header: name, kind: 'text', value: (row) => row[name] as string | null },
];
const accountColumns = (name: 'actor' | 'user'): Csv => [
  {
    header: `${name}Name`,
    kind: 'text',
    value: (row) => (row[name] as { name: string | null } | null)?.name ?? null,
  },
  {
    header: `${name}Email`,
    kind: 'text',
    value: (row) => (row[name] as { email: string | null } | null)?.email ?? null,
  },
];

// a line root wrote, or whose account is root's now: what an admin does not see of it
const ROOT_ACTOR = Prisma.sql`(l."actorRole" = 'ROOT'::cartlify."Role" OR a.role = 'ROOT'::cartlify."Role")`;

// a line whose buyer is root now
const ROOT_BUYER = Prisma.sql`b.role = 'ROOT'::cartlify."Role"`;

const MONEY_DEF: JournalDef<MoneyRow, MoneyItem> = {
  fileName: 'money-log',
  rootLine: ROOT_ACTOR,
  // the sums of the lines of the filters, a sum for each currency
  sums: {
    sql: (where) => Prisma.sql`
      SELECT COALESCE(
        jsonb_agg(jsonb_build_object('currency', s.currency, 'amount', s.amount) ORDER BY s.currency NULLS FIRST),
        '[]'::jsonb
      ) AS sums
      FROM (
        SELECT l.currency, to_char(SUM(l.amount), 'FM999999999990.00') AS amount
        FROM cartlify.money_log AS l
          LEFT JOIN cartlify.users AS a ON a.id = l."actorId"
          LEFT JOIN cartlify.users AS b ON b.id = l."userId"
        ${where}
        GROUP BY l.currency
      ) AS s`,
    of: (raw) =>
      ((raw ?? []) as { currency: string | null; amount: string }[]).map((sum) => ({
        currency: sum.currency,
        amount: Number(sum.amount),
      })),
  },
  from: Prisma.sql`cartlify.money_log AS l
    LEFT JOIN cartlify.users AS a ON a.id = l."actorId"
    LEFT JOIN cartlify.users AS b ON b.id = l."userId"`,
  select: Prisma.sql`
    l.id, l."createdAt", l."actorId", l."actorRole", a.name AS "actorName",
    a.email AS "actorEmail", a.role AS "actorRoleNow", (a."deletedAt" IS NOT NULL) AS "actorDeleted",
    l.event, l.purpose::text AS purpose, l.part::text AS part, l.amount, l.currency, l."orderId",
    l."userId", b.name AS "userName", b.email AS "userEmail", b.role AS "userRoleNow",
    (b."deletedAt" IS NOT NULL) AS "userDeleted", l."returnId",
    l."orderShipmentId", l."disputeId", l."coversId", l.provider::text AS provider, l."paymentId",
    l."refundId", l."transferKey", l."stripeTxId", l."bankReference", l."byDashboard",
    l.state::text AS state, l."stateAt", l.failure::text AS failure, l."failureText",
    l.method::text AS method, l.note, l."happenedAt", l."moneyUse"::text AS "moneyUse", l.ip,
    l."userAgent", l.meta`,
  createdAt: l('createdAt'),
  event: l('event'),
  columns: [
    'id',
    'createdAt',
    'actorId',
    'actor',
    'actorRole',
    'event',
    'purpose',
    'part',
    'amount',
    'currency',
    'orderId',
    'userId',
    'user',
    'returnId',
    'orderShipmentId',
    'disputeId',
    'coversId',
    'provider',
    'paymentId',
    'refundId',
    'transferKey',
    'stripeTxId',
    'bankReference',
    'byDashboard',
    'state',
    'stateAt',
    'failure',
    'failureText',
    'method',
    'note',
    'happenedAt',
    'moneyUse',
    'ip',
    'userAgent',
    'meta',
  ],
  sorts: MONEY_SORTS,
  events: MONEY_LOG_EVENTS,
  reason: 'ADMIN_MONEY_LOG_UNEXPECTED',
  itemOf: moneyLogItemOf,
  csv: {
    id: numberColumn('id'),
    createdAt: textColumn('createdAt'),
    actorId: numberColumn('actorId'),
    actor: accountColumns('actor'),
    actorRole: textColumn('actorRole'),
    event: textColumn('event'),
    purpose: textColumn('purpose'),
    part: textColumn('part'),
    // to the cent, with its sign
    amount: [{ header: 'amount', kind: 'money', value: (row) => row.amount as number }],
    currency: textColumn('currency'),
    orderId: numberColumn('orderId'),
    userId: numberColumn('userId'),
    user: accountColumns('user'),
    returnId: numberColumn('returnId'),
    orderShipmentId: numberColumn('orderShipmentId'),
    disputeId: numberColumn('disputeId'),
    coversId: numberColumn('coversId'),
    provider: textColumn('provider'),
    paymentId: textColumn('paymentId'),
    refundId: textColumn('refundId'),
    transferKey: textColumn('transferKey'),
    stripeTxId: textColumn('stripeTxId'),
    bankReference: textColumn('bankReference'),
    byDashboard: [{ header: 'byDashboard', kind: 'text', value: (row) => String(row.byDashboard) }],
    state: textColumn('state'),
    stateAt: textColumn('stateAt'),
    failure: textColumn('failure'),
    failureText: textColumn('failureText'),
    method: textColumn('method'),
    note: textColumn('note'),
    happenedAt: textColumn('happenedAt'),
    moneyUse: textColumn('moneyUse'),
    ip: textColumn('ip'),
    userAgent: textColumn('userAgent'),
    meta: [{ header: 'meta', kind: 'text', value: (row) => JSON.stringify(row.meta) }],
  },
};

export function moneyLogArgsOf(
  query: AdminMoneyLogQueryDto,
  actor: { id: UserId; role: Role },
): MoneyLogArgs {
  return {
    ...journalArgsOf(MONEY_DEF, query as JournalQuery, actor),
    orderId: query.orderId,
    userId: query.userId,
    returnId: query.returnId,
    disputeId: query.disputeId,
    paymentId: query.paymentId,
    purpose: query.purpose,
    state: query.state,
    filterValues: filterValuesOf(MONEY_FILTERS, query as Record<string, unknown>),
  };
}

// the filters of the other columns, each by the name of its parameter
export const MONEY_FILTERS: Record<string, ColumnFilter> = {
  actorId: { kind: 'id', sql: l('actorId') },
  actorRole: { kind: 'enum', sql: l('actorRole'), type: 'Role' },
  part: { kind: 'enum', sql: l('part'), type: 'MoneyPart' },
  currency: { kind: 'text', sql: l('currency') },
  amountFrom: { kind: 'atLeast', sql: l('amount') },
  amountTo: { kind: 'atMost', sql: l('amount') },
  orderShipmentId: { kind: 'id', sql: l('orderShipmentId') },
  coversId: { kind: 'id', sql: l('coversId') },
  provider: { kind: 'enum', sql: l('provider'), type: 'PaymentProvider' },
  refundId: { kind: 'text', sql: l('refundId') },
  transferKey: { kind: 'text', sql: l('transferKey') },
  stripeTxId: { kind: 'text', sql: l('stripeTxId') },
  bankReference: { kind: 'contains', sql: l('bankReference') },
  byDashboard: { kind: 'boolean', sql: l('byDashboard') },
  failure: { kind: 'enum', sql: l('failure'), type: 'RefundFailure' },
  method: { kind: 'enum', sql: l('method'), type: 'OutsideMethod' },
  moneyUse: { kind: 'enum', sql: l('moneyUse'), type: 'MoneyUse' },
  note: { kind: 'contains', sql: l('note') },
  stateFrom: { kind: 'from', sql: l('stateAt') },
  stateTo: { kind: 'to', sql: l('stateAt') },
  happenedFrom: { kind: 'from', sql: l('happenedAt') },
  happenedTo: { kind: 'to', sql: l('happenedAt') },
  ip: { kind: 'text', sql: l('ip'), rootHidden: true },
  userAgent: { kind: 'contains', sql: l('userAgent'), rootHidden: true },
};

const textKey = (column: string) => ({
  sql: () => Prisma.sql`${l(column)}::text`,
  kind: 'text' as const,
});
const numberKey = (column: string) => ({ sql: () => l(column), kind: 'number' as const });

// the keys the lines group by; root is one group of the hidden id for an admin, as the actor and as
// the buyer
export const MONEY_GROUPS: GroupsDef = {
  fileName: 'money-log-groups',
  reason: 'MONEY_LOG_GROUPS_FAILED',
  keys: {
    event: textKey('event'),
    purpose: textKey('purpose'),
    part: textKey('part'),
    currency: textKey('currency'),
    provider: textKey('provider'),
    state: textKey('state'),
    failure: textKey('failure'),
    method: textKey('method'),
    moneyUse: textKey('moneyUse'),
    actorRole: textKey('actorRole'),
    actorId: {
      sql: (viewer) =>
        viewer === 'ROOT'
          ? l('actorId')
          : Prisma.sql`CASE WHEN ${ROOT_ACTOR} THEN ${HIDDEN_ID} ELSE l."actorId" END`,
      kind: 'number',
    },
    userId: {
      sql: (viewer) =>
        viewer === 'ROOT'
          ? l('userId')
          : Prisma.sql`CASE WHEN b.role = 'ROOT'::cartlify."Role" THEN ${HIDDEN_ID} ELSE l."userId" END`,
      kind: 'number',
    },
    orderId: numberKey('orderId'),
    returnId: numberKey('returnId'),
    disputeId: numberKey('disputeId'),
    ...timeGroupKeys(l('createdAt')),
  },
  sums: {
    amount: { sql: Prisma.sql`to_char(SUM(l.amount), 'FM999999999990.00')`, kind: 'money' },
  },
};

function filtersOf(args: MoneyLogArgs): Prisma.Sql[] {
  const parts: Prisma.Sql[] = [];
  if (args.orderId !== undefined) parts.push(Prisma.sql`l."orderId" = ${args.orderId}::int`);
  if (args.userId !== undefined) parts.push(Prisma.sql`l."userId" = ${args.userId}::int`);
  if (args.returnId !== undefined) parts.push(Prisma.sql`l."returnId" = ${args.returnId}::int`);
  if (args.disputeId !== undefined) parts.push(Prisma.sql`l."disputeId" = ${args.disputeId}::int`);
  if (args.paymentId !== undefined) parts.push(Prisma.sql`l."paymentId" = ${args.paymentId}`);
  if (args.purpose !== undefined) {
    parts.push(Prisma.sql`l.purpose = ${args.purpose}::cartlify."MoneyPurpose"`);
  }
  if (args.state !== undefined)
    parts.push(Prisma.sql`l.state = ${args.state}::cartlify."MoneyState"`);
  parts.push(...columnFiltersSql(MONEY_DEF, MONEY_FILTERS, args.filterValues, args.actorRole));
  // a filter of who did it, or of the buyer, picks none of the lines of root for an admin, but for
  // one with the right of the money (journal.helper.ts)
  parts.push(
    ...rootNotPickedSql(
      args.actorRole,
      args.filterValues.actorId !== undefined || args.filterValues.actorRole !== undefined,
      ROOT_ACTOR,
      Prisma.sql`cartlify.money_manager()`,
    ),
    ...rootNotPickedSql(
      args.actorRole,
      args.userId !== undefined,
      ROOT_BUYER,
      Prisma.sql`cartlify.money_manager()`,
    ),
  );

  return parts;
}

export const listMoneyLog = (args: MoneyLogArgs) =>
  listJournal(MONEY_DEF, args, filtersOf(args)) as Promise<GetAdminMoneyLogResponseDto>;

export const moneyLogCsv = (args: MoneyLogArgs) => journalCsv(MONEY_DEF, args, filtersOf(args));

export const moneyGroupsArgsOf = (query: GroupsQuery) => groupsArgsOf(MONEY_GROUPS, query);

export const listMoneyGroups = (args: MoneyLogArgs, groups: GroupsArgs) =>
  groupJournal(MONEY_DEF, MONEY_GROUPS, args, groups, filtersOf(args));

export const moneyGroupsCsv = (args: MoneyLogArgs, groups: GroupsArgs) =>
  groupJournalCsv(MONEY_DEF, MONEY_GROUPS, args, groups, filtersOf(args));
