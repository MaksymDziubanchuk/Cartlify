import { Prisma } from '@prisma/client';

import { prisma } from '@db/client.js';
import { MAX_ATTRIBUTE_OPTIONS } from '@config/limits.js';
import {
  CHOICE_ATTRIBUTE_TYPES,
  checkOrderIds,
  normalizeColor,
  normalizeDirectoryName,
} from '@helpers/attributeFields.js';
import { BadRequestError, ConflictError, NotFoundError } from '@utils/errors.js';

import { assertValuesAccepted } from '@routes/api/products/services/helpers/variantValues.helper.js';

import {
  inAdminTx,
  isForeignKeyViolation,
  isUniqueViolationOn,
  lockRow,
  logDirectory,
  mapOptionRow,
  optionSelect,
  writeListOrder,
  type Tx,
} from './helpers/directory.helper.js';
import { optionUsage } from './helpers/valueUsage.helper.js';

import type {
  AttributeActorDto,
  AttributeOptionDto,
  AttributeOptionsListResponseDto,
  ReplaceOptionResponseDto,
} from 'types/dto/attributes.dto.js';
import type { MessageResponseDto } from 'types/common.js';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// the value of a characteristic that holds a name already (letter case ignored), another than skipId
async function optionNamed(
  attributeId: number,
  name: string,
  skipId?: number,
): Promise<number | null> {
  const rows = await prisma.$queryRaw<{ id: number }[]>(Prisma.sql`
    SELECT id FROM cartlify.attribute_options
    WHERE "attributeId" = ${attributeId} AND lower(name) = lower(${name})
      ${skipId === undefined ? Prisma.empty : Prisma.sql`AND id <> ${skipId}`}
    LIMIT 1
  `);

  return rows[0]?.id ?? null;
}

const nameTaken =
  (attributeId: number, name: string | undefined, skipId?: number) => async (err: unknown) => {
    if (name === undefined || !isUniqueViolationOn(err, 'attribute_options_name_uidx')) return null;

    const optionId = await optionNamed(attributeId, name, skipId);
    return optionId === null
      ? null
      : new ConflictError('ATTRIBUTE_OPTION_NAME_TAKEN', { optionId });
  };

// the characteristic must be there and be a choice: only a choice has values. It stays as it is
// (not deleted, not changed to another type) until the end of the transaction
async function choiceOf(tx: Tx, attributeId: number) {
  await lockRow(tx, 'attributes', attributeId, 'SHARE');

  const attribute = await tx.attribute.findUnique({
    where: { id: attributeId },
    select: { id: true, type: true },
  });
  if (!attribute) throw new NotFoundError('ATTRIBUTE_NOT_FOUND');
  if (!CHOICE_ATTRIBUTE_TYPES.includes(attribute.type)) {
    throw new BadRequestError('ATTRIBUTE_OPTIONS_NOT_ALLOWED', { type: attribute.type });
  }

  return attribute;
}

const readOptions = async (
  tx: Tx,
  attributeId: number,
): Promise<AttributeOptionsListResponseDto> => ({
  items: (
    await tx.attributeOption.findMany({
      where: { attributeId },
      orderBy: { position: 'asc' },
      select: optionSelect,
    })
  ).map(mapOptionRow),
});

// a new value goes to the end of the others; there are at most ATTRIBUTE_OPTIONS_MAX of them
export async function createAttributeOption(
  actor: AttributeActorDto & { attributeId: number; body: unknown },
): Promise<AttributeOptionDto> {
  const b = isRecord(actor.body) ? actor.body : {};
  const name = normalizeDirectoryName(b.name, 'ATTRIBUTE_OPTION');
  const colorCode = b.colorCode === undefined ? null : normalizeColor(b.colorCode);

  return inAdminTx(
    actor,
    'ATTRIBUTE_OPTIONS_CREATE_UNEXPECTED',
    async (tx) => {
      await choiceOf(tx, actor.attributeId);

      const count = await tx.attributeOption.count({ where: { attributeId: actor.attributeId } });
      if (count >= MAX_ATTRIBUTE_OPTIONS) {
        throw new BadRequestError('ATTRIBUTE_OPTIONS_TOO_MANY', { max: MAX_ATTRIBUTE_OPTIONS });
      }

      const last = await tx.attributeOption.findFirst({
        where: { attributeId: actor.attributeId },
        orderBy: { position: 'desc' },
        select: { position: true },
      });
      const created = await tx.attributeOption.create({
        data: {
          attributeId: actor.attributeId,
          name,
          colorCode,
          position: (last?.position ?? 0) + 1,
        },
        select: optionSelect,
      });

      await logDirectory(tx, actor, {
        event: 'attribute_option.create',
        entityId: created.id,
        changes: [
          { field: 'attributeId', old: null, new: actor.attributeId },
          { field: 'name', old: null, new: name },
          { field: 'colorCode', old: null, new: colorCode },
        ],
      });

      return mapOptionRow(created);
    },
    nameTaken(actor.attributeId, name),
  );
}

