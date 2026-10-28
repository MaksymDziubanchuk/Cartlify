import { prisma } from '@db/client.js';
import { categoryImageUrlsOf } from './helpers/categories.helper.js';
import { InternalError } from '@utils/errors.js';

import type { CategoryTreeNodeDto, CategoryTreeResponseDto } from 'types/dto/categories.dto.js';
import type { CategoryId } from 'types/ids.js';

// the whole tree of the categories for the menu of the catalog: each category with the ones right
// below it, by name, and the products of the catalog of its whole branch, the ones the catalog
// lists (with an image). Every role reads the categories and the products (db/03), so the tree is
// the same for everyone
export async function getCategoryTree(): Promise<CategoryTreeResponseDto> {
  try {
    const [categories, counts] = await prisma.$transaction([
      prisma.category.findMany({
        select: { id: true, name: true, slug: true, parentId: true, imageUrl: true },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
      }),
      prisma.product.groupBy({
        by: ['categoryId'],
        where: { deletedAt: null, images: { some: { isPrimary: true } } },
        _count: { _all: true },
      }),
    ]);

    const own = new Map(counts.map((row) => [row.categoryId, row._count._all]));
    const nodes = new Map<number, CategoryTreeNodeDto>(
      categories.map((row) => [
        row.id,
        {
          id: row.id as CategoryId,
          name: row.name,
          slug: row.slug,
          imageUrls: categoryImageUrlsOf(row.imageUrl),
          productCount: 0,
          children: [],
        },
      ]),
    );

    // the rows come by name, so the children of each category come by name too
    const top: CategoryTreeNodeDto[] = [];
    for (const row of categories) {
      const parent = row.parentId === null ? undefined : nodes.get(row.parentId);
      (parent ? parent.children : top).push(nodes.get(row.id)!);
    }

    // the products of a branch: its own and the ones of each category below it
    const countBranch = (node: CategoryTreeNodeDto): number => {
      node.productCount =
        (own.get(node.id) ?? 0) + node.children.reduce((sum, child) => sum + countBranch(child), 0);
      return node.productCount;
    };
    top.forEach(countBranch);

    return { items: top };
  } catch (err) {
    throw new InternalError({ reason: 'CATEGORIES_TREE_UNEXPECTED' }, err);
  }
}
