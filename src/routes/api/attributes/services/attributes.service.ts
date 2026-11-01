import { Prisma } from '@prisma/client';

import { prisma } from '@db/client.js';
import type { AuditChange } from '@db/adminAudit.helper.js';
import {
  ATTRIBUTE_TYPES,
  CHOICE_ATTRIBUTE_TYPES,
  checkAttributeSettings,
  checkOrderIds,
  normalizeDirectoryName,
  normalizeUnit,
  type AttributeType,
} from '@helpers/attributeFields.js';
import { likePattern } from '@helpers/likePattern.js';
import { decimalToNumber } from '@helpers/safeNormalizer.js';
import { BadRequestError, ConflictError, NotFoundError } from '@utils/errors.js';

import {
  NAMED_MAX,
  attributeSelect,
  inAdminTx,
  isForeignKeyViolation,
  isUniqueViolationOn,
  lockRow,
  logDirectory,
  mapAttributeRow,
  mapOptionRow,
  optionSelect,
  type Tx,
} from './helpers/directory.helper.js';
import { characteristicUsage } from './helpers/valueUsage.helper.js';

import type {
  AttributeActorDto,
  AttributeDetailDto,
  AttributeDto,
  AttributesListQueryDto,
  AttributesListResponseDto,
} from 'types/dto/attributes.dto.js';
import type { MessageResponseDto } from 'types/common.js';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const FIELDS = [
  'name',
  'type',
  'unit',
  'groupId',
  'isMain',
  'inFilters',
  'decimals',
  'minValue',
  'maxValue',
] as const;

// the characteristic that holds a name already (letter case ignored), another than skipId
async function attributeNamed(name: string, skipId?: number): Promise<number | null> {
  const rows = await prisma.$queryRaw<{ id: number }[]>(Prisma.sql`
    SELECT id FROM cartlify.attributes
    WHERE lower(name) = lower(${name})
      ${skipId === undefined ? Prisma.empty : Prisma.sql`AND id <> ${skipId}`}
    LIMIT 1
  `);

  return rows[0]?.id ?? null;
}

const nameTaken = (name: string | undefined, skipId?: number) => async (err: unknown) => {
  if (name === undefined || !isUniqueViolationOn(err, 'attributes_name_uidx')) return null;

  const attributeId = await attributeNamed(name, skipId);
  return attributeId === null ? null : new ConflictError('ATTRIBUTE_NAME_TAKEN', { attributeId });
};

// the group must be there, and stays so until the end of the transaction
const assertGroupExists = async (tx: Tx, groupId: number) => {
  if (!(await lockRow(tx, 'attribute_groups', groupId, 'SHARE'))) {
    throw new NotFoundError('ATTRIBUTE_GROUP_NOT_FOUND');
  }
};

const endOfGroup = async (tx: Tx, groupId: number) => {
  const last = await tx.attribute.findFirst({
    where: { groupId },
    orderBy: { position: 'desc' },
    select: { position: true },
  });

  return (last?.position ?? 0) + 1;
};

const typeOf = (input: unknown): AttributeType => {
  if (typeof input !== 'string' || !(ATTRIBUTE_TYPES as readonly string[]).includes(input)) {
    throw new BadRequestError('ATTRIBUTE_FIELDS_INVALID', { fields: ['type'] });
  }
  return input as AttributeType;
};

