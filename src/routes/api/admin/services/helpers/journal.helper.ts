import { Prisma } from '@prisma/client';

import { prisma } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { decodeCursor, encodeCursor } from '@helpers/codeCursor.js';
import { toCsv, type CsvColumn } from '@helpers/csv.js';
import { likePattern } from '@helpers/likePattern.js';
import { BadRequestError, InternalError, isAppError } from '@utils/errors.js';

import { periodOf } from '../stockMovements.service.js';
import { utcTime } from './accountingSql.helper.js';

import type { UserId } from 'types/ids.js';
import type { Role } from 'types/user.js';

// the engine of the journals an admin reads (the admin log, the log of prices, the logins, the
// consents, the stock and the money): the same for each. A journal sorts by any simple column both
// ways (rows without a value last, the id breaking ties), reads a period of the time of the line,
// takes the lines of some
// events, gives some columns only (in the page and in the csv), counts the lines of its filters and
// pages by a cursor that holds its sort. Admin and root see the same lines with the same filters
// and sorts; what a journal knows about the account of root (who, from where) is hidden from an
// admin by the server, not by the database: the values only, the answer keeps its shape
// (helpers/rootHidden.ts)

export type SortKind = 'number' | 'text' | 'date' | 'boolean';

export type Sorting = {
  // the value the sort goes by, over the alias l of the table of the journal
  sql: Prisma.Sql;
  kind: SortKind;
};

export type JournalDef<Row extends { id: number }, Item extends Record<string, unknown>> = {
  // the file name of the csv: cartlify-<name>-<day>.csv
  fileName: string;
  // the tables of the journal, the alias of the line is l
  from: Prisma.Sql;
  // what a line is read with: its columns and what it joins
  select: Prisma.Sql;
  // the time of a line, the event of a line
  createdAt: Prisma.Sql;
  event: Prisma.Sql;
  // the columns of a line as the answer gives them, in their order
  columns: readonly string[];
  // the columns a journal sorts by
  sorts: Record<string, Sorting>;
  // the events a line may have
  events: readonly string[];
  // a row of the query as the answer gives it, the column to its value; what an admin may not see of
  // root is left out here
  itemOf: (row: Row, viewer: Role) => Item;
  // the columns of the csv for each column of the answer
  csv: Record<string, CsvColumn<Item>[]>;
  reason: string;
  // a line whose account is root's: what an admin does not see of it (the address, the browser) is
  // never matched by a filter for an admin
  rootLine?: Prisma.Sql;
  // the sums of the lines of the filters the page gives with them, from the condition of the filters
  sums?: { sql: (where: Prisma.Sql) => Prisma.Sql; of: (raw: unknown) => unknown };
};

export type JournalQuery = {
  sortBy?: string | undefined;
  sortOrder?: 'asc' | 'desc' | undefined;
  from?: string | undefined;
  to?: string | undefined;
  columns?: string | undefined;
  events?: string | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
};

export type JournalArgs = {
  actorId: UserId;
  actorRole: Role;
  sortBy: string;
  sortOrder: 'asc' | 'desc';
  from?: Date | undefined;
  to?: Date | undefined;
  columns: string[];
  events?: string[] | undefined;
  limit: number;
  cursor?: string | undefined;
};

export const JOURNAL_DEFAULT_LIMIT = 20;

const unique = <T>(items: T[]) => [...new Set(items)];

// the columns asked for, in the order of the journal; all of them unless asked
function columnsOf(asked: string | undefined, known: readonly string[]): string[] {
  if (asked === undefined) return [...known];

  const wanted = unique(asked.split(','));
  const unknown = wanted.filter((column) => !known.includes(column));
  if (unknown.length) {
    throw new BadRequestError('LOG_COLUMNS_INVALID', { columns: unknown, allowed: [...known] });
  }

  return known.filter((column) => wanted.includes(column));
}

