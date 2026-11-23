import { decimalToNumber } from '@helpers/safeNormalizer.js';

import { Prisma } from '@prisma/client';
import type {
  MoneyPart,
  MoneyPurpose,
  MoneyState,
  OutsideMethod,
  RefundFailure,
  ReturnMoney,
} from '@prisma/client';

// The money of the statements of return, read from their lines of the money journal (db/05,
// money_log): the statement and its rows keep only where the money stands (returns.refundedTotal,
// return_items.money and the line that put it there), the movement itself is the lines. A transfer
// is written in parts under one key (the goods, the delivery, the deduction for the way back the
// buyer owes, the way back the shop pays), money sent outside the app in parts written together;
// what money already sent another way paid of the rows is no line (it moved once): the marks of the
// rows take it (return_row_shares, db/05), and it is read here as the part covered of a movement; a
// failure is new lines with the opposite sums; what the shop paid a carrier for a parcel back is a
// line of the parcel with its corrections

// the parts of a movement of a statement: those of the journal, and covered, what money already
// with the buyer paid of its rows (no line: the marks of the rows take it)
export type ReturnMoneyPart = MoneyPart | 'covered';

export type ReturnMoneyLine = {
  // a part covered has no line of its own: its id is below 0
  id: number;
  event: string;
  purpose: MoneyPurpose;
  part: ReturnMoneyPart;
  // signed: above 0 to the shop, below 0 from it
  amount: number;
  currency: string | null;
  state: MoneyState | null;
  stateAt: Date | null;
  createdAt: Date;
  // the day a person wrote it really happened (money sent outside the app, the compensation)
  happenedAt: Date | null;
  refundId: string | null;
  bankReference: string | null;
  byDashboard: boolean;
  transferKey: string | null;
  coversId: number | null;
  failure: RefundFailure | null;
  failureText: string | null;
  method: OutsideMethod | null;
  note: string | null;
  actorId: number | null;
  orderShipmentId: number | null;
  meta: unknown;
};

// cents without float math; a sum of nothing is 0, never -0
const cents = (value: number) => Math.round(value * 100) || 0;

const sumOf = (lines: ReturnMoneyLine[]) =>
  lines.reduce((sum, one) => sum + cents(one.amount), 0) / 100;

const LINE_SELECT = {
  id: true,
  returnId: true,
  event: true,
  purpose: true,
  part: true,
  amount: true,
  currency: true,
  state: true,
  stateAt: true,
  createdAt: true,
  happenedAt: true,
  refundId: true,
  bankReference: true,
  byDashboard: true,
  transferKey: true,
  coversId: true,
  failure: true,
  failureText: true,
  method: true,
  note: true,
  actorId: true,
  orderShipmentId: true,
  meta: true,
} as const;

