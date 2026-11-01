import { Prisma, type PrismaClient } from '@prisma/client';

import type { VariantAttributeGroupDto, VariantAttributeItemDto } from 'types/dto/variants.dto.js';

type Db = Prisma.TransactionClient | PrismaClient;

// one value row of a variant with the characteristic, its group and the value of the list it holds
type CardRow = {
  variantId: number;
  attributeId: number;
  name: string;
  unit: string | null;
  type: VariantAttributeItemDto['attribute']['type'];
  isMain: boolean;
  groupId: number;
  groupName: string;
  groupPosition: number;
  textValue: string | null;
  numberValue: Prisma.Decimal | string | number | null;
  boolValue: boolean | null;
  optionId: number | null;
  optionName: string | null;
  colorCode: string | null;
};

// a number as the card writes it: without trailing zeros, with its unit ("256 GB")
export function numberLabel(value: Prisma.Decimal | string | number, unit: string | null): string {
  const text = new Prisma.Decimal(value).toFixed();
  return unit ? `${text} ${unit}` : text;
}

// The characteristics each variant has, for the card: groups by their place, in a group the
// characteristics by theirs (the order of the directory, the same for all products), the values of
// a set in the order of the list. A variant that has no value is not in the map
export async function readCardAttributes(
  db: Db,
  variantIds: readonly number[],
): Promise<Map<number, VariantAttributeGroupDto[]>> {
  const ids = [...new Set(variantIds)];
  if (!ids.length) return new Map();

  const rows = await db.$queryRaw<CardRow[]>`
    select x."variantId", a.id as "attributeId", a.name, a.unit, a.type::text as type, a."isMain",
           g.id as "groupId", g.name as "groupName", g.position as "groupPosition",
           x."textValue", x."numberValue", x."boolValue",
           o.id as "optionId", o.name as "optionName", o."colorCode"
    from cartlify.variant_attribute_values as x
    join cartlify.attributes as a on a.id = x."attributeId"
    join cartlify.attribute_groups as g on g.id = a."groupId"
    left join cartlify.attribute_options as o on o.id = x."optionId"
    where x."variantId" = any(${ids}::int[])
    order by x."variantId", g.position, a.position, a.id, o.position, o.id
  `;

  return cardAttributesOf(rows);
}

// the rows in the order readCardAttributes reads them, folded into the groups of each variant
export function cardAttributesOf(
  rows: readonly CardRow[],
): Map<number, VariantAttributeGroupDto[]> {
  const byVariant = new Map<number, VariantAttributeGroupDto[]>();
  let item: VariantAttributeItemDto | undefined;
  let optionIds: number[] = [];
  let names: string[] = [];
  let last: { variantId: number; attributeId: number } | undefined;

  for (const row of rows) {
    const groups = byVariant.get(row.variantId) ?? [];
    byVariant.set(row.variantId, groups);

    // the next row of a set belongs to the item already made
    if (item && last && last.variantId === row.variantId && last.attributeId === row.attributeId) {
      optionIds.push(row.optionId!);
      names.push(row.optionName!);
      item.value = names.join(', ');
      item.raw = [...optionIds];
      continue;
    }

    let group = groups[groups.length - 1];
    if (!group || group.group.id !== row.groupId) {
      group = {
        group: { id: row.groupId, name: row.groupName, position: row.groupPosition },
        items: [],
      };
      groups.push(group);
    }

    item = itemOf(row);
    optionIds = row.optionId === null ? [] : [row.optionId];
    names = row.optionName === null ? [] : [row.optionName];
    last = { variantId: row.variantId, attributeId: row.attributeId };
    group.items.push(item);
  }

  return byVariant;
}

function itemOf(row: CardRow): VariantAttributeItemDto {
  const attribute = {
    id: row.attributeId,
    name: row.name,
    unit: row.unit,
    type: row.type,
    isMain: row.isMain,
  };

  switch (row.type) {
    case 'text':
      return { attribute, value: row.textValue!, raw: row.textValue! };
    case 'number':
      return {
        attribute,
        value: numberLabel(row.numberValue!, row.unit),
        raw: Number(new Prisma.Decimal(row.numberValue!).toString()),
      };
    case 'boolean':
      return { attribute, value: row.boolValue ? 'yes' : 'no', raw: row.boolValue === true };
    case 'option':
      return {
        attribute,
        value: row.optionName!,
        raw: row.optionId!,
        ...(row.colorCode ? { colorCode: row.colorCode } : {}),
      };
    default:
      // a set: the first value, the next rows of it are added by the caller
      return { attribute, value: row.optionName!, raw: [row.optionId!] };
  }
}
