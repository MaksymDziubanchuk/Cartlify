import { Prisma } from '@prisma/client';
import { describe, expect, it } from '@jest/globals';

import { mapProductListPart } from '@routes/api/products/services/helpers/productMapper.helper.js';
import { readListRows, type ProductKeyRow } from '@routes/api/products/services/helpers/index.js';
import type { VariantRow } from '@routes/api/products/services/helpers/variant.helper.js';

import { rejectedBy } from '../../../../../../helpers/errors.js';

// the rows of a page of the catalog list: the product part, the variant (the short form for a
// buyer, the full one for an admin), the range of prices and the free units. The database is a
// fake: the queries it answers are the ones readListRows makes

const imageUrl = 'https://res.cloudinary.com/demo/image/upload/v1/products/1/a.jpg';

const productRow = (id: number, patch: Record<string, unknown> = {}) => ({
  id,
  name: `Lamp ${id}`,
  description: 'Warm light' as string | null,
  categoryId: 2,
  category: { id: 2, name: 'Lamps', slug: 'lamps' },
  manufacturerId: 7,
  euResponsibleId: null,
  warnings: null,
  views: 40,
  popularity: 7,
  popularityOverride: null,
  popularityOverrideUntil: null,
  avgRating: new Prisma.Decimal('4.25'),
  reviewsCount: 4,
  deletedAt: null as Date | null,
  createdAt: new Date('2026-01-01T10:00:00.000Z'),
  updatedAt: new Date('2026-01-05T10:00:00.000Z'),
  ...patch,
});

const variantRow = (
  id: number,
  productId: number,
  patch: Partial<VariantRow> = {},
): VariantRow => ({
  id,
  productId,
  position: 1,
  sku: `SKU-${id}`,
  barcode: '4006381333931',
  price: new Prisma.Decimal('25.50'),
  stock: 10,
  reservedStock: 3,
  weightGrams: 350,
  lengthMm: 200,
  widthMm: 100,
  heightMm: 50,
  salePrice: null,
  saleEndsAt: null,
  salePriorPrice: null,
  deletedAt: null,
  updatedAt: new Date('2026-01-05T10:00:00.000Z'),
  images: [{ position: 1, image: { id: 5, url: imageUrl } }],
  ...patch,
});

type Aggregate = {
  productId: number;
  minPrice: unknown;
  maxPrice: unknown;
  stock: number;
  variantId: number;
};

// a transaction that answers the queries of the page: the aggregates of the products (a call with a
// Sql object), the units that are over, the names of the variants, the characteristics of the
// variants an admin gets in full and the costs of the latest deliveries (tagged templates), and the
// products and the variants Prisma reads
function fakeTx(data: {
  aggregates?: Aggregate[];
  products: ReturnType<typeof productRow>[];
  variants: VariantRow[];
  expired?: Array<{ id: number; n: number }>;
  costs?: Array<{ variantId: number; unitCost: Prisma.Decimal }>;
  // the name of a variant by its id; a variant has the name of its product ("Lamp <id>") otherwise
  names?: Record<number, string>;
}) {
  const asked: { products?: number[]; variants?: number[] } = {};

  const tx = {
    $queryRaw: (first: unknown, ...values: unknown[]) => {
      // a tagged template starts with the array of its strings
      if (Array.isArray(first)) {
        const text = (first as string[]).join('?');
        if (text.includes('variant_names')) {
          return Promise.resolve(
            (values[0] as number[]).map((id) => ({
              variant_id: id,
              name:
                data.names?.[id] ?? `Lamp ${data.variants.find((row) => row.id === id)?.productId}`,
              values: [],
            })),
          );
        }
        if (text.includes('variant_attribute_values')) return Promise.resolve([]);
        return Promise.resolve(
          text.includes('variant_expired_units') ? (data.expired ?? []) : (data.costs ?? []),
        );
      }
      return Promise.resolve(data.aggregates ?? []);
    },
    product: {
      findMany: (args: { where: { id: { in: number[] } } }) => {
        asked.products = args.where.id.in;
        return Promise.resolve(data.products.filter((row) => args.where.id.in.includes(row.id)));
      },
    },
    productVariant: {
      findMany: (args: { where: { id: { in: number[] } } }) => {
        asked.variants = args.where.id.in;
        return Promise.resolve(data.variants.filter((row) => args.where.id.in.includes(row.id)));
      },
    },
  };

  return { tx: tx as never, asked };
}

const keys = (...ids: number[]): ProductKeyRow[] => ids.map((id) => ({ id }));

