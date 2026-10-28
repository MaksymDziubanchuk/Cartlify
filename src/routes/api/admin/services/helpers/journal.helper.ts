import { Prisma } from '@prisma/client';

import { prisma } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { decodeCursor, encodeCursor } from '@helpers/codeCursor.js';
import { toCsv, type CsvColumn } from '@helpers/csv.js';
import { BadRequestError, InternalError, isAppError } from '@utils/errors.js';

import { periodOf } from '../stockMovements.service.js';
import { utcTime } from './accountingSql.helper.js';

import type { UserId } from 'types/ids.js';
import type { Role } from 'types/user.js';

// the engine of the journals an admin reads (the admin log, the log of prices, the logins and the
// consents): the same for each. A journal sorts by any simple column both ways (rows without a value
// last, the id breaking ties), reads a period of the time of the line, takes the lines of some
// events, gives some columns only (in the page and in the csv), counts the lines of its filters and
// pages by a cursor that holds its sort. Admin and root see the same lines with the same filters
// and sorts; what a journal knows about the account of root (who, from where) is hidden from an
// admin by the server, not by the database: the values only, the answer keeps its shape
// (helpers/rootHidden.ts)

export type SortKind = 'number' | 'text' | 'date';

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
  if (!(sortBy in def.sorts)) {
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
    const { rows, total } = await prisma.$transaction(async (tx) => {
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

      return { rows, total: count?.total ?? 0 };
    });

    const page = rows.slice(0, args.limit);
    const last = page[page.length - 1];

    return {
      items: page.map((row) => itemOfColumns(def.itemOf(row, args.actorRole), args.columns)),
      limit: args.limit,
      total,
      nextCursor:
        rows.length > args.limit && last ? encodeCursor({ id: last.id, s: key } as never) : null,
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
