import env from '@config/env.js';

// where and to whom an order goes, as the mails, the lists and the files of the shop print it

export type DeliveryTextParts = {
  method: 'manual' | 'pickup';
  recipientFirstName: string;
  recipientLastName: string;
  recipientPhone: string;
  country: string | null;
  postalCode: string | null;
  city: string | null;
  street: string | null;
  house: string | null;
  apartment: string | null;
};

// the address of a manual delivery in one line: the street and the house, the apartment, the postal
// code and the city, the country; empty for a pickup
export function addressLineOf(d: DeliveryTextParts): string {
  if (d.method !== 'manual') return '';

  return [
    [d.street, d.house].filter(Boolean).join(' '),
    d.apartment ? `apt ${d.apartment}` : null,
    [d.postalCode, d.city].filter(Boolean).join(' '),
    d.country,
  ]
    .filter(Boolean)
    .join(', ');
}

export const recipientNameOf = (d: DeliveryTextParts): string =>
  `${d.recipientFirstName} ${d.recipientLastName}`.trim();

// where and when a buyer collects an order at the shop
export const pickupPlaceOf = (): string =>
  [env.PICKUP_ADDRESS, env.PICKUP_HOURS].filter(Boolean).join(', ');

// the parts of the mails of an order that show where it goes; empty when the order has no delivery
export function deliveryMailParts(d: DeliveryTextParts | null) {
  return {
    shippingAddress: d ? addressLineOf(d) : '',
    recipientName: d ? recipientNameOf(d) : '',
    recipientPhone: d?.recipientPhone ?? '',
    pickup: d?.method === 'pickup' ? pickupPlaceOf() : '',
  };
}
