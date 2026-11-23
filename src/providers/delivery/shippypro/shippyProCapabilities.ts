import { getShippyPro } from './shippyProClient.js';

// What ShippyPro can do with a carrier, as its public catalog of the carriers (v2) tells it: the
// entry with the same name as the carrier of the parcel, active and not legacy, and its
// capabilities. Whether it cancels a parcel at the carrier: VoidShipments answers OK for every
// carrier, but only a carrier with the service voidShipment cancels anything (for the others the
// parcel leaves the lists of ShippyPro and stays at the carrier). Whether it takes the customs
// papers electronically with the parcel: the service etd. The connections of the account (v2
// carrier-configs) are never read: they carry the credentials of the carriers of the owner

// an hour: the capabilities of a carrier change with a release of ShippyPro, not with an order
const CACHE_MS = 60 * 60 * 1000;

type CarrierServices = { voids: boolean; takesDocuments: boolean };

const NONE: CarrierServices = { voids: false, takesDocuments: false };

const known = new Map<string, CarrierServices & { until: number }>();

type CatalogEntry = { slug?: unknown; name?: unknown; status?: unknown; isLegacy?: unknown };

const entriesOf = (body: Record<string, unknown>): CatalogEntry[] =>
  Array.isArray(body.data) ? (body.data as CatalogEntry[]) : [];

async function readServices(carrierName: string): Promise<CarrierServices> {
  const catalog = await getShippyPro('/v2/carriers');
  const matches = entriesOf(catalog).filter(
    (entry) => entry.name === carrierName && entry.status === 'ACTIVE' && entry.isLegacy === false,
  );
  // none or more than one: the carrier cannot be told, the shop cancels it by hand
  if (matches.length !== 1 || typeof matches[0]!.slug !== 'string') return NONE;

  const body = await getShippyPro(
    `/v2/carriers/${encodeURIComponent(matches[0]!.slug)}/capabilities`,
  );
  const capabilities = (body.data && typeof body.data === 'object' ? body.data : body) as Record<
    string,
    unknown
  >;
  const services = capabilities.services as Record<string, { available?: unknown }> | undefined;

  return {
    voids: services?.voidShipment?.available === true,
    takesDocuments: services?.etd?.available === true,
  };
}

// what the carrier can do through ShippyPro; an answer that cannot be read is nothing
async function servicesOf(carrierName: string): Promise<CarrierServices> {
  const cached = known.get(carrierName);
  if (cached && cached.until > Date.now()) return cached;

  const services = await readServices(carrierName);
  known.set(carrierName, { ...services, until: Date.now() + CACHE_MS });
  return services;
}

// true when the carrier cancels a parcel ShippyPro voids
export const carrierVoids = async (carrierName: string): Promise<boolean> =>
  (await servicesOf(carrierName)).voids;

// true when the carrier takes a commercial invoice electronically with the parcel (UploadETD)
export const carrierTakesDocuments = async (carrierName: string): Promise<boolean> =>
  (await servicesOf(carrierName)).takesDocuments;
