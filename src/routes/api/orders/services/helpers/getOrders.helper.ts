import { DELIVERY_METHOD_NAMES } from '@config/deliveryMethods.js';
import {
  cursorDate,
  cursorNumber,
  cursorString,
  decodeCursor,
  encodeCursor,
} from '@helpers/codeCursor.js';
import { assertLimit } from '@helpers/assertLimit.js';
import { decimalToNumber } from '@helpers/safeNormalizer.js';
import { MAX_ID } from '@schemas/idPathParam.js';
import { BadRequestError, ForbiddenError } from '@utils/errors.js';

import type { Prisma, PrismaClient } from '@prisma/client';
import type { FindOrdersDto, OrdersSortBy, OrdersSortDir } from 'types/dto/orders.dto.js';
import type { UserId } from 'types/ids.js';
import type { Role } from 'types/user.js';

// the statuses of the list: the cart (pending) is not an order, the list never has it
const LIST_STATUSES = ['waiting', 'unconfirmed', 'paid', 'shipped', 'delivered', 'cancelled'];

const isAdminRole = (role: Role) => role === 'ADMIN' || role === 'ROOT';

// normalize dto for findOrders; the filters of the desk of an admin (a buyer, the text of a
// buyer or a recipient, the csv) are FILTER_FORBIDDEN for a buyer, who sees only their own orders
export function normalizeFindOrdersInput(dto: FindOrdersDto) {
  const limit = assertLimit(dto.limit ?? 20);

  if (!isAdminRole(dto.actorRole)) {
    for (const filter of [
      'userId',
      'q',
      'format',
      'deliveryMethod',
      'country',
      'carrier',
      'shippedWithoutNumber',
      'deliveryCharged',
      'withoutWeight',
      'shippingCostMissing',
      'shippedTo',
    ] as const) {
      if (dto[filter] !== undefined) throw new ForbiddenError('FILTER_FORBIDDEN', { filter });
    }
  }

  // a few statuses, separated by commas
  const statuses = dto.statuses
    ? [...new Set(dto.statuses.split(',').map((status) => status.trim()))]
    : undefined;
  if (statuses?.some((status) => !LIST_STATUSES.includes(status))) {
    throw new BadRequestError('STATUS_INVALID');
  }

  const q = typeof dto.q === 'string' && dto.q.trim() ? dto.q.trim() : undefined;

  // newest first by default, whatever the status; the orders whose send has no cost written go by
  // the send that waits longest, the oldest first, unless the admin sorts otherwise
  const costMissing = dto.shippingCostMissing === true;
  const sortBy: OrdersSortBy = (dto.sortBy ??
    (costMissing ? 'shippingCostMissingSince' : 'createdAt')) as OrdersSortBy;
  const sortDir: OrdersSortDir =
    dto.sortDir === 'asc' || dto.sortDir === 'desc'
      ? dto.sortDir
      : sortBy === 'shippingCostMissingSince'
        ? 'asc'
        : 'desc';
  // the sort goes by the sends the filter finds: without it most orders would have no such time
  if (sortBy === 'shippingCostMissingSince' && !costMissing) {
    throw new BadRequestError('SORT_SHIPPING_COST_MISSING_REQUIRES_FILTER');
  }

  const cursor =
    typeof dto.cursor === 'string' && dto.cursor.trim() ? dto.cursor.trim() : undefined;
  // the cart is not an order, the list never has it
  if (dto.status)
    if (
      !['waiting', 'unconfirmed', 'paid', 'shipped', 'delivered', 'cancelled'].includes(dto.status)
    )
      throw new BadRequestError('STATUS_INVALID');

  const status = dto.status;
  const confirmed = typeof dto.confirmed === 'boolean' ? dto.confirmed : undefined;

  // the period takes its start and stops before its end: an end at its start holds nothing
  const { paidFrom, paidTo } = dto;
  if (paidFrom && paidTo && paidFrom.getTime() >= paidTo.getTime()) {
    throw new BadRequestError('PAID_PERIOD_INVALID');
  }

  // the same for the period of the last change
  const { updatedFrom, updatedTo } = dto;
  if (updatedFrom && updatedTo && updatedFrom.getTime() >= updatedTo.getTime()) {
    throw new BadRequestError('UPDATED_PERIOD_INVALID');
  }

  return {
    actorId: dto.actorId,
    actorRole: dto.actorRole,
    limit,
    cursor,
    status,
    statuses,
    confirmed,
    paidFrom,
    paidTo,
    updatedFrom,
    updatedTo,
    userId: dto.userId,
    productId: dto.productId,
    q,
    // the delivery filters of the desk; the schema holds the form of the lists
    deliveryMethod: dto.deliveryMethod ? dto.deliveryMethod.split(',') : undefined,
    country: dto.country ? dto.country.split(',') : undefined,
    carrier: dto.carrier?.trim() || undefined,
    shippedWithoutNumber: dto.shippedWithoutNumber,
    deliveryCharged: dto.deliveryCharged,
    withoutWeight: dto.withoutWeight,
    shippingCostMissing: dto.shippingCostMissing,
    shippedTo: dto.shippedTo,
    sortBy,
    sortDir,
  };
}

