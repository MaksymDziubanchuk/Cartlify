import type { Prisma, PrismaClient } from '@prisma/client';

import type { VariantValueDto } from 'types/dto/variants.dto.js';

type DbClient = Pick<Prisma.TransactionClient, '$queryRaw'> | PrismaClient;

// what a variant is called and by which characteristics it differs from the others of its product
export type VariantNameInfo = { name: string; values: VariantValueDto[] };

// The names of variants, with the values that tell them apart, in one query: cartlify.variant_names
// (db/05) is the one rule of the name, the order items copy the very same one at the confirmation,
// so what the card shows and what an order keeps agree. A variant that is not there is left out of
// the map
export async function variantNamesOf(
  db: DbClient,
  variantIds: readonly number[],
): Promise<Map<number, VariantNameInfo>> {
  const ids = [...new Set(variantIds)];
  if (!ids.length) return new Map();

  const rows = await db.$queryRaw<
    { variant_id: number; name: string; values: VariantValueDto[] }[]
  >`
    select variant_id, name, "values" from cartlify.variant_names(${ids}::int[])
  `;

  return new Map(rows.map((row) => [row.variant_id, { name: row.name, values: row.values }]));
}
