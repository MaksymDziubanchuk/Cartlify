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
  const change = { productId: 4, actorId: 1, mode: 'fixed' as const, value: 2.5 };

  it('writes nothing when the price stayed the same', async () => {
    const { tx, $executeRaw } = fakeTx();

    await writeProductPriceChangeLog(tx, {
      ...change,
      beforePrice: new Prisma.Decimal('9.90'),
      afterPrice: new Prisma.Decimal('9.9'),
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
    expect(values).toEqual([4, 1, 10, 12.5, 'fixed', 2.5]);
  });
});
