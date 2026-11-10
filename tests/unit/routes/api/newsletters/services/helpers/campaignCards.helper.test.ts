import { describe, expect, it } from '@jest/globals';

import {
  MANUAL_PRODUCTS_MAX,
  RULE_ROWS_MAX,
  cardOf,
  cardsOfRule,
  manualQueryOf,
  periodOf,
  ruleQueryOf,
} from '@routes/api/newsletters/services/helpers/campaignCards.helper.js';
import type { ProductListRowDto } from 'types/dto/products.dto.js';
import type {
  NewsletterProductsBestsellersBlockDto,
  NewsletterProductsRuleBlockDto,
} from 'types/dto/newsletters.dto.js';

const NOW = new Date('2026-11-09T15:30:00.000Z');
const DAY = 86_400_000;

const rule = (
  over: Partial<NewsletterProductsRuleBlockDto> = {},
): NewsletterProductsRuleBlockDto => ({
  type: 'products',
  source: 'rule',
  rule: 'popular',
  ...over,
});

const bestsellers = (
  over: Partial<NewsletterProductsBestsellersBlockDto> = {},
): NewsletterProductsBestsellersBlockDto => ({
  type: 'products',
  source: 'rule',
  rule: 'bestsellers',
  ...over,
});

// a row of the catalog list of a buyer, with the parts a card reads
function row(over: {
  id?: number;
  name?: string;
  variantId?: number;
  variantName?: string;
  price?: number;
  salePrice?: number;
  salePriorPrice?: number;
  saleEndsAt?: string;
  image?: string | null;
  min?: number | null;
  max?: number | null;
}): ProductListRowDto {
  const price = over.price ?? 10;
  const image = over.image === undefined ? 'https://img.example/400.jpg' : over.image;

  return {
    product: { id: over.id ?? 1, name: over.name ?? 'Shirt' },
    variant: {
      id: over.variantId ?? (over.id ?? 1) * 10,
      name: over.variantName ?? 'Shirt, Red',
      price,
      ...(over.salePrice !== undefined
        ? {
            salePrice: over.salePrice,
            saleEndsAt: over.saleEndsAt ?? '2026-12-01T00:00:00.000Z',
            ...(over.salePriorPrice !== undefined ? { salePriorPrice: over.salePriorPrice } : {}),
          }
        : {}),
      image: image === null ? null : { url200: 'x', url400: image, url800: 'y' },
    },
    ...(over.min === null ? {} : { minPrice: over.min ?? price, maxPrice: over.max ?? price }),
    stock: 5,
  } as unknown as ProductListRowDto;
}

describe('ruleQueryOf: the list a buyer sees for a rule', () => {
  it.each([
    ['new', 'createdAt'],
    ['sale', 'discount'],
    ['popular', 'popularity'],
    ['top_rated', 'avgRating'],
  ] as const)('asks the catalog for the rule %s sorted by %s, the biggest first', (name, sort) => {
    expect(ruleQueryOf(rule({ rule: name, limit: 6 }), NOW)).toMatchObject({
      actorRole: 'GUEST',
      sort,
      order: 'desc',
      inStock: true,
    });
  });

  it('asks as a visitor, never as a person of the shop', () => {
    const query = ruleQueryOf(rule(), NOW);

    expect(query.actorRole).toBe('GUEST');
    expect(query.actorId).toBeUndefined();
  });

  it('asks for the number of cards the block says, and for four when it says none', () => {
    expect(ruleQueryOf(rule({ limit: 9 }), NOW).limit).toBe(9);
    expect(ruleQueryOf(rule(), NOW).limit).toBe(4);
  });

  it('asks for the whole branch of the category, or for no category', () => {
    expect(ruleQueryOf(rule({ categoryId: 12 }), NOW)).toMatchObject({ categoryIds: [12] });
    expect(ruleQueryOf(rule({ categoryId: 12 }), NOW).branch).not.toBe(false);
    expect(ruleQueryOf(rule(), NOW)).not.toHaveProperty('categoryIds');
  });

  // the sale list has the variants on sale first and then the rest of the catalog, and a product may
  // come with two of its variants: more rows are read than cards are wanted
  it('reads more rows than cards for the rule sale, up to a limit', () => {
    expect(ruleQueryOf(rule({ rule: 'sale', limit: 4 }), NOW).limit).toBe(16);
    expect(ruleQueryOf(rule({ rule: 'sale', limit: 12 }), NOW).limit).toBe(RULE_ROWS_MAX);
    expect(ruleQueryOf(rule({ rule: 'popular', limit: 12 }), NOW).limit).toBe(12);
  });

  it.each([
    [undefined, 30],
    [7, 7],
    [30, 30],
    [90, 90],
  ] as const)(
    'counts the sales of the period %s as the last %s days up to the end of today',
    (days, count) => {
      const query = ruleQueryOf(bestsellers(days ? { periodDays: days } : {}), NOW);

      expect(query.sort).toBe('sales');
      // the end of today in UTC, the period the catalog takes by default
      expect(query.salesTo?.toISOString()).toBe('2026-11-10T00:00:00.000Z');
      expect(query.salesFrom?.getTime()).toBe(Date.parse('2026-11-10T00:00:00.000Z') - count * DAY);
    },
  );

  it('gives no period to a rule that does not sort by sales', () => {
    const query = ruleQueryOf(rule({ rule: 'new' }), NOW);

    expect(query.salesFrom).toBeUndefined();
    expect(query.salesTo).toBeUndefined();
  });
});

