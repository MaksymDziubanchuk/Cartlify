import { Prisma } from '@prisma/client';

import { prisma } from '@db/client.js';
import { setActorContext } from '@db/dbContext.service.js';
import { InternalError, NotFoundError, isAppError } from '@utils/errors.js';

import { categoryBranchSql, visibleSql } from './helpers/getAllProducts.helper.js';

import type {
  CatalogFilterDto,
  CatalogFiltersDto,
  CatalogFiltersResponseDto,
} from 'types/dto/products.dto.js';

// what the variants a buyer sees in a category have of each characteristic that can be filtered
type ValueRow = {
  attributeId: number;
  optionIds: number[] | null;
  minNumber: Prisma.Decimal | null;
  maxNumber: Prisma.Decimal | null;
  numbers: number;
  hasYes: boolean | null;
  hasNo: boolean | null;
};

const numberOf = (value: Prisma.Decimal) => Number(new Prisma.Decimal(value).toString());

// The panel of the filter of a category: the characteristics its variants are told apart by. A
// characteristic is in it when it is in the filters (`inFilters`), is no text, and has at least two
// DIFFERENT values among the variants a buyer sees (alive, with a picture, of a product that is
// not deleted) in the category and everything below it, or in the category alone with branch
// false. A variant without a value is no value. Nothing is stored: the figures are read for the
// request, in two queries (the values of all the characteristics, then their names and places),
// so a cache for a few minutes would go here if the panel gets slow
export async function findCatalogFilters(
  dto: CatalogFiltersDto,
): Promise<CatalogFiltersResponseDto> {
  try {
    return await prisma.$transaction(async (tx) => {
      await setActorContext(tx, { actorId: dto.actorId, role: dto.actorRole });

      const category = await tx.category.findUnique({
        where: { id: dto.categoryId },
        select: { id: true },
      });
      if (!category) throw new NotFoundError('CATEGORY_NOT_FOUND');

      const inCategory = dto.branch
        ? Prisma.sql`p."categoryId" IN (${categoryBranchSql([dto.categoryId])})`
        : Prisma.sql`p."categoryId" = ${dto.categoryId}`;

      // the values the variants have, each different value once (a hash aggregate, not a sort of
      // every value row), then what each characteristic has of them
      const rows = await tx.$queryRaw<ValueRow[]>(Prisma.sql`
        WITH vals AS (
          SELECT vav."attributeId" AS "attributeId",
                 vav."optionId" AS "optionId",
                 vav."numberValue" AS "numberValue",
                 vav."boolValue" AS "boolValue"
          FROM "products" p
          JOIN "product_variants" v ON v."productId" = p."id"
          JOIN "variant_attribute_values" vav ON vav."variantId" = v."id"
          JOIN "attributes" a ON a."id" = vav."attributeId" AND a."inFilters" AND a."type" <> 'text'
          WHERE p."deletedAt" IS NULL
            AND ${inCategory}
            AND ${visibleSql('v')}
          GROUP BY vav."attributeId", vav."optionId", vav."numberValue", vav."boolValue"
        )
        SELECT "attributeId",
               array_agg("optionId") FILTER (WHERE "optionId" IS NOT NULL) AS "optionIds",
               min("numberValue") AS "minNumber",
               max("numberValue") AS "maxNumber",
               count("numberValue")::int AS numbers,
               bool_or("boolValue") AS "hasYes",
               bool_or(NOT "boolValue") AS "hasNo"
        FROM vals
        GROUP BY "attributeId"
      `);
      if (!rows.length) return { items: [] };

      const byAttribute = new Map(rows.map((row) => [row.attributeId, row]));
      const optionIds = [...new Set(rows.flatMap((row) => row.optionIds ?? []))];

      const attributes = await tx.attribute.findMany({
        where: { id: { in: [...byAttribute.keys()] } },
        select: {
          id: true,
          name: true,
          unit: true,
          type: true,
          position: true,
          group: { select: { id: true, name: true, position: true } },
          options: {
            where: { id: { in: optionIds } },
            select: { id: true, name: true, colorCode: true, position: true },
            orderBy: [{ position: 'asc' }, { id: 'asc' }],
          },
        },
      });

      // the order of the card: the groups by their place, in a group the characteristics by theirs
      attributes.sort(
        (a, b) => a.group.position - b.group.position || a.position - b.position || a.id - b.id,
      );

      const items: CatalogFilterDto[] = [];
      for (const attribute of attributes) {
        const found = byAttribute.get(attribute.id)!;
        const base = {
          id: attribute.id,
          name: attribute.name,
          unit: attribute.unit,
          group: { id: attribute.group.id, name: attribute.group.name },
        };

        if (attribute.type === 'option' || attribute.type === 'options') {
          // the values of the category: the ones of the characteristic that its variants have
          const own = new Set(found.optionIds ?? []);
          const values = attribute.options.filter((option) => own.has(option.id));
          if (values.length >= 2) items.push({ ...base, type: attribute.type, values });
        } else if (attribute.type === 'number') {
          if (found.numbers >= 2 && found.minNumber && found.maxNumber) {
            items.push({
              ...base,
              type: 'number',
              min: numberOf(found.minNumber),
              max: numberOf(found.maxNumber),
            });
          }
        } else if (attribute.type === 'boolean') {
          if (found.hasYes && found.hasNo) {
            items.push({ ...base, type: 'boolean', values: ['yes', 'no'] });
          }
        }
      }

      return { items };
    });
  } catch (err) {
    if (isAppError(err)) throw err;

    throw new InternalError({ reason: 'CATALOG_FILTERS_UNEXPECTED' }, err);
  }
}