// the values of a characteristic in their order
export async function listAttributeOptions(
  actor: AttributeActorDto & { attributeId: number },
): Promise<AttributeOptionsListResponseDto> {
  return inAdminTx(actor, 'ATTRIBUTE_OPTIONS_LIST_UNEXPECTED', async (tx) => {
    const attribute = await tx.attribute.findUnique({
      where: { id: actor.attributeId },
      select: { id: true },
    });
    if (!attribute) throw new NotFoundError('ATTRIBUTE_NOT_FOUND');

    return readOptions(tx, actor.attributeId);
  });
}

// changes the name and the colour of a value that were named; what it has already is 200 with
// nothing written
export async function updateAttributeOption(
  actor: AttributeActorDto & { attributeId: number; optionId: number; body: unknown },
): Promise<AttributeOptionDto> {
  const b = isRecord(actor.body) ? actor.body : {};
  if (b.name === undefined && b.colorCode === undefined) {
    throw new BadRequestError('NO_FIELDS_TO_UPDATE');
  }
  const name =
    b.name !== undefined ? normalizeDirectoryName(b.name, 'ATTRIBUTE_OPTION') : undefined;
  const colorCode = b.colorCode !== undefined ? normalizeColor(b.colorCode) : undefined;

  return inAdminTx(
    actor,
    'ATTRIBUTE_OPTIONS_UPDATE_UNEXPECTED',
    async (tx) => {
      const before = await tx.attributeOption.findFirst({
        where: { id: actor.optionId, attributeId: actor.attributeId },
        select: optionSelect,
      });
      if (!before) throw new NotFoundError('ATTRIBUTE_OPTION_NOT_FOUND');

      const changes = [
        ...(name !== undefined && name !== before.name
          ? [{ field: 'name', old: before.name, new: name }]
          : []),
        ...(colorCode !== undefined && colorCode !== before.colorCode
          ? [{ field: 'colorCode', old: before.colorCode, new: colorCode }]
          : []),
      ];
      if (!changes.length) return mapOptionRow(before);

      const updated = await tx.attributeOption.update({
        where: { id: before.id },
        data: {
          ...(name !== undefined ? { name } : {}),
          ...(colorCode !== undefined ? { colorCode } : {}),
        },
        select: optionSelect,
      });
      await logDirectory(tx, actor, {
        event: 'attribute_option.update',
        entityId: before.id,
        changes,
      });

      return mapOptionRow(updated);
    },
    nameTaken(actor.attributeId, name, actor.optionId),
  );
}

// a new order of all the values of a characteristic; a line of the log for each that moved
export async function reorderAttributeOptions(
  actor: AttributeActorDto & { attributeId: number; body: unknown },
): Promise<AttributeOptionsListResponseDto> {
  const ids = (isRecord(actor.body) ? actor.body.ids : undefined) as number[];

  return inAdminTx(actor, 'ATTRIBUTE_OPTIONS_ORDER_UNEXPECTED', async (tx) => {
    if (!(await lockRow(tx, 'attributes', actor.attributeId, 'SHARE'))) {
      throw new NotFoundError('ATTRIBUTE_NOT_FOUND');
    }

    const rows = await tx.attributeOption.findMany({
      where: { attributeId: actor.attributeId },
      select: { id: true, position: true },
    });
    checkOrderIds(
      rows.map((row) => row.id),
      ids,
    );

    await writeListOrder(tx, actor, {
      table: 'attribute_options',
      event: 'attribute_option.reorder',
      before: new Map(rows.map((row) => [row.id, row.position])),
      ids,
    });

    return readOptions(tx, actor.attributeId);
  });
}

// deletes a value; one that a variant has stays: 409 names some of the products and of the variants
// (replace it first: POST .../replace)
export async function deleteAttributeOption(
  actor: AttributeActorDto & { attributeId: number; optionId: number },
): Promise<MessageResponseDto> {
  return inAdminTx(
    actor,
    'ATTRIBUTE_OPTIONS_DELETE_UNEXPECTED',
    async (tx) => {
      // a variant being given the value holds it: the delete waits for that request and counts after
      const locked = await tx.$queryRaw<{ id: number }[]>(Prisma.sql`
        SELECT id FROM cartlify.attribute_options
        WHERE id = ${actor.optionId}::int AND "attributeId" = ${actor.attributeId}::int
        FOR UPDATE
      `);
      if (!locked.length) throw new NotFoundError('ATTRIBUTE_OPTION_NOT_FOUND');

      const option = await tx.attributeOption.findFirstOrThrow({
        where: { id: actor.optionId, attributeId: actor.attributeId },
        select: { id: true, name: true, colorCode: true },
      });

      const used = await optionUsage(tx, option.id);
      if (used.variantsTotal > 0) throw new ConflictError('ATTRIBUTE_OPTION_IN_USE', used);

      await tx.attributeOption.delete({ where: { id: option.id } });
      await logDirectory(tx, actor, {
        event: 'attribute_option.delete',
        entityId: option.id,
        changes: [
          { field: 'name', old: option.name, new: null },
          { field: 'colorCode', old: option.colorCode, new: null },
        ],
      });

      return { message: 'Value deleted successfully.' };
    },
    // a variant that took the value between the check and the delete
    async (err) =>
      isForeignKeyViolation(err) ? new ConflictError('ATTRIBUTE_OPTION_IN_USE') : null,
  );
}

