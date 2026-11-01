import { writeAdminAuditLog } from '@db/adminAudit.helper.js';
import { BadRequestError, NotFoundError, ResourceBusyError } from '@utils/errors.js';

import { readCategorySetRows } from './helpers/categorySet.helper.js';
import {
  attributeSelect,
  inAdminTx,
  isForeignKeyViolation,
  isUniqueViolationOn,
  mapAttributeRow,
  type Tx,
} from './helpers/directory.helper.js';

import type {
  AttributeActorDto,
  CategoryAttributeDto,
  CategoryAttributesResponseDto,
} from 'types/dto/attributes.dto.js';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

async function assertCategory(tx: Tx, categoryId: number): Promise<void> {
  const category = await tx.category.findUnique({
    where: { id: categoryId },
    select: { id: true },
  });
  if (!category) throw new NotFoundError('CATEGORY_NOT_FOUND');
}

// what a category asks for: its own characteristics and those of its parents up the tree. For one
// characteristic the nearest category wins (a child takes its own setting over a parent's). In the
// order of the directory: the group, then the place in it
async function readSet(tx: Tx, categoryId: number): Promise<CategoryAttributesResponseDto> {
  const rows = await readCategorySetRows(tx, categoryId);
  if (!rows.length) return { items: [] };

  const attributes = await tx.attribute.findMany({
    where: { id: { in: rows.map((row) => row.attributeId) } },
    orderBy: [{ group: { position: 'asc' } }, { position: 'asc' }],
    select: attributeSelect,
  });
  const byAttribute = new Map(rows.map((row) => [row.attributeId, row]));

  return {
    items: attributes.map((attribute): CategoryAttributeDto => {
      const row = byAttribute.get(attribute.id)!;

      return {
        attribute: mapAttributeRow(attribute),
        required: row.required,
        categoryId: row.categoryId,
        inherited: row.categoryId !== categoryId,
      };
    }),
  };
}

export async function getCategoryAttributes(
  actor: AttributeActorDto & { categoryId: number },
): Promise<CategoryAttributesResponseDto> {
  return inAdminTx(actor, 'CATEGORY_ATTRIBUTES_LIST_UNEXPECTED', async (tx) => {
    await assertCategory(tx, actor.categoryId);
    return readSet(tx, actor.categoryId);
  });
}

const sameSet = (
  a: Array<{ attributeId: number; required: boolean }>,
  b: Array<{ attributeId: number; required: boolean }>,
) =>
  a.length === b.length &&
  a.every((row, at) => row.attributeId === b[at]!.attributeId && row.required === b[at]!.required);

// writes the own characteristics of a category whole: what is left out goes, what is new comes, a
// changed `required` is written (a row is made or deleted, never changed: db/03). A set that is
// the same as it was is 200 with nothing written. The answer is the set the category has now, with
// the parents' (readSet)
export async function setCategoryAttributes(
  actor: AttributeActorDto & { categoryId: number; body: unknown },
): Promise<CategoryAttributesResponseDto> {
  const items = (
    isRecord(actor.body) && Array.isArray(actor.body.items) ? actor.body.items : []
  ) as Array<{
    attributeId: number;
    required?: boolean;
  }>;
  const ids = items.map((item) => item.attributeId);

  const repeated = [...new Set(ids.filter((id, at) => ids.indexOf(id) !== at))].sort(
    (a, b) => a - b,
  );
  if (repeated.length) {
    throw new BadRequestError('CATEGORY_ATTRIBUTES_REPEATED', { attributeIds: repeated });
  }

  const wanted = items
    .map((item) => ({ attributeId: item.attributeId, required: item.required ?? false }))
    .sort((a, b) => a.attributeId - b.attributeId);

  return inAdminTx(
    actor,
    'CATEGORY_ATTRIBUTES_SET_UNEXPECTED',
    async (tx) => {
      await assertCategory(tx, actor.categoryId);

      const found = new Set(
        (await tx.attribute.findMany({ where: { id: { in: ids } }, select: { id: true } })).map(
          (row) => row.id,
        ),
      );
      const unknown = ids.filter((id) => !found.has(id)).sort((a, b) => a - b);
      if (unknown.length) throw new NotFoundError('ATTRIBUTE_NOT_FOUND', { attributeIds: unknown });

      const before = await tx.categoryAttribute.findMany({
        where: { categoryId: actor.categoryId },
        orderBy: { attributeId: 'asc' },
        select: { attributeId: true, required: true },
      });

      if (!sameSet(before, wanted)) {
        await tx.categoryAttribute.deleteMany({ where: { categoryId: actor.categoryId } });
        if (wanted.length) {
          await tx.categoryAttribute.createMany({
            data: wanted.map((row) => ({ categoryId: actor.categoryId, ...row })),
          });
        }

        await writeAdminAuditLog(tx, {
          actorId: actor.actorId,
          actorRole: actor.actorRole,
          entityType: 'category',
          entityId: actor.categoryId,
          action: 'OTHER',
          event: 'category.attributes_set',
          changes: [{ field: 'attributes', old: before, new: wanted }],
        });
      }

      return readSet(tx, actor.categoryId);
    },
    // two requests that wrote the set at once, or a characteristic deleted between the check and
    // the write: the one that lost is asked to come again
    async (err) =>
      isUniqueViolationOn(err, 'category_attributes_pkey') || isForeignKeyViolation(err)
        ? new ResourceBusyError({ reason: 'CATEGORY_ATTRIBUTES_CHANGED' }, err)
        : null,
  );
}
