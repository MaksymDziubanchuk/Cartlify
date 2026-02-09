import type { Prisma, PrismaClient } from '@prisma/client';
import type { UserId } from 'types/ids.js';

export type AuditChange = { field: string; old: unknown; new: unknown };

type DbClient = Prisma.TransactionClient | PrismaClient;

export function buildProductUpdateAuditChanges(
  before: {
    name: string;
    description: string | null;
    price: { toString(): string };
    categoryId: number;
    popularity: number;
  },
  args: {
    after: {
      name: string;
      description: string | null;
      price: { toString(): string };
      categoryId: number;
      popularity: number;
    };
    input: {
      name?: unknown;
      description?: unknown;
      price?: unknown;
      categoryId?: unknown;
      popularity?: unknown;
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

  if (args.input.popularity != null && before.popularity !== args.after.popularity) {
    changes.push({ field: 'popularity', old: before.popularity, new: args.after.popularity });
  }

  if (args.input.price != null && before.price.toString() !== args.after.price.toString()) {
    changes.push({
      field: 'price',
      old: before.price.toString(),
      new: args.after.price.toString(),
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
