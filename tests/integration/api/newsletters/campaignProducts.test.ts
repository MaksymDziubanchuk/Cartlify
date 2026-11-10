import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { resolveCampaignProducts } from '@routes/api/newsletters/services/helpers/campaignProducts.helper.js';
import type {
  NewsletterContentDto,
  NewsletterSnapshotCategoryDto,
  NewsletterSnapshotProductsDto,
} from 'types/dto/newsletters.dto.js';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { asAdmin } from '../../../helpers/db.js';
import {
  closeSessions,
  createCategory,
  createProduct,
  createReview,
  createUser,
  createVariant,
  deleteProductFromCatalog,
  waitForSalesEnd,
  type TestProduct,
  type TestUser,
} from '../../../helpers/factories.js';
import { placeOrder } from '../../../helpers/orders.js';
import { stripVariantImages } from '../../../helpers/variants.js';

// The products of the blocks of a mail, taken from the catalog of a buyer as it is: a block by hand
// gives the products named, in the order named, and tells apart those a buyer cannot buy now; a block
// by a rule gives the list the catalog gives a visitor for it. The data is made the way the shop makes
// it: products with variants, a sale with the prices that came before it, marks and orders

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
let buyer: TestUser;
const userIds: number[] = [];
const made: TestProduct[] = [];
const DAY = 86_400_000;

async function newProduct(opts: Parameters<typeof createProduct>[0] = {}) {
  const product = await createProduct({ price: 100, stock: 20, ...opts });
  made.push(product);
  return product;
}

const content = (...blocks: NewsletterContentDto['blocks']): NewsletterContentDto => ({
  subject: { en: 'Subject' },
  preview: {},
  blocks,
});

const productsOf = async (...blocks: NewsletterContentDto['blocks']) =>
  (await resolveCampaignProducts(content(...blocks))).blocks.map(
    (block) => block as NewsletterSnapshotProductsDto,
  );

const idsOf = (block: NewsletterSnapshotProductsDto | undefined) =>
  (block?.items ?? []).map((card) => card.productId);

const rule = (name: string, categoryId?: number, over: Record<string, unknown> = {}) =>
  ({
    type: 'products',
    source: 'rule',
    rule: name,
    ...(categoryId !== undefined ? { categoryId } : {}),
    ...over,
  }) as NewsletterContentDto['blocks'][number];

const manual = (...productIds: number[]) =>
  ({ type: 'products', source: 'manual', productIds }) as NewsletterContentDto['blocks'][number];

const adminCall = (method: 'PATCH', url: string, payload: unknown) =>
  app.inject({
    method,
    url,
    headers: withCsrf(csrf, accessCookie(admin)),
    payload: payload as Record<string, unknown>,
  });

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await createUser({ role: 'ADMIN' });
  buyer = await createUser();
  userIds.push(admin.id, buyer.id);
});

