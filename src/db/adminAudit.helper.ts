import { isSaleOn } from '@helpers/productSale.js';

import type { Prisma, PrismaClient } from '@prisma/client';
import type { UserId } from 'types/ids.js';

export type AuditChange = { field: string; old: unknown; new: unknown };

type DbClient = Prisma.TransactionClient | PrismaClient;

type SaleState = { salePrice: { toString(): string } | null; saleEndsAt: Date | null };

// what an admin did to a sale; the database writes its end by a price down to it, ended_by_price
export type SaleAuditEvent = 'start' | 'change' | 'removed';

// a line of the admin log of a sale (PRODUCT_SALE): what happened, the price, the sale before and
// after it the way the answers show it (a sale that is over is no sale) and the discount the admin
// gave. The same fields as the line of the database (db/05), prices the way Decimal writes them
export function buildSaleAuditChanges(args: {
  event: SaleAuditEvent;
  price: { toString(): string };
  before: SaleState;
  after: SaleState;
  discount?: { percent: number } | { amount: number };
}): AuditChange[] {
  const shown = (sale: SaleState) =>
    isSaleOn(sale)
      ? { salePrice: sale.salePrice!.toString(), saleEndsAt: sale.saleEndsAt!.toISOString() }
      : { salePrice: null, saleEndsAt: null };
  const old = shown(args.before);
  const next = shown(args.after);
  const price = args.price.toString();

  return [
    { field: 'event', old: null, new: args.event },
    { field: 'price', old: price, new: price },
    { field: 'salePrice', old: old.salePrice, new: next.salePrice },
    { field: 'saleEndsAt', old: old.saleEndsAt, new: next.saleEndsAt },
    ...(args.discount ? [{ field: 'discount', old: null, new: args.discount }] : []),
  ];
}

// the sale is no field here: a line of its own describes it (buildSaleAuditChanges, db/05)
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
      | 'PRODUCT_SALE'
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
      ${args.actorId}::int,
      ${args.actorRole}::cartlify."Role",
      ${args.entityType}::cartlify."AdminAuditEntityType",
      ${args.entityId}::int,
      ${args.action}::cartlify."AdminAuditAction",
      ${changesJson}::jsonb
    )
  `;
}