// the events asked for: each one has to be an event of the journal
function eventsOf(asked: string | undefined, known: readonly string[]): string[] | undefined {
  if (asked === undefined) return undefined;

  const wanted = unique(asked.split(','));
  const unknown = wanted.filter((event) => !known.includes(event));
  if (unknown.length) {
    throw new BadRequestError('LOG_EVENTS_INVALID', { events: unknown, allowed: [...known] });
  }

  return wanted;
}

export function journalArgsOf<Row extends { id: number }, Item extends Record<string, unknown>>(
  def: JournalDef<Row, Item>,
  query: JournalQuery,
  actor: { id: UserId; role: Role },
): JournalArgs {
  const sortBy = query.sortBy ?? 'createdAt';
  if (!Object.hasOwn(def.sorts, sortBy)) {
    throw new BadRequestError('LOG_SORT_INVALID', { sortBy, allowed: Object.keys(def.sorts) });
  }

  return {
    actorId: actor.id,
    actorRole: actor.role,
    sortBy,
    sortOrder: query.sortOrder ?? 'desc',
    ...periodOf(query),
    columns: columnsOf(query.columns, def.columns),
    events: eventsOf(query.events, def.events),
    limit: query.limit ?? JOURNAL_DEFAULT_LIMIT,
    cursor: query.cursor,
  };
}

// A cursor holds the id of the last line and the sort it was made for, not the value the lines
// are sorted by: the value of a line of root (the account, the address, the browser) must not
// reach an admin through a cursor. The value is read from the line when the next page is asked.
type Cursor = { id: number; s: string };

const readCursor = (text: string, key: string): Cursor => {
  const cursor = decodeCursor(text) as unknown as Partial<Cursor>;
  if (cursor.s !== key || !Number.isInteger(cursor.id)) {
    throw new BadRequestError('CURSOR_INVALID');
  }

  return cursor as Cursor;
};

// the lines after the cursor in the order of the sort: the rows without a value come last
// whichever way it goes, and the id breaks ties in the same direction
function afterCursor<Row extends { id: number }, Item extends Record<string, unknown>>(
  def: JournalDef<Row, Item>,
  sorting: Sorting,
  order: 'asc' | 'desc',
  cursor: Cursor,
): Prisma.Sql {
  const idAfter =
    order === 'asc' ? Prisma.sql`l.id > ${cursor.id}` : Prisma.sql`l.id < ${cursor.id}`;
  // the value of the line the cursor names; the aliases of this query shadow the outer ones
  const at = Prisma.sql`(SELECT ${sorting.sql} FROM ${def.from} WHERE l.id = ${cursor.id})`;
  const beyond =
    order === 'asc' ? Prisma.sql`${sorting.sql} > ${at}` : Prisma.sql`${sorting.sql} < ${at}`;

  return Prisma.sql`(CASE WHEN ${at} IS NULL
    THEN (${sorting.sql} IS NULL AND ${idAfter})
    ELSE (${beyond} OR (${sorting.sql} = ${at} AND ${idAfter}) OR ${sorting.sql} IS NULL) END)`;
}

// the conditions the period and the events of the query add to the ones of the journal
function commonWhere<Row extends { id: number }, Item extends Record<string, unknown>>(
  def: JournalDef<Row, Item>,
  args: JournalArgs,
): Prisma.Sql[] {
  const parts: Prisma.Sql[] = [];
  if (args.from) parts.push(Prisma.sql`${def.createdAt} >= ${utcTime(args.from)}`);
  if (args.to) parts.push(Prisma.sql`${def.createdAt} < ${utcTime(args.to)}`);
  if (args.events) parts.push(Prisma.sql`${def.event} = ANY(${args.events}::text[])`);

  return parts;
}

const whereSql = (parts: Prisma.Sql[]) =>
  parts.length ? Prisma.sql`WHERE ${Prisma.join(parts, ' AND ')}` : Prisma.empty;

