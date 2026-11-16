import { isSupportedDeliveryCountry, SUPPORTED_DELIVERY_COUNTRIES } from './deliveryCountries.js';

// The zones of the delivery (deliveryZones of the data of the shop): groups of countries, each with
// the price of the manual delivery there and the sum of the items from which every delivery there
// is free. The shop delivers to the countries of its zones, whatever the method: there is no other
// list of countries (docs/shop-settings.md)
export type DeliveryZone = {
  name: string;
  // two capital letters each; or 'rest', every country the app delivers to that no other zone names
  countries: string[] | 'rest';
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

const named = (zones: readonly DeliveryZone[]): Set<string> =>
  new Set(zones.flatMap((zone) => (zone.countries === 'rest' ? [] : zone.countries)));

// the zone a country is in: the one that names it, else the zone of the rest for a country the app
// delivers to; null when the shop does not deliver there
export function zoneOf(
  zones: readonly DeliveryZone[],
  country: string | null,
): DeliveryZone | null {
  if (!country) return null;

  const own = zones.find((zone) => zone.countries !== 'rest' && zone.countries.includes(country));
  if (own) return own;

  const rest = zones.find((zone) => zone.countries === 'rest');
  return rest && isSupportedDeliveryCountry(country) && !named(zones).has(country) ? rest : null;
}

// the countries of a zone as a list: the ones it names, or for the zone of the rest every country
// the app delivers to that no other zone names
export function countriesOfZone(zones: readonly DeliveryZone[], zone: DeliveryZone): string[] {
  if (zone.countries !== 'rest') return [...zone.countries];

  const taken = named(zones);
  return SUPPORTED_DELIVERY_COUNTRIES.filter((country) => !taken.has(country));
}
