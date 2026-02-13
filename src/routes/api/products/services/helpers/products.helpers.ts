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