describe('mapProductListPart', () => {
  it('gives a buyer what helps to buy and the popularity the list sorts by', () => {
    const out = mapProductListPart(productRow(1) as never, 'buyer');

    expect(out).toEqual({
      id: 1,
      name: 'Lamp 1',
      description: 'Warm light',
      category: { id: 2, name: 'Lamps', slug: 'lamps' },
      avgRating: 4.25,
      reviewsCount: 4,
      createdAt: '2026-01-01T10:00:00.000Z',
      popularity: 7,
    });
  });

  it('leaves out an empty description', () => {
    expect(
      mapProductListPart(productRow(1, { description: null }) as never, 'buyer'),
    ).not.toHaveProperty('description');
  });

  it('gives an admin the counters, the override and the delete date as the row has them', () => {
    const out = mapProductListPart(
      productRow(1, {
        popularityOverride: 50,
        popularityOverrideUntil: new Date('2026-03-01T00:00:00.000Z'),
        deletedAt: new Date('2026-02-01T00:00:00.000Z'),
      }) as never,
      'admin',
    );

    expect(out).toMatchObject({
      popularity: 7,
      views: 40,
      updatedAt: '2026-01-05T10:00:00.000Z',
      popularityOverride: 50,
      popularityOverrideUntil: '2026-03-01T00:00:00.000Z',
      deletedAt: '2026-02-01T00:00:00.000Z',
    });
  });

  it('shows an admin an empty override and delete date as null', () => {
    expect(mapProductListPart(productRow(1) as never, 'admin')).toMatchObject({
      popularityOverride: null,
      popularityOverrideUntil: null,
      deletedAt: null,
    });
  });

  it('gives a buyer none of the fields of an admin', () => {
    const out = mapProductListPart(productRow(1) as never, 'buyer');

    for (const field of ['views', 'updatedAt', 'popularityOverride', 'deletedAt', 'categoryId']) {
      expect(out).not.toHaveProperty(field);
    }
  });
});

