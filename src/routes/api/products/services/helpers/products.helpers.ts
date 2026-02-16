import { Prisma } from '@prisma/client';
import { toNumberSafe, toStringSafe } from '@helpers/safeNormalizer.js';
import { BadRequestError, ForbiddenError } from '@utils/errors.js';

import type { Role } from 'types/user.js';
import type { UserId } from 'types/ids.js';

export function normalizeFindProductByIdInput(dto: { productId: unknown }) {
  // normalize and validate product id
  const productId = toNumberSafe(dto.productId);
  if (productId == null || !Number.isInteger(productId) || productId <= 0) {
    throw new BadRequestError('PRODUCT_ID_INVALID');
  }

  return { productId };
}

export function assertAdminActor(actorId: unknown, actorRole: Role) {
  // validate actor context for rls and admin-only actions
  if (!Number.isInteger(actorId)) throw new ForbiddenError('ACTOR_ID_INVALID');
  if (actorRole !== 'ADMIN' && actorRole !== 'ROOT') throw new ForbiddenError('FORBIDDEN');
}

export function normalizeCreateProductInput(args: {
  name: unknown;
  description?: unknown;
  price: unknown;
  stock: unknown;
  categoryId: unknown;
}) {
  // normalize required category id
  const categoryIdRaw = toNumberSafe(args.categoryId);
  if (categoryIdRaw == null || !Number.isInteger(categoryIdRaw) || categoryIdRaw <= 0) {
    throw new BadRequestError('CATEGORY_ID_INVALID');
  }

  // normalize required scalars
  const nameRaw = toStringSafe(args.name);
  const priceRaw = toNumberSafe(args.price);
  const stockRaw = toNumberSafe(args.stock);

  // normalize optional description
  const descriptionRaw = args.description != null ? toStringSafe(args.description) : undefined;

  const nameNorm = typeof nameRaw === 'string' ? nameRaw.trim() : '';
  const descriptionNorm =
    typeof descriptionRaw === 'string' ? descriptionRaw.trim() || undefined : undefined;

  // validate required name
  if (!nameNorm.length) {
    throw new BadRequestError('PRODUCT_NAME_INVALID');
  }

  // validate required price
  if (priceRaw == null || !Number.isFinite(priceRaw) || priceRaw < 0) {
    throw new BadRequestError('PRODUCT_PRICE_INVALID');
  }

  // validate required stock
  if (stockRaw == null || !Number.isInteger(stockRaw) || stockRaw < 0) {
    throw new BadRequestError('PRODUCT_STOCK_INVALID');
  }

  return {
    nameNorm,
    descriptionNorm,
    priceRaw,
    stockNorm: stockRaw,
    categoryIdRaw,
  };
}
export function normalizeUpdateProductInput(args: {
  name?: unknown;
  description?: unknown;
  price?: unknown;
  stock?: unknown;
  categoryId?: unknown;
  popularityOverride?: unknown;
  popularityOverrideUntil?: unknown;
}) {
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
  const priceRaw = args.price != null ? toNumberSafe(args.price) : undefined;
  const stockRaw = args.stock != null ? toNumberSafe(args.stock) : undefined;

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

  // validate optional price
  if (args.price != null && (priceRaw == null || !Number.isFinite(priceRaw) || priceRaw < 0)) {
    throw new BadRequestError('PRODUCT_PRICE_INVALID');
  }

  // validate optional stock
  if (args.stock != null) {
    if (stockRaw == null || !Number.isInteger(stockRaw) || stockRaw < 0) {
      throw new BadRequestError('PRODUCT_STOCK_INVALID');
    }
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

  // validate optional popularity override until
  let popularityOverrideUntilDate: Date | null | undefined = undefined;
  if (popularityOverrideUntilRaw !== undefined) {
    if (popularityOverrideUntilRaw === null) {
      popularityOverrideUntilDate = null;
    } else {
      const d = new Date(popularityOverrideUntilRaw);
      if (Number.isNaN(d.getTime())) throw new BadRequestError('POPULARITY_OVERRIDE_UNTIL_INVALID');
      popularityOverrideUntilDate = d;
    }
  }

  return {
    nameNorm,
    descriptionNorm,
    priceRaw,
    stockRaw,
    categoryIdRaw,
    popularityOverrideRaw,
    popularityOverrideUntilDate,
  };
}

export function normalizeBulkUpdateProductsPriceInput(args: {
  mode: unknown;
  value: unknown;

  scope?: unknown;

  dryRun?: unknown;
  reason?: unknown;
}): {
  mode: 'percent' | 'fixed';
  value: number;

  where: Prisma.ProductWhereInput;

  dryRun: boolean;
  reason?: string;
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

  const productIdsVal = scopeObj ? scopeObj.productIds : undefined;
  let productIdsRaw: number[] | undefined = undefined;
  if (Array.isArray(productIdsVal) && productIdsVal.length) {
    const nums = productIdsVal.map((x) => toNumberSafe(x));
    if (nums.some((n) => n == null || !Number.isInteger(n) || n <= 0)) {
      throw new BadRequestError('PRODUCT_IDS_INVALID');
    }
    productIdsRaw = Array.from(new Set(nums as number[]));
  }

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

  const inStockVal = scopeObj ? scopeObj.inStock : undefined;
  const inStockRaw = typeof inStockVal === 'boolean' ? inStockVal : undefined;

  const deletedRaw = typeof scopeObj.deleted === 'boolean' ? scopeObj.deleted : undefined;

  // build prisma where once, outside tx
  const and: Prisma.ProductWhereInput[] = [];

  if (categoryIdRaw != null) and.push({ categoryId: categoryIdRaw });
  if (productIdsRaw?.length) and.push({ id: { in: productIdsRaw } });

  if (minPriceRaw != null || maxPriceRaw != null) {
    and.push({
      price: {
        ...(minPriceRaw != null ? { gte: new Prisma.Decimal(minPriceRaw) } : {}),
        ...(maxPriceRaw != null ? { lte: new Prisma.Decimal(maxPriceRaw) } : {}),
      },
    });
  }

  if (inStockRaw === true) and.push({ stock: { gt: 0 } });
  else if (inStockRaw === false) and.push({ stock: 0 });

  if (deletedRaw === true) and.push({ deletedAt: { not: null } });
  else if (deletedRaw === false) and.push({ deletedAt: null });

  const where: Prisma.ProductWhereInput = and.length ? { AND: and } : {};

  return {
    mode: modeRaw,
    value: valueRaw,
    where,
    dryRun,
    ...(reason ? { reason } : {}),
  };
}

export function normalizeDeleteProductByIdInput(args: {
  productId: unknown;
  actorId: unknown;
  actorRole: Role;
}) {
  // validate actor context for admin-only action
  assertAdminActor(args.actorId, args.actorRole);

  // validate product id
  const productId = toNumberSafe(args.productId);
  if (productId == null || !Number.isInteger(productId) || productId <= 0) {
    throw new BadRequestError('PRODUCT_ID_INVALID');
  }

  return {
    productId,
    actorId: args.actorId as UserId,
    actorRole: args.actorRole as Role,
  };
}