// the text an admin looks for: a whole number is the number of an order, or a postal code or a
// tracking number written in digits; any other text a part of the email of the buyer, the name or
// the phone of the recipient, the city or the postal code of the address, or a tracking number
function searchWhereOf(q: string) {
  // prisma puts the text into a LIKE pattern as it is: % and _ are wildcards there and \ is the
  // escape of postgres, so each of them gets a \ in front
  const part = { contains: q.replace(/[\\%_]/g, '\\$&'), mode: 'insensitive' as const };

  if (/^[1-9][0-9]*$/.test(q) && Number(q) <= MAX_ID) {
    return {
      OR: [
        { id: Number(q) },
        { delivery: { is: { postalCode: part } } },
        { shipments: { some: { trackingNumber: part } } },
      ],
    };
  }

  return {
    OR: [
      { user: { email: part } },
      { delivery: { is: { recipientFirstName: part } } },
      { delivery: { is: { recipientLastName: part } } },
      { delivery: { is: { recipientPhone: part } } },
      { delivery: { is: { city: part } } },
      { delivery: { is: { postalCode: part } } },
      { shipments: { some: { trackingNumber: part } } },
    ],
  };
}

// build base where
export function buildOrdersWhere(args: {
  actorId: UserId;
  actorRole: Role;
  status?: string | undefined;
  statuses?: string[] | undefined;
  confirmed?: boolean | undefined;
  paidFrom?: Date | undefined;
  paidTo?: Date | undefined;
  updatedFrom?: Date | undefined;
  updatedTo?: Date | undefined;
  userId?: number | undefined;
  productId?: number | undefined;
  q?: string | undefined;
  deliveryMethod?: string[] | undefined;
  country?: string[] | undefined;
  carrier?: string | undefined;
  shippedWithoutNumber?: boolean | undefined;
  deliveryCharged?: boolean | undefined;
  withoutWeight?: boolean | undefined;
  shippingCostMissing?: boolean | undefined;
  shippedTo?: Date | undefined;
  sortBy: OrdersSortBy;
}) {
  const where: any = {};
  if (args.actorRole === 'USER') where.userId = args.actorId;
  else if (args.userId !== undefined) where.userId = args.userId;

  // the cart is not an order, the list never has it; status and statuses are both kept
  const status = args.status ? args.status : { not: 'pending' };
  where.status = args.statuses ? { in: args.statuses } : status;
  if (args.statuses && args.status) where.AND = [{ status: args.status }];
  if (args.productId !== undefined) where.items = { some: { productId: args.productId } };
  if (args.q) Object.assign(where, searchWhereOf(args.q));
  if (args.confirmed !== undefined) where.confirmed = args.confirmed;

  // the delivery of the order: its method and country, its price, who carries it; an AND of the
  // parts, each one a condition of the delivery or of its sends
  const and: any[] = [];
  if (args.deliveryMethod) and.push({ delivery: { is: { method: { in: args.deliveryMethod } } } });
  if (args.country) and.push({ delivery: { is: { country: { in: args.country } } } });
  if (args.deliveryCharged !== undefined) {
    and.push({
      delivery: { is: { price: args.deliveryCharged ? { gt: 0 } : { equals: 0 } } },
    });
  }
  // the send on its way is the one that was not rolled back
  if (args.carrier) {
    const part = {
      contains: args.carrier.replace(/[\\%_]/g, '\\$&'),
      mode: 'insensitive' as const,
    };
    and.push({ shipments: { some: { rolledBackAt: null, carrier: part } } });
  }
  if (args.shippedWithoutNumber) {
    and.push({
      status: 'shipped',
      shipments: { some: { rolledBackAt: null, trackingNumber: null } },
    });
  }
  if (args.withoutWeight) {
    and.push({ items: { some: { product: { weightGrams: null } } } });
  }
  // a send whose cost the shop has not written, one it owes something for, and one sent before a
  // time: the parts are about the same send
  if (args.shippingCostMissing || args.shippedTo) {
    and.push({
      shipments: {
        some: {
          ...(args.shippingCostMissing ? { expense: true, cost: null } : {}),
          ...(args.shippedTo ? { shippedAt: { lt: args.shippedTo } } : {}),
        },
      },
    });
  }
  if (args.sortBy === 'deliveryMethod' || args.sortBy === 'deliveryPrice') {
    and.push({ delivery: { isNot: null } });
  }
  if (args.sortBy === 'destination') and.push({ delivery: { is: { country: { not: null } } } });
  if (and.length) where.AND = [...(where.AND ?? []), ...and];

  // an order that is not paid has no time of payment: no place in its sort or in its period
  const paidAt = {
    ...(args.sortBy === 'paidAt' ? { not: null } : {}),
    ...(args.paidFrom ? { gte: args.paidFrom } : {}),
    ...(args.paidTo ? { lt: args.paidTo } : {}),
  };
  if (Object.keys(paidAt).length) where.paidAt = paidAt;

  // the time of the last change of an order: a shipped one has not moved since it was shipped
  const updatedAt = {
    ...(args.updatedFrom ? { gte: args.updatedFrom } : {}),
    ...(args.updatedTo ? { lt: args.updatedTo } : {}),
  };
  if (Object.keys(updatedAt).length) where.updatedAt = updatedAt;

  return where;
}

