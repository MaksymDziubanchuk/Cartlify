import { decimalToNumber } from '@helpers/safeNormalizer.js';

import type { Prisma, PrismaClient } from '@prisma/client';
import type { UserId, ProductId } from 'types/ids.js';

type DbClient = Prisma.TransactionClient | PrismaClient;

export function computeFixedDelta(beforePrice: unknown, afterPrice: unknown): number {
  // compute delta for fixed mode logs
  const oldPriceNum = decimalToNumber(beforePrice);
  const newPriceNum = decimalToNumber(afterPrice);
  return newPriceNum - oldPriceNum;
}

export async function writeProductPriceChangeLog(
  tx: DbClient,
  args: {
    productId: ProductId;
    actorId: UserId;
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
      ${args.productId},
      ${args.actorId},
      ${oldPriceNum},
      ${newPriceNum},
      ${args.mode}::cartlify."PriceChangeMode",
      ${args.value}
    )
  `;
}
