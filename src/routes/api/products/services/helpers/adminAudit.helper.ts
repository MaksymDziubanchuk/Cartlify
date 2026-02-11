import type { Prisma, PrismaClient } from '@prisma/client';
import type { UserId } from 'types/ids.js';

export type AuditChange = { field: string; old: unknown; new: unknown };

type DbClient = Prisma.TransactionClient | PrismaClient;

export function buildProductUpdateAuditChanges(
  before: {
    name: string;
    description: string | null;
    price: { toString(): string };
    stock: number;
    categoryId: number;
    popularityOverride: number | null;
    popularityOverrideUntil: Date | null;
    deletedAt: Date | null;
  },
  args: {
    after: {
      name: string;
      description: string | null;
      price: { toString(): string };
      stock: number;
      categoryId: number;
      popularityOverride: number | null;
      popularityOverrideUntil: Date | null;
      deletedAt: Date | null;
    };
    input: {
      name?: unknown;
      description?: unknown;
      price?: unknown;
      stock?: unknown;
      categoryId?: unknown;
      popularityOverride?: unknown;
      popularityOverrideUntil?: unknown;
      deletedAt?: unknown;
    };
  },
): AuditChange[] {
  // build diff list only for fields present in input
  const changes: AuditChange[] = [];

  if (args.input.name != null && before.name !== args.after.name) {
    changes.push({ field: 'name', old: before.name, new: args.after.name });
  }

  if (args.input.description != null && before.description !== args.after.description) {
    changes.push({ field: 'description', old: before.description, new: args.after.description });
  }

  if (args.input.categoryId != null && before.categoryId !== args.after.categoryId) {
    changes.push({ field: 'categoryId', old: before.categoryId, new: args.after.categoryId });
  }

  if (args.input.price != null && before.price.toString() !== args.after.price.toString()) {
    changes.push({
      field: 'price',
      old: before.price.toString(),
      new: args.after.price.toString(),
    });
  }

  if (args.input.stock !== undefined && before.stock !== args.after.stock) {
    changes.push({ field: 'stock', old: before.stock, new: args.after.stock });
  }

  if (
    args.input.popularityOverride !== undefined &&
    before.popularityOverride !== args.after.popularityOverride
  ) {
    changes.push({
      field: 'popularityOverride',
      old: before.popularityOverride,
      new: args.after.popularityOverride,
    });
  }

  const beforeIso = before.popularityOverrideUntil
    ? before.popularityOverrideUntil.toISOString()
    : null;
  const afterIso = args.after.popularityOverrideUntil
    ? args.after.popularityOverrideUntil.toISOString()
    : null;

  if (args.input.popularityOverrideUntil !== undefined && beforeIso !== afterIso) {
    changes.push({ field: 'popularityOverrideUntil', old: beforeIso, new: afterIso });
  }

  const beforeDeletedIso = before.deletedAt ? before.deletedAt.toISOString() : null;
  const afterDeletedIso = args.after.deletedAt ? args.after.deletedAt.toISOString() : null;

  if (args.input.deletedAt !== undefined && beforeDeletedIso !== afterDeletedIso) {
    changes.push({
      field: 'deletedAt',
      old: beforeDeletedIso,
      new: afterDeletedIso,
    });
  }

  return changes;
}

export async function writeAdminAuditLog(
  tx: DbClient,
  args: {
    actorId: UserId;
    actorRole: string;
    entityType: 'product' | 'user' | 'category' | 'order' | 'review' | 'other';
    entityId: number;
    action:
      | 'PRODUCT_CREATE'
      | 'PRODUCT_UPDATE'
      | 'PRODUCT_DELETE'
      | 'PRODUCT_PRICE_BULK_UPDATE'
      | 'USER_ROLE_CHANGE'
      | 'ORDER_STATUS_CHANGE'
      | 'CATEGORY_UPDATE'
      | 'REVIEW_DELETE'
      | 'OTHER';
    changes: AuditChange[];
  },
): Promise<void> {
  // skip audit write when no changes
  if (!args.changes.length) return;

  const changesJson = JSON.stringify(args.changes);

  await tx.$executeRaw`
    select cartlify.log_admin_action(
      ${args.actorId},
      ${args.actorRole}::cartlify."Role",
      ${args.entityType}::cartlify."AdminAuditEntityType",
      ${args.entityId},
      ${args.action}::cartlify."AdminAuditAction",
      ${changesJson}::jsonb
    )
  `;
}
