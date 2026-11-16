// the delivery providers this server can send parcels with; DELIVERY_PROVIDER names the one it
// works with. Kept apart from the providers themselves (no client here), the settings and the tests
// read it
export const DELIVERY_PROVIDER_NAMES = ['shippypro'] as const;

export type DeliveryProviderName = (typeof DELIVERY_PROVIDER_NAMES)[number];
