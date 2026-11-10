import { describe, expect, it } from '@jest/globals';

import { encodeCursor } from '@helpers/codeCursor.js';
import {
  NO_LOCALE_FILTER,
  SUBSCRIBERS_DEFAULT_LIMIT,
  buildSubscribersCountQuery,
  buildSubscribersPageQuery,
  normalizeSubscribersQuery,
  subscribersNextCursor,
  type SubscriberRow,
} from '@routes/api/newsletters/services/helpers/subscribersList.helper.js';

const ACTOR = { actorId: 1, actorRole: 'ADMIN' } as const;
const normalize = (query: Record<string, unknown> = {}) =>
  normalizeSubscribersQuery({ ...ACTOR, ...query });

describe('the query of the list of subscribers', () => {
  it('has no filter and a page of the default size when nothing is asked', () => {
    expect(normalize()).toEqual({
      limit: SUBSCRIBERS_DEFAULT_LIMIT,
      email: null,
      statuses: null,
      sources: null,
      locales: null,
      withoutLocale: false,
      after: null,
    });
  });

  it('cuts the spaces around the part of an address and reads spaces alone as none', () => {
    expect(normalize({ email: '  Reader@  ' }).email).toBe('Reader@');
    expect(normalize({ email: '    ' }).email).toBeNull();
  });

  it('reads names through commas, each once', () => {
    expect(normalize({ status: 'active,ended,active' }).statuses).toEqual(['active', 'ended']);
    expect(normalize({ source: 'form' }).sources).toEqual(['form']);
  });

  it('keeps the subscriptions without a language apart from the languages', () => {
    expect(normalize({ locale: `uk,${NO_LOCALE_FILTER}` })).toMatchObject({
      locales: ['uk'],
      withoutLocale: true,
    });
    expect(normalize({ locale: NO_LOCALE_FILTER })).toMatchObject({
      locales: [],
      withoutLocale: true,
    });
    expect(normalize({ locale: 'es' })).toMatchObject({ locales: ['es'], withoutLocale: false });
  });

  it('caps the page at a hundred rows', () => {
    expect(normalize({ limit: 100 }).limit).toBe(100);
    expect(normalize({ limit: 5000 }).limit).toBe(100);
  });

  it('takes the row after which the page starts from the cursor', () => {
    expect(normalize({ cursor: encodeCursor({ id: 42, v: null }) }).after).toBe(42);
  });

  it.each([
    ['text that is no cursor', 'abc'],
    ['a cursor without an id', Buffer.from('{"v":null}').toString('base64url')],
    ['a cursor of a text id', Buffer.from('{"id":"7","v":null}').toString('base64url')],
    ['a cursor of an id past the numbers of the database', encodeCursor({ id: 2 ** 31, v: null })],
    ['a cursor of a zero id', encodeCursor({ id: 0, v: null })],
  ])('refuses %s as a cursor', (_what, cursor) => {
    expect(() => normalize({ cursor })).toThrow(
      expect.objectContaining({ errorCode: 'CURSOR_INVALID' }),
    );
  });

  it('hands out the cursor of the last row by its id alone', () => {
    const cursor = subscribersNextCursor({ id: 9 } as SubscriberRow);

    expect(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))).toEqual({
      id: 9,
      v: null,
    });
  });
});

describe('the statements of the list of subscribers', () => {
  const secrets = ['manageSalt', 'manageHash', 'confirmHash', 'emailHmac', 'confirmExpiresAt'];

  it('name the columns one by one and never a secret one', () => {
    const page = buildSubscribersPageQuery(normalize({ email: 'a' })).sql;
    const count = buildSubscribersCountQuery(normalize()).sql;

    for (const text of [page, count]) {
      expect(text).not.toContain('*,');
      expect(text).not.toMatch(/select\s+\*/i);
      for (const secret of secrets) expect(text).not.toContain(secret);
    }
    expect(page).toContain('"endReason"::text AS "endReason"');
  });

  it('take no filter that was not asked, in the page and the total', () => {
    const page = buildSubscribersPageQuery(normalize()).sql;
    const count = buildSubscribersCountQuery(normalize()).sql;

    expect(page).not.toContain('WHERE');
    expect(count).not.toContain('WHERE');
    expect(page).toContain('ORDER BY s.id DESC');
  });

  it('give the total the filters but not the cursor', () => {
    const q = normalize({ status: 'active', cursor: encodeCursor({ id: 5, v: null }) });

    expect(buildSubscribersPageQuery(q).sql).toContain('s.id <');
    expect(buildSubscribersCountQuery(q).sql).not.toContain('s.id <');
    expect(buildSubscribersCountQuery(q).sql).toContain('s.status::text = ANY');
  });

  it('look for an address by like with the signs of like taken as themselves', () => {
    const q = normalize({ email: 'a_b%c\\d' });
    const statement = buildSubscribersPageQuery(q);

    expect(statement.sql).toContain('ILIKE');
    expect(statement.values).toContain('%a\\_b\\%c\\\\d%');
  });

  it('read one more row than the page holds', () => {
    const statement = buildSubscribersPageQuery(normalize({ limit: 3 }));

    expect(statement.values).toContain(4);
  });
});