// a new characteristic goes to the end of its group
export async function createAttribute(
  actor: AttributeActorDto & { body: unknown },
): Promise<AttributeDto> {
  const b = isRecord(actor.body) ? actor.body : {};
  const name = normalizeDirectoryName(b.name, 'ATTRIBUTE');
  const type = typeOf(b.type);
  const unit = b.unit === undefined ? null : normalizeUnit(b.unit);
  const isMain = b.isMain === true;
  const inFilters = b.inFilters === undefined ? true : b.inFilters === true;
  const settings = checkAttributeSettings({
    type,
    isMain,
    decimals: b.decimals,
    minValue: b.minValue,
    maxValue: b.maxValue,
  });
  const groupId = b.groupId as number;

  return inAdminTx(
    actor,
    'ATTRIBUTES_CREATE_UNEXPECTED',
    async (tx) => {
      await assertGroupExists(tx, groupId);

      const created = await tx.attribute.create({
        data: {
          name,
          type,
          unit,
          groupId,
          position: await endOfGroup(tx, groupId),
          isMain,
          inFilters,
          ...settings,
        },
        select: attributeSelect,
      });

      const changes: AuditChange[] = [
        { field: 'name', old: null, new: name },
        { field: 'type', old: null, new: type },
        { field: 'unit', old: null, new: unit },
        { field: 'groupId', old: null, new: groupId },
        { field: 'isMain', old: null, new: isMain },
        { field: 'inFilters', old: null, new: inFilters },
        ...(type === 'number'
          ? [
              { field: 'decimals', old: null, new: settings.decimals },
              { field: 'minValue', old: null, new: settings.minValue },
              { field: 'maxValue', old: null, new: settings.maxValue },
            ]
          : []),
      ];
      await logDirectory(tx, actor, { event: 'attribute.create', entityId: created.id, changes });

      return mapAttributeRow(created);
    },
    nameTaken(name),
  );
}

// the characteristics in the order of the card (group, then place), with how many values each has
export async function listAttributes(
  actor: AttributeActorDto & AttributesListQueryDto,
): Promise<AttributesListResponseDto> {
  const filters: Prisma.Sql[] = [Prisma.sql`TRUE`];
  if (actor.q) filters.push(Prisma.sql`a.name ILIKE ${likePattern(actor.q)}`);
  if (actor.groupId !== undefined) filters.push(Prisma.sql`a."groupId" = ${actor.groupId}`);
  if (actor.type) filters.push(Prisma.sql`a.type = ${actor.type}::cartlify."AttributeType"`);

  return inAdminTx(actor, 'ATTRIBUTES_LIST_UNEXPECTED', async (tx) => {
    const found = await tx.$queryRaw<{ id: number }[]>(Prisma.sql`
      SELECT a.id
      FROM cartlify.attributes a
      JOIN cartlify.attribute_groups g ON g.id = a."groupId"
      WHERE ${Prisma.join(filters, ' AND ')}
      ORDER BY g.position, a.position, a.id
    `);

    const rows = await tx.attribute.findMany({
      where: { id: { in: found.map((row) => row.id) } },
      select: { ...attributeSelect, _count: { select: { options: true } } },
    });
    const byId = new Map(rows.map((row) => [row.id, row]));

    // one deleted between the two reads is left out
    const items = found.flatMap(({ id }) => {
      const row = byId.get(id);
      return row ? [{ ...mapAttributeRow(row), optionsCount: row._count.options }] : [];
    });

    return { items, total: items.length };
  });
}

// a characteristic with its values in their order and the number of categories that ask for it
export async function getAttribute(
  actor: AttributeActorDto & { attributeId: number },
): Promise<AttributeDetailDto> {
  return inAdminTx(actor, 'ATTRIBUTES_GET_UNEXPECTED', async (tx) => {
    const row = await tx.attribute.findUnique({
      where: { id: actor.attributeId },
      select: {
        ...attributeSelect,
        options: { orderBy: { position: 'asc' }, select: optionSelect },
      },
    });
    if (!row) throw new NotFoundError('ATTRIBUTE_NOT_FOUND');

    const categories = await tx.categoryAttribute.count({ where: { attributeId: row.id } });
    return {
      ...mapAttributeRow(row),
      options: row.options.map(mapOptionRow),
      usage: { categories },
    };
  });
}

