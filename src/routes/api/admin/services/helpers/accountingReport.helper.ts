import { Prisma } from '@prisma/client';

import { MAX_ID } from '@schemas/idPathParam.js';
import { BadRequestError, InternalError } from '@utils/errors.js';

import type { AdminUnitsValueDto, GetAdminAccountingResponseDto } from 'types/dto/admin.dto.js';

// the report of the accounting: the sales of a period at the cost of the batches they took, the
// returns that took money back, what came in and what was written off, the value of the stock

export const MAX_REPORT_PRODUCTS = 100;

export const WRITE_OFF_REASONS = [
  'damaged',
  'defective',
  'expired',
  'shortage',
  'returned_to_supplier',
  'other',
] as const;

// the reasons of the write-offs in a report: those of the stock write-off, and the goods that came
// back with a statement and were written off or lost at once (they have no reason of their own)
export const REPORT_WRITE_OFF_REASONS = [...WRITE_OFF_REASONS, 'customer_return'] as const;

export const STOCK_SOURCES = ['supplier', 'surplus', 'customer_return'] as const;

// the kinds of a return in a report: the right of withdrawal (a statement with no reason), and the
// reasons an admin gives to the others
export const RETURN_KINDS = [
  'withdrawal',
  'refused',
  'defect',
  'wrong_item',
  'damaged',
  'goodwill',
  'shop_cancel',
  'other',
] as const;

type WriteOffReason = (typeof REPORT_WRITE_OFF_REASONS)[number];
type WriteOffs = GetAdminAccountingResponseDto['writeOffs'];

// the ids a report reads (products or variants), each once; the schema let through ids of digits only
function parseIds(text: string | undefined, errorCode: string): number[] | undefined {
  if (text === undefined) return undefined;

  const ids = [...new Set(text.split(',').map(Number))].sort((a, b) => a - b);
  if (ids.length > MAX_REPORT_PRODUCTS || ids.some((id) => !Number.isInteger(id) || id > MAX_ID)) {
    throw new BadRequestError(errorCode, {
      maxIds: MAX_REPORT_PRODUCTS,
      maxId: MAX_ID,
    });
  }

  return ids;
}

// the products the report reads, each once
export const parseProductIds = (text: string | undefined) => parseIds(text, 'PRODUCT_IDS_INVALID');

// the variants the report reads, each once
export const parseVariantIds = (text: string | undefined) => parseIds(text, 'VARIANT_IDS_INVALID');

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

// the write-offs of the lines of the stock log (stock.write_off), as
// cartlify.write_off_variant_stock writes them (db/05): the reason, and the batches with their
// units and costs. Decimals, not floats, for the money. A line of another shape is a broken state
// of the log, not something the report may leave out. The goods that came back with a statement and
// went out at once (stock.return_write_off) have no reason and no line here: they come in apart, as
// the units and the value read from the log in sql, and count under customer_return
export function summarizeWriteOffs(
  lines: unknown[],
  returned: { units: number; value: Prisma.Decimal.Value } = { units: 0, value: 0 },
): WriteOffs {
  const total = emptySum();
  const byReason = Object.fromEntries(
    REPORT_WRITE_OFF_REASONS.map((r) => [r, emptySum()]),
  ) as Record<WriteOffReason, Sum>;

  for (const sum of [total, byReason.customer_return]) {
    sum.units += returned.units;
    sum.value = sum.value.plus(new Prisma.Decimal(returned.value));
  }

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
      REPORT_WRITE_OFF_REASONS.map((r) => [r, shown(byReason[r])]),
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