// Puts a value of a characteristic in the place of another of the same one in every variant that
// has it (the ones taken out of sale too): all of them or none. A variant of a set that has both
// just loses the old one. When two variants of a product would be left with the same values of all
// the characteristics, nothing changes: 409 VARIANT_DUPLICATE lists them. The old value stays in
// the directory (it is deleted apart). One line of the admin log says how many variants changed;
// the names of the variants follow the values at once. Nothing to replace is 200 with 0 and no line
export async function replaceAttributeOption(
  actor: AttributeActorDto & { attributeId: number; optionId: number; body: unknown },
): Promise<ReplaceOptionResponseDto> {
  const b = isRecord(actor.body) ? actor.body : {};
  const withOptionId = b.withOptionId as number;
  if (withOptionId === actor.optionId) throw new BadRequestError('ATTRIBUTE_OPTION_REPLACE_SAME');

  return inAdminTx(actor, 'ATTRIBUTE_OPTIONS_REPLACE_UNEXPECTED', async (tx) => {
    // the characteristic is a choice and stays so until the end
    await choiceOf(tx, actor.attributeId);

    // both values are values of it, and stay so until the end
    const options = await tx.$queryRaw<{ id: number }[]>(Prisma.sql`
      SELECT id FROM cartlify.attribute_options
      WHERE "attributeId" = ${actor.attributeId}::int AND id = ANY(${[actor.optionId, withOptionId]}::int[])
      ORDER BY id
      FOR KEY SHARE
    `);
    const found = new Set(options.map((option) => option.id));
    if (!found.has(actor.optionId)) throw new NotFoundError('ATTRIBUTE_OPTION_NOT_FOUND');
    if (!found.has(withOptionId)) {
      throw new NotFoundError('ATTRIBUTE_OPTION_NOT_FOUND', { withOptionId });
    }

    const holdersOf = () =>
      tx.$queryRaw<{ variantId: number; productId: number }[]>(Prisma.sql`
        SELECT DISTINCT v.id AS "variantId", v."productId"
        FROM cartlify.variant_attribute_values AS x
        JOIN cartlify.product_variants AS v ON v.id = x."variantId"
        WHERE x."optionId" = ${actor.optionId}::int
        ORDER BY v."productId", v.id
      `);

    // The variants that have the value, and their products, are locked as every change of the
    // values of a variant locks them (the products by id, then the variants by id); the holders are
    // read again after the locks, for a request that changed them meanwhile
    const asked = await holdersOf();
    if (!asked.length) return { updatedCount: 0 };

    await tx.$queryRaw(Prisma.sql`
      SELECT id FROM cartlify.products
      WHERE id = ANY(${[...new Set(asked.map((row) => row.productId))]}::int[])
      ORDER BY id FOR UPDATE
    `);
    await tx.$queryRaw(Prisma.sql`
      SELECT id FROM cartlify.product_variants
      WHERE id = ANY(${asked.map((row) => row.variantId)}::int[])
      ORDER BY id FOR UPDATE
    `);

    const holders = await holdersOf();
    if (!holders.length) return { updatedCount: 0 };

    // a variant of a set that has both values loses the old one, the others change it
    await tx.$executeRaw(Prisma.sql`
      DELETE FROM cartlify.variant_attribute_values AS x
      USING cartlify.variant_attribute_values AS y
      WHERE x."optionId" = ${actor.optionId}::int
        AND y."variantId" = x."variantId"
        AND y."attributeId" = x."attributeId"
        AND y."optionId" = ${withOptionId}::int
    `);
    await tx.$executeRaw(Prisma.sql`
      UPDATE cartlify.variant_attribute_values SET "optionId" = ${withOptionId}::int
      WHERE "optionId" = ${actor.optionId}::int
    `);

    // no two variants of a product are left alike (the products are locked)
    await assertValuesAccepted(
      tx,
      holders.map((row) => ({
        variantId: row.variantId,
        productId: row.productId,
        categoryId: 0,
        ref: { variantId: row.variantId },
      })),
      { required: false },
    );

    await logDirectory(tx, actor, {
      event: 'attribute_option.replace',
      entityId: actor.optionId,
      changes: [
        { field: 'optionId', old: actor.optionId, new: withOptionId },
        { field: 'variants', old: null, new: holders.length },
        { field: 'products', old: null, new: new Set(holders.map((row) => row.productId)).size },
      ],
    });

    return { updatedCount: holders.length };
  });
}
