import { decimalToNumber } from '@helpers/safeNormalizer.js';

import type { Prisma, PrismaClient } from '@prisma/client';
import type { ProductId } from 'types/ids.js';

type DbClient = Prisma.TransactionClient | PrismaClient;

// the change of a price by an amount, negative for a price that goes down
export function computeFixedDelta(beforePrice: unknown, afterPrice: unknown): number {
  const oldPriceNum = decimalToNumber(beforePrice);
  const newPriceNum = decimalToNumber(afterPrice);
  return newPriceNum - oldPriceNum;
}

// the line names the admin of the transaction context: the database function takes the actor
// from it and refuses a context without an id, so a line in the name of someone else is no option.
// The mode is how the change was given, the value its size in that mode (the percent or the
// amount), negative for a change down. A line with an end (endsAt) is the start of a sale, from
// the price down to the sale price; a sale taken off goes from the sale price back to the price
export async function writeProductPriceChangeLog(
  tx: DbClient,
  args: {
    productId: ProductId;
    beforePrice: unknown;
    afterPrice: unknown;
    mode: 'fixed' | 'percent';
    value: number;
    endsAt?: Date;
  },
): Promise<void> {
  // normalize numeric prices for sql function input
  const oldPriceNum = decimalToNumber(args.beforePrice);
  const newPriceNum = decimalToNumber(args.afterPrice);

  // skip when no actual change
  if (oldPriceNum === newPriceNum) return;

  // the end goes as an iso time and lands in utc, the way prisma keeps dates in columns without
  // a time zone
  const endsAt = args.endsAt ? args.endsAt.toISOString() : null;

  await tx.$executeRaw`
    select cartlify.log_product_price_change(
      ${args.productId}::int,
      ${oldPriceNum}::numeric,
      ${newPriceNum}::numeric,
      ${args.mode}::cartlify."PriceChangeMode",
      ${args.value}::numeric,
      (${endsAt}::timestamptz at time zone 'UTC')
    )
  `;
}
