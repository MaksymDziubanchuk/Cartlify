import { BadRequestError } from '@utils/errors.js';
import { toNumberSafe, toStringSafe } from '@helpers/safeNormalizer.js';

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
