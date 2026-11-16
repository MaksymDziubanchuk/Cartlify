import { getShippyPro } from './shippyProClient.js';

// Whether ShippyPro can cancel a parcel of a carrier at the carrier. VoidShipments answers OK for
// every carrier, but only a carrier with the service voidShipment cancels anything: for the others
// the parcel leaves the lists of ShippyPro and stays at the carrier. Told by the public catalog of
// the carriers (v2): the entry with the same name as the carrier of the parcel, active and not
// legacy, and its capabilities. The connections of the account (v2 carrier-configs) are never read:
// they carry the credentials of the carriers of the owner

// an hour: the capabilities of a carrier change with a release of ShippyPro, not with an order
const CACHE_MS = 60 * 60 * 1000;

const known = new Map<string, { voidable: boolean; until: number }>();

type CatalogEntry = { slug?: unknown; name?: unknown; status?: unknown; isLegacy?: unknown };

const entriesOf = (body: Record<string, unknown>): CatalogEntry[] =>
  Array.isArray(body.data) ? (body.data as CatalogEntry[]) : [];

async function readVoidable(carrierName: string): Promise<boolean> {
  const catalog = await getShippyPro('/v2/carriers');
  const matches = entriesOf(catalog).filter(
    (entry) => entry.name === carrierName && entry.status === 'ACTIVE' && entry.isLegacy === false,
  );
  // none or more than one: the carrier cannot be told, the shop cancels it by hand
  if (matches.length !== 1 || typeof matches[0]!.slug !== 'string') return false;

  const body = await getShippyPro(
    `/v2/carriers/${encodeURIComponent(matches[0]!.slug)}/capabilities`,
  );
  const capabilities = (body.data && typeof body.data === 'object' ? body.data : body) as Record<
    string,
    unknown
  >;
  const services = capabilities.services as Record<string, { available?: unknown }> | undefined;

  return services?.voidShipment?.available === true;
}

// true when the carrier cancels a parcel ShippyPro voids; an answer that cannot be read is false
export async function carrierVoids(carrierName: string): Promise<boolean> {
  const cached = known.get(carrierName);
  if (cached && cached.until > Date.now()) return cached.voidable;

  const voidable = await readVoidable(carrierName);
  known.set(carrierName, { voidable, until: Date.now() + CACHE_MS });
  return voidable;
}