// The orders of the filters by the oldest send of each that the shop owes the carrier for and has
// written no cost of, the order id breaking ties in the same direction; the ids after the cursor
// (a page is cut from them). Prisma does not sort by a value of many rows: the ids the filters find
// are read first, then the time of each from its sends
export async function ordersByMissingCost(
  db: Pick<PrismaClient, 'order' | '$queryRaw'> | Prisma.TransactionClient,
  where: Prisma.OrderWhereInput,
  sortDir: OrdersSortDir,
  cursor?: string,
): Promise<{ ids: number[]; total: number; since: Map<number, Date> }> {
  const found = await db.order.findMany({ where, select: { id: true } });
  if (found.length === 0) return { ids: [], total: 0, since: new Map() };

  const rows = await db.$queryRaw<{ id: number; since: Date }[]>`
    select s."orderId" as id, min(s."shippedAt") as since
    from cartlify.order_shipments as s
    where s.expense and s.cost is null and s."orderId" = any(${found.map((row) => row.id)}::int[])
    group by s."orderId"`;
  const since = new Map(rows.map((row) => [row.id, row.since]));

  const sign = sortDir === 'asc' ? 1 : -1;
  const keyOf = (id: number) => since.get(id)?.getTime() ?? Number.MAX_SAFE_INTEGER;
  const compare = (aKey: number, aId: number, bKey: number, bId: number) =>
    sign * (aKey - bKey || aId - bId);
  const ids = found.map((row) => row.id).sort((a, b) => compare(keyOf(a), a, keyOf(b), b));

  if (!cursor) return { ids, total: ids.length, since };

  // the cursor holds the time of the last order of the page and its id, for this sort and direction
  const { id, v, s } = decodeCursor(cursor) as { id: number; v?: unknown; s?: unknown };
  if (s !== `shippingCostMissingSince:${sortDir}`) throw new BadRequestError('CURSOR_INVALID');
  const at = cursorDate(v as string);

  return {
    ids: ids.filter((one) => compare(keyOf(one), one, at.getTime(), id) > 0),
    total: ids.length,
    since,
  };
}

// the cursor after the last order of a page sorted by the oldest send without a cost
export const makeMissingCostCursor = (lastId: number, since: Date, sortDir: OrdersSortDir) =>
  encodeCursor({
    id: lastId,
    v: since.toISOString(),
    s: `shippingCostMissingSince:${sortDir}`,
  } as never);

// build stable orderBy
export function buildOrdersOrderBy(sortBy: OrdersSortBy, sortDir: OrdersSortDir) {
  if (sortBy === 'createdAt') return [{ createdAt: sortDir }, { id: sortDir }];
  if (sortBy === 'updatedAt') return [{ updatedAt: sortDir }, { id: sortDir }];
  if (sortBy === 'paidAt') return [{ paidAt: sortDir }, { id: sortDir }];
  if (sortBy === 'total') return [{ total: sortDir }, { id: sortDir }];
  if (sortBy === 'deliveryMethod') return [{ delivery: { method: sortDir } }, { id: sortDir }];
  if (sortBy === 'deliveryPrice') return [{ delivery: { price: sortDir } }, { id: sortDir }];
  // destination: the country, the city, then the order
  return [{ delivery: { country: sortDir } }, { delivery: { city: sortDir } }, { id: sortDir }];
}

