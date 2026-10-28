import { prisma } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { toCsv, type CsvColumn } from '@helpers/csv.js';
import { InternalError, isAppError } from '@utils/errors.js';

import {
  freshenUnconfirmedOrders,
  mapOrderRowToResponse,
  expiredOfOrders,
  orderResponseSelect,
  withDeliveryAndSends,
  normalizeFindOrdersInput,
  buildOrdersWhere,
  buildOrdersCursorWhere,
  buildOrdersOrderBy,
  makeNextOrdersCursor,
  makeMissingCostCursor,
  ordersByMissingCost,
} from './helpers/index.js';

import type { FindOrdersDto, GetOrdersResponseDto, OrderBuyerDto } from 'types/dto/orders.dto.js';
import type { UserId } from 'types/ids.js';

// the buyer an admin sees in each row; a deleted account keeps its id and the name Guest
const buyerSelect = { id: true, name: true, email: true, deletedAt: true } as const;

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
    deliveryMethod: q.deliveryMethod,
    country: q.country,
    carrier: q.carrier,
    shippedWithoutNumber: q.shippedWithoutNumber,
    deliveryCharged: q.deliveryCharged,
    withoutWeight: q.withoutWeight,
    shippingCostMissing: q.shippingCostMissing,
    shippedTo: q.shippedTo,
    sortBy: q.sortBy,
  });

