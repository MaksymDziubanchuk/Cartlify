import { Prisma } from '@prisma/client';
import { describe, expect, it, jest } from '@jest/globals';

import {
  buildProductUpdateAuditChanges,
  buildSaleAuditChanges,
  writeAdminAuditLog,
  writeStockOperationAuditLog,
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

  // the description is plain text; the manufacturer, the person in the EU and the warnings are
  // fields of the product, each a change of its own
  it('records the text of the description, and that an empty one takes it away', () => {
    expect(
      buildProductUpdateAuditChanges(
        { ...before, description: 'White' },
        { after: { ...before, description: 'Black' }, input: { description: 'Black' } },
      ),
    ).toEqual([{ field: 'description', old: 'White', new: 'Black' }]);
    expect(
      buildProductUpdateAuditChanges(
        { ...before, description: 'White' },
        { after: { ...before, description: null }, input: { description: '' } },
      ),
    ).toEqual([{ field: 'description', old: 'White', new: null }]);
  });

  it('records the manufacturer, the person in the EU and the warnings as they were and are', () => {
    expect(
      buildProductUpdateAuditChanges(
        { ...before, manufacturerId: 1, euResponsibleId: null, warnings: null },
        {
          after: { ...before, manufacturerId: 2, euResponsibleId: 5, warnings: 'Hot surface.' },
          input: { manufacturerId: 2, euResponsibleId: 5, warnings: 'Hot surface.' },
        },
      ),
    ).toEqual([
      { field: 'manufacturerId', old: 1, new: 2 },
      { field: 'euResponsibleId', old: null, new: 5 },
      { field: 'warnings', old: null, new: 'Hot surface.' },
    ]);
  });

  it('records a person and warnings taken away as null, and nothing for what was not named or did not change', () => {
    const had = { ...before, manufacturerId: 1, euResponsibleId: 5, warnings: 'Hot surface.' };

    expect(
      buildProductUpdateAuditChanges(had, {
        after: { ...had, euResponsibleId: null, warnings: null },
        input: { euResponsibleId: null, warnings: null },
      }),
    ).toEqual([
      { field: 'euResponsibleId', old: 5, new: null },
      { field: 'warnings', old: 'Hot surface.', new: null },
    ]);
    expect(
      buildProductUpdateAuditChanges(had, {
        after: { ...had, manufacturerId: 1 },
        input: { manufacturerId: 1 },
      }),
    ).toEqual([]);
    expect(buildProductUpdateAuditChanges(had, { after: had, input: { name: 'x' } })).toEqual([]);
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
    event: 'product.update' as const,
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
    expect(values).toEqual([
      1,
      'ADMIN',
      'product',
      4,
      'PRODUCT_UPDATE',
      'product.update',
      JSON.stringify(changes),
    ]);
  });
});

describe('writeStockOperationAuditLog', () => {
  const fakeTx = () => {
    const $executeRaw = jest.fn<RawQuery>(async () => 1);
    return { tx: { $executeRaw } as unknown as Tx, $executeRaw };
  };

  const operation = {
    actorId: 7,
    actorRole: 'ROOT',
    operationId: '7d1f4f6e-6b1f-4a43-9a1b-0d2a3c4b5e6f',
    quantity: 9,
  };

  // the values the database function got: actor, role, entity type, entity id, action, event, changes
  const writtenOf = ($executeRaw: jest.Mock<RawQuery>) => {
    const [, ...values] = $executeRaw.mock.calls[0]!;
    return {
      entity: [values[2], values[3]],
      action: values[4],
      event: values[5],
      changes: JSON.parse(values[6] as string) as { field: string; old: unknown; new: unknown }[],
    };
  };

  it('points at the variant when the operation touched exactly one', async () => {
    const { tx, $executeRaw } = fakeTx();

    await writeStockOperationAuditLog(tx, {
      ...operation,
      kind: 'delivery',
      variantIds: [31],
      details: [{ field: 'source', value: 'supplier' }],
    });

    expect(writtenOf($executeRaw)).toMatchObject({
      entity: ['variant', 31],
      action: 'STOCK_DELIVERY',
      event: 'stock.delivery',
    });
  });

  it('points at nothing when the operation touched more than one variant', async () => {
    const { tx, $executeRaw } = fakeTx();

    await writeStockOperationAuditLog(tx, {
      ...operation,
      kind: 'write_off',
      variantIds: [31, 32],
      details: [],
    });

    expect(writtenOf($executeRaw)).toMatchObject({
      entity: ['other', null],
      action: 'STOCK_WRITE_OFF',
      event: 'stock.write_off',
    });
  });

  it('starts the changes with the id of the operation and ends them with how much it moved', async () => {
    const { tx, $executeRaw } = fakeTx();

    await writeStockOperationAuditLog(tx, {
      ...operation,
      kind: 'delivery',
      variantIds: [31, 32, 33],
      details: [
        { field: 'source', value: 'supplier' },
        { field: 'supplier', value: 'Acme' },
        { field: 'document', value: null },
        { field: 'note', value: undefined },
      ],
    });

    // the details that are empty are left out
    expect(writtenOf($executeRaw).changes).toEqual([
      { field: 'deliveryId', old: null, new: operation.operationId },
      { field: 'source', old: null, new: 'supplier' },
      { field: 'supplier', old: null, new: 'Acme' },
      { field: 'variants', old: null, new: 3 },
      { field: 'quantity', old: null, new: 9 },
    ]);
  });

  it('names the write-off by its own field', async () => {
    const { tx, $executeRaw } = fakeTx();

    await writeStockOperationAuditLog(tx, {
      ...operation,
      kind: 'write_off',
      variantIds: [31],
      details: [{ field: 'reason', value: 'damaged' }],
    });

    expect(writtenOf($executeRaw).changes.map((change) => change.field)).toEqual([
      'writeOffId',
      'reason',
      'variants',
      'quantity',
    ]);
  });
});