// build keyset cursor where
export function buildOrdersCursorWhere(args: {
  sortBy: OrdersSortBy;
  sortDir: OrdersSortDir;
  cursor?: string | undefined;
}) {
  if (!args.cursor) return undefined;

  // a cursor of another sort or direction would start the page from an order of another order
  const { id, v, s } = decodeCursor(args.cursor) as {
    id: number;
    v: string | number | null;
    s?: unknown;
  };
  if (s !== `${args.sortBy}:${args.sortDir}`) throw new BadRequestError('CURSOR_INVALID');
  const op = args.sortDir === 'asc' ? 'gt' : 'lt';

  // the method of the delivery, a name of the enum: the database orders the names as the enum
  // declares them, prisma compares an enum only for equality, so the names after or before the
  // one of the cursor are listed
  if (args.sortBy === 'deliveryMethod') {
    const val = cursorString(v);
    const at = (DELIVERY_METHOD_NAMES as readonly string[]).indexOf(val);
    if (at < 0) throw new BadRequestError('CURSOR_INVALID');
    const further =
      args.sortDir === 'asc'
        ? DELIVERY_METHOD_NAMES.slice(at + 1)
        : DELIVERY_METHOD_NAMES.slice(0, at);
    return {
      OR: [
        { delivery: { is: { method: { in: [...further] } } } },
        { AND: [{ delivery: { is: { method: val } } }, { id: { [op]: id } }] },
      ],
    };
  }

  // the price of the delivery
  if (args.sortBy === 'deliveryPrice') {
    const num = cursorNumber(v);
    return {
      OR: [
        { delivery: { is: { price: { [op]: num } } } },
        { AND: [{ delivery: { is: { price: num } } }, { id: { [op]: id } }] },
      ],
    };
  }

  // the country and the city of the address, kept in the cursor as one text
  if (args.sortBy === 'destination') {
    const [country, city] = cursorString(v).split('\u0001');
    if (country === undefined || city === undefined) throw new BadRequestError('CURSOR_INVALID');
    return {
      OR: [
        { delivery: { is: { country: { [op]: country } } } },
        {
          AND: [{ delivery: { is: { country } } }, { delivery: { is: { city: { [op]: city } } } }],
        },
        {
          AND: [
            { delivery: { is: { country } } },
            { delivery: { is: { city } } },
            { id: { [op]: id } },
          ],
        },
      ],
    };
  }

  // date sorts
  if (args.sortBy === 'createdAt') {
    const val = cursorDate(v);
    return {
      OR: [{ createdAt: { [op]: val } }, { AND: [{ createdAt: val }, { id: { [op]: id } }] }],
    };
  }

  if (args.sortBy === 'updatedAt') {
    const val = cursorDate(v);
    return {
      OR: [{ updatedAt: { [op]: val } }, { AND: [{ updatedAt: val }, { id: { [op]: id } }] }],
    };
  }

  if (args.sortBy === 'paidAt') {
    const val = cursorDate(v);
    return {
      OR: [{ paidAt: { [op]: val } }, { AND: [{ paidAt: val }, { id: { [op]: id } }] }],
    };
  }

  // numeric sort (total)
  const num = cursorNumber(v);
  return {
    OR: [{ total: { [op]: num } }, { AND: [{ total: num }, { id: { [op]: id } }] }],
  };
}

// build next cursor from last row, with its sort and direction
export function makeNextOrdersCursor(
  sortBy: OrdersSortBy,
  last: any,
  sortDir: OrdersSortDir,
): string {
  let v: string | number;

  if (sortBy === 'createdAt') v = new Date(last.createdAt).toISOString();
  else if (sortBy === 'updatedAt') v = new Date(last.updatedAt).toISOString();
  else if (sortBy === 'paidAt') v = new Date(last.paidAt).toISOString();
  else if (sortBy === 'deliveryMethod') v = String(last.delivery?.method ?? '');
  else if (sortBy === 'deliveryPrice') v = decimalToNumber(last.delivery?.price ?? 0);
  else if (sortBy === 'destination')
    v = `${last.delivery?.country ?? ''}\u0001${last.delivery?.city ?? ''}`;
  else v = decimalToNumber(last.total);

  return encodeCursor({ id: last.id, v, s: `${sortBy}:${sortDir}` } as never);
}
