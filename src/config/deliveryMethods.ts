// the ways a shop gets an order to its buyer: it sends it itself with a carrier it picks and works
// with outside the app (manual), or the buyer collects it at the shop (pickup). A carrier connected
// to the app comes as another name
export const DELIVERY_METHOD_NAMES = ['manual', 'pickup'] as const;

export type DeliveryMethodName = (typeof DELIVERY_METHOD_NAMES)[number];

export const isDeliveryMethodName = (value: unknown): value is DeliveryMethodName =>
  DELIVERY_METHOD_NAMES.includes(value as DeliveryMethodName);
