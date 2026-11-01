import { Prisma } from '@prisma/client';
import { getPgCode } from '@db/client.js';
import {
  parseCharacteristicFilter,
  type CharacteristicFilterEntry,
} from '@helpers/characteristicFilter.js';
import { toNumberSafe, toStringSafe } from '@helpers/safeNormalizer.js';
import { BadRequestError } from '@utils/errors.js';

// the highest price numeric(10, 2) holds
export const MAX_PRICE = 99_999_999.99;

// a price of whole cents from 0 up to MAX_PRICE: 10.004 was kept as 10.00 by the database
export const isPrice = (value: number): boolean =>
  Number.isFinite(value) &&
  value >= 0 &&
  value <= MAX_PRICE &&
  Math.abs(Math.round(value * 100) - value * 100) < 1e-6;

// the longest article number the column keeps, in signs (code points, as the json schema counts)
export const MAX_SKU_LENGTH = 64;

// an article number as it is kept: trimmed, an empty one is none (null), undefined is not sent.
// The json schema stops a longer one, a form is checked here
export function normalizeSku(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;

  const sku = String(value).trim();
  if (!sku) return null;
  if ([...sku].length > MAX_SKU_LENGTH) throw new BadRequestError('PRODUCT_SKU_TOO_LONG');

  return sku;
}

