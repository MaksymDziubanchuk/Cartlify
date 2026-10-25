import { Prisma } from '@prisma/client';

import { MAX_ID } from '@schemas/idPathParam.js';
import { BadRequestError, InternalError } from '@utils/errors.js';

import type { AdminUnitsValueDto, GetAdminAccountingResponseDto } from 'types/dto/admin.dto.js';

// the report of the accounting: the sales of a period at the cost of the batches they took, the
// cancels that took sales back, what came in and what was written off, the value of the stock left

export const MAX_REPORT_PRODUCTS = 100;

export const WRITE_OFF_REASONS = [
  'damaged',
  'defective',
  'expired',
  'shortage',
  'returned_to_supplier',
  'other',
] as const;

export const STOCK_SOURCES = ['supplier', 'surplus', 'customer_return'] as const;

type WriteOffReason = (typeof WRITE_OFF_REASONS)[number];
type WriteOffs = GetAdminAccountingResponseDto['writeOffs'];

// the products the report reads, each once; the schema let through ids of digits only
export function parseProductIds(text: string | undefined): number[] | undefined {
  if (text === undefined) return undefined;

  const ids = [...new Set(text.split(',').map(Number))].sort((a, b) => a - b);
  if (ids.length > MAX_REPORT_PRODUCTS || ids.some((id) => !Number.isInteger(id) || id > MAX_ID)) {
    throw new BadRequestError('PRODUCT_IDS_INVALID', {
      maxIds: MAX_REPORT_PRODUCTS,
      maxId: MAX_ID,
    });
  }

  return ids;
}

// money of the report as a number, to the cent
export const money = (value: Prisma.Decimal) => value.toDecimalPlaces(2).toNumber();

// the margin as a part of the revenue, in percent to the hundredth; nothing sold has no percent
export const marginPercentOf = (margin: Prisma.Decimal, revenue: Prisma.Decimal) =>
  revenue.isZero() ? null : margin.times(100).dividedBy(revenue).toDecimalPlaces(2).toNumber();

type Sum = { units: number; value: Prisma.Decimal };

const emptySum = (): Sum => ({ units: 0, value: new Prisma.Decimal(0) });

const shown = (sum: Sum): AdminUnitsValueDto => ({ units: sum.units, value: money(sum.value) });

type Change = { field?: unknown; new?: unknown };

const broken = (reason: string): never => {
  throw new InternalError({ reason: 'WRITE_OFF_LINE_INVALID', detail: reason });
};

// the write-offs of the lines of the admin log (STOCK_WRITE_OFF), as
// cartlify.write_off_product_stock writes them (db/05): the reason, and the batches with their
// units and costs. Decimals, not floats, for the money. A line of another shape is a broken state
// of the log, not something the report may leave out
export function summarizeWriteOffs(lines: unknown[]): WriteOffs {
  const total = emptySum();
  const byReason = Object.fromEntries(WRITE_OFF_REASONS.map((r) => [r, emptySum()])) as Record<
    WriteOffReason,
    Sum
  >;

  for (const meta of lines) {
    const changes = Array.isArray(meta) ? (meta as Change[]) : broken('not a list');
    const reason = changes.find((c) => c.field === 'reason')?.new;
    const batches = changes.find((c) => c.field === 'batches')?.new;

    if (typeof reason !== 'string' || !(WRITE_OFF_REASONS as readonly string[]).includes(reason)) {
      broken('reason');
    }
    if (!Array.isArray(batches)) broken('batches');

    for (const batch of batches as { quantity?: unknown; unitCost?: unknown }[]) {
      const quantity = batch.quantity;
      if (typeof quantity !== 'number' || !Number.isInteger(quantity)) broken('quantity');

      let cost: Prisma.Decimal;
      try {
        cost = new Prisma.Decimal(String(batch.unitCost));
      } catch {
        return broken('unitCost');
      }

      const value = cost.times(quantity as number);
      for (const sum of [total, byReason[reason as WriteOffReason]]) {
        sum.units += quantity as number;
        sum.value = sum.value.plus(value);
      }
    }
  }

  return {
    ...shown(total),
    byReason: Object.fromEntries(
      WRITE_OFF_REASONS.map((r) => [r, shown(byReason[r])]),
    ) as WriteOffs['byReason'],
  };
}

// rows sorted by a value in the order asked, rows without a value last whichever way, rows of the
// same value by id in the same order
export function sortRows<T extends { id: number }>(
  rows: T[],
  valueOf: (row: T) => number | string | null,
  order: 'asc' | 'desc',
): T[] {
  const dir = order === 'desc' ? -1 : 1;

  return [...rows].sort((a, b) => {
    const x = valueOf(a);
    const y = valueOf(b);
    if (x === null || y === null) {
      if (x !== y) return x === null ? 1 : -1;
    } else if (x !== y) {
      const diff = typeof x === 'string' ? x.localeCompare(String(y)) : x - (y as number);
      return diff * dir;
    }
    return (a.id - b.id) * dir;
  });
}
