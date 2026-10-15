import { Prisma } from '@prisma/client';
import { describe, expect, it, jest } from '@jest/globals';

import { buildProductUpdateAuditChanges, writeAdminAuditLog } from '@db/adminAudit.helper.js';

type Tx = Parameters<typeof writeAdminAuditLog>[0];
type Product = Parameters<typeof buildProductUpdateAuditChanges>[0];
type RawQuery = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<number>;

const before: Product = {
  name: 'Mug',
  description: 'White',
  price: new Prisma.Decimal('9.99'),
  stock: 10,
  categoryId: 1,
  popularityOverride: 5,
  popularityOverrideUntil: new Date('2026-07-01T00:00:00.000Z'),
  deletedAt: null,
};

const diff = (after: Partial<Product>, input: Record<string, unknown>) =>
  buildProductUpdateAuditChanges(before, { after: { ...before, ...after }, input });

describe('buildProductUpdateAuditChanges', () => {
  it('records nothing when the request changed nothing', () => {
    expect(diff({}, {})).toEqual([]);
  });

  it('records only the fields the request sent', () => {
    expect(diff({ name: 'Cup', stock: 12 }, { name: 'Cup' })).toEqual([
      { field: 'name', old: 'Mug', new: 'Cup' },
    ]);
  });

  it('records nothing for a field sent with the value it already had', () => {
    expect(diff({}, { name: 'Mug', price: 9.99, categoryId: 1, stock: 0 })).toEqual([]);
  });

  it('records every changed field in a fixed order', () => {
    const out = diff(
      {
        name: 'Cup',
        description: '',
        categoryId: 2,
        price: new Prisma.Decimal('12.50'),
        stock: 15,
        popularityOverride: null,
        popularityOverrideUntil: null,
      },
      {
        name: 'Cup',
        description: '',
        categoryId: 2,
        price: 12.5,
        stock: 5,
        popularityOverride: null,
        popularityOverrideUntil: null,
      },
    );

    expect(out).toEqual([
      { field: 'name', old: 'Mug', new: 'Cup' },
      { field: 'description', old: 'White', new: '' },
      { field: 'categoryId', old: 1, new: 2 },
      { field: 'price', old: '9.99', new: '12.5' },
      { field: 'stock', old: 10, new: 15 },
      { field: 'popularityOverride', old: 5, new: null },
      { field: 'popularityOverrideUntil', old: '2026-07-01T00:00:00.000Z', new: null },
    ]);
  });

  it('compares prices by value, so 9.90 and 9.9 are the same price', () => {
    const same = buildProductUpdateAuditChanges(
      { ...before, price: new Prisma.Decimal('9.90') },
      { after: { ...before, price: new Prisma.Decimal('9.9') }, input: { price: 9.9 } },
    );

    expect(same).toEqual([]);
  });

  it('compares dates by the moment, not by the object', () => {
    const moment = new Date(before.popularityOverrideUntil!.getTime());

    expect(diff({ popularityOverrideUntil: moment }, { popularityOverrideUntil: moment })).toEqual(
      [],
    );
  });

  it('records a deletion as iso dates', () => {
    const deletedAt = new Date('2026-08-01T10:00:00.000Z');

    expect(diff({ deletedAt }, { deletedAt })).toEqual([
      { field: 'deletedAt', old: null, new: '2026-08-01T10:00:00.000Z' },
    ]);
  });
});

describe('writeAdminAuditLog', () => {
  const fakeTx = () => {
    const $executeRaw = jest.fn<RawQuery>(async () => 1);
    return { tx: { $executeRaw } as unknown as Tx, $executeRaw };
  };

  const entry = {
    actorId: 1,
    actorRole: 'ADMIN',
    entityType: 'product' as const,
    entityId: 4,
    action: 'PRODUCT_UPDATE' as const,
  };

  it('writes nothing when there are no changes', async () => {
    const { tx, $executeRaw } = fakeTx();

    await writeAdminAuditLog(tx, { ...entry, changes: [] });

    expect($executeRaw).not.toHaveBeenCalled();
  });

  it('passes the actor, the entity and the changes as json to the database function', async () => {
    const { tx, $executeRaw } = fakeTx();
    const changes = [{ field: 'name', old: 'Mug', new: 'Cup' }];

    await writeAdminAuditLog(tx, { ...entry, changes });

    const [strings, ...values] = $executeRaw.mock.calls[0]!;
    expect(strings.join('?')).toContain('cartlify.log_admin_action(');
    expect(values).toEqual([1, 'ADMIN', 'product', 4, 'PRODUCT_UPDATE', JSON.stringify(changes)]);
  });
});
