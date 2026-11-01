import { describe, expect, it } from '@jest/globals';

import { Prisma } from '@prisma/client';

import {
  isForeignKeyViolation,
  isForeignKeyViolationOn,
  isUniqueViolationOn,
} from '@routes/api/attributes/services/helpers/directory.helper.js';

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
