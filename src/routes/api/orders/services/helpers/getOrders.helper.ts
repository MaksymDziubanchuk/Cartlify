import {
  cursorDate,
  cursorNumber,
  cursorString,
  decodeCursor,
  encodeCursor,
} from '@helpers/codeCursor.js';
import { assertLimit } from '@helpers/assertLimit.js';
import { decimalToNumber } from '@helpers/safeNormalizer.js';
import { BadRequestError } from '@utils/errors.js';

import type { FindOrdersDto, OrdersSortBy, OrdersSortDir } from 'types/dto/orders.dto.js';
import type { UserId } from 'types/ids.js';
import type { Role } from 'types/user.js';

// normalize dto for findOrders
export function normalizeFindOrdersInput(dto: FindOrdersDto) {
  const limit = assertLimit(dto.limit ?? 20);

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

  return {
    actorId: dto.actorId,
    actorRole: dto.actorRole,
    limit,
    cursor,
    status,
    confirmed,
    sortBy,
    sortDir,
  };
}

// build base where
export function buildOrdersWhere(args: {
  actorId: UserId;
  actorRole: Role;
  status?: string | undefined;
  confirmed?: boolean | undefined;
  sortBy: OrdersSortBy;
}) {
  const where: any = {};
  if (args.actorRole === 'USER') where.userId = args.actorId;

  // the cart is not an order, the list never has it
  where.status = args.status ? args.status : { not: 'pending' };
  if (args.confirmed !== undefined) where.confirmed = args.confirmed;

  if (args.sortBy === 'shippingAddress') where.shippingAddress = { not: null };

  return where;
}

// build stable orderBy
export function buildOrdersOrderBy(sortBy: OrdersSortBy, sortDir: OrdersSortDir) {
  if (sortBy === 'createdAt') return [{ createdAt: sortDir }, { id: sortDir }];
  if (sortBy === 'updatedAt') return [{ updatedAt: sortDir }, { id: sortDir }];
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

  const { id, v } = decodeCursor(args.cursor);
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

  // numeric sort (total)
  const num = cursorNumber(v);
  return {
    OR: [{ total: { [op]: num } }, { AND: [{ total: num }, { id: { [op]: id } }] }],
  };
}

// build next cursor from last row
export function makeNextOrdersCursor(sortBy: OrdersSortBy, last: any): string {
  let v: string | number;

  if (sortBy === 'createdAt') v = new Date(last.createdAt).toISOString();
  else if (sortBy === 'updatedAt') v = new Date(last.updatedAt).toISOString();
  else if (sortBy === 'shippingAddress') v = String(last.shippingAddress ?? '');
  else v = decimalToNumber(last.total);

  return encodeCursor({ id: last.id, v });
}
