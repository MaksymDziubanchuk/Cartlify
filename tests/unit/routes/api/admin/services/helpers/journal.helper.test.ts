import { describe, expect, it } from '@jest/globals';
import { Prisma } from '@prisma/client';

import {
  JOURNAL_DEFAULT_LIMIT,
  journalArgsOf,
  type JournalDef,
} from '@routes/api/admin/services/helpers/journal.helper.js';
import type { UserId } from 'types/ids.js';

import { thrownBy } from '../../../../../../helpers/errors.js';

// the engine of the journals: what a query of a journal is made of. The lines themselves come from
// the database (tests/integration/api/admin/journals.test.ts)

const def: JournalDef<{ id: number }, Record<string, unknown>> = {
  fileName: 'test-log',
  from: Prisma.sql`cartlify.admin_audit_log AS l`,
  select: Prisma.sql`l.id`,
  createdAt: Prisma.sql`l."createdAt"`,
  event: Prisma.sql`l.event`,
  columns: ['id', 'createdAt', 'actor', 'event'],
  sorts: {
    id: { sql: Prisma.sql`l.id`, kind: 'number' },
    createdAt: { sql: Prisma.sql`l."createdAt"`, kind: 'date' },
    event: { sql: Prisma.sql`l.event`, kind: 'text' },
  },
  events: ['product.update', 'order.ship', 'legacy.unknown'],
  itemOf: (row) => ({ ...row }),
  csv: {},
  reason: 'TEST_LOG_UNEXPECTED',
};

const actor = { id: 7 as UserId, role: 'ADMIN' as const };
const argsOf = (query: Parameters<typeof journalArgsOf>[1] = {}) =>
  journalArgsOf(def, query, actor);

describe('journalArgsOf', () => {
  it('takes the newest first, every column and every event, a page of the default size', () => {
    expect(argsOf()).toEqual({
      actorId: 7,
      actorRole: 'ADMIN',
      sortBy: 'createdAt',
      sortOrder: 'desc',
      from: undefined,
      to: undefined,
      columns: ['id', 'createdAt', 'actor', 'event'],
      events: undefined,
      limit: JOURNAL_DEFAULT_LIMIT,
      cursor: undefined,
    });
  });

  it('keeps the sort, the order, the page size and the cursor as asked', () => {
    expect(argsOf({ sortBy: 'event', sortOrder: 'asc', limit: 5, cursor: 'abc' })).toMatchObject({
      sortBy: 'event',
      sortOrder: 'asc',
      limit: 5,
      cursor: 'abc',
    });
  });

  it('refuses a sort by a column the journal cannot sort by, and names the ones it can', () => {
    expect(thrownBy(() => argsOf({ sortBy: 'actor' }))).toMatchObject({
      statusCode: 400,
      errorCode: 'LOG_SORT_INVALID',
      details: { sortBy: 'actor', allowed: ['id', 'createdAt', 'event'] },
    });
  });

  it('reads a period and refuses one that ends before it starts', () => {
    const args = argsOf({ from: '2026-10-01T00:00:00.000Z', to: '2026-11-01T00:00:00.000Z' });

    expect(args.from).toEqual(new Date('2026-10-01T00:00:00.000Z'));
    expect(args.to).toEqual(new Date('2026-11-01T00:00:00.000Z'));
    expect(
      thrownBy(() => argsOf({ from: '2026-11-01T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z' })),
    ).toMatchObject({ errorCode: 'INVALID_STATS_PERIOD' });
  });

  describe('the columns', () => {
    it('are the ones asked for, in the order of the journal, each once', () => {
      expect(argsOf({ columns: 'event,id,event' }).columns).toEqual(['id', 'event']);
    });

    it('refuse a column the journal has not, and name it with the ones it has', () => {
      expect(thrownBy(() => argsOf({ columns: 'id,secret,password' }))).toMatchObject({
        statusCode: 400,
        errorCode: 'LOG_COLUMNS_INVALID',
        details: {
          columns: ['secret', 'password'],
          allowed: ['id', 'createdAt', 'actor', 'event'],
        },
      });
    });
  });

  describe('the events', () => {
    it('are the ones asked for, each once', () => {
      expect(argsOf({ events: 'order.ship,product.update,order.ship' }).events).toEqual([
        'order.ship',
        'product.update',
      ]);
    });

    it('take the event of the lines from before the events too', () => {
      expect(argsOf({ events: 'legacy.unknown' }).events).toEqual(['legacy.unknown']);
    });

    it('refuse an event the journal has not, and name it with the ones it has', () => {
      expect(thrownBy(() => argsOf({ events: 'order.ship,order.cancel' }))).toMatchObject({
        statusCode: 400,
        errorCode: 'LOG_EVENTS_INVALID',
        details: {
          events: ['order.cancel'],
          allowed: ['product.update', 'order.ship', 'legacy.unknown'],
        },
      });
    });
  });
});
