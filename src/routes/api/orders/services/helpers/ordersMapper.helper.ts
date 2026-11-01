import type { Prisma } from '@prisma/client';

import env from '@config/env.js';
import { expiredUnitsOf } from '@db/expiredStock.helper.js';
import { variantNamesOf, type VariantNameInfo } from '@db/variantNames.helper.js';

import { deliveryPriceOf, deliveryQuotesOf } from '@helpers/deliveryPrice.js';
import { decimalToNumber } from '@helpers/safeNormalizer.js';
import {
  isVariantVisible,
  variantRowSelect,
  variantShortOf,
} from '@routes/api/products/services/helpers/variant.helper.js';

import type {
  OrderDeliveryDto,
  OrderItemDto,
  OrderResponseDto,
  OrderShipmentAdminDto,
} from 'types/dto/orders.dto.js';

// what every order answer reads: the cart, the confirmation, one order, the list and the status
// change of an admin. The payment id stays internal and is not read
export const orderResponseSelect = {
  id: true,
  userId: true,
  status: true,
  confirmed: true,
  reservationExpiresAt: true,
  total: true,
  paidAt: true,
  cancelledAt: true,
  createdAt: true,
  updatedAt: true,
  items: {
    select: {
      id: true,
      productId: true,
      variantId: true,
      quantity: true,
      unitPrice: true,
      totalPrice: true,
      productName: true,

      // the product of the position, and its variant as the catalog reads it (the price, the sale,
      // the stock, the weight and the pictures of THIS variant); a query reads at most two
      // relations side by side
      product: { select: { id: true, name: true, categoryId: true, deletedAt: true } },
      variant: { select: variantRowSelect },
    },
    orderBy: { id: 'asc' },
  },
} satisfies Prisma.OrderSelect;

// where an order goes and the sends of it. The relations of one query run at once on the one
// connection of a transaction, and pg warns of a query started while another runs: so the order
// is read with its items only, and its delivery and its sends are read apart and put on it
// (withDeliveryAndSends)
export const orderDeliverySelect = {
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
} satisfies Prisma.OrderDeliverySelect;

export type OrderDeliveryRow = Prisma.OrderDeliveryGetPayload<{
  select: typeof orderDeliverySelect;
}>;

export const orderShipmentSelect = {
  id: true,
  carrier: true,
  trackingNumber: true,
  trackingUrl: true,
  cost: true,
  expense: true,
  shippedAt: true,
  rolledBackAt: true,
} satisfies Prisma.OrderShipmentSelect;

export type OrderShipmentRow = Prisma.OrderShipmentGetPayload<{
  select: typeof orderShipmentSelect;
}>;

type OrderRowWithoutShipments = Prisma.OrderGetPayload<{ select: typeof orderResponseSelect }>;

// the order as the answers read it: the buyer is given the send on its way, without its cost
export type OrderResponseRow = OrderRowWithoutShipments & {
  delivery: OrderDeliveryRow | null;
  shipments: OrderShipmentRow[];
};

// the delivery and the sends of the rows, the latest send of an order first: one query for each,
// one after the other, for all the rows
export async function withDeliveryAndSends<T extends { id: number }>(
  db: Prisma.TransactionClient,
  rows: T[],
): Promise<(T & { delivery: OrderDeliveryRow | null; shipments: OrderShipmentRow[] })[]> {
  if (rows.length === 0) return [];

  const orderIds = rows.map((row) => row.id);

  const deliveries = await db.orderDelivery.findMany({
    where: { orderId: { in: orderIds } },
    select: { ...orderDeliverySelect, orderId: true },
  });

  const sends = await db.orderShipment.findMany({
    where: { orderId: { in: orderIds } },
    orderBy: [{ shippedAt: 'desc' }, { id: 'desc' }],
    select: { ...orderShipmentSelect, orderId: true },
  });

  const deliveryOf = new Map<number, OrderDeliveryRow>();
  for (const { orderId, ...delivery } of deliveries) deliveryOf.set(orderId, delivery);

  const sendsOf = new Map<number, OrderShipmentRow[]>();
  for (const { orderId, ...send } of sends) {
    sendsOf.set(orderId, [...(sendsOf.get(orderId) ?? []), send]);
  }

  return rows.map((row) => ({
    ...row,
    delivery: deliveryOf.get(row.id) ?? null,
    shipments: sendsOf.get(row.id) ?? [],
  }));
}