// the lines of the statements, oldest first. What money already with the buyer paid of the rows of
// a statement (a refund made by hand, what a bank gave for a dispute: lines of the order, not of a
// statement; the marks of the rows take it) comes as the part covered of the movement written in the
// moment the row took it (none, a movement of its own), and so does what became of that money
// (its failure, money root sent another way instead), so each statement tells the whole of its money
export async function readReturnMoneyLines(
  db: Prisma.TransactionClient,
  returnIds: number[],
): Promise<Map<number, ReturnMoneyLine[]>> {
  const found = returnIds.length
    ? await db.moneyLog.findMany({
        where: { returnId: { in: returnIds } },
        orderBy: { id: 'asc' },
        select: LINE_SELECT,
      })
    : [];

  // what money already with the buyer pays of the rows by their marks, and the sources each
  // statement took of (the queries of one transaction one after another)
  const statements = returnIds.length
    ? await db.orderReturn.findMany({
        where: { id: { in: returnIds } },
        select: { orderId: true },
      })
    : [];
  const shares: Share[] = [];
  for (const orderId of [...new Set(statements.map((one) => one.orderId))]) {
    const found = await db.$queryRaw<ShareRow[]>(Prisma.sql`
      select return_item_id, return_id, source_id, order_item_id, amount::text as amount, at
      from cartlify.return_row_shares_of(${orderId}::int, true)
    `);
    for (const one of found) {
      if (!returnIds.includes(one.return_id)) continue;
      shares.push({
        rowId: one.return_item_id,
        returnId: one.return_id,
        moneyLogId: one.source_id,
        orderItemId: one.order_item_id,
        amount: Number(one.amount),
        at: one.at,
      });
    }
  }
  const sourcesOf = new Map<number, Set<number>>();
  for (const share of shares) {
    sourcesOf.set(
      share.returnId,
      (sourcesOf.get(share.returnId) ?? new Set()).add(share.moneyLogId),
    );
  }
  const sourceIds = [...new Set([...sourcesOf.values()].flatMap((ids) => [...ids]))];
  const sources = sourceIds.length
    ? await db.moneyLog.findMany({
        where: {
          OR: [
            { id: { in: sourceIds } },
            {
              coversId: { in: sourceIds },
              returnId: null,
              event: { in: ['money.refund_failed', 'money.outside'] },
            },
          ],
        },
        orderBy: { id: 'asc' },
        select: LINE_SELECT,
      })
    : [];

  const byReturn = new Map<number, ReturnMoneyLine[]>(returnIds.map((id) => [id, []]));
  for (const { returnId, amount, ...rest } of found) {
    byReturn.get(returnId!)?.push({ ...rest, amount: decimalToNumber(amount) });
  }
  // each share as the part covered of the movement written in the moment the row took it
  const kOf = new Map<number, number>();
  for (const entry of shares) {
    const lines = byReturn.get(entry.returnId)!;
    const k = kOf.get(entry.rowId) ?? 0;
    kOf.set(entry.rowId, k + 1);
    {
      // the last movement of the own money of the row (a transfer, money sent outside the app), the
      // part covered goes with it; none, the moment the row took the share
      const own =
        [...lines]
          .reverse()
          .find(
            (one) =>
              one.id > 0 &&
              one.part === 'goods' &&
              (one.event === 'money.refund' || one.event === 'money.outside') &&
              namesRow(one, entry.rowId),
          ) ?? null;
      const at = own?.createdAt ?? entry.at;
      lines.push({
        id: -(entry.rowId * 100 + k + 1),
        event: own?.event ?? 'money.refund',
        purpose: 'return',
        part: 'covered',
        amount: entry.amount,
        currency: own?.currency ?? null,
        state: own?.state ?? (own ? null : 'sent'),
        stateAt: own?.stateAt ?? at,
        createdAt: at,
        happenedAt: own?.happenedAt ?? null,
        refundId: own?.refundId ?? null,
        bankReference: null,
        byDashboard: false,
        transferKey: own?.transferKey ?? null,
        coversId: entry.moneyLogId,
        failure: null,
        failureText: null,
        method: own?.method ?? null,
        note: null,
        actorId: own?.actorId ?? null,
        orderShipmentId: null,
        meta: [{ returnItemId: entry.rowId, orderItemId: entry.orderItemId, amount: entry.amount }],
      });
    }
  }
  for (const [returnId, ids] of sourcesOf) {
    const lines = byReturn.get(returnId)!;
    for (const { returnId: _none, amount, ...rest } of sources) {
      if (ids.has(rest.id) || (rest.coversId !== null && ids.has(rest.coversId))) {
        lines.push({ ...rest, amount: decimalToNumber(amount) });
      }
    }
  }
  // in the order they were written; a part covered with its movement
  for (const lines of byReturn.values()) {
    lines.sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || Math.abs(a.id) - Math.abs(b.id),
    );
  }
  return byReturn;
}

// what money already with the buyer pays of a row by its marks (return_row_shares, db/05)
type ShareRow = {
  return_item_id: number;
  return_id: number;
  source_id: number;
  order_item_id: number | null;
  amount: string;
  at: Date;
};
type Share = {
  rowId: number;
  returnId: number;
  moneyLogId: number;
  orderItemId: number | null;
  amount: number;
  at: Date;
};

// the lines of the movement a line is part of: the parts of a transfer under its key; the parts of
// money that has no key (sent outside the app, or a transfer that money already there paid all of)
// written together with it. A failure belongs to the transfer it reversed
export function movementOf(lines: ReturnMoneyLine[], line: ReturnMoneyLine): ReturnMoneyLine[] {
  const head =
    line.event === 'money.refund_failed'
      ? (lines.find((one) => one.id === line.coversId) ?? line)
      : line;

  return lines.filter((one) =>
    head.transferKey !== null
      ? one.event === head.event && one.transferKey === head.transferKey
      : one.event === head.event &&
        one.transferKey === null &&
        one.createdAt.getTime() === head.createdAt.getTime(),
  );
}