// changes what was named. A new group puts the characteristic at its end. The type changes unless
// values of a choice would be left without a choice; the settings of a number go with the type. A
// request that changes nothing is 200 with nothing written
export async function updateAttribute(
  actor: AttributeActorDto & { attributeId: number; body: unknown },
): Promise<AttributeDto> {
  const b = isRecord(actor.body) ? actor.body : {};
  if (!FIELDS.some((key) => b[key] !== undefined)) throw new BadRequestError('NO_FIELDS_TO_UPDATE');

  const name = b.name !== undefined ? normalizeDirectoryName(b.name, 'ATTRIBUTE') : undefined;
  const unit = b.unit !== undefined ? normalizeUnit(b.unit) : undefined;
  const newType = b.type !== undefined ? typeOf(b.type) : undefined;

  return inAdminTx(
    actor,
    'ATTRIBUTES_UPDATE_UNEXPECTED',
    async (tx) => {
      // a type counts the values: a value being made for the characteristic is waited for
      if (newType !== undefined) await lockRow(tx, 'attributes', actor.attributeId, 'UPDATE');

      const before = await tx.attribute.findUnique({
        where: { id: actor.attributeId },
        select: attributeSelect,
      });
      if (!before) throw new NotFoundError('ATTRIBUTE_NOT_FOUND');

      const type = newType ?? before.type;
      if (type !== before.type) {
        // the values of the variants are of the old type: the type stays while a variant has one
        // (the characteristic is locked, so a value being written is waited for)
        const used = await characteristicUsage(tx, before.id);
        if (used.variantsCount > 0) {
          throw new ConflictError('ATTRIBUTE_TYPE_LOCKED', {
            reason: 'variants',
            variantsCount: used.variantsCount,
            productsTotal: used.productsTotal,
            productIds: used.productIds,
          });
        }
      }
      if (type !== before.type && !CHOICE_ATTRIBUTE_TYPES.includes(type)) {
        const optionsCount = await tx.attributeOption.count({ where: { attributeId: before.id } });
        if (optionsCount > 0) {
          throw new ConflictError('ATTRIBUTE_TYPE_LOCKED', { reason: 'options', optionsCount });
        }
      }

      const isMain = (b.isMain as boolean | undefined) ?? before.isMain;
      const inFilters = (b.inFilters as boolean | undefined) ?? before.inFilters;

      // the settings of a number are the ones sent, else the ones it has as a number, else none
      const wasNumber = before.type === 'number';
      const kept = <T>(sent: unknown, had: T) =>
        sent !== undefined ? sent : wasNumber ? had : undefined;
      const settings = checkAttributeSettings({
        type,
        isMain,
        decimals: type === 'number' ? kept(b.decimals, before.decimals) : b.decimals,
        minValue:
          type === 'number'
            ? kept(b.minValue, before.minValue === null ? null : decimalToNumber(before.minValue))
            : b.minValue,
        maxValue:
          type === 'number'
            ? kept(b.maxValue, before.maxValue === null ? null : decimalToNumber(before.maxValue))
            : b.maxValue,
      });

      const groupId = (b.groupId as number | undefined) ?? before.groupId;
      if (groupId !== before.groupId) await assertGroupExists(tx, groupId);

      const next = {
        name: name ?? before.name,
        type,
        unit: unit === undefined ? before.unit : unit,
        groupId,
        isMain,
        inFilters,
        decimals: settings.decimals,
        minValue: settings.minValue,
        maxValue: settings.maxValue,
      };
      const was = {
        name: before.name,
        type: before.type,
        unit: before.unit,
        groupId: before.groupId,
        isMain: before.isMain,
        inFilters: before.inFilters,
        decimals: before.decimals,
        minValue: before.minValue === null ? null : decimalToNumber(before.minValue),
        maxValue: before.maxValue === null ? null : decimalToNumber(before.maxValue),
      };
      const changed = FIELDS.filter((key) => next[key] !== was[key]);
      if (!changed.length) return mapAttributeRow(before);

      const updated = await tx.attribute.update({
        where: { id: before.id },
        data: {
          ...Object.fromEntries(changed.map((key) => [key, next[key]])),
          ...(groupId !== before.groupId ? { position: await endOfGroup(tx, groupId) } : {}),
        },
        select: attributeSelect,
      });

      await logDirectory(tx, actor, {
        event: 'attribute.update',
        entityId: before.id,
        changes: changed.map((key) => ({ field: key, old: was[key], new: next[key] })),
      });

      return mapAttributeRow(updated);
    },
    nameTaken(name, actor.attributeId),
  );
}