const itemOfColumns = <Item extends Record<string, unknown>>(item: Item, columns: string[]) =>
  Object.fromEntries(columns.map((column) => [column, item[column]])) as Partial<Item>;

// a page of the journal and how many lines its filters hold
export async function listJournal<Row extends { id: number }, Item extends Record<string, unknown>>(
  def: JournalDef<Row, Item>,
  args: JournalArgs,
  filters: Prisma.Sql[],
) {
  const sorting = def.sorts[args.sortBy]!;
  const key = `${args.sortBy}:${args.sortOrder}`;
  const cursor = args.cursor ? readCursor(args.cursor, key) : null;
  const where = [...filters, ...commonWhere(def, args)];
  const dir = args.sortOrder === 'asc' ? Prisma.sql`ASC` : Prisma.sql`DESC`;

  try {
    const { rows, total, sums } = await prisma.$transaction(async (tx) => {
      await setUserContext(tx, { userId: args.actorId, role: args.actorRole });

      const pageWhere = cursor
        ? [...where, afterCursor(def, sorting, args.sortOrder, cursor)]
        : where;
      const rows = await tx.$queryRaw<Row[]>`
        SELECT ${def.select}
        FROM ${def.from}
        ${whereSql(pageWhere)}
        ORDER BY ${sorting.sql} ${dir} NULLS LAST, l.id ${dir}
        LIMIT ${args.limit + 1}
      `;
      const [count] = await tx.$queryRaw<{ total: number }[]>`
        SELECT count(*)::int AS total FROM ${def.from} ${whereSql(where)}
      `;
      const sums = def.sums
        ? (await tx.$queryRaw<{ sums: unknown }[]>(def.sums.sql(whereSql(where))))[0]?.sums
        : undefined;

      return { rows, total: count?.total ?? 0, sums };
    });

    const page = rows.slice(0, args.limit);
    const last = page[page.length - 1];

    return {
      items: page.map((row) => itemOfColumns(def.itemOf(row, args.actorRole), args.columns)),
      limit: args.limit,
      total,
      nextCursor:
        rows.length > args.limit && last ? encodeCursor({ id: last.id, s: key } as never) : null,
      ...(def.sums ? { sums: def.sums.of(sums) } : {}),
    };
  } catch (err) {
    if (isAppError(err)) throw err;
    throw new InternalError({ reason: def.reason }, err);
  }
}

// every line of the filters as a csv file, without pages, the columns asked for
export async function journalCsv<Row extends { id: number }, Item extends Record<string, unknown>>(
  def: JournalDef<Row, Item>,
  args: JournalArgs,
  filters: Prisma.Sql[],
): Promise<{ fileName: string; body: string }> {
  const sorting = def.sorts[args.sortBy]!;
  const where = [...filters, ...commonWhere(def, args)];
  const dir = args.sortOrder === 'asc' ? Prisma.sql`ASC` : Prisma.sql`DESC`;

  try {
    const rows = await prisma.$transaction(async (tx) => {
      await setUserContext(tx, { userId: args.actorId, role: args.actorRole });

      return tx.$queryRaw<Row[]>`
        SELECT ${def.select}
        FROM ${def.from}
        ${whereSql(where)}
        ORDER BY ${sorting.sql} ${dir} NULLS LAST, l.id ${dir}
      `;
    });

    const columns = args.columns.flatMap((column) => def.csv[column] ?? []);

    return {
      fileName: `cartlify-${def.fileName}-${new Date().toISOString().slice(0, 10)}.csv`,
      body: toCsv(
        columns,
        rows.map((row) => def.itemOf(row, args.actorRole)),
      ),
    };
  } catch (err) {
    if (isAppError(err)) throw err;
    throw new InternalError({ reason: `${def.reason}_CSV` }, err);
  }
}

// ---------------------------------------------------------------- the filters of the columns

