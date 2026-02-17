import { BadRequestError } from '@utils/errors.js';
import { toNumberSafe, toStringSafe } from '@helpers/safeNormalizer.js';
import { assertAdminActor } from '@helpers/roleGuard.js';

import type { Role } from 'types/user.js';
import type { UserId } from 'types/ids.js';

export function slugifyLoose(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

export function normalizeFindCategoryByIdInput(dto: { categoryId: unknown }) {
  // normalize and validate category id
  const categoryId = toNumberSafe(dto.categoryId);
  if (categoryId == null || !Number.isInteger(categoryId) || categoryId <= 0) {
    throw new BadRequestError('CATEGORY_ID_INVALID');
  }

  return { categoryId };
}

export function normalizeCreateCategoryInput(args: {
  name: unknown;
  slug: unknown;
  description?: unknown;
  parentId?: unknown;
}) {
  // normalize required name
  const nameRaw = toStringSafe(args.name);
  const nameNorm = typeof nameRaw === 'string' ? nameRaw.trim() : '';
  if (!nameNorm.length) throw new BadRequestError('CATEGORY_NAME_INVALID');

  // normalize optional slug
  const slugRaw = toStringSafe(args.slug);
  const slugTrim = typeof slugRaw === 'string' ? slugRaw.trim() : '';
  if (!slugTrim.length) throw new BadRequestError('CATEGORY_SLUG_INVALID');

  const slugNorm = slugifyLoose(slugTrim);
  if (!slugNorm.length) throw new BadRequestError('CATEGORY_SLUG_INVALID');

  // normalize optional description
  const descriptionRaw = args.description != null ? toStringSafe(args.description) : undefined;
  const descriptionTrim = typeof descriptionRaw === 'string' ? descriptionRaw.trim() : '';
  const descriptionNorm = descriptionTrim.length ? descriptionTrim : null;

  // normalize optional parent id
  const parentIdRaw = args.parentId != null ? toNumberSafe(args.parentId) : undefined;
  if (args.parentId != null) {
    if (parentIdRaw == null || !Number.isInteger(parentIdRaw) || parentIdRaw <= 0) {
      throw new BadRequestError('CATEGORY_PARENT_ID_INVALID');
    }
  }

  return {
    nameNorm,
    slugNorm,
    descriptionNorm,
    parentIdNorm: parentIdRaw ?? null,
  };
}

export function normalizeUpdateCategoryInput(args: {
  name?: unknown;
  slug?: unknown;
  description?: unknown;
  parentId?: unknown;
}) {
  // normalize optional scalars
  const nameRaw = args.name !== undefined ? toStringSafe(args.name) : undefined;
  const slugRaw = args.slug !== undefined ? toStringSafe(args.slug) : undefined;

  const descriptionRaw =
    args.description === null
      ? null
      : args.description !== undefined
        ? toStringSafe(args.description)
        : undefined;

  const nameNorm = typeof nameRaw === 'string' ? nameRaw.trim() : undefined;

  const slugTrim = typeof slugRaw === 'string' ? slugRaw.trim() : undefined;
  const slugNorm = slugTrim !== undefined ? slugifyLoose(slugTrim) : undefined;

  const descriptionTrim = typeof descriptionRaw === 'string' ? descriptionRaw.trim() : undefined;
  const descriptionNorm =
    descriptionRaw === null
      ? null
      : descriptionTrim !== undefined
        ? descriptionTrim || null
        : undefined;

  // normalize optional parent id with explicit clear
  const parentIdNorm =
    args.parentId === null
      ? null
      : args.parentId !== undefined
        ? toNumberSafe(args.parentId)
        : undefined;

  // validate optional name
  if (args.name !== undefined && (!nameNorm || !nameNorm.length)) {
    throw new BadRequestError('CATEGORY_NAME_INVALID');
  }

  // validate optional slug
  if (args.slug !== undefined) {
    if (!slugTrim || !slugTrim.length) throw new BadRequestError('CATEGORY_SLUG_INVALID');
    if (!slugNorm || !slugNorm.length) throw new BadRequestError('CATEGORY_SLUG_INVALID');
  }

  // validate optional parent id
  if (args.parentId !== undefined && args.parentId !== null) {
    if (parentIdNorm == null || !Number.isInteger(parentIdNorm) || parentIdNorm <= 0) {
      throw new BadRequestError('CATEGORY_PARENT_ID_INVALID');
    }
  }

  return {
    nameNorm,
    slugNorm,
    descriptionNorm,
    parentIdNorm,
  };
}

export function normalizeDeleteCategoryInput(args: {
  categoryId: unknown;
  actorId: unknown;
  actorRole: Role;
}) {
  // validate actor context for admin-only action
  assertAdminActor(args.actorId, args.actorRole);

  // normalize and validate category id
  const categoryId = toNumberSafe(args.categoryId);
  if (categoryId == null || !Number.isInteger(categoryId) || categoryId <= 0) {
    throw new BadRequestError('CATEGORY_ID_INVALID');
  }

  return {
    categoryId,
    actorId: args.actorId as UserId,
    actorRole: args.actorRole as Role,
  };
}