export async function findOrders(dto: FindOrdersDto): Promise<GetOrdersResponseDto> {
  const q = normalizeFindOrdersInput(dto);
  const { actorId, actorRole, limit, cursor, sortBy, sortDir } = q;
  const isAdmin = actorRole === 'ADMIN' || actorRole === 'ROOT';

  const baseWhere = whereOf(q);
  // the oldest send without a cost is a value of many rows: that sort reads the ids first
  const byMissingCost = sortBy === 'shippingCostMissingSince';
  const cursorWhere = byMissingCost
    ? undefined
    : buildOrdersCursorWhere({ sortBy, sortDir, cursor });

  const where = cursorWhere ? { AND: [baseWhere, cursorWhere] } : baseWhere;
  const orderBy = buildOrdersOrderBy(sortBy, sortDir);

  try {
    return await prisma.$transaction(async (tx) => {
      // set rls session context
      await setUserContext(tx, { userId: actorId, role: actorRole });

      // unconfirmed orders of the user show current prices and no deleted products, paid ones
      // keep the prices they were paid with: a confirmed order never changes its items
      if (actorRole === 'USER') await freshenUnconfirmedOrders(tx, Number(actorId));

      let rows;
      let total: number;
      let since = new Map<number, Date>();
      if (byMissingCost) {
        const sorted = await ordersByMissingCost(tx, baseWhere, sortDir, cursor);
        const pageIds = sorted.ids.slice(0, limit + 1);
        const found = await tx.order.findMany({
          where: { id: { in: pageIds } },
          select: orderResponseSelect,
        });
        rows = pageIds.map((id) => found.find((row) => row.id === id)!);
        total = sorted.total;
        since = sorted.since;
      } else {
        rows = await tx.order.findMany({
          where,
          orderBy,
          take: limit + 1,
          select: orderResponseSelect,
        });
        total = await tx.order.count({ where: baseWhere });
      }

      const hasNext = rows.length > limit;
      const pageRows = await withDeliveryAndSends(tx, hasNext ? rows.slice(0, limit) : rows);

      // an admin sees who bought each order, read apart from the orders
      const buyers = isAdmin
        ? new Map(
            (
              await tx.user.findMany({
                where: { id: { in: [...new Set(pageRows.map((row) => row.userId))] } },
                select: buyerSelect,
              })
            ).map((buyer) => [buyer.id, buyer]),
          )
        : new Map<number, Parameters<typeof buyerOf>[0]>();

      const expired = await expiredOfOrders(tx, pageRows);

      const last = pageRows[pageRows.length - 1];
      const nextCursor =
        hasNext && last
          ? byMissingCost
            ? makeMissingCostCursor(last.id, since.get(last.id)!, sortDir)
            : makeNextOrdersCursor(sortBy, last, sortDir)
          : null;

      return {
        items: pageRows.map((row) => ({
          ...mapOrderRowToResponse(row, expired, isAdmin ? 'admin' : 'buyer'),
          ...(isAdmin ? { buyer: buyerOf(buyers.get(row.userId)!) } : {}),
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
  delivery: {
    method: string;
    recipientFirstName: string;
    recipientLastName: string;
    recipientPhone: string;
    country: string | null;
    postalCode: string | null;
    city: string | null;
    street: string | null;
    house: string | null;
    apartment: string | null;
    note: string | null;
    price: unknown;
  } | null;
  // the send on its way: the latest that was not rolled back
  shipments: { carrier: string | null; trackingNumber: string | null; cost: unknown }[];
  user: { email: string; deletedAt: Date | null };
  items: {
    quantity: number;
    productName: string | null;
    product: { name: string; weightGrams: number | null };
  }[];
};

// the weight of the order: what the items that have a weight add up to, and whether every item has one
const weightOf = (row: CsvOrder) => ({
  grams: row.items.reduce((sum, item) => sum + (item.product.weightGrams ?? 0) * item.quantity, 0),
  complete: row.items.every((item) => item.product.weightGrams !== null),
});

// a line for each order to pack and hand to the courier: the buyer, the recipient, where to, how, what
// and how much it weighs, and what the send is
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
    value: (row) =>
      [row.delivery?.recipientFirstName, row.delivery?.recipientLastName].filter(Boolean).join(' '),
  },
  { header: 'Phone', kind: 'text', value: (row) => row.delivery?.recipientPhone },
  { header: 'Method', kind: 'text', value: (row) => row.delivery?.method },
  { header: 'Country', kind: 'text', value: (row) => row.delivery?.country },
  { header: 'Postal code', kind: 'text', value: (row) => row.delivery?.postalCode },
  { header: 'City', kind: 'text', value: (row) => row.delivery?.city },
  { header: 'Street', kind: 'text', value: (row) => row.delivery?.street },
  { header: 'House', kind: 'text', value: (row) => row.delivery?.house },
  { header: 'Apartment', kind: 'text', value: (row) => row.delivery?.apartment },
  { header: 'Note', kind: 'text', value: (row) => row.delivery?.note },
  {
    header: 'Delivery price',
    kind: 'money',
    value: (row) => (row.delivery ? Number(row.delivery.price) : null),
  },
  {
    header: 'Items',
    kind: 'text',
    // the name an item was confirmed with
    value: (row) =>
      row.items
        .map((item) => `${item.productName ?? item.product.name} x ${item.quantity}`)
        .join('; '),
  },
  { header: 'Weight g', kind: 'number', value: (row) => weightOf(row).grams },
  {
    header: 'Weight complete',
    kind: 'text',
    value: (row) => (weightOf(row).complete ? 'yes' : 'no'),
  },
  { header: 'Total', kind: 'money', value: (row) => Number(row.total) },
  { header: 'Carrier', kind: 'text', value: (row) => row.shipments[0]?.carrier },
  { header: 'Tracking number', kind: 'text', value: (row) => row.shipments[0]?.trackingNumber },
  {
    header: 'Shipping cost',
    kind: 'money',
    value: (row) => {
      const cost = row.shipments[0]?.cost;
      return cost === null || cost === undefined ? null : Number(cost);
    },
  },
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

      // the oldest send without a cost is a value of many rows: that sort reads the ids first
      const byMissingCost =
        q.sortBy === 'shippingCostMissingSince'
          ? (await ordersByMissingCost(tx, whereOf(q), q.sortDir)).ids
          : null;

      // a query reads at most two relations side by side, so the sends and the buyers are read apart
      const found = await tx.order.findMany({
        where: byMissingCost ? { id: { in: byMissingCost } } : whereOf(q),
        ...(byMissingCost ? {} : { orderBy: buildOrdersOrderBy(q.sortBy, q.sortDir) }),
        select: {
          id: true,
          userId: true,
          status: true,
          paidAt: true,
          total: true,
          delivery: {
            select: {
              method: true,
              recipientFirstName: true,
              recipientLastName: true,
              recipientPhone: true,
              country: true,
              postalCode: true,
              city: true,
              street: true,
              house: true,
              apartment: true,
              note: true,
              price: true,
            },
          },
          items: {
            orderBy: { id: 'asc' },
            select: {
              quantity: true,
              productName: true,
              product: { select: { name: true, weightGrams: true } },
            },
          },
        },
      });

      const orders = byMissingCost
        ? byMissingCost.map((id) => found.find((order) => order.id === id)!)
        : found;

      // the send on its way: the latest that was not rolled back
      const sends = await tx.orderShipment.findMany({
        where: { orderId: { in: orders.map((order) => order.id) }, rolledBackAt: null },
        orderBy: [{ shippedAt: 'desc' }, { id: 'desc' }],
        select: { orderId: true, carrier: true, trackingNumber: true, cost: true },
      });
      const buyers = await tx.user.findMany({
        where: { id: { in: [...new Set(orders.map((order) => order.userId))] } },
        select: { id: true, email: true, deletedAt: true },
      });
      const buyerOf = new Map(buyers.map((buyer) => [buyer.id, buyer]));

      return orders.map((order) => {
        const send = sends.find((s) => s.orderId === order.id);
        return {
          ...order,
          shipments: send ? [send] : [],
          user: buyerOf.get(order.userId)!,
        };
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
