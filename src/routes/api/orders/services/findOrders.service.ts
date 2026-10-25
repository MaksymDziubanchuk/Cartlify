import { prisma } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { toCsv, type CsvColumn } from '@helpers/csv.js';
import { InternalError, isAppError } from '@utils/errors.js';

import {
  freshenUnconfirmedOrders,
  mapOrderRowToResponse,
  expiredOfOrders,
  orderResponseSelect,
  normalizeFindOrdersInput,
  buildOrdersWhere,
  buildOrdersCursorWhere,
  buildOrdersOrderBy,
  makeNextOrdersCursor,
} from './helpers/index.js';

import type { FindOrdersDto, GetOrdersResponseDto, OrderBuyerDto } from 'types/dto/orders.dto.js';
import type { UserId } from 'types/ids.js';

// the buyer an admin sees in each row; a deleted account keeps its id and the name Guest
const buyerSelect = {
  user: { select: { id: true, name: true, email: true, deletedAt: true } },
} as const;

const buyerOf = (user: {
  id: number;
  name: string | null;
  email: string;
  deletedAt: Date | null;
}): OrderBuyerDto => ({
  id: user.id as UserId,
  name: user.name,
  email: user.deletedAt ? null : user.email,
  deleted: user.deletedAt !== null,
});

const whereOf = (q: ReturnType<typeof normalizeFindOrdersInput>) =>
  buildOrdersWhere({
    actorId: q.actorId,
    actorRole: q.actorRole,
    status: q.status,
    statuses: q.statuses,
    confirmed: q.confirmed,
    paidFrom: q.paidFrom,
    paidTo: q.paidTo,
    updatedFrom: q.updatedFrom,
    updatedTo: q.updatedTo,
    userId: q.userId,
    productId: q.productId,
    q: q.q,
    sortBy: q.sortBy,
  });

export async function findOrders(dto: FindOrdersDto): Promise<GetOrdersResponseDto> {
  const q = normalizeFindOrdersInput(dto);
  const { actorId, actorRole, limit, cursor, sortBy, sortDir } = q;
  const isAdmin = actorRole === 'ADMIN' || actorRole === 'ROOT';

  const baseWhere = whereOf(q);
  const cursorWhere = buildOrdersCursorWhere({ sortBy, sortDir, cursor });

  const where = cursorWhere ? { AND: [baseWhere, cursorWhere] } : baseWhere;
  const orderBy = buildOrdersOrderBy(sortBy, sortDir);

  try {
    return await prisma.$transaction(async (tx) => {
      // set rls session context
      await setUserContext(tx, { userId: actorId, role: actorRole });

      // unconfirmed orders of the user show current prices and no deleted products, paid ones
      // keep the prices they were paid with: a confirmed order never changes its items
      if (actorRole === 'USER') await freshenUnconfirmedOrders(tx, Number(actorId));

      const rows = await tx.order.findMany({
        where,
        orderBy,
        take: limit + 1,
        select: { ...orderResponseSelect, ...buyerSelect },
      });

      const total = await tx.order.count({ where: baseWhere });

      const hasNext = rows.length > limit;
      const pageRows = hasNext ? rows.slice(0, limit) : rows;

      const expired = await expiredOfOrders(tx, pageRows);

      const nextCursor =
        hasNext && pageRows.length
          ? makeNextOrdersCursor(sortBy, pageRows[pageRows.length - 1], sortDir)
          : null;

      return {
        // an admin sees who bought each order
        items: pageRows.map(({ user, ...row }) => ({
          ...mapOrderRowToResponse(row, expired),
          ...(isAdmin ? { buyer: buyerOf(user) } : {}),
        })),
        limit,
        nextCursor,
        total,
      };
    });
  } catch (err) {
    if (isAppError(err)) throw err;
    throw new InternalError({ reason: 'ORDERS_LIST_UNEXPECTED' }, err);
  }
}

type CsvOrder = {
  id: number;
  status: string;
  paidAt: Date | null;
  total: unknown;
  shippingAddress: string | null;
  recipientFirstName: string | null;
  recipientLastName: string | null;
  recipientPhone: string | null;
  user: { email: string; deletedAt: Date | null };
  items: { quantity: number; productName: string | null; product: { name: string } }[];
};

// a line for each order to pack and hand to the courier: the buyer, the recipient, where to, what
const CSV_COLUMNS: CsvColumn<CsvOrder>[] = [
  { header: 'Order', kind: 'number', value: (row) => row.id },
  { header: 'Status', kind: 'text', value: (row) => row.status },
  { header: 'Paid at', kind: 'text', value: (row) => row.paidAt?.toISOString() },
  {
    header: 'Buyer email',
    kind: 'text',
    value: (row) => (row.user.deletedAt ? null : row.user.email),
  },
  {
    header: 'Recipient',
    kind: 'text',
    value: (row) => [row.recipientFirstName, row.recipientLastName].filter(Boolean).join(' '),
  },
  { header: 'Phone', kind: 'text', value: (row) => row.recipientPhone },
  { header: 'Address', kind: 'text', value: (row) => row.shippingAddress },
  {
    header: 'Items',
    kind: 'text',
    // the name an item was confirmed with
    value: (row) =>
      row.items
        .map((item) => `${item.productName ?? item.product.name} x ${item.quantity}`)
        .join('; '),
  },
  { header: 'Total', kind: 'money', value: (row) => Number(row.total) },
];

// every order of the filters as a csv file, in the order of the sort, without pages (admin and
// root only: normalizeFindOrdersInput refuses the format to a buyer)
export async function findOrdersCsv(
  dto: FindOrdersDto,
): Promise<{ fileName: string; body: string }> {
  const q = normalizeFindOrdersInput(dto);

  try {
    const rows = await prisma.$transaction(async (tx) => {
      await setUserContext(tx, { userId: q.actorId, role: q.actorRole });

      return tx.order.findMany({
        where: whereOf(q),
        orderBy: buildOrdersOrderBy(q.sortBy, q.sortDir),
        select: {
          id: true,
          status: true,
          paidAt: true,
          total: true,
          shippingAddress: true,
          recipientFirstName: true,
          recipientLastName: true,
          recipientPhone: true,
          user: { select: { email: true, deletedAt: true } },
          items: {
            orderBy: { id: 'asc' },
            select: { quantity: true, productName: true, product: { select: { name: true } } },
          },
        },
      });
    });

    return {
      fileName: `cartlify-orders-${new Date().toISOString().slice(0, 10)}.csv`,
      body: toCsv(CSV_COLUMNS, rows),
    };
  } catch (err) {
    if (isAppError(err)) throw err;
    throw new InternalError({ reason: 'ORDERS_CSV_UNEXPECTED' }, err);
  }
}