// a new order of all the characteristics of a group; a line of the log for each that moved
export async function reorderGroupAttributes(
  actor: AttributeActorDto & { groupId: number; body: unknown },
): Promise<AttributesListResponseDto> {
  const ids = (isRecord(actor.body) ? actor.body.ids : undefined) as number[];

  await inAdminTx(actor, 'ATTRIBUTES_ORDER_UNEXPECTED', async (tx) => {
    await assertGroupExists(tx, actor.groupId);

    const rows = await tx.attribute.findMany({
      where: { groupId: actor.groupId },
      select: { id: true, position: true },
    });
    checkOrderIds(
      rows.map((row) => row.id),
      ids,
    );

    const before = new Map(rows.map((row) => [row.id, row.position]));
    for (const [at, id] of ids.entries()) {
      const position = at + 1;
      if (before.get(id) === position) continue;

      await tx.attribute.update({ where: { id }, data: { position } });
      await logDirectory(tx, actor, {
        event: 'attribute.reorder',
        entityId: id,
        changes: [{ field: 'position', old: before.get(id), new: position }],
      });
    }
  });

  return listAttributes({ ...actor, groupId: actor.groupId });
}

// deletes a characteristic with its values; one that a category asks for, or that a variant has a
// value of, stays: 409 names some of the categories and of the products
export async function deleteAttribute(
  actor: AttributeActorDto & { attributeId: number },
): Promise<MessageResponseDto> {
  return inAdminTx(
    actor,
    'ATTRIBUTES_DELETE_UNEXPECTED',
    async (tx) => {
      // a value being written holds the characteristic: the delete waits for it and counts after
      if (!(await lockRow(tx, 'attributes', actor.attributeId, 'UPDATE'))) {
        throw new NotFoundError('ATTRIBUTE_NOT_FOUND');
      }
      const attribute = await tx.attribute.findUnique({
        where: { id: actor.attributeId },
        select: { id: true, name: true, type: true },
      });
      if (!attribute) throw new NotFoundError('ATTRIBUTE_NOT_FOUND');

      const asked = await tx.categoryAttribute.findMany({
        where: { attributeId: attribute.id },
        select: { categoryId: true },
        orderBy: { categoryId: 'asc' },
        take: NAMED_MAX,
      });
      const used = await characteristicUsage(tx, attribute.id);
      if (asked.length || used.variantsCount > 0) {
        const total = asked.length
          ? await tx.categoryAttribute.count({ where: { attributeId: attribute.id } })
          : 0;

        throw new ConflictError('ATTRIBUTE_IN_USE', {
          ...(asked.length ? { categoryIds: asked.map((row) => row.categoryId), total } : {}),
          ...(used.variantsCount > 0
            ? {
                productIds: used.productIds,
                productsTotal: used.productsTotal,
                variantsCount: used.variantsCount,
              }
            : {}),
        });
      }

      await tx.attribute.delete({ where: { id: attribute.id } });
      await logDirectory(tx, actor, {
        event: 'attribute.delete',
        entityId: attribute.id,
        changes: [
          { field: 'name', old: attribute.name, new: null },
          { field: 'type', old: attribute.type, new: null },
        ],
      });

      return { message: 'Characteristic deleted successfully.' };
    },
    // a category that asked for it, or a variant that took a value of it, between the check and the delete
    async (err) => (isForeignKeyViolation(err) ? new ConflictError('ATTRIBUTE_IN_USE') : null),
  );
}
