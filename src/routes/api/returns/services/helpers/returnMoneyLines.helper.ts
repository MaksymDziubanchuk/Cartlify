import { decimalToNumber } from '@helpers/safeNormalizer.js';

import type {
  MoneyPart,
  MoneyPurpose,
  MoneyState,
  OutsideMethod,
  Prisma,
  RefundFailure,
} from '@prisma/client';

// The money of the statements of return, read from their lines of the money journal (db/05,
// money_log): the statement and its rows keep only where the money stands (returns.refundedTotal,
// return_items.money and the line that put it there), the movement itself is the lines. A transfer
// is written in parts under one key (the goods, the delivery, the deduction for the way back the
// buyer owes, the way back the shop pays, what money already sent another way covered), money sent
// outside the app in parts written together, a
// failure is new lines with the opposite sums; what the shop paid a carrier for a parcel back is a
// line of the parcel with its corrections

export type ReturnMoneyLine = {
  id: number;
  event: string;
  purpose: MoneyPurpose;
  part: MoneyPart;
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

// the lines of the statements, oldest first. The money already with the buyer that the parts covered
// of a statement took (a refund made by hand, what a bank gave for a dispute: lines of the order,
// not of a statement) comes with it, and so does what became of that money (its failure, money root
// sent another way instead), so each statement tells the whole of its money
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

  // the sources each statement took money of
  const sourcesOf = new Map<number, Set<number>>();
  for (const line of found) {
    if (line.part !== 'covered' || line.event === 'money.refund_failed' || line.coversId === null) {
      continue;
    }
    sourcesOf.set(line.returnId!, (sourcesOf.get(line.returnId!) ?? new Set()).add(line.coversId));
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
  for (const [returnId, ids] of sourcesOf) {
    const lines = byReturn.get(returnId)!;
    for (const { returnId: _none, amount, ...rest } of sources) {
      if (ids.has(rest.id) || (rest.coversId !== null && ids.has(rest.coversId))) {
        lines.push({ ...rest, amount: decimalToNumber(amount) });
      }
    }
    lines.sort((a, b) => a.id - b.id);
  }
  return byReturn;
}

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
// covered; total is what the buyer got (the goods, the delivery and the way back less the
// deduction), the covered part with it
export function sumsOf(parts: ReturnMoneyLine[]) {
  const of = (part: MoneyPart) => parts.filter((one) => one.part === part);
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
    total: (goods + delivery - deduction + wayBack) / 100,
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

// what each row of a statement has had of its money (the card: "paid X of Y"): the goods of its
// transfers, sent or on their way, and of the money sent outside the app, [{ returnItemId, amount }]
// in the meta; a failure takes its part back. A row is paid in parts when the payment held only
// some of it (the rest went outside the app); a row without any is not in the map
export function rowPaidOf(lines: ReturnMoneyLine[]): Map<number, number> {
  const cents = new Map<number, number>();

  for (const line of lines) {
    if (line.purpose !== 'return' || line.part !== 'goods' || !ROW_PART_EVENTS.has(line.event)) {
      continue;
    }
    if (!Array.isArray(line.meta)) continue;

    const sign = line.event === 'money.refund_failed' ? -1 : 1;
    for (const element of line.meta as { returnItemId?: unknown; amount?: unknown }[]) {
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