afterAll(async () => {
  try {
    for (const product of made) await deleteProductFromCatalog(product.id);
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

describe('a block of products by hand', () => {
  let first: TestProduct;
  let second: TestProduct;
  let third: TestProduct;

  beforeAll(async () => {
    [first, second, third] = [
      await newProduct({ price: 12.5, name: 'First product' }),
      await newProduct({ price: 30 }),
      await newProduct({ price: 45.25 }),
    ];
  });

  it('gives the products in the order the block names them, not the order of the catalog', async () => {
    const [block] = await productsOf(manual(third.id, first.id, second.id));

    expect(idsOf(block)).toEqual([third.id, first.id, second.id]);
    expect(block!.unavailable).toEqual([]);
    expect(block!.categoryMissing).toBe(false);
  });

  it('gives a card the way a buyer sees the product: its name, picture, price and variant', async () => {
    const [block] = await productsOf(manual(first.id));

    expect(block!.items).toEqual([
      {
        productId: first.id,
        variantId: first.variantId,
        name: 'First product',
        // the size of a card, from the picture the variant shows
        imageUrl: expect.stringContaining('w_400'),
        price: 12.5,
        from: false,
        salePrice: null,
        priorPrice: null,
        saleEndsAt: null,
      },
    ]);
  });

  it('takes the name as the shop keeps it, markup of a hostile name and all', async () => {
    const hostile = await newProduct({ name: '<script>alert(1)</script> & "co"' });

    const [block] = await productsOf(manual(hostile.id));

    expect(block!.items[0]!.name).toBe('<script>alert(1)</script> & "co"');
  });

  it('is plain json, with the time it was taken and the currency of the shop', async () => {
    const taken = await resolveCampaignProducts(content(manual(first.id)), {
      now: new Date('2026-11-09T12:00:00.000Z'),
    });

    expect(taken.takenAt).toBe('2026-11-09T12:00:00.000Z');
    expect(taken.currency).toBe('EUR');
    expect(JSON.parse(JSON.stringify(taken))).toEqual(taken);
  });

  describe('leaves out what a buyer cannot buy', () => {
    it('a product that was deleted from the catalog', async () => {
      const gone = await newProduct();
      await deleteProductFromCatalog(gone.id);

      const [block] = await productsOf(manual(first.id, gone.id, second.id));

      expect(idsOf(block)).toEqual([first.id, second.id]);
      expect(block!.unavailable).toEqual([gone.id]);
    });

    it('a product with no free unit', async () => {
      const empty = await newProduct({ stock: 0 });

      const [block] = await productsOf(manual(empty.id, first.id));

      expect(idsOf(block)).toEqual([first.id]);
      expect(block!.unavailable).toEqual([empty.id]);
    });

    it('a product whose variants show no picture, which a buyer does not see', async () => {
      const hidden = await newProduct();
      await stripVariantImages(hidden.variantId);

      const [block] = await productsOf(manual(hidden.id, first.id));

      expect(idsOf(block)).toEqual([first.id]);
      expect(block!.unavailable).toEqual([hidden.id]);
    });

    it('a product that is not there at all', async () => {
      const [block] = await productsOf(manual(2_147_483_647, first.id));

      expect(idsOf(block)).toEqual([first.id]);
      expect(block!.unavailable).toEqual([2_147_483_647]);
    });

    it('every product, when none can be bought', async () => {
      const gone = await newProduct();
      await deleteProductFromCatalog(gone.id);

      const [block] = await productsOf(manual(gone.id));

      expect(block!.items).toEqual([]);
      expect(block!.unavailable).toEqual([gone.id]);
    });
  });

  it('keeps a product that has stock in one variant and none in the other', async () => {
    const mixed = await newProduct({ stock: 0 });
    await createVariant(mixed.id, { stock: 3 });

    const [block] = await productsOf(manual(mixed.id));

    expect(idsOf(block)).toEqual([mixed.id]);
  });

  // the catalog row of a product of several variants shows the lowest price of them
  it('shows the lowest price "from" when the variants are priced differently', async () => {
    const varied = await newProduct({ price: 50 });
    await createVariant(varied.id, { price: 35 });

    const [block] = await productsOf(manual(varied.id));

    expect(block!.items[0]).toMatchObject({ price: 35, from: true, salePrice: null });
  });

  it('shows the price of the variant when the variants are priced alike', async () => {
    const same = await newProduct({ price: 50 });
    await createVariant(same.id, { price: 50 });

    const [block] = await productsOf(manual(same.id));

    expect(block!.items[0]).toMatchObject({ price: 50, from: false });
  });

  it('shows no sale for a sale that is over', async () => {
    const over = await newProduct({ price: 40 });
    await asAdmin(
      (tx) => tx.$executeRaw`
        update cartlify.product_variants
        set "salePrice" = 30, "salePriorPrice" = 40,
            "saleEndsAt" = (now() at time zone 'utc') + interval '1.5 seconds'
        where id = ${over.variantId}
      `,
    );
    await waitForSalesEnd([over.id]);

    const [block] = await productsOf(manual(over.id));

    expect(block!.items[0]).toMatchObject({ price: 40, salePrice: null, priorPrice: null });
  });

  describe('a product on sale', () => {
    let onSale: TestProduct;

    // the product cost 90 for a while, then 100, and goes on sale at 30% off: the lowest price of the
    // 30 days before the sale is 90
    beforeAll(async () => {
      onSale = await newProduct({ price: 100 });
      for (const price of [90, 100]) {
        const set = await adminCall(
          'PATCH',
          `/api/products/${onSale.id}/variants/${onSale.variantId}`,
          {
            price,
          },
        );
        expect(set.statusCode).toBe(200);
      }
      const sale = await adminCall('PATCH', `/api/products/${onSale.id}/sale`, {
        sale: { percent: 30, endsAt: new Date(Date.now() + 5 * DAY).toISOString() },
      });
      expect(sale.statusCode).toBe(200);
    });

    it('has the regular price, the price now and the lowest price of the 30 days before the sale', async () => {
      const [block] = await productsOf(manual(onSale.id));

      expect(block!.items[0]).toMatchObject({
        productId: onSale.id,
        price: 100,
        from: false,
        salePrice: 70,
        priorPrice: 90,
        saleEndsAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      });
    });
  });
});

describe('a block by a rule', () => {
  let category: { id: number };
  let sub: { id: number };
  let p1: TestProduct;
  let p2: TestProduct;
  let p3: TestProduct;
  let p4: TestProduct;
  let p5: TestProduct;
  let empty: TestProduct;
  let deleted: TestProduct;

  // five products in a category (the third in a category below it), made one after another. Marks 5,
  // 3, 4, 1, 2; units sold 1, 3, 2, 0, 0; the override of the popularity 10, 90, 50, 30, 70. The third
  // and the fifth are on sale, 30% and 50% off. The last two are in the category and cannot be bought
  beforeAll(async () => {
    category = await createCategory();
    sub = await createCategory({ parentId: category.id });

    p1 = await newProduct({ categoryId: category.id });
    p2 = await newProduct({ categoryId: category.id });
    p3 = await newProduct({ categoryId: sub.id });
    p4 = await newProduct({ categoryId: category.id });
    p5 = await newProduct({ categoryId: category.id });

    const reviewer = await createUser();
    userIds.push(reviewer.id);
    for (const [product, rating] of [
      [p1, 5],
      [p2, 3],
      [p3, 4],
      [p4, 1],
      [p5, 2],
    ] as const) {
      await createReview(reviewer.id, product.id, { rating });
    }

    await placeOrder(app, csrf, buyer, p1, 'paid', 1);
    await placeOrder(app, csrf, buyer, p2, 'paid', 3);
    await placeOrder(app, csrf, buyer, p3, 'paid', 2);

    for (const [product, percent] of [
      [p3, 30],
      [p5, 50],
    ] as const) {
      const sale = await adminCall('PATCH', `/api/products/${product.id}/sale`, {
        sale: { percent, endsAt: new Date(Date.now() + 5 * DAY).toISOString() },
      });
      expect(sale.statusCode).toBe(200);
    }

    const overrides: Array<[TestProduct, number]> = [
      [p1, 10],
      [p2, 90],
      [p3, 50],
      [p4, 30],
      [p5, 70],
    ];
    for (const [product, popularityOverride] of overrides) {
      await asAdmin((tx) =>
        tx.product.update({
          where: { id: product.id },
          data: { popularityOverride, popularityOverrideUntil: new Date(Date.now() + 30 * DAY) },
        }),
      );
    }

    // the popularity follows the override with the next event of the product: a visit of a buyer
    for (const product of [p1, p2, p3, p4, p5]) {
      expect(
        (await app.inject({ method: 'GET', url: `/api/products/${product.id}` })).statusCode,
      ).toBe(200);
    }

    empty = await newProduct({ categoryId: category.id, stock: 0 });
    deleted = await newProduct({ categoryId: category.id });
    await deleteProductFromCatalog(deleted.id);
  });

  // the lists the catalog gives a visitor for the same questions (api/products/ tests the sorts
  // themselves); here is the list a block takes from them
  it.each([
    ['new', () => [p5.id, p4.id, p3.id, p2.id]],
    ['popular', () => [p2.id, p5.id, p3.id, p4.id]],
    ['top_rated', () => [p1.id, p3.id, p2.id, p5.id]],
    ['bestsellers', () => [p2.id, p3.id, p1.id, p5.id]],
  ])(
    'gives the list of the rule %s, four cards when the block says no number',
    async (name, ids) => {
      const [block] = await productsOf(rule(name, category.id));

      expect(idsOf(block)).toEqual(ids());
    },
  );

  it('gives only the products on sale for the rule sale, the biggest discount first', async () => {
    const [block] = await productsOf(rule('sale', category.id));

    expect(idsOf(block)).toEqual([p5.id, p3.id]);
    expect(block!.items[0]).toMatchObject({ price: 100, salePrice: 50 });
    expect(block!.items[1]).toMatchObject({ price: 100, salePrice: 70, priorPrice: 100 });
  });

  it('gives as many cards as the block says', async () => {
    const [two, six] = await productsOf(
      rule('popular', category.id, { limit: 2 }),
      rule('popular', category.id, { limit: 12 }),
    );

    expect(idsOf(two)).toEqual([p2.id, p5.id]);
    // the category holds five products a buyer can buy
    expect(idsOf(six)).toEqual([p2.id, p5.id, p3.id, p4.id, p1.id]);
  });

  it('takes the products of the categories below the category too', async () => {
    const [whole, onlySub] = await productsOf(
      rule('new', category.id, { limit: 12 }),
      rule('new', sub.id, { limit: 12 }),
    );

    expect(idsOf(whole)).toContain(p3.id);
    expect(idsOf(onlySub)).toEqual([p3.id]);
  });

  it('leaves out a product that is deleted or out of stock, as the catalog does for a visitor', async () => {
    const [block] = await productsOf(rule('new', category.id, { limit: 12 }));

    expect(idsOf(block)).not.toContain(empty.id);
    expect(idsOf(block)).not.toContain(deleted.id);
    expect(block!.unavailable).toEqual([]);
  });

  it('counts the sales of the period of the best sellers: a week, a month, three months', async () => {
    const blocks = await productsOf(
      rule('bestsellers', category.id, { limit: 3, periodDays: 7 }),
      rule('bestsellers', category.id, { limit: 3, periodDays: 30 }),
      rule('bestsellers', category.id, { limit: 3, periodDays: 90 }),
    );

    // the orders were paid a moment ago: they are in every period
    for (const block of blocks) expect(idsOf(block)).toEqual([p2.id, p3.id, p1.id]);
  });

  it('takes the list of the whole catalog when the block names no category', async () => {
    const [block] = await productsOf(rule('new', undefined, { limit: 12 }));

    expect(idsOf(block).length).toBeGreaterThan(0);
    expect(idsOf(block)).not.toContain(deleted.id);
    expect(idsOf(block)).not.toContain(empty.id);
  });

  it('gives the list of a category that holds nothing a buyer can buy as no card', async () => {
    const hollow = await createCategory();
    const gone = await newProduct({ categoryId: hollow.id });
    await deleteProductFromCatalog(gone.id);

    const [block] = await productsOf(rule('popular', hollow.id));

    expect(block!.items).toEqual([]);
    expect(block!.categoryMissing).toBe(false);
  });

  it('tells a category that is gone, and reads no list for it', async () => {
    const [block] = await productsOf(rule('popular', 2_147_483_647));

    expect(block).toEqual({ kind: 'products', items: [], unavailable: [], categoryMissing: true });
  });
});

describe('a block of a category', () => {
  const PICTURE = 'https://res.cloudinary.com/demo/image/upload/v1/categories/shoes.jpg';

  it('gives the category as the shop keeps it: its name and its picture', async () => {
    const made1 = await createCategory({ name: 'Shoes & <b>boots</b>' });
    await asAdmin((tx) =>
      tx.category.update({
        where: { id: made1.id },
        data: { imageUrl: PICTURE, imagePublicId: 'categories/shoes' },
      }),
    );

    const taken = await resolveCampaignProducts(
      content({ type: 'category', categoryId: made1.id }),
    );
    const block = taken.blocks[0] as NewsletterSnapshotCategoryDto;

    expect(block).toEqual({
      kind: 'category',
      category: {
        id: made1.id,
        name: 'Shoes & <b>boots</b>',
        imageUrl: expect.stringContaining('w_400'),
      },
    });
    expect(block.category!.imageUrl).toContain('categories/shoes.jpg');
  });

  it('has no picture for a category without one', async () => {
    const plain = await createCategory();

    const taken = await resolveCampaignProducts(
      content({ type: 'category', categoryId: plain.id }),
    );

    expect((taken.blocks[0] as NewsletterSnapshotCategoryDto).category).toMatchObject({
      id: plain.id,
      imageUrl: null,
    });
  });

  it('has no category when it is gone', async () => {
    const taken = await resolveCampaignProducts(
      content({ type: 'category', categoryId: 2_147_483_647 }),
    );

    expect(taken.blocks[0]).toEqual({ kind: 'category', category: null });
  });
});

describe('the blocks together', () => {
  it('gives a place to every block in the order of the content, null for text and a button', async () => {
    const product = await newProduct();
    const shoes = await createCategory();

    const taken = await resolveCampaignProducts(
      content(
        { type: 'text', text: { en: 'Hello' } },
        manual(product.id),
        { type: 'category', categoryId: shoes.id },
        { type: 'button', kind: 'shop', url: '/' },
      ),
    );

    expect(taken.blocks.map((block) => block?.kind ?? null)).toEqual([
      null,
      'products',
      'category',
      null,
    ]);
  });

  it('takes nothing from the catalog for a content without a block of products', async () => {
    const taken = await resolveCampaignProducts(
      content({ type: 'button', kind: 'shop', url: '/' }),
    );

    expect(taken.blocks).toEqual([null]);
  });

  it('gives the same cards to two blocks that ask for the same products', async () => {
    const product = await newProduct();

    const [one, two] = await productsOf(manual(product.id), manual(product.id));

    expect(one!.items).toEqual(two!.items);
  });
});
