import type { Prisma } from '@prisma/client';

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
