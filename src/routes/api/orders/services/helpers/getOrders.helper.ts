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
    for (const filter of ['userId', 'q', 'format'] as const) {
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

  // newest first by default, whatever the status
  const sortBy: OrdersSortBy = (dto.sortBy ?? 'createdAt') as OrdersSortBy;
  const sortDir: OrdersSortDir = dto.sortDir === 'asc' ? 'asc' : 'desc';

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
    sortBy,
    sortDir,
  };
}

// the text an admin looks for: a whole number is the number of an order, any other text a part of
// the email of the buyer, the name or the phone of the recipient
function searchWhereOf(q: string) {
  if (/^[1-9][0-9]*$/.test(q) && Number(q) <= MAX_ID) return { id: Number(q) };

  // prisma puts the text into a LIKE pattern as it is: % and _ are wildcards there and \ is the
  // escape of postgres, so each of them gets a \ in front
  const part = { contains: q.replace(/[\\%_]/g, '\\$&'), mode: 'insensitive' as const };
  return {
    OR: [
      { user: { email: part } },
      { recipientFirstName: part },
      { recipientLastName: part },
      { recipientPhone: part },
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

  if (args.sortBy === 'shippingAddress') where.shippingAddress = { not: null };

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

// build stable orderBy
export function buildOrdersOrderBy(sortBy: OrdersSortBy, sortDir: OrdersSortDir) {
  if (sortBy === 'createdAt') return [{ createdAt: sortDir }, { id: sortDir }];
  if (sortBy === 'updatedAt') return [{ updatedAt: sortDir }, { id: sortDir }];
  if (sortBy === 'paidAt') return [{ paidAt: sortDir }, { id: sortDir }];
  if (sortBy === 'total') return [{ total: sortDir }, { id: sortDir }];
  return [{ shippingAddress: sortDir }, { id: sortDir }];
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

  // string sort
  if (args.sortBy === 'shippingAddress') {
    const val = cursorString(v);
    return {
      OR: [
        { shippingAddress: { [op]: val } },
        { AND: [{ shippingAddress: val }, { id: { [op]: id } }] },
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
  else if (sortBy === 'shippingAddress') v = String(last.shippingAddress ?? '');
  else v = decimalToNumber(last.total);

  return encodeCursor({ id: last.id, v, s: `${sortBy}:${sortDir}` } as never);
}
