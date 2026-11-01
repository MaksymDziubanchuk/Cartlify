import type { Prisma, PrismaClient } from '@prisma/client';

import { expiredUnitsOf, freeUnits } from '@db/expiredStock.helper.js';
import { lastUnitCostsOf } from '@db/lastUnitCost.helper.js';
import { variantNamesOf } from '@db/variantNames.helper.js';
import { saleFieldsOf } from '@helpers/productSale.js';
import { decimalToNumber } from '@helpers/safeNormalizer.js';
import { InternalError } from '@utils/errors.js';
import { buildImageUrls } from '@utils/cloudinary.util.js';

import type {
  VariantContext,
  VariantFullDto,
  VariantImageDto,
  VariantShortDto,
} from 'types/dto/variants.dto.js';
import { readCardAttributes } from './variantCardAttributes.helper.js';

import type { ProductView } from './productMapper.helper.js';

type DbClient = Prisma.TransactionClient | PrismaClient;

// the fields of a variant its answers show (a card, a list row, a cart position, a favorite): a new
// field of the answer is added here once. The pictures come with the place each has in the variant
export const variantRowSelect = {
  id: true,
  productId: true,
  position: true,
  sku: true,
  barcode: true,
  price: true,
  stock: true,
  reservedStock: true,
  weightGrams: true,
  lengthMm: true,
  widthMm: true,
  heightMm: true,
  salePrice: true,
  saleEndsAt: true,
  salePriorPrice: true,
  deletedAt: true,
  updatedAt: true,
  images: {
    select: { position: true, image: { select: { id: true, url: true } } },
    orderBy: { position: 'asc' },
  },
} as const;

export type VariantRow = Prisma.ProductVariantGetPayload<{ select: typeof variantRowSelect }>;

// a variant a buyer sees: it is for sale and it shows at least one picture (a variant without one
// is hidden, so a product whose variants all lack pictures is in no list)
export const visibleVariantWhere = {
  deletedAt: null,
  images: { some: {} },
} satisfies Prisma.ProductVariantWhereInput;

export const isVariantVisible = (row: Pick<VariantRow, 'deletedAt' | 'images'>): boolean =>
  row.deletedAt === null && row.images.length > 0;

// the variant the card of a product opens by default: the first by its place that has free units,
// the first of all when none has
export function mainVariantOf<T extends { id: number; stock: number; reservedStock: number }>(
  rows: readonly T[],
  context: Pick<VariantContext, 'expired'>,
): T | undefined {
  return (
    rows.find(
      (row) => freeUnits(row.stock, row.reservedStock, context.expired.get(row.id) ?? 0) > 0,
    ) ?? rows[0]
  );
}

// what an answer needs besides the rows of its variants: the units that are over, the names and the
// values that tell the variants apart (one query for the whole page, cartlify.variant_names: the one
// rule of the name), for an admin the cost of the latest delivery, and the characteristics of the
// variants the answer gives in full (`full`: all the rows, or the ids that are)
export async function readVariantContext(
  db: DbClient,
  rows: ReadonlyArray<Pick<VariantRow, 'id'>>,
  view: ProductView,
  opts: { full?: boolean | readonly number[] } = {},
): Promise<VariantContext> {
  const ids = rows.map((row) => row.id);
  const expired = await expiredUnitsOf(db, ids);
  const names = await variantNamesOf(db, ids);
  const costs = view === 'admin' ? await lastUnitCostsOf(db, ids) : new Map();

  const fullIds = opts.full === true ? ids : Array.isArray(opts.full) ? opts.full : [];
  const attributes = await readCardAttributes(db, fullIds);

  return { expired, names, costs, attributes };
}

const imageOf = (row: VariantRow['images'][number]): VariantImageDto => ({
  id: row.image.id,
  position: row.position,
  ...buildImageUrls(row.image.url, 'product'),
});

// the sale as an admin gets it: the row as it is, null when empty, a sale past its end too
const rawSaleOf = (row: VariantRow) => ({
  salePrice: row.salePrice === null ? null : decimalToNumber(row.salePrice),
  saleEndsAt: row.saleEndsAt ? row.saleEndsAt.toISOString() : null,
  salePriorPrice: row.salePriorPrice == null ? null : decimalToNumber(row.salePriorPrice),
});

export function variantShortOf(
  row: VariantRow,
  context: VariantContext,
  view: ProductView,
): VariantShortDto {
  const first = row.images[0];
  const named = context.names.get(row.id);
  if (!named) throw new InternalError({ reason: 'VARIANT_NAME_MISSING', variantId: row.id });

  return {
    id: row.id,
    position: row.position,
    name: named.name,
    values: named.values,
    price: decimalToNumber(row.price),
    ...(view === 'admin' ? rawSaleOf(row) : saleFieldsOf(row)),
    stock: freeUnits(row.stock, row.reservedStock, context.expired.get(row.id) ?? 0),
    image: first ? buildImageUrls(first.image.url, 'product') : null,
    ...(view === 'admin'
      ? { visible: isVariantVisible(row), deletedAt: row.deletedAt?.toISOString() ?? null }
      : {}),
  };
}

export function variantFullOf(
  row: VariantRow,
  context: VariantContext,
  view: ProductView,
): VariantFullDto {
  const adminFields =
    view === 'admin'
      ? {
          barcode: row.barcode,
          totalStock: row.stock,
          reservedStock: row.reservedStock,
          expiredStock: context.expired.get(row.id) ?? 0,
          lastUnitCost:
            context.costs.get(row.id) == null ? null : decimalToNumber(context.costs.get(row.id)),
          updatedAt: row.updatedAt.toISOString(),
        }
      : {};

  return {
    ...variantShortOf(row, context, view),
    attributes: context.attributes.get(row.id) ?? [],
    sku: row.sku,
    weightGrams: row.weightGrams,
    lengthMm: row.lengthMm,
    widthMm: row.widthMm,
    heightMm: row.heightMm,
    images: row.images.map(imageOf),
    ...adminFields,
  };
}
