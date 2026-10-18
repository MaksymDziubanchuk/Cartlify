import { isPhone } from '@helpers/profileText.js';
import { BadRequestError } from '@utils/errors.js';

import type { Prisma } from '@prisma/client';
import type { ConfirmCurrentOrderBodyDto } from 'types/dto/orders.dto.js';

const LETTER = /\p{L}/u;
const DIGIT = /\p{Nd}/u;

// a first or last name of the recipient: at least one letter and no digit, in any script
export const isRecipientName = (value: string): boolean => LETTER.test(value) && !DIGIT.test(value);

export type ConfirmOrderShippingInput = Omit<ConfirmCurrentOrderBodyDto, 'orderId'>;

export type UnavailableOrderItem = {
  itemId: number;
  productId: number;
  // deleted: the product is gone from the catalog; out_of_stock: fewer units are free than ordered
  reason: 'deleted' | 'out_of_stock';
  available: number;
  requested: number;
};

// the items an order cannot be confirmed with, so the page can show which ones and why
export function findUnavailableItems(
  items: {
    id: number;
    productId: number;
    quantity: number;
    product: { deletedAt: Date | null; stock: number; reservedStock: number };
  }[],
): UnavailableOrderItem[] {
  return items.flatMap((item) => {
    const available = item.product.deletedAt
      ? 0
      : Math.max(0, item.product.stock - item.product.reservedStock);

    if (!item.product.deletedAt && item.quantity <= available) return [];

    return [
      {
        itemId: item.id,
        productId: item.productId,
        reason: item.product.deletedAt ? 'deleted' : 'out_of_stock',
        available,
        requested: item.quantity,
      },
    ];
  });
}

// what the confirm request writes to the order before it is confirmed. A field that is not sent
// keeps what the order has: an order that lost its reservation keeps its shipping data, so
// confirming it again needs none of it. A failed confirm writes nothing, the transaction rolls back.
// The request schema holds the lengths and the phone format, this checks the rest
export function buildConfirmOrderData(
  input: ConfirmOrderShippingInput,
): Prisma.OrderUpdateManyMutationInput {
  const data: Prisma.OrderUpdateManyMutationInput = {};

  if (input.shippingAddress !== undefined) {
    const address = input.shippingAddress.trim();
    if (!address) throw new BadRequestError('SHIPPING_ADDRESS_INVALID');
    data.shippingAddress = address;
  }

  if (input.recipientFirstName !== undefined) {
    const firstName = input.recipientFirstName.trim();
    if (!isRecipientName(firstName)) throw new BadRequestError('RECIPIENT_FIRST_NAME_INVALID');
    data.recipientFirstName = firstName;
  }

  if (input.recipientLastName !== undefined) {
    const lastName = input.recipientLastName.trim();
    if (!isRecipientName(lastName)) throw new BadRequestError('RECIPIENT_LAST_NAME_INVALID');
    data.recipientLastName = lastName;
  }

  // the phone is taken as it is sent, the same as the profile phone
  if (input.recipientPhone !== undefined) {
    if (!isPhone(input.recipientPhone)) throw new BadRequestError('RECIPIENT_PHONE_INVALID');
    data.recipientPhone = input.recipientPhone;
  }

  // an empty note removes the one the order has
  if (input.note !== undefined) {
    data.note = input.note.trim() || null;
  }

  return data;
}
