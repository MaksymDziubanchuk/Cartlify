import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import {
  isUuid,
  setActorContext,
  setAdminContext,
  setGuestContext,
  setGuestNullContext,
  setUserContext,
} from '@db/dbContext.service.js';

import { rejectedBy } from '../../helpers/errors.js';

type Tx = Parameters<typeof setUserContext>[0];

// a transaction that only records the context query: the sql text and its parameters
function fakeTx() {
  const queries: Array<{ sql: string; values: unknown[] }> = [];
  const $executeRaw = jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    queries.push({ sql: strings.join('?').replace(/\s+/g, ' '), values });
    return 1;
  });

  return { tx: { $executeRaw } as unknown as Tx, queries };
}

const guestId = randomUUID();

// the day of the shop goes with every context (cartlify.shop_today): it says which batches are
// over; a fixed clock gives a fixed day, Madrid is an hour ahead of utc in winter
const NOW = Date.parse('2026-10-31T23:30:00.000Z');
const TODAY = '2026-11-01';

beforeEach(() => {
  jest.spyOn(Date, 'now').mockReturnValue(NOW);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('isUuid', () => {
  it.each([guestId, guestId.toUpperCase(), '0b9d6f1e-3c2a-1f4b-9e8d-7c6b5a4f3e2d'])(
    'accepts the uuid %s',
    (value) => {
      expect(isUuid(value)).toBe(true);
    },
  );

  it.each([
    ['not a string', 42],
    ['empty', ''],
    ['without dashes', guestId.replaceAll('-', '')],
    ['in braces', `{${guestId}}`],
    ['with extra text', `${guestId} `],
    ['the nil uuid', '00000000-0000-0000-0000-000000000000'],
    ['made of other letters', 'zzzzzzzz-zzzz-4zzz-8zzz-zzzzzzzzzzzz'],
  ])('rejects a value that is %s', (_case, value) => {
    expect(isUuid(value)).toBe(false);
  });
});

describe('setActorContext', () => {
  it('sets a guest context with the guest id', async () => {
    const { tx, queries } = fakeTx();

    await setActorContext(tx, { actorId: guestId, role: 'GUEST' });

    expect(queries).toHaveLength(1);
    expect(queries[0]?.sql).toContain(`'GUEST'::cartlify."Role", NULL, ?::uuid`);
    expect(queries[0]?.values).toEqual([guestId, TODAY]);
  });

  it.each([
    ['no id', undefined, 'GUEST_ID_REQUIRED'],
    ['an id that is not a uuid', 'guest-1', 'GUEST_ID_INVALID'],
    ['a numeric id', 7, 'GUEST_ID_INVALID'],
  ])('rejects a guest with %s before any query', async (_case, actorId, errorCode) => {
    const { tx, queries } = fakeTx();

    expect(await rejectedBy(() => setActorContext(tx, { actorId, role: 'GUEST' }))).toMatchObject({
      statusCode: 400,
      errorCode,
    });
    expect(queries).toHaveLength(0);
  });

  it.each([
    ['USER', 7, 7],
    ['USER', '7', 7],
    ['ADMIN', 12, 12],
    ['ROOT', '1', 1],
  ] as const)('sets a %s context with the numeric id of %p', async (role, actorId, id) => {
    const { tx, queries } = fakeTx();

    await setActorContext(tx, { actorId, role });

    expect(queries[0]?.sql).toContain('?::cartlify."Role", ?::int, NULL');
    expect(queries[0]?.values).toEqual([role, id, TODAY]);
  });

  it.each([
    ['zero', 0],
    ['negative', -3],
    ['a fraction', 1.5],
    ['an exponent', '1e3'],
    ['padded', ' 7'],
    ['a fraction string', '7.0'],
    ['a uuid', guestId],
    ['missing', undefined],
  ])('rejects a user id that is %s before any query', async (_case, actorId) => {
    const { tx, queries } = fakeTx();

    expect(await rejectedBy(() => setActorContext(tx, { actorId, role: 'USER' }))).toMatchObject({
      statusCode: 400,
      errorCode: 'USER_ID_INVALID',
    });
    expect(queries).toHaveLength(0);
  });
});

describe('setUserContext', () => {
  it('sets the role and the user id', async () => {
    const { tx, queries } = fakeTx();

    await setUserContext(tx, { userId: 5, role: 'ADMIN' });

    expect(queries[0]?.values).toEqual(['ADMIN', 5, TODAY]);
  });

  it('takes a numeric string id', async () => {
    const { tx, queries } = fakeTx();

    await setUserContext(tx, { userId: '5', role: 'USER' });

    expect(queries[0]?.values).toEqual(['USER', 5, TODAY]);
  });

  it('requires a role', async () => {
    const { tx, queries } = fakeTx();

    expect(
      await rejectedBy(() => setUserContext(tx, { userId: 5, role: undefined as never })),
    ).toMatchObject({ errorCode: 'ROLE_REQUIRED' });
    expect(queries).toHaveLength(0);
  });

  // a guest id reaching a user context means a guest got into a user-only path
  it.each([0, -1, 2.5, Number.NaN, guestId])('rejects the user id %p', async (userId) => {
    const { tx, queries } = fakeTx();

    expect(await rejectedBy(() => setUserContext(tx, { userId, role: 'USER' }))).toMatchObject({
      statusCode: 400,
      errorCode: 'USER_ID_INVALID',
    });
    expect(queries).toHaveLength(0);
  });
});

describe('contexts without an actor id', () => {
  it('sets an admin context with no ids, for system work like the order worker', async () => {
    const { tx, queries } = fakeTx();

    await setAdminContext(tx);

    expect(queries[0]?.sql).toContain(`'ADMIN'::cartlify."Role", NULL, NULL`);
    expect(queries[0]?.values).toEqual([TODAY]);
  });

  it('sets an anonymous guest context with no ids', async () => {
    const { tx, queries } = fakeTx();

    await setGuestNullContext(tx);

    expect(queries[0]?.sql).toContain(`'GUEST'::cartlify."Role", NULL, NULL`);
    expect(queries[0]?.values).toEqual([TODAY]);
  });

  // one statement: the context and the day of the shop are set together, for the transaction
  it('sets the day of the shop in the same statement as the context, for the transaction only', async () => {
    const { tx, queries } = fakeTx();

    await setAdminContext(tx);

    expect(queries).toHaveLength(1);
    expect(queries[0]?.sql).toContain("set_config('cartlify.shop_today', ?, true)");
  });

  it('requires a guest id for a guest context', async () => {
    const { tx, queries } = fakeTx();

    expect(await rejectedBy(() => setGuestContext(tx, ''))).toMatchObject({
      errorCode: 'GUEST_ID_REQUIRED',
    });
    expect(queries).toHaveLength(0);
  });
});
