import { Prisma } from '@prisma/client';

import { prisma } from '@db/client.js';
import { checkOrderIds, normalizeDirectoryName } from '@helpers/attributeFields.js';
import { BadRequestError, ConflictError, NotFoundError } from '@utils/errors.js';

import {
  NAMED_MAX,
  inAdminTx,
  isForeignKeyViolation,
  isUniqueViolationOn,
  logDirectory,
  writeListOrder,
  type Tx,
} from './helpers/directory.helper.js';

import type {
  AttributeActorDto,
  AttributeGroupDto,
  AttributeGroupsListResponseDto,
} from 'types/dto/attributes.dto.js';
import type { MessageResponseDto } from 'types/common.js';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// the group that holds a name already (letter case ignored), another than skipId
async function groupNamed(name: string, skipId?: number): Promise<number | null> {
  const rows = await prisma.$queryRaw<{ id: number }[]>(Prisma.sql`
    SELECT id FROM cartlify.attribute_groups
    WHERE lower(name) = lower(${name})
      ${skipId === undefined ? Prisma.empty : Prisma.sql`AND id <> ${skipId}`}
    LIMIT 1
  `);

  return rows[0]?.id ?? null;
}

const nameTaken = (name: string, skipId?: number) => async (err: unknown) => {
  if (!isUniqueViolationOn(err, 'attribute_groups_name_uidx')) return null;

  const groupId = await groupNamed(name, skipId);
  return groupId === null ? null : new ConflictError('ATTRIBUTE_GROUP_NAME_TAKEN', { groupId });
};

const countsOf = async (tx: Tx, groupIds: number[]) => {
  const counts = new Map<number, number>(groupIds.map((id) => [id, 0]));
  if (!groupIds.length) return counts;

  const rows = await tx.attribute.groupBy({
    by: ['groupId'],
    where: { groupId: { in: groupIds } },
    _count: { _all: true },
  });
  for (const row of rows) counts.set(row.groupId, row._count._all);

  return counts;
};

const toDto = (
  row: { id: number; name: string; position: number },
  attributesCount: number,
): AttributeGroupDto => ({
  id: row.id,
  name: row.name,
  position: row.position,
  attributesCount,
});

const readGroups = async (tx: Tx): Promise<AttributeGroupDto[]> => {
  const rows = await tx.attributeGroup.findMany({
    orderBy: { position: 'asc' },
    select: { id: true, name: true, position: true },
  });
  const counts = await countsOf(
    tx,
    rows.map((row) => row.id),
  );

  return rows.map((row) => toDto(row, counts.get(row.id) ?? 0));
};

// a new group goes to the end of the others
export async function createAttributeGroup(
  actor: AttributeActorDto & { body: unknown },
): Promise<AttributeGroupDto> {
  const name = normalizeDirectoryName(
    isRecord(actor.body) ? actor.body.name : undefined,
    'ATTRIBUTE_GROUP',
  );

  return inAdminTx(
    actor,
    'ATTRIBUTE_GROUPS_CREATE_UNEXPECTED',
    async (tx) => {
      const last = await tx.attributeGroup.findFirst({
        orderBy: { position: 'desc' },
        select: { position: true },
      });
      const created = await tx.attributeGroup.create({
        data: { name, position: (last?.position ?? 0) + 1 },
        select: { id: true, name: true, position: true },
      });

      await logDirectory(tx, actor, {
        event: 'attribute_group.create',
        entityId: created.id,
        changes: [{ field: 'name', old: null, new: created.name }],
      });

      return toDto(created, 0);
    },
    nameTaken(name),
  );
}

// the groups in the order of the card, each with how many characteristics it has
export async function listAttributeGroups(
  actor: AttributeActorDto,
): Promise<AttributeGroupsListResponseDto> {
  return inAdminTx(actor, 'ATTRIBUTE_GROUPS_LIST_UNEXPECTED', async (tx) => ({
    items: await readGroups(tx),
  }));
}

