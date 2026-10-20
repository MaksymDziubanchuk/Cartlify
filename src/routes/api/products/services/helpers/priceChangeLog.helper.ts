import { decimalToNumber } from '@helpers/safeNormalizer.js';

import type { Prisma, PrismaClient } from '@prisma/client';
import type { ProductId } from 'types/ids.js';

type DbClient = Prisma.TransactionClient | PrismaClient;

export function computeFixedDelta(beforePrice: unknown, afterPrice: unknown): number {
  // compute delta for fixed mode logs
  const oldPriceNum = decimalToNumber(beforePrice);
  const newPriceNum = decimalToNumber(afterPrice);
  return newPriceNum - oldPriceNum;
}

// the line names the admin of the transaction context: the database function takes the actor
// from it and refuses a context without an id, so a line in the name of someone else is no option
export async function writeProductPriceChangeLog(
  tx: DbClient,
  args: {
    productId: ProductId;
    beforePrice: unknown;
    afterPrice: unknown;
    mode: 'fixed' | 'percent';
    value: number;
  },
): Promise<void> {
  // normalize numeric prices for sql function input
  const oldPriceNum = decimalToNumber(args.beforePrice);
  const newPriceNum = decimalToNumber(args.afterPrice);

  // skip when no actual change
  if (oldPriceNum === newPriceNum) return;

  await tx.$executeRaw`
    select cartlify.log_product_price_change(
      ${args.productId}::int,
      ${oldPriceNum}::numeric,
      ${newPriceNum}::numeric,
      ${args.mode}::cartlify."PriceChangeMode",
      ${args.value}::numeric
    )
  `;
}
