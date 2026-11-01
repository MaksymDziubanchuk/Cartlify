import { Prisma } from '@prisma/client';

import type { Tx } from './directory.helper.js';

// how far up the tree the walk goes: a guard against a loop the database does not let in
const CATEGORY_DEPTH_MAX = 50;

export type CategorySetRow = { categoryId: number; attributeId: number; required: boolean };

// What a category asks for: its own characteristics and those of its parents up the tree. For one
// characteristic the nearest category wins (a child takes its own setting over a parent's). The
// rows come with the category that asks (categoryId); a category that is not there has no set
export async function readCategorySetRows(tx: Tx, categoryId: number): Promise<CategorySetRow[]> {
  return tx.$queryRaw<CategorySetRow[]>(Prisma.sql`
    WITH RECURSIVE up AS (
      SELECT c.id, c."parentId", 0 AS depth
      FROM cartlify.categories AS c
      WHERE c.id = ${categoryId}::int
      UNION ALL
      SELECT p.id, p."parentId", up.depth + 1
      FROM cartlify.categories AS p
      JOIN up ON p.id = up."parentId"
      WHERE up.depth < ${CATEGORY_DEPTH_MAX}::int
    )
    SELECT DISTINCT ON (ca."attributeId") ca."categoryId", ca."attributeId", ca.required
    FROM up
    JOIN cartlify.category_attributes AS ca ON ca."categoryId" = up.id
    ORDER BY ca."attributeId", up.depth
  `);
}

// the characteristics a variant of a product of the category must have a value of: the ones the set
// of the category (with its parents') marks required, with their names, by id
export async function requiredAttributesOf(
  tx: Tx,
  categoryId: number,
): Promise<Array<{ id: number; name: string }>> {
  const required = (await readCategorySetRows(tx, categoryId))
    .filter((row) => row.required)
    .map((row) => row.attributeId);
  if (!required.length) return [];

  return tx.attribute.findMany({
    where: { id: { in: required } },
    select: { id: true, name: true },
    orderBy: { id: 'asc' },
  });
}
