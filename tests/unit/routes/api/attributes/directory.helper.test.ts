import { describe, expect, it, jest } from '@jest/globals';

import { Prisma } from '@prisma/client';

import {
  isForeignKeyViolation,
  isForeignKeyViolationOn,
  isUniqueViolationOn,
  writeListOrder,
  type Tx,
} from '@routes/api/attributes/services/helpers/directory.helper.js';

import type { AttributeActorDto } from 'types/dto/attributes.dto.js';

// a key that is checked at the end of the transaction (the places of the directory) fails when the
// transaction commits, and the driver adapter raises it bare, not as a Prisma error: its cause names
// the kind and the constraint

const adapterError = (cause: object) =>
  Object.assign(new Error('adapter failed', { cause }), { name: 'DriverAdapterError' });

describe('isUniqueViolationOn', () => {
  it('knows a unique key by the end of its name when the adapter raises it at the commit', () => {
    const err = adapterError({
      kind: 'UniqueConstraintViolation',
      constraint: { index: 'attribute_groups_position_key' },
    });

    expect(isUniqueViolationOn(err, '_position_key')).toBe(true);
    expect(isUniqueViolationOn(err, 'attributes_name_uidx')).toBe(false);
  });

  it('does not take another kind of failure, or an error that is no adapter error', () => {
    expect(
      isUniqueViolationOn(
        adapterError({
          kind: 'ForeignKeyConstraintViolation',
          constraint: { index: 'attribute_groups_position_key' },
        }),
        '_position_key',
      ),
    ).toBe(false);
    expect(isUniqueViolationOn(new Error('_position_key'), '_position_key')).toBe(false);
    expect(isUniqueViolationOn(null, '_position_key')).toBe(false);
  });
});

describe('isForeignKeyViolation', () => {
  it('knows a foreign key raised at the commit', () => {
    expect(isForeignKeyViolation(adapterError({ kind: 'ForeignKeyConstraintViolation' }))).toBe(
      true,
    );
  });

  it('does not take a unique key, or an error that is no adapter error', () => {
    expect(isForeignKeyViolation(adapterError({ kind: 'UniqueConstraintViolation' }))).toBe(false);
    expect(isForeignKeyViolation(new Error('failed'))).toBe(false);
  });
});

describe('isForeignKeyViolationOn', () => {
  it('knows a foreign key by the end of its name, as prisma and as the adapter raise it', () => {
    const prisma = new Prisma.PrismaClientKnownRequestError(
      'Foreign key constraint violated on the constraint: `variant_images_imageId_fkey`',
      {
        code: 'P2003',
        clientVersion: 'test',
        meta: { constraint: 'variant_images_imageId_fkey' },
      },
    );
    const adapter = adapterError({
      kind: 'ForeignKeyConstraintViolation',
      constraint: { index: 'variant_images_imageId_fkey' },
    });

    expect(isForeignKeyViolationOn(prisma, '_imageId_fkey')).toBe(true);
    expect(isForeignKeyViolationOn(adapter, '_imageId_fkey')).toBe(true);
    expect(isForeignKeyViolationOn(prisma, '_variantId_fkey')).toBe(false);
    expect(isForeignKeyViolationOn(adapter, '_variantId_fkey')).toBe(false);
  });

  it('does not take a unique key, or an error that is no database error', () => {
    expect(
      isForeignKeyViolationOn(
        adapterError({ kind: 'UniqueConstraintViolation', constraint: { index: 'a_fkey' } }),
        '_fkey',
      ),
    ).toBe(false);
    expect(isForeignKeyViolationOn(new Error('_fkey'), '_fkey')).toBe(false);
    expect(isForeignKeyViolationOn(null, '_fkey')).toBe(false);
  });
});

// a new order of a whole list of the directory. A statement for each row that moved (its place and
// its line of the log) ran a list of hundreds past the time of its transaction (409 RESOURCE_BUSY
// in a full run of the tests): however long the list, the places go in one statement and the
// lines of the log in one more
describe('writeListOrder', () => {
  const ACTOR = { actorId: 7, actorRole: 'ADMIN' } as unknown as AttributeActorDto;

  const fakeTx = () => {
    const $executeRaw = jest.fn<(...args: unknown[]) => Promise<number>>(async () => 1);
    return { tx: { $executeRaw } as unknown as Tx, $executeRaw };
  };

  const placesOf = ($executeRaw: ReturnType<typeof fakeTx>['$executeRaw']) =>
    ($executeRaw.mock.calls[0]![0] as Prisma.Sql).values;

  it('writes the places of every row that moved in one statement and their log in one more', async () => {
    const { tx, $executeRaw } = fakeTx();
    const ids = Array.from({ length: 500 }, (_, at) => at + 1);

    await writeListOrder(tx, ACTOR, {
      table: 'attribute_groups',
      event: 'attribute_group.reorder',
      before: new Map(ids.map((id) => [id, id])),
      ids: [...ids].reverse(),
    });

    expect($executeRaw).toHaveBeenCalledTimes(2);
    // the places: the ids that moved and the place each takes, side by side
    expect(placesOf($executeRaw)).toEqual([[...ids].reverse(), ids]);

    // the log: a line for each row that moved, its place before and after
    const [, ...logValues] = $executeRaw.mock.calls[1]!;
    expect(logValues).toEqual(
      expect.arrayContaining(['attribute_group.reorder', 'attribute', 'OTHER']),
    );
    const lines = JSON.parse(
      logValues.find((value) => typeof value === 'string' && value.startsWith('[')) as string,
    );
    expect(lines).toHaveLength(500);
    expect(lines[0]).toEqual({
      entityId: 500,
      changes: [{ field: 'position', old: 500, new: 1 }],
    });
  });

  it('names only the rows that moved', async () => {
    const { tx, $executeRaw } = fakeTx();

    await writeListOrder(tx, ACTOR, {
      table: 'attributes',
      event: 'attribute.reorder',
      before: new Map([
        [1, 1],
        [2, 2],
        [3, 3],
      ]),
      ids: [1, 3, 2],
    });

    expect(placesOf($executeRaw)).toEqual([
      [3, 2],
      [2, 3],
    ]);
  });

  it('writes nothing when no row moved', async () => {
    const { tx, $executeRaw } = fakeTx();

    await writeListOrder(tx, ACTOR, {
      table: 'attribute_options',
      event: 'attribute_option.reorder',
      before: new Map([
        [1, 1],
        [2, 2],
      ]),
      ids: [1, 2],
    });

    expect($executeRaw).not.toHaveBeenCalled();
  });
});
