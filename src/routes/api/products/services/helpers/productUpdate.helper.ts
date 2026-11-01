import { Prisma } from '@prisma/client';

import { buildProductUpdateAuditChanges, writeAdminAuditLog } from '@db/adminAudit.helper.js';
import { normalizeWarnings } from '@helpers/party.js';
import { BadRequestError, NotFoundError } from '@utils/errors.js';

import { assertCategoryExists } from './productCategory.helper.js';
import {
  assertDocumentsExist,
  readDocumentIds,
  readProductDocumentIds,
  replaceProductDocuments,
} from './productDocuments.helper.js';
import { checkUpdatedParties, planUpdateParties } from './productParties.helper.js';
import { productResponseSelect } from './productMapper.helper.js';
import { assertPopularityOverridePair, normalizeUpdateProductInput } from './products.helpers.js';

import type { UserId } from 'types/ids.js';
import type { UpdateProductBodyDto } from 'types/dto/products.dto.js';
import type { Role } from 'types/user.js';

// the context of a change of a product: the transaction, the admin it is done for, and batch when
// the change comes from the route of many
export type ProductWriteContext = {
  db: Prisma.TransactionClient;
  actorId: UserId;
  actorRole: Role;
  batch?: boolean;
};

// a change of a product: its own fields only (name, description, category, parties, warnings,
// documents, the override of the popularity). The price, the sale, the article number, the weight
// and the stock are the variant's. The fields are read and checked first, then the product as it
// is under the lock of its row, then the steps are written in the transaction of the caller with
// every line of the logs

// the fields of a change, each one left out or undefined when it is not sent
export type ProductUpdateFields = {
  [K in keyof UpdateProductBodyDto]?: UpdateProductBodyDto[K] | undefined;
};

export type ProductUpdatePlan = ReturnType<typeof planProductUpdate>;

// the fields sent, normalized; a change with nothing to change is refused. A caller that has other
// kinds of change (opts.hasImages: true) lets an empty set of fields through
export function planProductUpdate(fields: ProductUpdateFields, opts: { hasImages?: boolean } = {}) {
  const {
    name,
    description,
    manufacturerId,
    euResponsibleId,
    warnings,
    documentIds,
    stock,
    categoryId,
    popularityOverride,
    popularityOverrideUntil,
  } = fields;

  // a stock sent is refused, it changes only with a delivery or a write-off
  const {
    nameNorm,
    descriptionNorm,
    categoryIdRaw,
    popularityOverrideRaw,
    popularityOverrideUntilDate,
  } = normalizeUpdateProductInput({
    name,
    description,
    stock,
    categoryId,
    popularityOverride,
    popularityOverrideUntil,
  });
  // the manufacturer and the person in the EU by their ids; the warnings, none when empty
  const partyChanges = planUpdateParties({ manufacturerId, euResponsibleId });
  const warningsNorm = warnings !== undefined ? normalizeWarnings(warnings) : undefined;
  // the documents by their ids, the list written whole; null or none is an empty list
  const documentIdsNorm = readDocumentIds(documentIds);

  // reject empty patch
  const hasAnyUpdates =
    opts.hasImages === true ||
    name !== undefined ||
    description !== undefined ||
    manufacturerId !== undefined ||
    euResponsibleId !== undefined ||
    warnings !== undefined ||
    documentIds !== undefined ||
    categoryId !== undefined ||
    popularityOverride !== undefined ||
    popularityOverrideUntil !== undefined;

  if (!hasAnyUpdates) throw new BadRequestError('NO_FIELDS_TO_UPDATE');

  return {
    // as sent: the admin log names the fields given
    input: fields,
    nameNorm,
    descriptionNorm,
    categoryIdRaw,
    popularityOverrideRaw,
    popularityOverrideUntilDate,
    partyChanges,
    warningsNorm,
    documentIdsNorm,
  };
}

// the product as it is before the change, for the checks and the admin log
export const productBeforeUpdateSelect = {
  id: true,
  name: true,
  description: true,
  categoryId: true,
  manufacturerId: true,
  euResponsibleId: true,
  warnings: true,
  popularityOverride: true,
  popularityOverrideUntil: true,
  popularity: true,
  deletedAt: true,
} as const;

export type ProductBeforeUpdate = Prisma.ProductGetPayload<{
  select: typeof productBeforeUpdateSelect;
}>;

