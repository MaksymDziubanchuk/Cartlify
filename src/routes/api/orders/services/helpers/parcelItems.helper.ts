import { boxOf, type ShippingData } from '@helpers/parcelBox.js';
import { BadRequestError } from '@utils/errors.js';

import type { Prisma } from '@prisma/client';
import type { ShipmentBoxInputDto } from 'types/dto/orders.dto.js';

// What travels to the buyer and how it is packed: the units of each item less the units statements
// brought back before the sending (on the shelf, written off, lost), laid out in the boxes of the
// parcels. Every unit that travels is in a box of a live parcel, and no box holds more

export type BoxItem = { orderItemId: number; quantity: number };

export type BoxData = {
  weightGrams: number | null;
  lengthMm: number | null;
  widthMm: number | null;
  heightMm: number | null;
  items: BoxItem[];
};

export type ItemToSend = ShippingData & { orderItemId: number; units: number };

// the items of an order with the units that travel, in the order of the order; an item all of whose
// units came back is left out
export async function itemsToSendOf(
  db: Prisma.TransactionClient,
  orderId: number,
): Promise<ItemToSend[]> {
  const items = await db.orderItem.findMany({
    where: { orderId },
    orderBy: { id: 'asc' },
    select: {
      id: true,
      quantity: true,
      variant: { select: { weightGrams: true, lengthMm: true, widthMm: true, heightMm: true } },
    },
  });

  const back = await db.orderReturnItem.findMany({
    where: { orderItem: { orderId }, goods: { in: ['to_stock', 'written_off', 'lost'] } },
    select: { orderItemId: true, quantity: true },
  });
  const backOf = new Map<number, number>();
  for (const row of back) {
    backOf.set(row.orderItemId, (backOf.get(row.orderItemId) ?? 0) + row.quantity);
  }

  return items
    .map((item) => ({
      orderItemId: item.id,
      units: item.quantity - (backOf.get(item.id) ?? 0),
      ...item.variant,
    }))
    .filter((item) => item.units > 0);
}

// the most a box weighs and measures, as the database keeps it (db/06, shipment_boxes_size_chk)
export const BOX_MAX_WEIGHT_GRAMS = 1_000_000;
export const BOX_MAX_SIZE_MM = 10_000;

// the one box of every unit that travels: the weight and the sizes when every variant has them
// (decision 8 of the delivery) and they fit a box, none otherwise (the admin lays the units out in
// several boxes; a carrier refuses a box without them, PARCEL_BOX_SIZES_REQUIRED)
export function oneBoxOf(items: readonly ItemToSend[]): BoxData {
  const summed = boxOf(items.map((item) => ({ variant: item, quantity: item.units })));
  const box =
    summed &&
    summed.weightGrams <= BOX_MAX_WEIGHT_GRAMS &&
    Math.max(summed.lengthMm, summed.widthMm, summed.heightMm) <= BOX_MAX_SIZE_MM
      ? summed
      : null;
  return {
    weightGrams: box?.weightGrams ?? null,
    lengthMm: box?.lengthMm ?? null,
    widthMm: box?.widthMm ?? null,
    heightMm: box?.heightMm ?? null,
    items: items.map((item) => ({ orderItemId: item.orderItemId, quantity: item.units })),
  };
}

// a box as the admin gave it: the four sizes together or none (SHIPMENT_BOX_SIZES_INVALID), the
// items whole numbers of units of the order, each once in a box
export function boxDataOf(input: ShipmentBoxInputDto): BoxData {
  const sizes = [input.weightGrams, input.lengthMm, input.widthMm, input.heightMm];
  const given = sizes.filter((size) => size !== undefined && size !== null).length;
  if (given !== 0 && given !== 4) throw new BadRequestError('SHIPMENT_BOX_SIZES_INVALID');

  const ids = input.items.map((item) => item.orderItemId);
  if (new Set(ids).size !== ids.length) throw new BadRequestError('PARCEL_ITEMS_MISMATCH');

  return {
    weightGrams: input.weightGrams ?? null,
    lengthMm: input.lengthMm ?? null,
    widthMm: input.widthMm ?? null,
    heightMm: input.heightMm ?? null,
    items: input.items.map((item) => ({ orderItemId: item.orderItemId, quantity: item.quantity })),
  };
}

// the boxes laid out over the parcels must hold every unit that travels, no more and no less, and
// only items of the order (PARCEL_ITEMS_MISMATCH, details.items: { orderItemId, units, packed }
// of each item that does not add up)
export function assertLaidOut(boxes: readonly BoxData[], items: readonly ItemToSend[]): void {
  const packed = new Map<number, number>();
  for (const box of boxes) {
    for (const item of box.items) {
      packed.set(item.orderItemId, (packed.get(item.orderItemId) ?? 0) + item.quantity);
    }
  }

  const unitsOf = new Map(items.map((item) => [item.orderItemId, item.units]));
  const ids = new Set([...unitsOf.keys(), ...packed.keys()]);
  const wrong = [...ids]
    .map((orderItemId) => ({
      orderItemId,
      units: unitsOf.get(orderItemId) ?? 0,
      packed: packed.get(orderItemId) ?? 0,
    }))
    .filter((item) => item.units !== item.packed);

  if (wrong.length) throw new BadRequestError('PARCEL_ITEMS_MISMATCH', { items: wrong });
}
