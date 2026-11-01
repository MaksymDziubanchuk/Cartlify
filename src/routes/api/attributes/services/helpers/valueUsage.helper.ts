import { Prisma } from '@prisma/client';

import { NAMED_MAX, type Tx } from './directory.helper.js';

// Who holds a value of a characteristic of the directory: the variants that have a value of it (or
// a given value of its list) and the products they belong to. The rules of the directory that
// protect the variants (the type, a delete) name some of them in their refusals; the rest is counted.

export type CharacteristicUsage = {
  // the variants that have a value of the characteristic
  variantsCount: number;
  // the products those variants belong to, how many, and the first of them by id
  productsTotal: number;
  productIds: number[];
};

export async function characteristicUsage(
  tx: Tx,
  attributeId: number,
): Promise<CharacteristicUsage> {
  const [totals] = await tx.$queryRaw<{ variants: number; products: number }[]>(Prisma.sql`
    SELECT count(DISTINCT x."variantId")::int AS variants, count(DISTINCT v."productId")::int AS products
    FROM cartlify.variant_attribute_values AS x
    JOIN cartlify.product_variants AS v ON v.id = x."variantId"
    WHERE x."attributeId" = ${attributeId}::int
  `);
  if (!totals || totals.variants === 0)
    return { variantsCount: 0, productsTotal: 0, productIds: [] };

  const named = await tx.$queryRaw<{ productId: number }[]>(Prisma.sql`
    SELECT DISTINCT v."productId"
    FROM cartlify.variant_attribute_values AS x
    JOIN cartlify.product_variants AS v ON v.id = x."variantId"
    WHERE x."attributeId" = ${attributeId}::int
    ORDER BY v."productId"
    LIMIT ${NAMED_MAX}::int
  `);

  return {
    variantsCount: totals.variants,
    productsTotal: totals.products,
    productIds: named.map((row) => row.productId),
  };
}

export type OptionUsage = {
  variantsTotal: number;
  productsTotal: number;
  // the first products by id, each with the first of its variants that have the value
  products: Array<{ productId: number; variantIds: number[] }>;
};

export async function optionUsage(tx: Tx, optionId: number): Promise<OptionUsage> {
  const [totals] = await tx.$queryRaw<{ variants: number; products: number }[]>(Prisma.sql`
    SELECT count(DISTINCT x."variantId")::int AS variants, count(DISTINCT v."productId")::int AS products
    FROM cartlify.variant_attribute_values AS x
    JOIN cartlify.product_variants AS v ON v.id = x."variantId"
    WHERE x."optionId" = ${optionId}::int
  `);
  if (!totals || totals.variants === 0) return { variantsTotal: 0, productsTotal: 0, products: [] };

  const rows = await tx.$queryRaw<{ productId: number; variantId: number }[]>(Prisma.sql`
    SELECT v."productId", v.id AS "variantId"
    FROM cartlify.variant_attribute_values AS x
    JOIN cartlify.product_variants AS v ON v.id = x."variantId"
    WHERE x."optionId" = ${optionId}::int
      AND v."productId" IN (
        SELECT DISTINCT v2."productId"
        FROM cartlify.variant_attribute_values AS x2
        JOIN cartlify.product_variants AS v2 ON v2.id = x2."variantId"
        WHERE x2."optionId" = ${optionId}::int
        ORDER BY v2."productId"
        LIMIT ${NAMED_MAX}::int
      )
    ORDER BY v."productId", v.id
  `);

  const byProduct = new Map<number, number[]>();
  for (const row of rows) {
    const ids = byProduct.get(row.productId) ?? [];
    if (ids.length < NAMED_MAX) ids.push(row.variantId);
    byProduct.set(row.productId, ids);
  }

  return {
    variantsTotal: totals.variants,
    productsTotal: totals.products,
    products: [...byProduct].map(([productId, variantIds]) => ({ productId, variantIds })),
  };
}