// A filter of a column of a journal, by the name of its parameter: an id, a uuid, a text as it is, a
// flag, a value of an enum of the database, a part of a text in any case, the lower or the upper
// bound of a number (taken in) or of a time (from taken in, to left out). A value of a line of root
// an admin does not see (rootHidden: the address, the browser) is never matched for an admin
export type ColumnFilter =
  | { kind: 'id' | 'uuid' | 'boolean'; sql: Prisma.Sql }
  | { kind: 'text' | 'contains'; sql: Prisma.Sql; rootHidden?: boolean }
  | { kind: 'enum'; sql: Prisma.Sql; type: string }
  | { kind: 'atLeast' | 'atMost'; sql: Prisma.Sql }
  | { kind: 'from' | 'to'; sql: Prisma.Sql };

// the values of the filters of a journal the query gives, by the names of the filters
export function filterValuesOf(
  filters: Record<string, ColumnFilter>,
  query: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.keys(filters)
      .filter((name) => query[name] !== undefined)
      .map((name) => [name, query[name]]),
  );
}

// A filter of a person (who did it, whose line it is, a role, an email) picks none of the lines of
// root for anyone but root: an admin sees them in the lists and the sorts, who root is hidden, but
// cannot single them out. picked: the request names such a
// filter; rootLine: the line is of root; allowed: the sql of a viewer who may pick them all the same
// (an admin with the right of the money, in the journal of the money)
export function rootNotPickedSql(
  viewer: Role,
  picked: boolean,
  rootLine: Prisma.Sql,
  allowed?: Prisma.Sql,
): Prisma.Sql[] {
  if (viewer === 'ROOT' || !picked) return [];
  const notRoot = Prisma.sql`NOT COALESCE(${rootLine}, false)`;
  return [allowed ? Prisma.sql`(${allowed} OR ${notRoot})` : notRoot];
}

export function columnFiltersSql<Row extends { id: number }, Item extends Record<string, unknown>>(
  def: JournalDef<Row, Item>,
  filters: Record<string, ColumnFilter>,
  values: Record<string, unknown>,
  viewer: Role,
): Prisma.Sql[] {
  const parts: Prisma.Sql[] = [];
  for (const [name, value] of Object.entries(values)) {
    const filter = filters[name];
    if (!filter || value === undefined) continue;

    switch (filter.kind) {
      case 'id':
        parts.push(Prisma.sql`${filter.sql} = ${Number(value)}::int`);
        break;
      case 'uuid':
        parts.push(Prisma.sql`${filter.sql} = ${String(value)}::uuid`);
        break;
      case 'boolean':
        parts.push(Prisma.sql`${filter.sql} = ${value === true}`);
        break;
      case 'enum':
        parts.push(
          Prisma.sql`${filter.sql} = ${String(value)}::cartlify.${Prisma.raw(`"${filter.type}"`)}`,
        );
        break;
      case 'text':
      case 'contains': {
        const match =
          filter.kind === 'text'
            ? Prisma.sql`${filter.sql} = ${String(value)}`
            : Prisma.sql`${filter.sql} ILIKE ${likePattern(String(value))}`;
        parts.push(
          filter.rootHidden && viewer !== 'ROOT' && def.rootLine
            ? Prisma.sql`(${match} AND NOT (${def.rootLine}))`
            : match,
        );
        break;
      }
      case 'atLeast':
        parts.push(Prisma.sql`${filter.sql} >= ${Number(value)}`);
        break;
      case 'atMost':
        parts.push(Prisma.sql`${filter.sql} <= ${Number(value)}`);
        break;
      case 'from':
        parts.push(Prisma.sql`${filter.sql} >= ${utcTime(new Date(String(value)))}`);
        break;
      case 'to':
        parts.push(Prisma.sql`${filter.sql} < ${utcTime(new Date(String(value)))}`);
        break;
    }
  }

  return parts;
}

// ---------------------------------------------------------------- the groups