// what the parts of a movement gave back, each above 0: the goods, the delivery, what was kept for
// the way back the buyer owes, the way back the shop paid, what money already sent another way
// paid of the rows (covered); total is what the buyer got for the rows (the goods, the delivery and
// the way back less the deduction, with what money already there paid of them)
export function sumsOf(parts: ReturnMoneyLine[]) {
  const of = (part: ReturnMoneyPart) => parts.filter((one) => one.part === part);
  const goods = -cents(sumOf(of('goods'))) || 0;
  const delivery = -cents(sumOf(of('delivery'))) || 0;
  const deduction = cents(sumOf(of('deduction')));
  const wayBack = -cents(sumOf(of('way_back'))) || 0;
  const covered = cents(sumOf(of('covered')));

  return {
    goods: goods / 100,
    delivery: delivery / 100,
    deduction: deduction / 100,
    wayBack: wayBack / 100,
    covered: covered / 100,
    total: (goods + delivery - deduction + wayBack + covered) / 100,
  };
}

// the most a transfer may still take off for the way back: what the parcel the goods came back to
// the shop in (wayBack, none without one) cost the shop less what its transfers took for it (a
// failed transfer gave its part back), never below 0. A parcel the shop sent goods it did not accept
// back to the buyer in is not the way back. begin_return_refund (db/05) holds the same bound;
// whether the buyer owes the way back at all is the caller's to say
export function deductibleOf(wayBack: number | null, lines: ReturnMoneyLine[]): number {
  const parcels =
    wayBack === null
      ? 0
      : -cents(
          sumOf(
            lines.filter((one) => one.purpose === 'shipping' && one.orderShipmentId === wayBack),
          ),
        ) || 0;
  const taken = cents(
    sumOf(lines.filter((one) => one.purpose === 'return' && one.part === 'deduction')),
  );

  return Math.max(0, parcels - taken) / 100;
}

// what the shop paid for a parcel of a statement: its first cost with the corrections; none while no
// cost was written (a cost of 0 writes no line)
export function shipmentCostOf(lines: ReturnMoneyLine[], shipmentId: number): number | null {
  const own = lines.filter(
    (one) => one.orderShipmentId === shipmentId && one.purpose === 'shipping',
  );
  return own.length ? -sumOf(own) || 0 : null;
}

// the way back the shop paid the buyer outside the app with nothing else: the last line of it, none
// before it
export const wayBackOutsideOf = (lines: ReturnMoneyLine[]): ReturnMoneyLine | null =>
  [...lines].reverse().find((one) => one.event === 'money.outside' && one.part === 'way_back') ??
  null;

// the way back a transfer of its own sent (the way back left alone), once the provider told it sent
export const wayBackSentOf = (lines: ReturnMoneyLine[], key: string): ReturnMoneyLine | null =>
  lines.find(
    (one) =>
      one.event === 'money.refund' &&
      one.part === 'way_back' &&
      one.transferKey === key &&
      one.state === 'sent',
  ) ?? null;

// whether a line names the row in its meta ([{ returnItemId, amount }])
export const namesRow = (line: ReturnMoneyLine, rowId: number): boolean =>
  Array.isArray(line.meta) &&
  (line.meta as { returnItemId?: unknown }[]).some((one) => Number(one?.returnItemId) === rowId);

// a row of a statement as its money is read: the lines of the journal name the first row, a row
// split off it (its units with a result of their own, splitFromId) goes with it
export type RowOfLines = { id: number; splitFromId: number | null };

// whether a line names the row or a row it was split off
export function namesRowOrOrigin(
  line: ReturnMoneyLine,
  rows: readonly RowOfLines[],
  rowId: number,
): boolean {
  const byId = new Map(rows.map((one) => [one.id, one]));
  let id: number | null = rowId;
  for (let n = 0; id !== null && n < 100; n += 1) {
    if (namesRow(line, id)) return true;
    id = byId.get(id)?.splitFromId ?? null;
  }
  return false;
}

