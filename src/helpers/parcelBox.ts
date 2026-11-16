import { shopSettings } from '@config/shopSettings.js';
import type { DeliveryAddress, DeliveryBox } from '@providers/delivery/index.js';

// The box the app puts the items of an order in before anybody packs them (decision 8 of the
// delivery): one parcel, the weight the sum of the weights, the length and the width the biggest of
// the items, the height the sum of the heights (the items stacked). The prices of the carriers are
// asked for it, and an admin gets it as the draft of the parcels

export type ShippingData = {
  weightGrams: number | null;
  lengthMm: number | null;
  widthMm: number | null;
  heightMm: number | null;
};

export type BoxLine = { variant: ShippingData; quantity: number };

// whether a variant has what a carrier needs: its weight and its three sizes
export const hasShippingData = (v: ShippingData): boolean =>
  v.weightGrams !== null && v.lengthMm !== null && v.widthMm !== null && v.heightMm !== null;

// the one box of the lines; null when a line has no weight or sizes (no carrier can price it) or
// there is no line at all
export function boxOf(lines: readonly BoxLine[]): DeliveryBox | null {
  if (!lines.length || !lines.every((line) => hasShippingData(line.variant))) return null;

  return {
    weightGrams: lines.reduce((sum, l) => sum + l.variant.weightGrams! * l.quantity, 0),
    lengthMm: Math.max(...lines.map((l) => l.variant.lengthMm!)),
    widthMm: Math.max(...lines.map((l) => l.variant.widthMm!)),
    heightMm: lines.reduce((sum, l) => sum + l.variant.heightMm! * l.quantity, 0),
  };
}

// where the parcels go from, in the words of the delivery provider; null while the shop names none
export function senderAddressOf(): DeliveryAddress | null {
  const sender = shopSettings().deliverySender;
  if (!sender) return null;

  return {
    name: sender.name,
    street: sender.street,
    house: sender.house,
    apartment: sender.apartment,
    city: sender.city,
    postalCode: sender.postalCode,
    country: sender.country,
    phone: sender.phone,
    email: sender.email,
  };
}

// The shop sells a variant without shipping data only by a way that needs none: the manual delivery
// to a zone with its price, or a pickup with its address and hours. A shop that sends by carriers
// only has nothing to send such a variant with: the buyer sees it as not for sale (no free units),
// it is not put in a cart (PRODUCT_NOT_DELIVERABLE) and a cart with it is not confirmed
export function sellsWithoutShippingData(): boolean {
  const settings = shopSettings();
  if (!settings.deliveryMethods.includes('carrier')) return true;

  const manual =
    settings.deliveryMethods.includes('manual') &&
    settings.deliveryZones.some((zone) => zone.manualPrice !== null);
  const pickup =
    settings.deliveryMethods.includes('pickup') &&
    settings.pickupAddress.trim() !== '' &&
    settings.pickupHours.trim() !== '';
  return manual || pickup;
}
