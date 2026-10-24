import { Prisma } from '@prisma/client';
import { describe, expect, it, jest } from '@jest/globals';

import {
  buildProductUpdateAuditChanges,
  buildSaleAuditChanges,
  writeAdminAuditLog,
} from '@db/adminAudit.helper.js';

type Tx = Parameters<typeof writeAdminAuditLog>[0];
type Product = Parameters<typeof buildProductUpdateAuditChanges>[0];
type RawQuery = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<number>;

const before: Product = {
  name: 'Mug',
  description: 'White',
  price: new Prisma.Decimal('9.99'),
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

  // an empty article number takes it away: null is a change the log keeps
  it('records a new article number and the one taken away', () => {
    expect(diff({ sku: 'MUG-2' }, { sku: 'MUG-2' })).toEqual([
      { field: 'sku', old: null, new: 'MUG-2' },
    ]);
    expect(
      buildProductUpdateAuditChanges(
        { ...before, sku: 'MUG-1' },
        { after: { ...before, sku: null }, input: { sku: '' } },
      ),
    ).toEqual([{ field: 'sku', old: 'MUG-1', new: null }]);
    expect(diff({ sku: 'MUG-2' }, {})).toEqual([]);
  });

  it('records only the fields the request sent', () => {
    expect(diff({ name: 'Cup', categoryId: 4 }, { name: 'Cup' })).toEqual([
      { field: 'name', old: 'Mug', new: 'Cup' },
    ]);
  });

  it('records nothing for a field sent with the value it already had', () => {
    expect(diff({}, { name: 'Mug', price: 9.99, categoryId: 1 })).toEqual([]);
  });

  it('records every changed field in a fixed order', () => {
    const out = diff(
      {
        name: 'Cup',
        description: '',
        categoryId: 2,
        price: new Prisma.Decimal('12.50'),
        popularityOverride: null,
        popularityOverrideUntil: null,
      },
      {
        name: 'Cup',
        description: '',
        categoryId: 2,
        price: 12.5,
        popularityOverride: null,
        popularityOverrideUntil: null,
      },
    );

    // the text of a description taken away is none, the way the column keeps it
    expect(out).toEqual([
      { field: 'name', old: 'Mug', new: 'Cup' },
      { field: 'description', old: 'White', new: null },
      { field: 'categoryId', old: 1, new: 2 },
      { field: 'price', old: '9.99', new: '12.5' },
      { field: 'popularityOverride', old: 5, new: null },
      { field: 'popularityOverrideUntil', old: '2026-07-01T00:00:00.000Z', new: null },
    ]);
  });

  // the description keeps the text and the safety data in one column: each is a change of its own
  it('records the text and the safety data of the description apart', () => {
    const safety = {
      manufacturer: { name: 'Lampwerk', address: 'Berlin', email: 'a@b.de', country: 'DE' },
      responsiblePerson: null,
      warnings: null,
    };
    const kept = (text: string, data: unknown) => JSON.stringify({ v: 1, text, safety: data });

    expect(
      buildProductUpdateAuditChanges(
        { ...before, description: 'White' },
        { after: { ...before, description: kept('White', safety) }, input: { safety } },
      ),
    ).toEqual([{ field: 'safety', old: null, new: safety }]);
    expect(
      buildProductUpdateAuditChanges(
        { ...before, description: kept('White', safety) },
        {
          after: { ...before, description: kept('Black', safety) },
          input: { description: 'Black' },
        },
      ),
    ).toEqual([{ field: 'description', old: 'White', new: 'Black' }]);
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

  // the sale is not a field of this line: a sale of its own (PRODUCT_SALE) describes it, the end
  // of one by a price down to it is written by the database (db/05)
  it('records no sale, also when the price ended one', () => {
    const out = buildProductUpdateAuditChanges(before, {
      after: { ...before, price: new Prisma.Decimal('8.00') },
      input: { price: 8 },
    });

    expect(out).toEqual([{ field: 'price', old: '9.99', new: '8' }]);
  });
});

// a line of the admin log of a sale (PRODUCT_SALE): what happened, the price, the sale before and
// after it as the answers show it, and the discount the admin gave
describe('buildSaleAuditChanges', () => {
  const ends = (ms: number) => new Date(Date.now() + ms);
  const noSale = { salePrice: null, saleEndsAt: null };
  const price = new Prisma.Decimal('20.00');

  it('describes a sale that starts: the event, the price, the sale and the discount', () => {
    const saleEndsAt = ends(60_000);

    expect(
      buildSaleAuditChanges({
        event: 'start',
        price,
        before: noSale,
        after: { salePrice: new Prisma.Decimal('15.00'), saleEndsAt },
        discount: { percent: 25 },
      }),
    ).toEqual([
      { field: 'event', old: null, new: 'start' },
      { field: 'price', old: '20', new: '20' },
      { field: 'salePrice', old: null, new: '15' },
      { field: 'saleEndsAt', old: null, new: saleEndsAt.toISOString() },
      { field: 'discount', old: null, new: { percent: 25 } },
    ]);
  });

  it('describes a sale written over one that is on, with the sale before it', () => {
    const firstEnd = ends(60_000);
    const secondEnd = ends(120_000);

    expect(
      buildSaleAuditChanges({
        event: 'change',
        price,
        before: { salePrice: new Prisma.Decimal('15.50'), saleEndsAt: firstEnd },
        after: { salePrice: new Prisma.Decimal('12.00'), saleEndsAt: secondEnd },
        discount: { amount: 8 },
      }),
    ).toEqual([
      { field: 'event', old: null, new: 'change' },
      { field: 'price', old: '20', new: '20' },
      { field: 'salePrice', old: '15.5', new: '12' },
      { field: 'saleEndsAt', old: firstEnd.toISOString(), new: secondEnd.toISOString() },
      { field: 'discount', old: null, new: { amount: 8 } },
    ]);
  });

  it('describes a sale taken off, with no discount', () => {
    const saleEndsAt = ends(60_000);

    expect(
      buildSaleAuditChanges({
        event: 'removed',
        price,
        before: { salePrice: new Prisma.Decimal('15.00'), saleEndsAt },
        after: noSale,
      }),
    ).toEqual([
      { field: 'event', old: null, new: 'removed' },
      { field: 'price', old: '20', new: '20' },
      { field: 'salePrice', old: '15', new: null },
      { field: 'saleEndsAt', old: saleEndsAt.toISOString(), new: null },
    ]);
  });

  // a sale past its end is no sale, the answers leave it out as well
  it('shows a sale that is over as no sale before', () => {
    const saleEndsAt = ends(60_000);
    const out = buildSaleAuditChanges({
      event: 'start',
      price,
      before: { salePrice: new Prisma.Decimal('15.00'), saleEndsAt: ends(-1) },
      after: { salePrice: new Prisma.Decimal('18.00'), saleEndsAt },
      discount: { amount: 2 },
    });

    expect(out.slice(2, 4)).toEqual([
      { field: 'salePrice', old: null, new: '18' },
      { field: 'saleEndsAt', old: null, new: saleEndsAt.toISOString() },
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
