import type { Prisma } from '@prisma/client';

import env from '@config/env.js';
import { expiredUnitsOf, freeUnits } from '@db/expiredStock.helper.js';

import { deliveryPriceOf, deliveryQuotesOf } from '@helpers/deliveryPrice.js';
import { saleFieldsOf } from '@helpers/productSale.js';
import { decimalToNumber } from '@helpers/safeNormalizer.js';
import { buildImageUrls } from '@utils/cloudinary.util.js';

import type {
  OrderDeliveryDto,
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
      quantity: true,
      unitPrice: true,
      totalPrice: true,
      productName: true,

      // include minimal product snapshot for order ui
      product: {
        select: {
          id: true,
          name: true,
          price: true,
          salePrice: true,
          saleEndsAt: true,
          salePriorPrice: true,
          categoryId: true,
          weightGrams: true,
          stock: true,
          reservedStock: true,
          deletedAt: true,
          images: {
            select: { url: true, position: true, isPrimary: true },
            orderBy: [{ isPrimary: 'desc' }, { position: 'asc' }],
            take: 1,
          },
        },
      },
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

// the units of batches that are over of the products of the orders, by the day of the shop the
// transaction carries: the free units of an item leave them out
export const expiredOfOrders = (
  db: Prisma.TransactionClient,
  rows: { items: { productId: number }[] }[],
) =>
  expiredUnitsOf(
    db,
    rows.flatMap((row) => row.items.map((item) => item.productId)),
  );

// the orders the buyer has not paid yet: the price of their products is still the one of now
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

// what the order weighs: the items that have a weight add up to it, and it is whole only when every
// item has one
const weightOf = (row: OrderResponseRow) => ({
  grams: row.items.reduce((sum, item) => sum + (item.product.weightGrams ?? 0) * item.quantity, 0),
  complete: row.items.every((item) => item.product.weightGrams !== null),
});

// the admin and the root see the sends of an order with what the shop pays for them and what it
// weighs; the buyer does not
export type OrderView = 'buyer' | 'admin';

export function mapOrderRowToResponse(
  row: OrderResponseRow,
  expired: Map<number, number>,
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
    items: row.items.map((it) => {
      // a product without an image opens by its id and goes into a cart: no images then
      const primaryUrl = it.product.images?.[0]?.url;

      // the free units: the stock less what the waiting orders hold and what is over
      const availableStock = freeUnits(
        it.product.stock,
        it.product.reservedStock,
        expired.get(it.productId) ?? 0,
      );

      return {
        // order item id, cart item routes take it as itemId
        id: it.id,
        productId: it.productId as any,
        // the name kept at the confirm; a cart and an unconfirmed order follow the product, an
        // item from before the name was kept shows the name of now
        name: (row.confirmed && it.productName) || it.product.name,
        product: {
          id: it.product.id as any,
          name: it.product.name,
          categoryId: it.product.categoryId as any,
          images: primaryUrl ? buildImageUrls(primaryUrl, 'product') : null,
          availableStock,
          deletedAt: it.product.deletedAt,
          // what the product sells at now, for an order still to pay: the sale while it lasts
          ...(unpaid
            ? { price: decimalToNumber(it.product.price), ...saleFieldsOf(it.product) }
            : {}),
        },
        quantity: it.quantity,
        unitPrice: decimalToNumber(it.unitPrice),
        totalPrice: decimalToNumber(it.totalPrice),
      };
    }),
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
