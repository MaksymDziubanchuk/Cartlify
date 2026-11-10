import env from '@config/env.js';
import { prisma } from '@db/client.js';
import { findAll } from '@routes/api/products/services/getAllProducts.service.js';
import { categoryImageUrlsOf } from '@routes/api/categories/services/helpers/categories.helper.js';
import { InternalError, isAppError } from '@utils/errors.js';
import type {
  NewsletterBlockDto,
  NewsletterContentDto,
  NewsletterSnapshotCategoryDto,
  NewsletterSnapshotDto,
  NewsletterSnapshotProductsDto,
} from 'types/dto/newsletters.dto.js';

import { cardOf, cardsOfRule, manualQueryOf, ruleQueryOf } from './campaignCards.helper.js';

type Category = NonNullable<NewsletterSnapshotCategoryDto['category']>;

// the categories a content names, a block of a category and a rule that names one, as the shop keeps
// them; a category that is gone is not in the map
async function categoriesOf(blocks: readonly NewsletterBlockDto[]): Promise<Map<number, Category>> {
  const ids = new Set<number>();
  for (const block of blocks) {
    if (block.type === 'category') ids.add(block.categoryId);
    else if (
      block.type === 'products' &&
      block.source === 'rule' &&
      block.categoryId !== undefined
    ) {
      ids.add(block.categoryId);
    }
  }
  if (ids.size === 0) return new Map();

  const rows = await prisma.category.findMany({
    where: { id: { in: [...ids] } },
    select: { id: true, name: true, imageUrl: true },
  });

  return new Map(
    rows.map((row) => [
      row.id,
      { id: row.id, name: row.name, imageUrl: categoryImageUrlsOf(row.imageUrl)?.url400 ?? null },
    ]),
  );
}

// The products and the categories of a content, taken now, for the mail of a campaign: the list a buyer
// would see in the catalog for each block of products (the catalog is asked as a visitor, so a product
// that is deleted, hidden or out of stock is not there), and the category each block of a category
// names. One snapshot for the whole campaign: everybody gets the same cards, whenever the mail is
// read. The queries are made one after another, so `takenAt` is the start of the taking, not one
// instant of the database; a product that changes while it runs is in or out, never half of each
export async function resolveCampaignProducts(
  content: NewsletterContentDto,
  opts: { now?: Date } = {},
): Promise<NewsletterSnapshotDto> {
  const now = opts.now ?? new Date();

  try {
    const categories = await categoriesOf(content.blocks);
    const blocks: NewsletterSnapshotDto['blocks'] = [];

    for (const block of content.blocks) {
      if (block.type === 'category') {
        blocks.push({ kind: 'category', category: categories.get(block.categoryId) ?? null });
      } else if (block.type !== 'products') {
        blocks.push(null);
      } else if (block.source === 'manual') {
        blocks.push(await manualBlock(block.productIds));
      } else if (block.categoryId !== undefined && !categories.has(block.categoryId)) {
        blocks.push({ kind: 'products', items: [], unavailable: [], categoryMissing: true });
      } else {
        const rows = await findAll(ruleQueryOf(block, now));
        blocks.push({
          kind: 'products',
          items: cardsOfRule(rows.items, block),
          unavailable: [],
          categoryMissing: false,
        });
      }
    }

    return { takenAt: now.toISOString(), currency: env.STRIPE_CURRENCY.toUpperCase(), blocks };
  } catch (err) {
    if (isAppError(err)) throw err;

    throw new InternalError({ reason: 'NEWSLETTER_PRODUCTS_UNEXPECTED' }, err);
  }
}

// the products a block by hand names, in the order it names them; the ones the catalog does not show
// a buyer are told apart
async function manualBlock(productIds: readonly number[]): Promise<NewsletterSnapshotProductsDto> {
  const found = await findAll(manualQueryOf(productIds));
  const rows = new Map(found.items.map((row) => [row.product.id as number, row]));

  return {
    kind: 'products',
    items: productIds.flatMap((id) => {
      const row = rows.get(id);
      return row ? [cardOf(row)] : [];
    }),
    unavailable: productIds.filter((id) => !rows.has(id)),
    categoryMissing: false,
  };
}