// The lines of the filters of a journal taken together by up to three of its keys, with how many
// lines each group has and its sums. A key reads the line l for the viewer: what an admin does not
// see of root (who root is) is one group of the hidden id. The groups sort by a key, by the count or
// by a sum, a page at a time by an offset
export type GroupKey = { sql: (viewer: Role) => Prisma.Sql; kind: 'number' | 'text' };

export type GroupsDef = {
  keys: Record<string, GroupKey>;
  // the sums of a group by their names: an aggregate over l, money as text of two decimals
  sums: Record<string, { sql: Prisma.Sql; kind: 'number' | 'money' }>;
  fileName: string;
  reason: string;
};

export type GroupsQuery = {
  groupBy: string;
  sortBy?: string | undefined;
  sortOrder?: 'asc' | 'desc' | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
};

export type GroupsArgs = {
  groupBy: string[];
  sortBy: string;
  sortOrder: 'asc' | 'desc';
  limit: number;
  offset: number;
};

export const GROUPS_DEFAULT_LIMIT = 100;
export const GROUPS_MAX_KEYS = 3;

export function groupsArgsOf(groups: GroupsDef, query: GroupsQuery): GroupsArgs {
  const groupBy = unique(query.groupBy.split(','));
  const unknown = groupBy.filter((key) => !Object.hasOwn(groups.keys, key));
  if (unknown.length || groupBy.length > GROUPS_MAX_KEYS) {
    throw new BadRequestError('LOG_GROUP_INVALID', {
      groupBy: unknown.length ? unknown : groupBy,
      allowed: Object.keys(groups.keys),
      max: GROUPS_MAX_KEYS,
    });
  }

  const sortBy = query.sortBy ?? 'count';
  const sortable = [...groupBy, 'count', ...Object.keys(groups.sums)];
  if (!sortable.includes(sortBy)) {
    throw new BadRequestError('LOG_SORT_INVALID', { sortBy, allowed: sortable });
  }

  return {
    groupBy,
    sortBy,
    sortOrder: query.sortOrder ?? 'desc',
    limit: query.limit ?? GROUPS_DEFAULT_LIMIT,
    offset: query.offset ?? 0,
  };
}

const quoted = (name: string) => Prisma.raw(`"${name}"`);

function groupsSql<Row extends { id: number }, Item extends Record<string, unknown>>(
  def: JournalDef<Row, Item>,
  groups: GroupsDef,
  args: JournalArgs,
  gargs: GroupsArgs,
  filters: Prisma.Sql[],
  page: boolean,
): Prisma.Sql {
  const where = [...filters, ...commonWhere(def, args)];
  const keys = gargs.groupBy.map(
    (key) => Prisma.sql`${groups.keys[key]!.sql(args.actorRole)} AS ${quoted(key)}`,
  );
  const sums = Object.entries(groups.sums).map(
    ([name, sum]) => Prisma.sql`${sum.sql} AS ${quoted(name)}`,
  );
  const dir = gargs.sortOrder === 'asc' ? Prisma.sql`ASC` : Prisma.sql`DESC`;
  const ties = gargs.groupBy.map((key) => Prisma.sql`${quoted(key)} ASC NULLS LAST`);

  return Prisma.sql`
    WITH g AS (
      SELECT ${Prisma.join([...keys, Prisma.sql`count(*)::int AS count`, ...sums])}
      FROM ${def.from}
      ${whereSql(where)}
      GROUP BY ${Prisma.join(gargs.groupBy.map((_, n) => Prisma.raw(String(n + 1))))}
    )
    SELECT g.*, count(*) OVER ()::int AS "groupsTotal"
    FROM g
    ORDER BY ${quoted(gargs.sortBy)} ${dir} NULLS LAST, ${Prisma.join(ties)}
    ${page ? Prisma.sql`LIMIT ${gargs.limit} OFFSET ${gargs.offset}` : Prisma.empty}
  `;
}