describe('periodOf', () => {
  it('ends at the next midnight UTC, also at the very midnight', () => {
    expect(periodOf(new Date('2026-11-09T23:59:59.999Z'), 7).to.toISOString()).toBe(
      '2026-11-10T00:00:00.000Z',
    );
    expect(periodOf(new Date('2026-11-10T00:00:00.000Z'), 7).to.toISOString()).toBe(
      '2026-11-11T00:00:00.000Z',
    );
  });
});

describe('manualQueryOf: the products a block names', () => {
  it('asks for exactly these products, the ones a buyer can buy', () => {
    expect(manualQueryOf([5, 3, 9])).toMatchObject({
      actorRole: 'GUEST',
      productIds: [5, 3, 9],
      limit: 3,
      inStock: true,
    });
  });

  it('asks for as many rows as there are products', () => {
    expect(manualQueryOf([1]).limit).toBe(1);
    expect(manualQueryOf(Array.from({ length: MANUAL_PRODUCTS_MAX }, (_v, i) => i + 1)).limit).toBe(
      MANUAL_PRODUCTS_MAX,
    );
  });
});

describe('cardOf', () => {
  it('shows a product that is not on sale by its price', () => {
    expect(cardOf(row({ id: 4, name: 'Shirt', price: 19.9 }))).toEqual({
      productId: 4,
      variantId: 40,
      name: 'Shirt',
      imageUrl: 'https://img.example/400.jpg',
      price: 19.9,
      from: false,
      salePrice: null,
      priorPrice: null,
      saleEndsAt: null,
    });
  });

  it('shows a product on sale with its regular price, the price now and the lowest of 30 days', () => {
    expect(
      cardOf(
        row({
          price: 100,
          salePrice: 70,
          salePriorPrice: 90,
          saleEndsAt: '2026-12-01T00:00:00.000Z',
        }),
      ),
    ).toMatchObject({
      price: 100,
      from: false,
      salePrice: 70,
      priorPrice: 90,
      saleEndsAt: '2026-12-01T00:00:00.000Z',
    });
  });

  it('has no lowest price of 30 days for a sale that does not know it', () => {
    expect(cardOf(row({ price: 100, salePrice: 70 }))).toMatchObject({
      salePrice: 70,
      priorPrice: null,
    });
  });

  // a product of variants that sell at different prices is shown "from" the lowest of them
  it('shows the lowest price "from" when the variants differ in price', () => {
    expect(cardOf(row({ price: 20, min: 12, max: 20 }))).toMatchObject({ price: 12, from: true });
  });

  it('shows the price of the variant when the variants are priced alike', () => {
    expect(cardOf(row({ price: 20, min: 20, max: 20 }))).toMatchObject({ price: 20, from: false });
  });

  it('does not say "from" for a product on sale, it names its own sale', () => {
    expect(cardOf(row({ price: 20, salePrice: 15, min: 12, max: 20 }))).toMatchObject({
      price: 20,
      from: false,
      salePrice: 15,
    });
  });

  it('copes with a row that has no range of prices', () => {
    expect(cardOf(row({ price: 8, min: null }))).toMatchObject({ price: 8, from: false });
  });

  it('has no picture when the variant shows none', () => {
    expect(cardOf(row({ image: null })).imageUrl).toBeNull();
  });

  it('names the product, as the catalog keeps it', () => {
    expect(cardOf(row({ name: '  <b>Shirt</b> & co  ', variantName: 'Other' })).name).toBe(
      '  <b>Shirt</b> & co  ',
    );
  });
});

describe('cardsOfRule: the cards of the rows the catalog gave', () => {
  const sale = (id: number, variantId = id * 10) =>
    row({ id, variantId, price: 100, salePrice: 80, salePriorPrice: 95 });
  const plain = (id: number) => row({ id, price: 100 });

  it('takes the rows as they come, up to the number of cards', () => {
    const cards = cardsOfRule([plain(1), plain(2), plain(3)], rule({ rule: 'popular', limit: 2 }));

    expect(cards.map((card) => card.productId)).toEqual([1, 2]);
  });

  it('takes four cards when the block says no number', () => {
    const rows = [1, 2, 3, 4, 5, 6].map(plain);

    expect(cardsOfRule(rows, rule()).map((card) => card.productId)).toEqual([1, 2, 3, 4]);
  });

  // the sale list of the catalog goes on after the last product on sale: the rest are not for a block
  // of sales
  it('keeps only the products on sale for the rule sale', () => {
    const cards = cardsOfRule(
      [sale(1), sale(2), plain(3), plain(4)],
      rule({ rule: 'sale', limit: 4 }),
    );

    expect(cards.map((card) => card.productId)).toEqual([1, 2]);
  });

  it('shows a product once when two of its variants are on sale, the better first', () => {
    const cards = cardsOfRule(
      [sale(1, 11), sale(2), sale(1, 12), sale(3)],
      rule({ rule: 'sale', limit: 3 }),
    );

    expect(cards.map((card) => [card.productId, card.variantId])).toEqual([
      [1, 11],
      [2, 20],
      [3, 30],
    ]);
  });

  it('counts the cards after the doubles are gone', () => {
    const cards = cardsOfRule(
      [sale(1, 11), sale(1, 12), sale(1, 13), sale(2)],
      rule({ rule: 'sale', limit: 2 }),
    );

    expect(cards.map((card) => card.productId)).toEqual([1, 2]);
  });

  it('keeps a product that is not on sale for the other rules, on sale or not', () => {
    const cards = cardsOfRule([plain(1), sale(2)], rule({ rule: 'new', limit: 4 }));

    expect(cards.map((card) => card.productId)).toEqual([1, 2]);
  });

  it('gives no card for no row', () => {
    expect(cardsOfRule([], rule())).toEqual([]);
  });
});
