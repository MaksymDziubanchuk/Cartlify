import { Prisma } from '@prisma/client';

import { BadRequestError } from '@utils/errors.js';

// The tax group of a product and the countries that class it in another group (docs/taxes.md): a
// form gives the id as text and the classes as json, a json body gives them as they are. The
// database checks the classes again (db/05, products_tax_exceptions_check)

const GROUP_ID = /^[1-9][0-9]{0,8}$/;
const COUNTRY = /^[A-Z]{2}$/;

export type TaxExceptions = Record<string, number | null>;

// the group of a product as sent: none sent, null (an empty text of a form too) for the main
// rate, or the id of a group
export function normalizeTaxGroupId(input: unknown): number | null | undefined {
  if (input === undefined) return undefined;
  if (input === null || input === '') return null;
  const text = typeof input === 'number' ? String(input) : input;
  if (typeof text !== 'string' || !GROUP_ID.test(text.trim())) {
    throw new BadRequestError('PRODUCT_TAX_GROUP_INVALID');
  }
  return Number(text.trim());
}

// the classes of a product as sent: none sent, or the whole object (an empty text of a form is
// none); a country two capital letters, a group its id or null for the main rate
export function normalizeTaxExceptions(input: unknown): TaxExceptions | undefined {
  if (input === undefined) return undefined;
  if (input === null || input === '') return {};

  let value: unknown = input;
  if (typeof input === 'string') {
    try {
      value = JSON.parse(input);
    } catch {
      throw new BadRequestError('PRODUCT_TAX_EXCEPTIONS_INVALID');
    }
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestError('PRODUCT_TAX_EXCEPTIONS_INVALID');
  }

  const out: TaxExceptions = {};
  for (const [country, group] of Object.entries(value as Record<string, unknown>)) {
    if (!COUNTRY.test(country)) throw new BadRequestError('PRODUCT_TAX_EXCEPTIONS_INVALID');
    if (group !== null && (typeof group !== 'number' || !GROUP_ID.test(String(group)))) {
      throw new BadRequestError('PRODUCT_TAX_EXCEPTIONS_INVALID');
    }
    out[country] = group as number | null;
  }
  return out;
}

// the groups a change names are there (TAX_GROUP_NOT_FOUND names the missing ones)
export async function assertTaxGroupsExist(
  db: Prisma.TransactionClient,
  groupId: number | null | undefined,
  exceptions: TaxExceptions | undefined,
): Promise<void> {
  const ids = [
    ...new Set([
      ...(groupId ? [groupId] : []),
      ...Object.values(exceptions ?? {}).filter((id): id is number => id !== null),
    ]),
  ];
  if (!ids.length) return;

  const found = await db.taxGroup.findMany({ where: { id: { in: ids } }, select: { id: true } });
  const known = new Set(found.map((row) => row.id));
  const missing = ids.filter((id) => !known.has(id));
  if (missing.length) throw new BadRequestError('TAX_GROUP_NOT_FOUND', { groupIds: missing });
}

// the same classes, whatever the order of the countries
export const sameExceptions = (a: unknown, b: unknown): boolean => {
  const sorted = (v: unknown) =>
    JSON.stringify(
      Object.entries((v ?? {}) as TaxExceptions).sort(([x], [y]) => x.localeCompare(y)),
    );
  return sorted(a) === sorted(b);
};