// the article number another variant of the catalog has already: the unique index of db/06
export function isSkuTaken(err: unknown): boolean {
  const unique =
    (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') ||
    getPgCode(err) === '23505';
  if (!unique) return false;

  const meta = err instanceof Prisma.PrismaClientKnownRequestError ? err.meta : undefined;
  return `${JSON.stringify(meta ?? {})} ${String((err as Error)?.message ?? '')}`.includes(
    'product_variants_sku_catalog_uidx',
  );
}

export function normalizeFindProductByIdInput(dto: { productId: unknown }) {
  // normalize and validate product id
  const productId = toNumberSafe(dto.productId);
  if (productId == null || !Number.isInteger(productId) || productId <= 0) {
    throw new BadRequestError('PRODUCT_ID_INVALID');
  }

  return { productId };
}

// the fields of a new product itself; its price, its article number, its weight and its stock are
// the ones of its variants (variantInput.helper.ts)
export function normalizeCreateProductInput(args: {
  name: unknown;
  description?: unknown;
  stock?: unknown;
  categoryId: unknown;
}) {
  // a new product has no stock: it comes only with a delivery (POST /api/products/stock/deliveries)
  if (args.stock !== undefined) throw new BadRequestError('PRODUCT_STOCK_NOT_ALLOWED');

  // normalize required category id
  const categoryIdRaw = toNumberSafe(args.categoryId);
  if (categoryIdRaw == null || !Number.isInteger(categoryIdRaw) || categoryIdRaw <= 0) {
    throw new BadRequestError('CATEGORY_ID_INVALID');
  }

  // normalize required scalars
  const nameRaw = toStringSafe(args.name);

  // normalize optional description
  const descriptionRaw = args.description != null ? toStringSafe(args.description) : undefined;

  const nameNorm = typeof nameRaw === 'string' ? nameRaw.trim() : '';
  const descriptionNorm =
    typeof descriptionRaw === 'string' ? descriptionRaw.trim() || undefined : undefined;

  // validate required name
  if (!nameNorm.length) {
    throw new BadRequestError('PRODUCT_NAME_INVALID');
  }

  return {
    nameNorm,
    descriptionNorm,
    categoryIdRaw,
  };
}
export function normalizeUpdateProductInput(
  args: {
    name?: unknown;
    description?: unknown;
    stock?: unknown;
    categoryId?: unknown;
    popularityOverride?: unknown;
    popularityOverrideUntil?: unknown;
  },
  now = Date.now(),
) {
  // the stock changes only with a delivery or a write-off, each with its line in the admin log
  if (args.stock !== undefined) throw new BadRequestError('PRODUCT_STOCK_NOT_ALLOWED');

  // normalize optional ids
  const categoryIdRaw = args.categoryId != null ? toNumberSafe(args.categoryId) : undefined;
  if (args.categoryId != null) {
    if (categoryIdRaw == null || !Number.isInteger(categoryIdRaw) || categoryIdRaw <= 0) {
      throw new BadRequestError('CATEGORY_ID_INVALID');
    }
  }

  // normalize optional scalars
  const nameRaw = args.name != null ? toStringSafe(args.name) : undefined;
  const descriptionRaw = args.description != null ? toStringSafe(args.description) : undefined;

  const popularityOverrideRaw =
    args.popularityOverride === null
      ? null
      : args.popularityOverride != null
        ? toNumberSafe(args.popularityOverride)
        : undefined;

  const popularityOverrideUntilRaw =
    args.popularityOverrideUntil === null
      ? null
      : args.popularityOverrideUntil != null
        ? toStringSafe(args.popularityOverrideUntil)
        : undefined;

  const nameNorm = typeof nameRaw === 'string' ? nameRaw.trim() : undefined;
  const descriptionNorm = typeof descriptionRaw === 'string' ? descriptionRaw.trim() : undefined;

  // validate optional name
  if (args.name != null && (!nameNorm || !nameNorm.length)) {
    throw new BadRequestError('PRODUCT_NAME_INVALID');
  }

  // validate optional popularity override
  if (args.popularityOverride != null && args.popularityOverride !== null) {
    if (
      popularityOverrideRaw == null ||
      !Number.isInteger(popularityOverrideRaw) ||
      popularityOverrideRaw < 0
    ) {
      throw new BadRequestError('POPULARITY_OVERRIDE_INVALID');
    }
  }

  // validate optional popularity override until: an override overrides while its end is ahead
  // (recalc_product_popularity, db/05), an end that is not ahead would override nothing
  let popularityOverrideUntilDate: Date | null | undefined = undefined;
  if (popularityOverrideUntilRaw !== undefined) {
    if (popularityOverrideUntilRaw === null) {
      popularityOverrideUntilDate = null;
    } else {
      const d = new Date(popularityOverrideUntilRaw);
      if (Number.isNaN(d.getTime()) || d.getTime() <= now) {
        throw new BadRequestError('POPULARITY_OVERRIDE_UNTIL_INVALID');
      }
      popularityOverrideUntilDate = d;
    }
  }

  return {
    nameNorm,
    descriptionNorm,
    categoryIdRaw,
    popularityOverrideRaw,
    popularityOverrideUntilDate,
  };
}

// an override of the popularity overrides only with its end, and an end is the end of an
// override: after a change the product has both or neither
export function assertPopularityOverridePair(next: {
  popularityOverride: number | null;
  popularityOverrideUntil: Date | null;
}): void {
  if (next.popularityOverride !== null && next.popularityOverrideUntil === null) {
    throw new BadRequestError('POPULARITY_OVERRIDE_UNTIL_REQUIRED');
  }
  if (next.popularityOverride === null && next.popularityOverrideUntil !== null) {
    throw new BadRequestError('POPULARITY_OVERRIDE_REQUIRED');
  }
}

export function normalizeBulkUpdateProductsPriceInput(args: {
  mode: unknown;
  value: unknown;

  scope?: unknown;

  dryRun?: unknown;
  reason?: unknown;
  sale?: unknown;
}): {
  mode: 'percent' | 'fixed';
  value: number;

  // the filter of the variants the change goes to
  where: Prisma.ProductVariantWhereInput;
  // the characteristics the variants have to have (scope.f, the filter of the catalog): the entries,
  // none when the scope names none; the database checks them (resolveCharacteristicFilter)
  characteristics: CharacteristicFilterEntry[];
  // the variants with free units (true) or without (false); none: every variant of the scope
  inStock?: boolean;

  dryRun: boolean;
  reason?: string;
  sale?: 'keep' | 'remove';
} {
  // normalize mode and value
  const modeRaw =
    args.mode === 'percent' || args.mode === 'fixed' ? (args.mode as 'percent' | 'fixed') : null;
  if (!modeRaw) throw new BadRequestError('BULK_PRICE_MODE_INVALID');

  const valueRaw = toNumberSafe(args.value);
  if (valueRaw == null || !Number.isFinite(valueRaw)) {
    throw new BadRequestError('BULK_PRICE_VALUE_INVALID');
  }

  // block impossible percent that would always produce negative prices
  if (modeRaw === 'percent' && valueRaw < -100) {
    throw new BadRequestError('BULK_PRICE_PERCENT_TOO_LOW');
  }

  // normalize optional flags
  const dryRun = args.dryRun === true;

  const reasonStr = toStringSafe(args.reason);
  const reason = reasonStr ? reasonStr.trim() || undefined : undefined;

  // unwrap optional scope object
  const scopeObj =
    typeof args.scope === 'object' && args.scope !== null ? (args.scope as any) : null;

  // normalize optional filters
  const categoryIdVal = scopeObj ? scopeObj.categoryId : undefined;
  const categoryIdRaw = categoryIdVal != null ? toNumberSafe(categoryIdVal) : undefined;
  if (categoryIdVal != null) {
    if (categoryIdRaw == null || !Number.isInteger(categoryIdRaw) || categoryIdRaw <= 0) {
      throw new BadRequestError('CATEGORY_ID_INVALID');
    }
  }

  const idsOf = (value: unknown, code: string): number[] | undefined => {
    if (!Array.isArray(value) || !value.length) return undefined;

    const nums = value.map((x) => toNumberSafe(x));
    if (nums.some((n) => n == null || !Number.isInteger(n) || n <= 0)) {
      throw new BadRequestError(code);
    }
    return Array.from(new Set(nums as number[]));
  };
  const productIdsRaw = idsOf(scopeObj ? scopeObj.productIds : undefined, 'PRODUCT_IDS_INVALID');
  const variantIdsRaw = idsOf(scopeObj ? scopeObj.variantIds : undefined, 'VARIANT_IDS_INVALID');

  const minPriceVal = scopeObj ? scopeObj.minPrice : undefined;
  const maxPriceVal = scopeObj ? scopeObj.maxPrice : undefined;

  const minPriceRaw = minPriceVal != null ? toNumberSafe(minPriceVal) : undefined;
  if (minPriceVal != null && (minPriceRaw == null || minPriceRaw < 0)) {
    throw new BadRequestError('MIN_PRICE_INVALID');
  }

  const maxPriceRaw = maxPriceVal != null ? toNumberSafe(maxPriceVal) : undefined;
  if (maxPriceVal != null && (maxPriceRaw == null || maxPriceRaw < 0)) {
    throw new BadRequestError('MAX_PRICE_INVALID');
  }

  if (minPriceRaw != null && maxPriceRaw != null && minPriceRaw > maxPriceRaw) {
    throw new BadRequestError('PRICE_RANGE_INVALID');
  }

  const characteristics = parseCharacteristicFilter(scopeObj ? scopeObj.f : undefined);

  const inStockVal = scopeObj ? scopeObj.inStock : undefined;
  const inStockRaw = typeof inStockVal === 'boolean' ? inStockVal : undefined;

  // deleted variants (the ones of a deleted product too) stay untouched unless the request asks for them
  const deletedRaw = typeof scopeObj?.deleted === 'boolean' ? scopeObj.deleted : false;

  // build prisma where once, outside tx
  const and: Prisma.ProductVariantWhereInput[] = [];

  if (categoryIdRaw != null) and.push({ product: { categoryId: categoryIdRaw } });
  if (productIdsRaw?.length) and.push({ productId: { in: productIdsRaw } });
  if (variantIdsRaw?.length) and.push({ id: { in: variantIdsRaw } });

  // the usual price of the variant, not the sale price
  if (minPriceRaw != null || maxPriceRaw != null) {
    and.push({
      price: {
        ...(minPriceRaw != null ? { gte: new Prisma.Decimal(minPriceRaw) } : {}),
        ...(maxPriceRaw != null ? { lte: new Prisma.Decimal(maxPriceRaw) } : {}),
      },
    });
  }

  // in stock is counted in free units on the rows (the stock less the reserve and the units over):
  // a filter of prisma has no word for it

  if (deletedRaw === true) and.push({ deletedAt: { not: null } });
  else if (deletedRaw === false) and.push({ deletedAt: null });

  const where: Prisma.ProductVariantWhereInput = and.length ? { AND: and } : {};

  return {
    mode: modeRaw,
    value: valueRaw,
    where,
    characteristics,
    ...(inStockRaw !== undefined ? { inStock: inStockRaw } : {}),
    dryRun,
    ...(reason ? { reason } : {}),
    // the same word on the sales for every product, the schema lets through keep or remove
    ...(args.sale === 'keep' || args.sale === 'remove' ? { sale: args.sale } : {}),
  };
}