// one order as the answers read it, or null when it is not there or the context may not see it
export async function readOrderResponse(
  db: Prisma.TransactionClient,
  id: number,
): Promise<OrderResponseRow | null> {
  const row = await db.order.findUnique({ where: { id }, select: orderResponseSelect });
  if (!row) return null;

  const [full] = await withDeliveryAndSends(db, [row]);
  return full;
}

// what the items of orders need besides their rows: the units of batches that are over of their
// variants, by the day of the shop the transaction carries (the free units of an item leave them
// out), and the names the variants have now, for the items that do not carry a name of the
// confirmation
export type OrderContext = {
  expired: Map<number, number>;
  names: Map<number, VariantNameInfo>;
};

export async function orderContextOf(
  db: Prisma.TransactionClient,
  rows: { confirmed: boolean; items: { variantId: number; productName: string | null }[] }[],
): Promise<OrderContext> {
  const expired = await expiredUnitsOf(
    db,
    rows.flatMap((row) => row.items.map((item) => item.variantId)),
  );
  // the name of a confirmed item is its copy; every other item shows the name of now
  const names = await variantNamesOf(
    db,
    rows.flatMap((row) =>
      row.items
        .filter((item) => !(row.confirmed && item.productName))
        .map((item) => item.variantId),
    ),
  );

  return { expired, names };
}

// the orders the buyer has not paid yet: the price of their variants is still the one of now
const UNPAID_STATUSES = new Set(['pending', 'unconfirmed', 'waiting']);

// what the items of the row cost, to the cent
const itemsTotalOf = (row: OrderResponseRow): number =>
  row.items.reduce((sum, item) => sum + Math.round(decimalToNumber(item.totalPrice) * 100), 0) /
  100;

// where and to whom the row goes. The price is the one fixed at the confirmation; an order that is
// not confirmed has none yet, it shows the price of now. The buyer is given the send on its way,
// the one that was not rolled back, once the order is shipped
function mapDelivery(row: OrderResponseRow, itemsTotal: number): OrderDeliveryDto | null {
  const d = row.delivery;
  if (!d) return null;

  const onItsWay = row.shipments.find((s) => s.rolledBackAt === null);
  const sent = row.status === 'shipped' || row.status === 'delivered';

  return {
    method: d.method,
    price: row.confirmed ? decimalToNumber(d.price) : deliveryPriceOf(d.method, itemsTotal),
    recipient: {
      firstName: d.recipientFirstName,
      lastName: d.recipientLastName,
      phone: d.recipientPhone,
    },
    address:
      d.method === 'manual' && d.country && d.city && d.street && d.house
        ? {
            country: d.country,
            postalCode: d.postalCode,
            city: d.city,
            street: d.street,
            house: d.house,
            apartment: d.apartment,
          }
        : null,
    note: d.note,
    pickup: d.method === 'pickup' ? { address: env.PICKUP_ADDRESS, hours: env.PICKUP_HOURS } : null,
    shipment:
      sent && d.method === 'manual' && onItsWay
        ? {
            carrier: onItsWay.carrier,
            trackingNumber: onItsWay.trackingNumber,
            trackingUrl: onItsWay.trackingUrl,
          }
        : null,
  };
}

const mapShipments = (row: OrderResponseRow): OrderShipmentAdminDto[] =>
  row.shipments.map((s) => ({
    id: s.id,
    carrier: s.carrier,
    trackingNumber: s.trackingNumber,
    trackingUrl: s.trackingUrl,
    cost: s.cost === null ? null : decimalToNumber(s.cost),
    expense: s.expense,
    shippedAt: s.shippedAt,
    rolledBackAt: s.rolledBackAt,
  }));