// the line of the last money of a row (no row names one): while it is failed, the last failure of
// its goods; else the last line of its goods that went and did not fail (a transfer, money sent
// outside the app), or the part covered of money already with the buyer when only that paid it
export function lastLineOfRow(
  lines: readonly ReturnMoneyLine[],
  rows: readonly RowOfLines[],
  row: RowOfLines & { money: ReturnMoney },
): ReturnMoneyLine | null {
  const goods = lines.filter(
    (one) => one.id > 0 && one.part === 'goods' && namesRowOrOrigin(one, rows, row.id),
  );
  if (row.money === 'failed') {
    return goods.filter((one) => one.event === 'money.refund_failed').at(-1) ?? null;
  }
  const failed = new Set(
    lines.filter((one) => one.event === 'money.refund_failed').map((one) => one.coversId),
  );
  return (
    goods
      .filter(
        (one) =>
          (one.event === 'money.refund' || one.event === 'money.outside') && !failed.has(one.id),
      )
      .at(-1) ??
    lines.find((one) => one.part === 'covered' && namesRow(one, row.id)) ??
    null
  );
}

// what each row of a statement has had of its money (the card: "paid X of Y"): the goods of its
// transfers, sent or on their way, and of the money sent outside the app, [{ returnItemId, amount }]
// in the meta; a failure takes its part back; and what money already with the buyer paid of it (its
// part covered, but the delivery). A row is paid in parts when the payment held only some of it
// (the rest went outside the app, or money already there paid some); a row without any is not in
// the map
export function rowPaidOf(lines: ReturnMoneyLine[]): Map<number, number> {
  const cents = new Map<number, number>();

  for (const line of lines) {
    const covered = line.part === 'covered';
    if (
      !covered &&
      (line.purpose !== 'return' || line.part !== 'goods' || !ROW_PART_EVENTS.has(line.event))
    ) {
      continue;
    }
    if (!Array.isArray(line.meta)) continue;

    const sign = line.event === 'money.refund_failed' && !covered ? -1 : 1;
    for (const element of line.meta as {
      returnItemId?: unknown;
      orderItemId?: unknown;
      amount?: unknown;
    }[]) {
      if (covered && element?.orderItemId === null) continue;
      const rowId = Number(element?.returnItemId);
      const amount = Number(element?.amount);
      if (!Number.isInteger(rowId) || !Number.isFinite(amount)) continue;
      cents.set(rowId, (cents.get(rowId) ?? 0) + sign * Math.round(amount * 100));
    }
  }

  return new Map([...cents].map(([rowId, paid]) => [rowId, paid / 100 || 0]));
}

// the parts of a movement that name the row they go with in the meta: the delivery and the
// deduction for the way back go with the last row of the transfer or of the money sent outside the
// app, [{ returnItemId, amount }]
const ROW_PART_EVENTS = new Set(['money.refund', 'money.refund_failed', 'money.outside']);

// what each row of a statement got with its money now: its share of the delivery and the deduction
// for the way back, each above 0. A transfer names them, its failure takes them back, money sent
// outside the app after it names them again. A row without either is not in the map
export function rowSharesOf(
  lines: ReturnMoneyLine[],
): Map<number, { delivery: number; deduction: number }> {
  const cents = new Map<number, { delivery: number; deduction: number }>();

  for (const line of lines) {
    if (line.purpose !== 'return' || !ROW_PART_EVENTS.has(line.event)) continue;
    if (line.part !== 'delivery' && line.part !== 'deduction') continue;
    if (!Array.isArray(line.meta)) continue;

    // the delivery goes from the shop (below 0), the deduction stays with it (above 0); a failure
    // is the opposite line
    const sign = line.part === 'delivery' ? -Math.sign(line.amount) : Math.sign(line.amount);
    for (const element of line.meta as { returnItemId?: unknown; amount?: unknown }[]) {
      const rowId = Number(element?.returnItemId);
      const amount = Number(element?.amount);
      if (!Number.isInteger(rowId) || !Number.isFinite(amount)) continue;

      const share = cents.get(rowId) ?? { delivery: 0, deduction: 0 };
      share[line.part] += sign * Math.round(amount * 100);
      cents.set(rowId, share);
    }
  }

  return new Map(
    [...cents].map(([rowId, share]) => [
      rowId,
      { delivery: share.delivery / 100 || 0, deduction: share.deduction / 100 || 0 },
    ]),
  );
}

// when the money of a line went, as the buyer is told it: a refund when it was told sent (asked,
// while it is still on its way), money sent outside the app on the day it really went
export function sentAtOf(line: ReturnMoneyLine | null): string | null {
  if (!line) return null;
  if (line.event === 'money.outside') return (line.happenedAt ?? line.createdAt).toISOString();
  return (line.state === 'sent' ? (line.stateAt ?? line.createdAt) : line.createdAt).toISOString();
}
