// the ways a shop gets an order to its buyer: it sends it itself with a carrier it picks and works
// with outside the app (manual), the buyer collects it at the shop (pickup), or a carrier of the
// delivery provider the buyer picks from its prices sends it, the parcel made by the app (carrier,
// src/providers/delivery)
export const DELIVERY_METHOD_NAMES = ['manual', 'pickup', 'carrier'] as const;

export type DeliveryMethodName = (typeof DELIVERY_METHOD_NAMES)[number];

export const isDeliveryMethodName = (value: unknown): value is DeliveryMethodName =>
  DELIVERY_METHOD_NAMES.includes(value as DeliveryMethodName);

// the methods that send the order to an address: the address is written with the order, the
// country is one of a zone of the shop, customs are checked for it
const ADDRESS_METHODS: readonly DeliveryMethodName[] = ['manual', 'carrier'];

export const sendsToAddress = (method: DeliveryMethodName): boolean =>
  ADDRESS_METHODS.includes(method);
