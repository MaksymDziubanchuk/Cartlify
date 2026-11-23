// The zones of the delivery (deliveryZones of the data of the shop): groups of countries, each with
// the price of the manual delivery there and the sum of the items from which every delivery there
// is free. The shop delivers to the countries of its zones, whatever the method: there is no other
// list of countries, and each of them has its record with customs and the tax (cartlify.
// shop_countries, docs/taxes.md)
export type DeliveryZone = {
  name: string;
  // two capital letters each
  countries: string[];
  // what the manual delivery to the zone costs, 0 or more; null: the manual delivery does not go
  // there (the carriers of the delivery provider still may)
  manualPrice: number | null;
  // from this sum of the items every delivery to the zone is free, the carriers too (the shop pays
  // the carrier); null: never
  freeFrom: number | null;
};

// where the parcels of the delivery provider go from (deliverySender): the person or the shop, the
// address and how the carrier reaches them
export type DeliverySender = {
  name: string;
  street: string;
  house: string;
  apartment: string | null;
  city: string;
  postalCode: string | null;
  country: string;
  phone: string;
  email: string;
};

// the zone a country is in: the one that names it; null when the shop does not deliver there
export function zoneOf(
  zones: readonly DeliveryZone[],
  country: string | null,
): DeliveryZone | null {
  if (!country) return null;
  return zones.find((zone) => zone.countries.includes(country)) ?? null;
}
