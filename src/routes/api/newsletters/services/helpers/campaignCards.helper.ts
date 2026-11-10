import type {
  NewsletterCardDto,
  NewsletterProductsBestsellersBlockDto,
  NewsletterProductsRuleBlockDto,
} from 'types/dto/newsletters.dto.js';
import type { ProductListRowDto, ReadProductsDto } from 'types/dto/products.dto.js';

import {
  BESTSELLERS_DEFAULT_PERIOD_DAYS,
  RULE_BLOCK_DEFAULT_LIMIT,
} from './newsletterContent.helper.js';

// The pure part of the products of a mail: which question to put to the catalog of a buyer for a block,
// and what a row of its answer becomes in a card. The catalog is asked as a visitor, so a mail shows
// what a buyer sees and can buy: the products that are there, with a variant that shows a picture and
// with free units. Nothing here reads a database

type RuleBlock = NewsletterProductsRuleBlockDto | NewsletterProductsBestsellersBlockDto;

// the most products a block by hand names (the schema of the content holds the same limit)
export const MANUAL_PRODUCTS_MAX = 12;

// The sale list of the catalog has the variants on sale first and the rest of the catalog after them,
// and a product may come with several of its variants: to fill a block more rows are read than it has
// cards (a row is cheap), up to this many
export const RULE_ROWS_FACTOR = 4;
export const RULE_ROWS_MAX = 48;

const DAY_MS = 86_400_000;

// the sort of the catalog each rule is: the new products, the biggest discounts (a variant on sale
// first), the popular ones, the units sold in a period, the best marks
const SORT_OF_RULE = {
  new: 'createdAt',
  sale: 'discount',
  popular: 'popularity',
  bestsellers: 'sales',
  top_rated: 'avgRating',
} as const;

// The period of the best sellers: the days up to the end of today by the UTC day (the period the
// catalog takes when it is asked for none), [from, to)
export function periodOf(now: Date, days: number): { from: Date; to: Date } {
  const to = new Date(now);
  to.setUTCHours(24, 0, 0, 0);

  return { from: new Date(to.getTime() - days * DAY_MS), to };
}

// the question to the catalog of a buyer that gives the list of a rule, for the category and its whole
// branch when the block names one
export function ruleQueryOf(block: RuleBlock, now: Date): ReadProductsDto {
  const cards = block.limit ?? RULE_BLOCK_DEFAULT_LIMIT;
  const rows = block.rule === 'sale' ? Math.min(cards * RULE_ROWS_FACTOR, RULE_ROWS_MAX) : cards;
  const period =
    block.rule === 'bestsellers'
      ? periodOf(now, block.periodDays ?? BESTSELLERS_DEFAULT_PERIOD_DAYS)
      : undefined;

  return {
    actorRole: 'GUEST',
    sort: SORT_OF_RULE[block.rule],
    order: 'desc',
    limit: rows,
    inStock: true,
    ...(block.categoryId !== undefined ? { categoryIds: [block.categoryId] } : {}),
    ...(period ? { salesFrom: period.from, salesTo: period.to } : {}),
  } as ReadProductsDto;
}

// the question that finds the products a block names, the ones a buyer can buy now
export function manualQueryOf(productIds: readonly number[]): ReadProductsDto {
  return {
    actorRole: 'GUEST',
    sort: 'popularity',
    order: 'desc',
    limit: productIds.length,
    inStock: true,
    productIds: [...productIds],
  } as ReadProductsDto;
}

// whether the row is a variant on sale now (a buyer gets the sale fields only while the sale lasts)
const onSale = (row: ProductListRowDto): boolean =>
  row.variant.salePrice !== undefined && row.variant.salePrice !== null;

// The card of a row: the product and the variant the row shows. A product on sale shows its regular
// price, the price now and the lowest price of the 30 days before the sale; a product that is not
// shows its price, "from" the lowest one when its variants sell at different prices
export function cardOf(row: ProductListRowDto): NewsletterCardDto {
  const variant = row.variant;
  const sale = onSale(row);
  const varies =
    row.minPrice !== undefined && row.maxPrice !== undefined && row.minPrice < row.maxPrice;
  const from = !sale && varies;

  return {
    productId: row.product.id as number,
    variantId: variant.id,
    name: row.product.name,
    imageUrl: variant.image?.url400 ?? null,
    price: from ? row.minPrice! : variant.price,
    from,
    salePrice: sale ? (variant.salePrice ?? null) : null,
    priorPrice: sale ? (variant.salePriorPrice ?? null) : null,
    saleEndsAt: sale ? (variant.saleEndsAt ?? null) : null,
  };
}

// The cards of the rows the catalog gave for a rule: the sale rule keeps the rows on sale only (the
// list goes on after them), a product is shown once whatever the number of its variants the list
// has (the first row of it, which is the better one), and the number of cards is the block's
export function cardsOfRule(
  rows: readonly ProductListRowDto[],
  block: RuleBlock,
): NewsletterCardDto[] {
  const wanted = block.limit ?? RULE_BLOCK_DEFAULT_LIMIT;
  const seen = new Set<number>();
  const cards: NewsletterCardDto[] = [];

  for (const row of rows) {
    if (block.rule === 'sale' && !onSale(row)) continue;
    if (seen.has(row.product.id as number)) continue;

    seen.add(row.product.id as number);
    cards.push(cardOf(row));
    if (cards.length === wanted) break;
  }

  return cards;
}
