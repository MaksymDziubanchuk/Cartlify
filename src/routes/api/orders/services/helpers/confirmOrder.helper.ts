import { shopSettings } from '@config/shopSettings.js';
import { normalizePostalCode } from '@config/deliveryCountries.js';
import type { DeliveryMethodName } from '@config/deliveryMethods.js';
import { freeUnits } from '@db/expiredStock.helper.js';
import { isPhone } from '@helpers/profileText.js';
import { BadRequestError } from '@utils/errors.js';

import type { ConfirmDeliveryBodyDto } from 'types/dto/orders.dto.js';

const LETTER = /\p{L}/u;
const DIGIT = /\p{Nd}/u;

// a first or last name of the recipient: at least one letter and no digit, in any script
export const isRecipientName = (value: string): boolean => LETTER.test(value) && !DIGIT.test(value);

// a city and a street have a letter; a house is any text, its number, its name or both, or s/n for
// a house without a number
const HOUSE_WITHOUT_NUMBER = /^s\/n$/i;

export type UnavailableOrderItem = {
  itemId: number;
  variantId: number;
  // deleted: the variant is not for sale any more (taken out of sale, its product removed, or it
  // shows no picture); out_of_stock: fewer units are free than ordered
  reason: 'deleted' | 'out_of_stock';
  available: number;
  requested: number;
};

// the items an order cannot be confirmed with, so the page can show which ones and why; the
// units of batches that are over are no free units (expired, by variant). A variant that a buyer
// does not see (taken out of sale, its product removed, no picture) has no free units to buy
export function findUnavailableItems(
  items: {
    id: number;
    variantId: number;
    quantity: number;
    product: { deletedAt: Date | null };
    variant: {
      deletedAt: Date | null;
      stock: number;
      reservedStock: number;
      images: readonly unknown[];
    };
  }[],
  expired: Map<number, number>,
): UnavailableOrderItem[] {
  return items.flatMap((item) => {
    const hidden =
      item.variant.deletedAt !== null ||
      item.product.deletedAt !== null ||
      item.variant.images.length === 0;
    const available = hidden
      ? 0
      : freeUnits(item.variant.stock, item.variant.reservedStock, expired.get(item.variantId) ?? 0);

    if (!hidden && item.quantity <= available) return [];

    return [
      {
        itemId: item.id,
        variantId: item.variantId,
        reason: hidden ? ('deleted' as const) : ('out_of_stock' as const),
        available,
        requested: item.quantity,
      },
    ];
  });
}

// what a delivery of the confirm request writes to order_deliveries before the order is confirmed
export type DeliveryWriteData = {
  method: DeliveryMethodName;
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
};

// the delivery an order already has must still be one the shop offers: the owner may have changed
// the methods or the countries since the buyer wrote it
export function assertDeliveryOfShop(method: DeliveryMethodName, country: string | null): void {
  const settings = shopSettings();
  if (!settings.deliveryMethods.includes(method)) {
    throw new BadRequestError('DELIVERY_METHOD_NOT_AVAILABLE', { method });
  }

  if (method === 'manual' && (!country || !settings.deliveryCountries.includes(country))) {
    throw new BadRequestError('DELIVERY_COUNTRY_NOT_ALLOWED', { country });
  }
}

// the address of a manual delivery in the form it is written in: the shop delivers to the country,
// the postal code is one of that country in its own form, the parts are what they should be
export function buildAddressData(address: NonNullable<ConfirmDeliveryBodyDto['address']>) {
  if (!shopSettings().deliveryCountries.includes(address.country)) {
    throw new BadRequestError('DELIVERY_COUNTRY_NOT_ALLOWED', { country: address.country });
  }

  const postalCode = normalizePostalCode(address.country, address.postalCode);
  if (postalCode === null) throw new BadRequestError('DELIVERY_POSTAL_CODE_INVALID');

  const city = address.city.trim();
  if (!LETTER.test(city)) throw new BadRequestError('DELIVERY_CITY_INVALID');

  const street = address.street.trim();
  if (!LETTER.test(street)) throw new BadRequestError('DELIVERY_STREET_INVALID');

  const house = address.house.trim();
  if (!house) throw new BadRequestError('DELIVERY_HOUSE_INVALID');

  return {
    country: address.country,
    postalCode,
    city,
    street,
    house: HOUSE_WITHOUT_NUMBER.test(house) ? 's/n' : house,
    apartment: address.apartment?.trim() || null,
  };
}

// the delivery of the confirm request in the form it is written in: the text without the spaces
// around it, the postal code the way its country writes it, empty parts as none. The request
// schema holds the lengths and the forms of the phone and the country, this checks the rest: the
// shop makes the method, the country is one the shop delivers to, the parts are what they should
// be. Checked before anything is written, a refusal leaves the order as it was
export function buildDeliveryData(input: ConfirmDeliveryBodyDto): DeliveryWriteData {
  if (!shopSettings().deliveryMethods.includes(input.method)) {
    throw new BadRequestError('DELIVERY_METHOD_NOT_AVAILABLE', { method: input.method });
  }

  const firstName = input.recipientFirstName.trim();
  if (!isRecipientName(firstName)) throw new BadRequestError('RECIPIENT_FIRST_NAME_INVALID');

  const lastName = input.recipientLastName.trim();
  if (!isRecipientName(lastName)) throw new BadRequestError('RECIPIENT_LAST_NAME_INVALID');

  // the phone is taken as it is sent, the same as the profile phone
  if (!isPhone(input.recipientPhone)) throw new BadRequestError('RECIPIENT_PHONE_INVALID');

  const person = {
    method: input.method,
    recipientFirstName: firstName,
    recipientLastName: lastName,
    recipientPhone: input.recipientPhone,
    note: input.note?.trim() || null,
  };

  if (input.method === 'pickup') {
    if (input.address !== undefined) throw new BadRequestError('DELIVERY_ADDRESS_NOT_ALLOWED');

    return {
      ...person,
      country: null,
      postalCode: null,
      city: null,
      street: null,
      house: null,
      apartment: null,
    };
  }

  if (!input.address) throw new BadRequestError('DELIVERY_ADDRESS_REQUIRED');

  return { ...person, ...buildAddressData(input.address) };
}
