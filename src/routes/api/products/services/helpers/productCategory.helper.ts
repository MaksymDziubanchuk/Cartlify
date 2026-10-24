import type { Prisma } from '@prisma/client';

import { prisma } from '@db/client.js';
import { NotFoundError } from '@utils/errors.js';

import type { ProductCategoryDto } from 'types/dto/products.dto.js';

// the category a product goes into: a page that kept a category since deleted got 500 on the
// foreign key; now it is 404 CATEGORY_NOT_FOUND, read in the transaction that writes the product
export async function assertCategoryExists(
  tx: Prisma.TransactionClient,
  categoryId: number,
): Promise<void> {
  const category = await tx.category.findUnique({
    where: { id: categoryId },
    select: { id: true },
  });
  if (!category) throw new NotFoundError('CATEGORY_NOT_FOUND');
}

// the way from the top of the tree to a category: its parent categories, the top one first, without
// the category itself; empty for a category at the top. Every role reads the categories
export async function readCategoryPath(
  categoryId: number,
  db: Prisma.TransactionClient = prisma,
): Promise<ProductCategoryDto[]> {
  const rows = await db.$queryRaw<Array<{ id: number; name: string; slug: string }>>`
    WITH RECURSIVE up AS (
      SELECT c."parentId" AS id, 1 AS depth FROM "categories" c WHERE c."id" = ${categoryId}::int
      UNION ALL
      SELECT c."parentId", up.depth + 1 FROM "categories" c JOIN up ON c."id" = up.id
    )
    SELECT c."id", c."name", c."slug" FROM up JOIN "categories" c ON c."id" = up.id
    ORDER BY up.depth DESC
  `;

  return rows.map((row) => ({ id: row.id as never, name: row.name, slug: row.slug }));
}
