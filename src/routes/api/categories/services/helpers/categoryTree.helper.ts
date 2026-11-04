import type { Prisma } from '@prisma/client';

import { readProductWithdrawals } from '@db/productWithdrawal.helper.js';
import { ConflictError } from '@utils/errors.js';

// the tree of the categories goes from the top down: a category never goes inside its own branch,
// under one of its subcategories at any depth. The walk goes up from the new parent and stops at a
// row it has seen. The database refuses the same (trg_categories_before_parent_change), and it
// alone sees two moves at the same time that make a loop together
export async function assertOutsideOwnBranch(
  tx: Prisma.TransactionClient,
  categoryId: number,
  parentId: number,
): Promise<void> {
  const rows = await tx.$queryRaw<{ id: number }[]>`
    WITH RECURSIVE up AS (
      SELECT c.id, c."parentId"
      FROM cartlify.categories AS c
      WHERE c.id = ${parentId}::int
      UNION
      SELECT c.id, c."parentId"
      FROM cartlify.categories AS c
      JOIN up ON c.id = up."parentId"
    )
    SELECT id FROM up WHERE id = ${categoryId}::int LIMIT 1
  `;

  if (rows.length) throw new ConflictError('CATEGORY_PARENT_CYCLE');
}

// the rule of withdrawal each live product of the branch of a category has (the category and every
// category below it), by the id of the product: read before and after a change of a rule, the two
// say which products took another one
export async function withdrawalsOfBranch(
  tx: Prisma.TransactionClient,
  categoryId: number,
): Promise<Map<number, string>> {
  const products = await tx.$queryRaw<{ id: number }[]>`
    WITH RECURSIVE branch AS (
      SELECT c.id
      FROM cartlify.categories AS c
      WHERE c.id = ${categoryId}::int
      UNION
      SELECT c.id
      FROM cartlify.categories AS c
      JOIN branch ON c."parentId" = branch.id
    )
    SELECT p.id
    FROM cartlify.products AS p
    JOIN branch ON p."categoryId" = branch.id
    WHERE p."deletedAt" IS NULL
  `;

  const rules = await readProductWithdrawals(
    tx,
    products.map((product) => product.id),
  );

  return new Map([...rules].map(([id, row]) => [id, row.rule]));
}
