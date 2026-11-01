import { isSaleOn } from '@helpers/productSale.js';

import type { Prisma, PrismaClient } from '@prisma/client';
import type { AuditEvent, WrittenEvent } from '@config/journalEvents.js';
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

// the sale and the stock are no fields here: lines of their own describe them (buildSaleAuditChanges;
// STOCK_DELIVERY and STOCK_WRITE_OFF, one line for a whole delivery or write-off: stockOperationLine).
// The price, the article number and the weight are the variant's now: a line of a variant
// (variant.update) names them; the fields stay here for the callers that still pass them
export function buildProductUpdateAuditChanges(
  before: {
    name: string;
    description: string | null;
    sku?: string | null;
    price?: { toString(): string };
    categoryId: number;
    manufacturerId?: number;
    euResponsibleId?: number | null;
    warnings?: string | null;
    weightGrams?: number | null;
    lengthMm?: number | null;
    widthMm?: number | null;
    heightMm?: number | null;
    popularityOverride: number | null;
    popularityOverrideUntil: Date | null;
    deletedAt: Date | null;
  },
  args: {
    after: {
      name: string;
      description: string | null;
      sku?: string | null;
      price?: { toString(): string };
      categoryId: number;
      manufacturerId?: number;
      euResponsibleId?: number | null;
      warnings?: string | null;
      weightGrams?: number | null;
      lengthMm?: number | null;
      widthMm?: number | null;
      heightMm?: number | null;
      popularityOverride: number | null;
      popularityOverrideUntil: Date | null;
      deletedAt: Date | null;
    };
    input: {
      name?: unknown;
      description?: unknown;
      manufacturerId?: unknown;
      euResponsibleId?: unknown;
      warnings?: unknown;
      sku?: unknown;
      price?: unknown;
      categoryId?: unknown;
      weightGrams?: unknown;
      lengthMm?: unknown;
      widthMm?: unknown;
      heightMm?: unknown;
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

  // an empty description is none: an empty one sent takes the text away, which is a change too
  const oldText = before.description || null;
  const newText = args.after.description || null;
  if (args.input.description != null && oldText !== newText) {
    changes.push({ field: 'description', old: oldText, new: newText });
  }

  // the manufacturer and the person in the EU by their ids in the directory, the warnings as text;
  // null takes the person and the warnings away, and is a change too
  if (
    args.input.manufacturerId !== undefined &&
    before.manufacturerId !== args.after.manufacturerId
  ) {
    changes.push({
      field: 'manufacturerId',
      old: before.manufacturerId ?? null,
      new: args.after.manufacturerId ?? null,
    });
  }
  if (
    args.input.euResponsibleId !== undefined &&
    (before.euResponsibleId ?? null) !== (args.after.euResponsibleId ?? null)
  ) {
    changes.push({
      field: 'euResponsibleId',
      old: before.euResponsibleId ?? null,
      new: args.after.euResponsibleId ?? null,
    });
  }
  if (
    args.input.warnings !== undefined &&
    (before.warnings ?? null) !== (args.after.warnings ?? null)
  ) {
    changes.push({
      field: 'warnings',
      old: before.warnings ?? null,
      new: args.after.warnings ?? null,
    });
  }

  // an empty article number takes it away: null is a change too
  if (args.input.sku !== undefined && (before.sku ?? null) !== (args.after.sku ?? null)) {
    changes.push({ field: 'sku', old: before.sku ?? null, new: args.after.sku ?? null });
  }

  if (args.input.categoryId != null && before.categoryId !== args.after.categoryId) {
    changes.push({ field: 'categoryId', old: before.categoryId, new: args.after.categoryId });
  }

  // the weight and the sizes sent; null is a change too, it clears them
  for (const field of ['weightGrams', 'lengthMm', 'widthMm', 'heightMm'] as const) {
    if (
      args.input[field] !== undefined &&
      (before[field] ?? null) !== (args.after[field] ?? null)
    ) {
      changes.push({ field, old: before[field] ?? null, new: args.after[field] ?? null });
    }
  }

  if (
    args.input.price != null &&
    before.price !== undefined &&
    args.after.price !== undefined &&
    before.price.toString() !== args.after.price.toString()
  ) {
    changes.push({
      field: 'price',
      old: before.price.toString(),
      new: args.after.price.toString(),
    });
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
    entityType:
      | 'product'
      | 'variant'
      | 'user'
      | 'category'
      | 'order'
      | 'review'
      | 'party'
      | 'document'
      | 'attribute'
      | 'other';
    // null for a line that is about no one thing, such as a delivery of many variants (other)
    entityId: number | null;
    // what made the line, finer than the action (src/config/journalEvents.ts)
    event: WrittenEvent<AuditEvent>;
    action:
      | 'PRODUCT_CREATE'
      | 'PRODUCT_UPDATE'
      | 'PRODUCT_DELETE'
      | 'PRODUCT_PRICE_BULK_UPDATE'
      | 'PRODUCT_SALE'
      | 'STOCK_DELIVERY'
      | 'STOCK_WRITE_OFF'
      | 'USER_ROLE_CHANGE'
      | 'ORDER_STATUS_CHANGE'
      | 'ORDER_SHIPMENT_CHANGE'
      | 'ORDER_DELIVERY_CHANGE'
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
      ${args.event},
      ${changesJson}::jsonb
    )
  `;
}

// The line of the admin log for a whole delivery or write-off of stock: one line for the operation,
// however many variants it touched (the line of each variant is in the stock log, db/05). It points
// at the variant when the operation touched exactly one, and at nothing (other, no id) when it
// touched more. Its changes start with the id of the operation, the same id the lines of the stock
// log carry (deliveryId or writeOffId), then what tells the operation (the source and the
// supplier of a delivery, the reason of a write-off, the note), then how many variants and units it
// moved. The empty details are left out. The stock is a thing of the admin: it is always in the
// admin log, the system alone (the sale at a payment) writes only the stock log
export async function writeStockOperationAuditLog(
  tx: DbClient,
  args: {
    actorId: UserId;
    actorRole: string;
    kind: 'delivery' | 'write_off';
    operationId: string;
    // the variants the operation touched, a variant once however many lines it had
    variantIds: number[];
    // the units in all, taken in or written off
    quantity: number;
    details: Array<{ field: string; value: unknown }>;
  },
): Promise<void> {
  const single = args.variantIds.length === 1 ? args.variantIds[0]! : null;

  await writeAdminAuditLog(tx, {
    actorId: args.actorId,
    actorRole: args.actorRole,
    entityType: single === null ? 'other' : 'variant',
    entityId: single,
    action: args.kind === 'delivery' ? 'STOCK_DELIVERY' : 'STOCK_WRITE_OFF',
    event: args.kind === 'delivery' ? 'stock.delivery' : 'stock.write_off',
    changes: [
      {
        field: args.kind === 'delivery' ? 'deliveryId' : 'writeOffId',
        old: null,
        new: args.operationId,
      },
      ...args.details
        .filter((detail) => detail.value !== null && detail.value !== undefined)
        .map((detail) => ({ field: detail.field, old: null, new: detail.value })),
      { field: 'variants', old: null, new: args.variantIds.length },
      { field: 'quantity', old: null, new: args.quantity },
    ],
  });
}