// the checks of a change against the product as it is, before anything is written: a product
// that is not there is PRODUCT_NOT_FOUND
export async function checkProductUpdate(
  db: Prisma.TransactionClient,
  plan: ProductUpdatePlan,
  before: ProductBeforeUpdate | null,
): Promise<ProductBeforeUpdate> {
  if (!before) throw new NotFoundError('PRODUCT_NOT_FOUND');

  const { categoryId, popularityOverride, popularityOverrideUntil } = plan.input;

  if (categoryId !== undefined) await assertCategoryExists(db, plan.categoryIdRaw!);

  // the documents named are in the directory of documents
  if (plan.documentIdsNorm) await assertDocumentsExist(db, plan.documentIdsNorm);

  // the parties after the change: in the directory, and by the rule of the EU
  if (Object.keys(plan.partyChanges).length > 0) {
    await checkUpdatedParties(db, before, plan.partyChanges);
  }

  // an override with its end, or neither: a change of one keeps the other one of the
  // product. A change that leaves the override alone is not checked, old rows of dev may
  // have an override without an end
  if (popularityOverride !== undefined || popularityOverrideUntil !== undefined) {
    assertPopularityOverridePair({
      popularityOverride:
        popularityOverride === undefined
          ? before.popularityOverride
          : (plan.popularityOverrideRaw ?? null),
      popularityOverrideUntil:
        popularityOverrideUntil === undefined
          ? before.popularityOverrideUntil
          : (plan.popularityOverrideUntilDate ?? null),
    });
  }

  return before;
}

// writes a change that checkProductUpdate let through, under the lock of the row: the fields and
// the documents, with the line of the admin log, in the name of the admin of the context
export async function writeProductUpdate(
  ctx: ProductWriteContext,
  plan: ProductUpdatePlan,
  before: ProductBeforeUpdate,
) {
  const { db, actorId, actorRole } = ctx;
  const { input } = plan;

  // build update payload only for provided fields
  const data: Prisma.ProductUpdateInput = {
    ...(input.name !== undefined ? { name: plan.nameNorm! } : {}),
    ...(input.description !== undefined ? { description: plan.descriptionNorm || null } : {}),
    ...plan.partyChanges,
    ...(plan.warningsNorm !== undefined ? { warnings: plan.warningsNorm } : {}),
    ...(input.categoryId !== undefined ? { categoryId: plan.categoryIdRaw! } : {}),
  };

  // apply explicit nulls only when client asked to clear values
  if (input.popularityOverride === null) {
    data.popularityOverride = null;
  } else if (input.popularityOverride !== undefined) {
    data.popularityOverride = plan.popularityOverrideRaw as number;
  }

  if (input.popularityOverrideUntil === null) {
    data.popularityOverrideUntil = null;
  } else if (input.popularityOverrideUntil !== undefined) {
    data.popularityOverrideUntil = plan.popularityOverrideUntilDate as Date;
  }

  // a change of the documents alone is an edit of the product too: its last edit moves
  if (!Object.keys(data).length) {
    data.updatedAt = new Date();
  }

  // persist product update under row lock
  const after = await db.product.update({
    where: { id: before.id },
    data,
    select: productResponseSelect,
  });

  // build diff list for admin audit log
  const auditChanges = buildProductUpdateAuditChanges(before, {
    after,
    input: {
      name: input.name,
      description: input.description,
      manufacturerId: plan.partyChanges.manufacturerId,
      euResponsibleId: plan.partyChanges.euResponsibleId,
      warnings: plan.warningsNorm,
      categoryId: input.categoryId,
      popularityOverride: input.popularityOverride,
      popularityOverrideUntil: input.popularityOverrideUntil,
    },
  });

  // the documents are written whole; a list the product has already is no change
  if (plan.documentIdsNorm !== undefined) {
    const oldIds = await readProductDocumentIds(db, before.id);
    const newIds = plan.documentIdsNorm;
    if (oldIds.length !== newIds.length || oldIds.some((id, at) => id !== newIds[at])) {
      await replaceProductDocuments(db, before.id, newIds);
      auditChanges.push({ field: 'documentIds', old: oldIds, new: newIds });
    }
  }

  // write admin audit log when something actually changed
  if (auditChanges.length) {
    await writeAdminAuditLog(db, {
      actorId,
      actorRole,
      entityType: 'product',
      entityId: after.id,
      action: 'PRODUCT_UPDATE',
      event: ctx.batch ? 'product.update_batch' : 'product.update',
      changes: auditChanges,
    });
  }

  return after;
}
