import { Prisma } from '@prisma/client';
import { describe, expect, it, jest } from '@jest/globals';

import {
  computeFixedDelta,
  writeProductPriceChangeLog,
} from '@routes/api/products/services/helpers/priceChangeLog.helper.js';

type Tx = Parameters<typeof writeProductPriceChangeLog>[0];
type RawQuery = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<number>;

const fakeTx = () => {
  const $executeRaw = jest.fn<RawQuery>(async () => 1);
  return { tx: { $executeRaw } as unknown as Tx, $executeRaw };
};

// a line keeps the change in its mode with its sign: negative for a price that goes down
describe('computeFixedDelta', () => {
  it.each([
    ['a rise', '10.00', '12.50', 2.5],
    ['a cut', '12.50', '10.00', -2.5],
    ['no change', '9.99', '9.99', 0],
  ])('gives the change of the price for %s', (_case, from, to, delta) => {
    expect(computeFixedDelta(new Prisma.Decimal(from), new Prisma.Decimal(to))).toBe(delta);
  });

  // the log column is numeric(10,2), it keeps the cents of the float result
  it('lands on the right cents where float math is off', () => {
    expect(computeFixedDelta(new Prisma.Decimal('10.10'), new Prisma.Decimal('30.30'))).toBeCloseTo(
      20.2,
      10,
    );
  });
});

describe('writeProductPriceChangeLog', () => {
  // no actor: the database function takes it from the context of the transaction
  const change = {
    productId: 4,
    mode: 'fixed' as const,
    value: 2.5,
    event: 'price.set' as const,
  };

  it.each([
    ['a change', undefined],
    ['the start of a sale', new Date('2026-11-01T10:00:00.000Z')],
  ])('writes nothing for %s that leaves the price as it was', async (_case, endsAt) => {
    const { tx, $executeRaw } = fakeTx();

    await writeProductPriceChangeLog(tx, {
      ...change,
      beforePrice: new Prisma.Decimal('9.90'),
      afterPrice: new Prisma.Decimal('9.9'),
      ...(endsAt ? { endsAt } : {}),
    });

    expect($executeRaw).not.toHaveBeenCalled();
  });

  it('passes the old and the new price as numbers to the database function', async () => {
    const { tx, $executeRaw } = fakeTx();

    await writeProductPriceChangeLog(tx, {
      ...change,
      beforePrice: new Prisma.Decimal('10.00'),
      afterPrice: new Prisma.Decimal('12.50'),
    });

    const [strings, ...values] = $executeRaw.mock.calls[0]!;
    expect(strings.join('?')).toContain('cartlify.log_product_price_change(');
    expect(values).toEqual([4, 10, 12.5, 'fixed', 2.5, 'price.set', null]);
  });

  it('passes a change down with its negative value', async () => {
    const { tx, $executeRaw } = fakeTx();

    await writeProductPriceChangeLog(tx, {
      productId: 4,
      mode: 'percent',
      value: -10,
      event: 'price.bulk',
      beforePrice: new Prisma.Decimal('20.00'),
      afterPrice: new Prisma.Decimal('18.00'),
    });

    const [, ...values] = $executeRaw.mock.calls[0]!;
    expect(values).toEqual([4, 20, 18, 'percent', -10, 'price.bulk', null]);
  });

  // a line with an end is the start of a sale; the end lands in utc like every date prisma keeps
  it('passes the end of a sale as an utc time', async () => {
    const { tx, $executeRaw } = fakeTx();

    await writeProductPriceChangeLog(tx, {
      productId: 4,
      mode: 'percent',
      value: -25,
      event: 'price.sale_start',
      beforePrice: new Prisma.Decimal('20.00'),
      afterPrice: new Prisma.Decimal('15.00'),
      endsAt: new Date('2026-11-01T10:00:00.000Z'),
    });

    const [strings, ...values] = $executeRaw.mock.calls[0]!;
    expect(strings.join('?')).toContain(`::timestamptz at time zone 'UTC'`);
    expect(values).toEqual([
      4,
      20,
      15,
      'percent',
      -25,
      'price.sale_start',
      '2026-11-01T10:00:00.000Z',
    ]);
  });
});