// what the order weighs: the variants that have a weight add up to it (the weight of one times the
// units ordered), and it is whole only when every variant has one
const weightOf = (row: OrderResponseRow) => ({
  grams: row.items.reduce((sum, item) => sum + (item.variant.weightGrams ?? 0) * item.quantity, 0),
  complete: row.items.every((item) => item.variant.weightGrams !== null),
});

// a position of the order as the answers show it: the product, and the variant that was bought.
// While the buyer has not paid, the variant shows what it sells at now (the price, the sale while
// it lasts, the name of now until the confirmation fixes it); a position of a paid order shows the
// copies of the confirmation, the name and the price it was bought at, and no sale. A variant a
// buyer does not see any more (taken out of sale, its product removed, its pictures taken away)
// stays in an order that is confirmed and says so with forSale: false
function mapItem(
  row: OrderResponseRow,
  it: OrderResponseRow['items'][number],
  context: OrderContext,
  unpaid: boolean,
): OrderItemDto {
  // an item that keeps its name needs none of now
  const named = context.names.get(it.variantId) ?? {
    name: it.productName ?? it.product.name,
    values: [],
  };
  const live = variantShortOf(
    it.variant,
    {
      expired: context.expired,
      names: new Map([[it.variantId, named]]),
      costs: new Map(),
      attributes: new Map(),
    },
    'buyer',
  );
  const forSale = isVariantVisible(it.variant) && it.product.deletedAt === null;

  // the name kept at the confirmation; a cart and an unconfirmed order follow the variant, an item
  // from before the name was kept shows the name of now
  const name = (row.confirmed && it.productName) || live.name;
  const unitPrice = decimalToNumber(it.unitPrice);

  return {
    // order item id, cart item routes take it as itemId
    id: it.id,
    product: {
      id: it.product.id as any,
      name: it.product.name,
      categoryId: it.product.categoryId as any,
    },
    variant: unpaid
      ? {
          id: live.id,
          position: live.position,
          name,
          price: live.price,
          ...(live.salePrice !== undefined ? { salePrice: live.salePrice } : {}),
          ...(live.saleEndsAt !== undefined ? { saleEndsAt: live.saleEndsAt } : {}),
          ...(live.salePriorPrice !== undefined ? { salePriorPrice: live.salePriorPrice } : {}),
          stock: live.stock,
          image: live.image,
          forSale,
        }
      : {
          id: live.id,
          position: live.position,
          name,
          price: unitPrice,
          stock: live.stock,
          image: live.image,
          forSale,
        },
    quantity: it.quantity,
    unitPrice,
    totalPrice: decimalToNumber(it.totalPrice),
  };
}

// the admin and the root see the sends of an order with what the shop pays for them and what it
// weighs; the buyer does not
export type OrderView = 'buyer' | 'admin';

export function mapOrderRowToResponse(
  row: OrderResponseRow,
  context: OrderContext,
  view: OrderView = 'buyer',
): OrderResponseDto {
  const unpaid = UNPAID_STATUSES.has(row.status);
  const itemsTotal = itemsTotalOf(row);
  const delivery = mapDelivery(row, itemsTotal);

  return {
    id: row.id as any,
    userId: row.userId as any,
    status: row.status,
    confirmed: row.confirmed,
    itemsTotal,
    // what the buyer pays: the total the database holds once the order is confirmed (the items and
    // the delivery fixed then), before that the items and the delivery of now
    total: row.confirmed
      ? decimalToNumber(row.total)
      : Math.round((itemsTotal + (delivery?.price ?? 0)) * 100) / 100,
    delivery,
    items: row.items.map((it) => mapItem(row, it, context, unpaid)),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    // a field the order does not have yet is left out
    ...(row.reservationExpiresAt ? { reservationExpiresAt: row.reservationExpiresAt } : {}),
    ...(row.paidAt ? { paidAt: row.paidAt } : {}),
    ...(row.cancelledAt ? { cancelledAt: row.cancelledAt } : {}),
    // an order that is not confirmed: what each method of the shop would cost now
    ...(row.confirmed ? {} : { deliveryQuotes: deliveryQuotesOf(itemsTotal) }),
    ...(view === 'admin' ? { shipments: mapShipments(row), weight: weightOf(row) } : {}),
  };
}
