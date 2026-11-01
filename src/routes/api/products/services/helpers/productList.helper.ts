import type { Prisma } from '@prisma/client';

import { decimalToNumber } from '@helpers/safeNormalizer.js';
import { InternalError } from '@utils/errors.js';

import type { ProductListRowDto } from 'types/dto/products.dto.js';

import {
  buildProductAggregatesQuery,
  type ProductKeyRow,
  type ProductListQuery,
} from './getAllProducts.helper.js';
import {
  mapProductListPart,
  productResponseSelect,
  type ProductView,
} from './productMapper.helper.js';
import {
  readVariantContext,
  variantFullOf,
  variantRowSelect,
  variantShortOf,
  type VariantRow,
} from './variant.helper.js';

type Db = Prisma.TransactionClient;

// the variant of a row: the short form for a buyer, the full one (with the stock, the reserve and
// the cost of the latest delivery) for an admin
const variantOfRow = (
  row: VariantRow,
  product: { name: string },
  context: Awaited<ReturnType<typeof readVariantContext>>,
  view: ProductView,
) => (view === 'admin' ? variantFullOf(row, context, view) : variantShortOf(row, context, view));

type ProductAggregateRow = {
  productId: number;
  minPrice: unknown;
  maxPrice: unknown;
  stock: number;
  variantId: number;
};

// The rows of a page, in the order of its keys. A variant row is the variant and its product, its
// stock the free units of the variant; a group (the rows of variants that are merged by their main
// characteristics) is its first variant and the product, with the lowest and the highest price and
// the free units of its variants, which the keys carry. A product row is the product, its main
// variant, the lowest and the highest price it sells at now over its variants of the list, and
// their free units
export async function readListRows(
  tx: Db,
  q: Pick<ProductListQuery, 'view' | 'mode' | 'grouped' | 'deleted' | 'search'>,
  keys: readonly ProductKeyRow[],
): Promise<ProductListRowDto[]> {
  if (!keys.length) return [];

  const productIds =
    q.mode === 'variant'
      ? [...new Set(keys.map((key) => key.productId!))]
      : keys.map((key) => key.id);

  // product rows: the figures of each product and its main variant, found in one query
  const aggregates = new Map<number, ProductAggregateRow>();
  if (q.mode === 'product') {
    const found = await tx.$queryRaw<ProductAggregateRow[]>(
      buildProductAggregatesQuery(q, productIds),
    );
    for (const row of found) aggregates.set(row.productId, row);
  }

  const variantIds =
    q.mode === 'variant'
      ? keys.map((key) => key.id)
      : [...aggregates.values()].map((row) => row.variantId);

  const products = await tx.product.findMany({
    where: { id: { in: productIds } },
    select: productResponseSelect,
  });
  const variants = await tx.productVariant.findMany({
    where: { id: { in: variantIds } },
    select: variantRowSelect,
  });
  // an admin gets the full variant, with the characteristics it has
  const context = await readVariantContext(tx, variants, q.view, { full: q.view === 'admin' });

  const productById = new Map(products.map((row) => [row.id, row]));
  const variantById = new Map(variants.map((row) => [row.id, row]));

  return keys.map((key) => {
    const aggregate = q.mode === 'product' ? aggregates.get(key.id) : undefined;
    const variant = variantById.get(aggregate?.variantId ?? key.id);
    const product = productById.get(q.mode === 'variant' ? key.productId! : key.id);
    if (!product || !variant) {
      throw new InternalError({ reason: 'PRODUCT_LIST_ROW_MISSING', rowId: key.id, mode: q.mode });
    }

    const shown = variantOfRow(variant, product, context, q.view);
    // the figures of a product row and of a group: the same for the variants the row holds
    const figures = aggregate ?? (q.mode === 'variant' && q.grouped ? key : undefined);
    const range =
      figures && figures.minPrice != null && figures.maxPrice != null
        ? {
            minPrice: decimalToNumber(figures.minPrice),
            maxPrice: decimalToNumber(figures.maxPrice),
          }
        : {};

    return {
      product: mapProductListPart(product, q.view),
      variant: shown,
      ...range,
      stock: figures?.stock ?? shown.stock,
    };
  });
}