describe('readListRows', () => {
  it('gives no row for no key and asks the database nothing', async () => {
    const { tx, asked } = fakeTx({ products: [], variants: [] });

    expect(await readListRows(tx, { view: 'buyer', mode: 'product', deleted: false }, [])).toEqual(
      [],
    );
    expect(asked).toEqual({});
  });

  describe('a list of variants', () => {
    it('gives a buyer the short variant with its product and the free units of the variant', async () => {
      const { tx } = fakeTx({
        products: [productRow(1)],
        variants: [variantRow(31, 1)],
      });

      const [row, ...rest] = await readListRows(
        tx,
        { view: 'buyer', mode: 'variant', deleted: false },
        [{ id: 31, productId: 1 }],
      );

      expect(rest).toEqual([]);
      expect(row!.product).toMatchObject({ id: 1, popularity: 7 });
      expect(row!.variant).toMatchObject({ id: 31, name: 'Lamp 1', price: 25.5, stock: 7 });
      // the stock of the row is the stock of the variant, and there is no range of prices
      expect(row!.stock).toBe(7);
      expect(row).not.toHaveProperty('minPrice');
      expect(row).not.toHaveProperty('maxPrice');
      for (const field of ['sku', 'barcode', 'totalStock', 'images', 'lastUnitCost']) {
        expect(row!.variant).not.toHaveProperty(field);
      }
    });

    it('gives an admin the full variant with the stock, the reserve, the units that are over and the cost', async () => {
      const { tx } = fakeTx({
        products: [productRow(1)],
        variants: [variantRow(31, 1)],
        expired: [{ id: 31, n: 2 }],
        costs: [{ variantId: 31, unitCost: new Prisma.Decimal('8.40') }],
      });

      const [row] = await readListRows(tx, { view: 'admin', mode: 'variant', deleted: false }, [
        { id: 31, productId: 1 },
      ]);

      expect(row!.variant).toMatchObject({
        id: 31,
        sku: 'SKU-31',
        barcode: '4006381333931',
        weightGrams: 350,
        stock: 5,
        totalStock: 10,
        reservedStock: 3,
        expiredStock: 2,
        lastUnitCost: 8.4,
        visible: true,
        deletedAt: null,
      });
      expect(row!.variant).toHaveProperty('images');
      expect(row!.stock).toBe(5);
      expect(row!.product).toMatchObject({ views: 40, deletedAt: null });
    });

    it('keeps the order of the keys and gives the variants of one product their product once', async () => {
      const { tx, asked } = fakeTx({
        products: [productRow(1), productRow(2)],
        variants: [variantRow(31, 1), variantRow(32, 1), variantRow(41, 2)],
      });

      const rows = await readListRows(tx, { view: 'buyer', mode: 'variant', deleted: false }, [
        { id: 41, productId: 2 },
        { id: 31, productId: 1 },
        { id: 32, productId: 1 },
      ]);

      expect(rows.map((row) => [row.product.id, row.variant.id])).toEqual([
        [2, 41],
        [1, 31],
        [1, 32],
      ]);
      expect(asked.products).toEqual([2, 1]);
      expect(asked.variants).toEqual([41, 31, 32]);
    });

    it('shows the sale next to the price while it lasts and leaves it out when it is over', async () => {
      const running = new Date(Date.now() + 60_000);
      const over = new Date(Date.now() - 60_000);
      const { tx } = fakeTx({
        products: [productRow(1)],
        variants: [
          variantRow(31, 1, { salePrice: new Prisma.Decimal('19.90'), saleEndsAt: running }),
          variantRow(32, 1, { salePrice: new Prisma.Decimal('19.90'), saleEndsAt: over }),
        ],
      });

      const rows = await readListRows(tx, { view: 'buyer', mode: 'variant', deleted: false }, [
        { id: 31, productId: 1 },
        { id: 32, productId: 1 },
      ]);

      expect(rows[0]!.variant).toMatchObject({ price: 25.5, salePrice: 19.9 });
      expect(rows[1]!.variant).not.toHaveProperty('salePrice');
    });

    it('fails when a variant of the page is gone', async () => {
      const { tx } = fakeTx({ products: [productRow(1)], variants: [] });

      const error = await rejectedBy(() =>
        readListRows(tx, { view: 'buyer', mode: 'variant', deleted: false }, [
          { id: 31, productId: 1 },
        ]),
      );

      expect(error).toMatchObject({
        statusCode: 500,
        details: { reason: 'PRODUCT_LIST_ROW_MISSING' },
      });
    });
  });

  describe('a list of groups', () => {
    const grouped = { view: 'buyer', mode: 'variant', grouped: true, deleted: false } as const;

    it('gives the first variant of the group, the range of prices and the free units the key carries', async () => {
      const { tx } = fakeTx({
        products: [productRow(1)],
        variants: [variantRow(31, 1)],
      });

      const [row, ...rest] = await readListRows(tx, grouped, [
        {
          id: 31,
          productId: 1,
          minPrice: new Prisma.Decimal('19.90'),
          maxPrice: new Prisma.Decimal('30.00'),
          stock: 12,
        },
      ]);

      expect(rest).toEqual([]);
      expect(row!.variant).toMatchObject({ id: 31, price: 25.5 });
      expect(row).toMatchObject({ minPrice: 19.9, maxPrice: 30, stock: 12 });
    });

    it('gives a group of one price the same minimum and maximum', async () => {
      const { tx } = fakeTx({ products: [productRow(1)], variants: [variantRow(31, 1)] });

      const [row] = await readListRows(tx, grouped, [
        {
          id: 31,
          productId: 1,
          minPrice: new Prisma.Decimal('25.50'),
          maxPrice: new Prisma.Decimal('25.50'),
          stock: 7,
        },
      ]);

      expect(row).toMatchObject({ minPrice: 25.5, maxPrice: 25.5, stock: 7 });
    });

    it('keeps the order of the keys and reads each product once', async () => {
      const { tx, asked } = fakeTx({
        products: [productRow(1), productRow(2)],
        variants: [variantRow(31, 1), variantRow(32, 1), variantRow(41, 2)],
      });
      const key = (id: number, productId: number): ProductKeyRow => ({
        id,
        productId,
        minPrice: 1,
        maxPrice: 2,
        stock: 3,
      });

      const rows = await readListRows(tx, grouped, [key(41, 2), key(31, 1), key(32, 1)]);

      expect(rows.map((row) => [row.product.id, row.variant.id])).toEqual([
        [2, 41],
        [1, 31],
        [1, 32],
      ]);
      expect(asked.products).toEqual([2, 1]);
      expect(asked.variants).toEqual([41, 31, 32]);
    });

    it('gives an admin the full variant with the figures of the group', async () => {
      const { tx } = fakeTx({
        products: [productRow(1)],
        variants: [variantRow(31, 1)],
        expired: [{ id: 31, n: 2 }],
      });

      const [row] = await readListRows(tx, { ...grouped, view: 'admin' }, [
        { id: 31, productId: 1, minPrice: 5, maxPrice: 9, stock: 4 },
      ]);

      expect(row!.variant).toMatchObject({
        id: 31,
        totalStock: 10,
        expiredStock: 2,
        visible: true,
      });
      expect(row).toMatchObject({ minPrice: 5, maxPrice: 9, stock: 4 });
    });

    it('leaves the range and the units of the variant to a single variant that is not in a group', async () => {
      const { tx } = fakeTx({ products: [productRow(1)], variants: [variantRow(31, 1)] });

      const [row] = await readListRows(tx, { ...grouped, grouped: false }, [
        { id: 31, productId: 1, minPrice: 1, maxPrice: 2, stock: 99 },
      ]);

      expect(row).not.toHaveProperty('minPrice');
      expect(row!.stock).toBe(7);
    });
  });

  describe('a list of products', () => {
    const aggregate = (patch: Partial<Aggregate> = {}): Aggregate => ({
      productId: 1,
      minPrice: new Prisma.Decimal('9.50'),
      maxPrice: new Prisma.Decimal('30.00'),
      stock: 12,
      variantId: 32,
      ...patch,
    });

    it('gives the product with its main variant, the range of prices and the free units of all the variants', async () => {
      const { tx, asked } = fakeTx({
        aggregates: [aggregate()],
        products: [productRow(1)],
        variants: [
          variantRow(31, 1),
          variantRow(32, 1, { price: new Prisma.Decimal('30'), stock: 4, reservedStock: 0 }),
        ],
      });

      const [row] = await readListRows(
        tx,
        { view: 'buyer', mode: 'product', deleted: false },
        keys(1),
      );

      expect(row!.product).toMatchObject({ id: 1, popularity: 7 });
      // the variant of the row is the main one the aggregates named, the figures are the product's
      expect(row!.variant).toMatchObject({ id: 32, price: 30, stock: 4 });
      expect(row).toMatchObject({ minPrice: 9.5, maxPrice: 30, stock: 12 });
      // only the main variant is read, not every variant of the product
      expect(asked.variants).toEqual([32]);
    });

    it('gives the same minimum and maximum for one price', async () => {
      const { tx } = fakeTx({
        aggregates: [
          aggregate({
            minPrice: new Prisma.Decimal('25.50'),
            maxPrice: new Prisma.Decimal('25.50'),
            variantId: 31,
          }),
        ],
        products: [productRow(1)],
        variants: [variantRow(31, 1)],
      });

      const [row] = await readListRows(
        tx,
        { view: 'buyer', mode: 'product', deleted: false },
        keys(1),
      );

      expect(row).toMatchObject({ minPrice: 25.5, maxPrice: 25.5 });
    });

    it('leaves out the range of prices and shows no free units for a product no variant of the list is alive in', async () => {
      const { tx } = fakeTx({
        aggregates: [aggregate({ minPrice: null, maxPrice: null, stock: 0, variantId: 31 })],
        products: [productRow(1)],
        variants: [variantRow(31, 1, { deletedAt: new Date('2026-02-01T00:00:00.000Z') })],
      });

      const [row] = await readListRows(
        tx,
        { view: 'admin', mode: 'product', deleted: false },
        keys(1),
      );

      expect(row).not.toHaveProperty('minPrice');
      expect(row).not.toHaveProperty('maxPrice');
      expect(row!.stock).toBe(0);
      expect(row!.variant).toMatchObject({ id: 31, visible: false });
    });

    it('gives an admin the full variant and the figures over the variants of the list', async () => {
      const { tx } = fakeTx({
        aggregates: [aggregate({ variantId: 31 })],
        products: [productRow(1)],
        variants: [variantRow(31, 1)],
        costs: [{ variantId: 31, unitCost: new Prisma.Decimal('3') }],
      });

      const [row] = await readListRows(
        tx,
        { view: 'admin', mode: 'product', deleted: false },
        keys(1),
      );

      expect(row!.variant).toMatchObject({
        id: 31,
        totalStock: 10,
        reservedStock: 3,
        lastUnitCost: 3,
      });
      expect(row).toMatchObject({ minPrice: 9.5, maxPrice: 30, stock: 12 });
    });

    it('keeps the order of the keys', async () => {
      const { tx } = fakeTx({
        aggregates: [
          aggregate({ productId: 1, variantId: 31 }),
          aggregate({ productId: 2, variantId: 41 }),
        ],
        products: [productRow(1), productRow(2)],
        variants: [variantRow(31, 1), variantRow(41, 2)],
      });

      const rows = await readListRows(
        tx,
        { view: 'buyer', mode: 'product', deleted: false },
        keys(2, 1),
      );

      expect(rows.map((row) => row.product.id)).toEqual([2, 1]);
    });

    it('fails when the aggregates do not name a variant of a product of the page', async () => {
      const { tx } = fakeTx({ aggregates: [], products: [productRow(1)], variants: [] });

      const error = await rejectedBy(() =>
        readListRows(tx, { view: 'buyer', mode: 'product', deleted: false }, keys(1)),
      );

      expect(error).toMatchObject({
        statusCode: 500,
        details: { reason: 'PRODUCT_LIST_ROW_MISSING' },
      });
    });
  });
});
