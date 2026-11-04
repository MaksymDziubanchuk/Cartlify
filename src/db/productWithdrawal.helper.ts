import { Prisma } from '@prisma/client';

import type { WithdrawalRuleName, WithdrawalSource } from '@helpers/withdrawal.js';

// the rule of withdrawal of products as the database counts it (cartlify.product_withdrawals,
// db/05): the one rule for every reader, with where it comes from. The reads of a transaction go
// through its own client, so a rule changed in it is seen

export type ProductWithdrawalRow = {
  rule: WithdrawalRuleName;
  source: WithdrawalSource;
  // the category the rule comes from, only for source category
  categoryId: number | null;
};

export async function readProductWithdrawals(
  db: Pick<Prisma.TransactionClient, '$queryRaw'>,
  productIds: readonly number[],
): Promise<Map<number, ProductWithdrawalRow>> {
  const ids = [...new Set(productIds)];
  if (ids.length === 0) return new Map();

  const rows = await db.$queryRaw<
    {
      productId: number;
      rule: WithdrawalRuleName;
      source: WithdrawalSource;
      categoryId: number | null;
    }[]
  >(Prisma.sql`
    select "productId", rule::text as rule, source, "categoryId"
    from cartlify.product_withdrawals(${ids}::int[])
  `);

  return new Map(
    rows.map(({ productId, ...row }) => [productId, row] as [number, ProductWithdrawalRow]),
  );
}