// renames a group; the name it has already is 200 with nothing written
export async function updateAttributeGroup(
  actor: AttributeActorDto & { groupId: number; body: unknown },
): Promise<AttributeGroupDto> {
  const named = isRecord(actor.body) ? actor.body.name : undefined;
  if (named === undefined) throw new BadRequestError('NO_FIELDS_TO_UPDATE');
  const name = normalizeDirectoryName(named, 'ATTRIBUTE_GROUP');

  return inAdminTx(
    actor,
    'ATTRIBUTE_GROUPS_UPDATE_UNEXPECTED',
    async (tx) => {
      const before = await tx.attributeGroup.findUnique({
        where: { id: actor.groupId },
        select: { id: true, name: true, position: true },
      });
      if (!before) throw new NotFoundError('ATTRIBUTE_GROUP_NOT_FOUND');

      const counts = await countsOf(tx, [before.id]);
      if (before.name === name) return toDto(before, counts.get(before.id) ?? 0);

      const updated = await tx.attributeGroup.update({
        where: { id: before.id },
        data: { name },
        select: { id: true, name: true, position: true },
      });
      await logDirectory(tx, actor, {
        event: 'attribute_group.update',
        entityId: before.id,
        changes: [{ field: 'name', old: before.name, new: name }],
      });

      return toDto(updated, counts.get(before.id) ?? 0);
    },
    nameTaken(name, actor.groupId),
  );
}

// writes a new order of all the groups, in one statement however many there are
// (writeListOrder); a line of the log for each group that moved
export async function reorderAttributeGroups(
  actor: AttributeActorDto & { body: unknown },
): Promise<AttributeGroupsListResponseDto> {
  const ids = (isRecord(actor.body) ? actor.body.ids : undefined) as number[];

  return inAdminTx(actor, 'ATTRIBUTE_GROUPS_ORDER_UNEXPECTED', async (tx) => {
    const rows = await tx.attributeGroup.findMany({ select: { id: true, position: true } });
    checkOrderIds(
      rows.map((row) => row.id),
      ids,
    );

    await writeListOrder(tx, actor, {
      table: 'attribute_groups',
      event: 'attribute_group.reorder',
      before: new Map(rows.map((row) => [row.id, row.position])),
      ids,
    });

    return { items: await readGroups(tx) };
  });
}

// deletes a group that has no characteristics; one that has stays, 409 names some of them
export async function deleteAttributeGroup(
  actor: AttributeActorDto & { groupId: number },
): Promise<MessageResponseDto> {
  return inAdminTx(
    actor,
    'ATTRIBUTE_GROUPS_DELETE_UNEXPECTED',
    async (tx) => {
      const group = await tx.attributeGroup.findUnique({
        where: { id: actor.groupId },
        select: { id: true, name: true },
      });
      if (!group) throw new NotFoundError('ATTRIBUTE_GROUP_NOT_FOUND');

      const named = await tx.attribute.findMany({
        where: { groupId: group.id },
        select: { id: true },
        orderBy: { id: 'asc' },
        take: NAMED_MAX,
      });
      if (named.length) {
        const total = await tx.attribute.count({ where: { groupId: group.id } });
        throw new ConflictError('ATTRIBUTE_GROUP_IN_USE', {
          attributeIds: named.map((row) => row.id),
          total,
        });
      }

      await tx.attributeGroup.delete({ where: { id: group.id } });
      await logDirectory(tx, actor, {
        event: 'attribute_group.delete',
        entityId: group.id,
        changes: [{ field: 'name', old: group.name, new: null }],
      });

      return { message: 'Group deleted successfully.' };
    },
    // a characteristic that came into the group between the check and the delete
    async (err) =>
      isForeignKeyViolation(err) ? new ConflictError('ATTRIBUTE_GROUP_IN_USE') : null,
  );
}