function groupOf(groups: GroupsDef, gargs: GroupsArgs, row: Record<string, unknown>) {
  const item: Record<string, unknown> = {};
  for (const key of gargs.groupBy) {
    const value = row[key];
    item[key] =
      value === null || value === undefined
        ? null
        : groups.keys[key]!.kind === 'number'
          ? Number(value)
          : String(value);
  }
  item.count = Number(row.count);
  for (const name of Object.keys(groups.sums)) {
    item[name] = row[name] === null || row[name] === undefined ? 0 : Number(row[name]);
  }
  return item;
}

export async function groupJournal<
  Row extends { id: number },
  Item extends Record<string, unknown>,
>(
  def: JournalDef<Row, Item>,
  groups: GroupsDef,
  args: JournalArgs,
  gargs: GroupsArgs,
  filters: Prisma.Sql[],
) {
  try {
    const rows = await prisma.$transaction(async (tx) => {
      await setUserContext(tx, { userId: args.actorId, role: args.actorRole });
      return tx.$queryRaw<Record<string, unknown>[]>(
        groupsSql(def, groups, args, gargs, filters, true),
      );
    });

    return {
      items: rows.map((row) => groupOf(groups, gargs, row)),
      total: rows.length ? Number(rows[0]!.groupsTotal) : 0,
      limit: gargs.limit,
      offset: gargs.offset,
    };
  } catch (err) {
    if (isAppError(err)) throw err;
    throw new InternalError({ reason: groups.reason }, err);
  }
}

// every group of the filters as a csv file, without pages: the keys, the count and the sums
export async function groupJournalCsv<
  Row extends { id: number },
  Item extends Record<string, unknown>,
>(
  def: JournalDef<Row, Item>,
  groups: GroupsDef,
  args: JournalArgs,
  gargs: GroupsArgs,
  filters: Prisma.Sql[],
): Promise<{ fileName: string; body: string }> {
  try {
    const rows = await prisma.$transaction(async (tx) => {
      await setUserContext(tx, { userId: args.actorId, role: args.actorRole });
      return tx.$queryRaw<Record<string, unknown>[]>(
        groupsSql(def, groups, args, gargs, filters, false),
      );
    });
    type Group = Record<string, unknown>;
    const columns: CsvColumn<Group>[] = [
      ...gargs.groupBy.map((key) => ({
        header: key,
        kind: groups.keys[key]!.kind === 'number' ? ('number' as const) : ('text' as const),
        value: (row: Group) => row[key] as string | number | null,
      })),
      { header: 'count', kind: 'number' as const, value: (row: Group) => row.count as number },
      ...Object.entries(groups.sums).map(([name, sum]) => ({
        header: name,
        kind: sum.kind === 'money' ? ('money' as const) : ('number' as const),
        value: (row: Group) => row[name] as number,
      })),
    ];

    return {
      fileName: `cartlify-${groups.fileName}-${new Date().toISOString().slice(0, 10)}.csv`,
      body: toCsv(
        columns,
        rows.map((row) => groupOf(groups, gargs, row)),
      ),
    };
  } catch (err) {
    if (isAppError(err)) throw err;
    throw new InternalError({ reason: `${groups.reason}_CSV` }, err);
  }
}

// the keys of the time of a line every journal groups by: the day, the week (from its Monday) and
// the month, in utc as the times of the lines
export const timeGroupKeys = (createdAt: Prisma.Sql): Record<string, GroupKey> => ({
  day: { sql: () => Prisma.sql`to_char(${createdAt}, 'YYYY-MM-DD')`, kind: 'text' },
  week: {
    sql: () => Prisma.sql`to_char(date_trunc('week', ${createdAt}), 'YYYY-MM-DD')`,
    kind: 'text',
  },
  month: { sql: () => Prisma.sql`to_char(${createdAt}, 'YYYY-MM')`, kind: 'text' },
});
