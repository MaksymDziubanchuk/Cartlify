import { Prisma } from '@prisma/client';

import { prisma } from '@db/client.js';
import { writeAdminAuditLog } from '@db/adminAudit.helper.js';
import { isEuCountry, normalizeParty, type PartyValues } from '@helpers/party.js';
import { BadRequestError, NotFoundError } from '@utils/errors.js';
import { MAX_ID } from '@schemas/idPathParam.js';
import { partySelect } from '@routes/api/parties/services/helpers/parties.helper.js';

import type { ProductPartyDto } from 'types/dto/products.dto.js';
import type { Role } from 'types/user.js';

// the manufacturer and the person responsible in the EU of a product (GPSR): parties of the
// directory (src/routes/api/parties). A product names them by their ids; a new product may bring
// a party that is not in the directory yet, which is added to it in the same transaction

type Tx = Prisma.TransactionClient;
type PartyRow = { id: number; name: string; address: string; email: string; country: string };
type Side = 'manufacturer' | 'euResponsible';

export type PartyChoice = { id: number } | { values: PartyValues };

const NOT_FOUND: Record<Side, string> = {
  manufacturer: 'MANUFACTURER_NOT_FOUND',
  euResponsible: 'EU_RESPONSIBLE_NOT_FOUND',
};

// the id of a party as a request gives it: a number (json) or the digits of a text field (form)
export function readPartyId(raw: unknown, field: string): number {
  const text = typeof raw === 'string' ? raw.trim() : raw;
  const id = typeof text === 'string' && /^[1-9][0-9]*$/.test(text) ? Number(text) : text;

  if (typeof id !== 'number' || !Number.isInteger(id) || id < 1 || id > MAX_ID) {
    throw new BadRequestError('PARTY_ID_INVALID', { field });
  }

  return id;
}

// what a request names for one side: the id of a party, or the values of a new one, never both
function choiceOf(side: Side, id: unknown, values: unknown, required: boolean): PartyChoice | null {
  const hasId = id !== undefined && id !== null;
  const hasValues = values !== undefined && values !== null;

  if (hasId && hasValues) throw new BadRequestError('PARTY_CHOICE_AMBIGUOUS', { field: side });
  if (hasId) return { id: readPartyId(id, `${side}Id`) };
  if (hasValues) return { values: normalizeParty(values, { path: side, required: true }) };

  if (required) throw new BadRequestError('MANUFACTURER_REQUIRED');
  return null;
}

// the parties a new product names, read and checked as far as the request alone tells: the
// manufacturer is required, the person in the EU is not
export function planCreateParties(input: {
  manufacturerId?: unknown;
  manufacturer?: unknown;
  euResponsibleId?: unknown;
  euResponsible?: unknown;
}): { manufacturer: PartyChoice; euResponsible: PartyChoice | null } {
  return {
    manufacturer: choiceOf('manufacturer', input.manufacturerId, input.manufacturer, true)!,
    euResponsible: choiceOf('euResponsible', input.euResponsibleId, input.euResponsible, false),
  };
}

// the rule of the EU: a manufacturer outside it names a person responsible in the EU, and that
// person is in the EU
export function assertEuRule(manufacturer: PartyRow, euResponsible: PartyRow | null): void {
  if (euResponsible && !isEuCountry(euResponsible.country)) {
    throw new BadRequestError('EU_RESPONSIBLE_NOT_IN_EU', { country: euResponsible.country });
  }
  if (!euResponsible && !isEuCountry(manufacturer.country)) {
    throw new BadRequestError('PRODUCT_EU_RESPONSIBLE_REQUIRED');
  }
}

// the parties by their ids, read under a shared lock that holds to the end of the transaction: the
// change of the country of a party waits for the product that names it (and the product for the
// change), so the rule of the EU cannot be broken between the check and the write
async function readPartiesShared(tx: Tx, ids: number[]): Promise<PartyRow[]> {
  if (!ids.length) return [];

  return tx.$queryRaw<PartyRow[]>(Prisma.sql`
    SELECT id, name, address, email, country FROM cartlify.parties
    WHERE id IN (${Prisma.join(ids)})
    ORDER BY id
    FOR SHARE
  `);
}

async function resolveChoice(
  tx: Tx,
  choice: PartyChoice,
  side: Side,
  actor: { actorId: number | string; actorRole: Role },
): Promise<PartyRow> {
  if ('id' in choice) {
    const [row] = await readPartiesShared(tx, [choice.id]);
    if (!row) throw new NotFoundError(NOT_FOUND[side]);
    return row;
  }

  // a new party goes to the directory with the line of the admin log a party of its own has
  const created = await tx.party.create({ data: choice.values, select: partySelect });
  await writeAdminAuditLog(tx, {
    actorId: actor.actorId,
    actorRole: actor.actorRole,
    entityType: 'party',
    entityId: created.id,
    action: 'OTHER',
    event: 'party.create',
    changes: [
      { field: 'name', old: null, new: created.name },
      { field: 'address', old: null, new: created.address },
      { field: 'email', old: null, new: created.email },
      { field: 'country', old: null, new: created.country },
    ],
  });
  return created;
}

// the parties of a new product, in the transaction that creates it
export async function resolveCreateParties(
  tx: Tx,
  plan: ReturnType<typeof planCreateParties>,
  actor: { actorId: number | string; actorRole: Role },
): Promise<{ manufacturer: PartyRow; euResponsible: PartyRow | null }> {
  const manufacturer = await resolveChoice(tx, plan.manufacturer, 'manufacturer', actor);
  const euResponsible = plan.euResponsible
    ? await resolveChoice(tx, plan.euResponsible, 'euResponsible', actor)
    : null;

  assertEuRule(manufacturer, euResponsible);
  return { manufacturer, euResponsible };
}

// the values of the parties of a plan that are new, for the failure that says which party of the
// directory already holds them
export const newPartyValuesOf = (plan: ReturnType<typeof planCreateParties>): PartyValues[] =>
  [plan.manufacturer, plan.euResponsible].flatMap((choice) =>
    choice && 'values' in choice ? [choice.values] : [],
  );

// a change of a product names its parties by their ids only (a new party comes by its own route);
// null takes the person in the EU away
export function planUpdateParties(input: { manufacturerId?: unknown; euResponsibleId?: unknown }): {
  manufacturerId?: number;
  euResponsibleId?: number | null;
} {
  return {
    ...(input.manufacturerId !== undefined
      ? { manufacturerId: readPartyId(input.manufacturerId, 'manufacturerId') }
      : {}),
    ...(input.euResponsibleId !== undefined
      ? {
          euResponsibleId:
            input.euResponsibleId === null || input.euResponsibleId === ''
              ? null
              : readPartyId(input.euResponsibleId, 'euResponsibleId'),
        }
      : {}),
  };
}

// the parties a product has after a change, checked against the rule of the EU; a party that is not
// in the directory is 404
export async function checkUpdatedParties(
  tx: Tx,
  before: { manufacturerId: number; euResponsibleId: number | null },
  change: { manufacturerId?: number; euResponsibleId?: number | null },
): Promise<void> {
  const manufacturerId = change.manufacturerId ?? before.manufacturerId;
  const euResponsibleId =
    change.euResponsibleId === undefined ? before.euResponsibleId : change.euResponsibleId;

  const ids = [manufacturerId, ...(euResponsibleId === null ? [] : [euResponsibleId])];
  const rows = await readPartiesShared(tx, [...new Set(ids)]);
  const byId = new Map(rows.map((row) => [row.id, row]));

  const manufacturer = byId.get(manufacturerId);
  if (!manufacturer) throw new NotFoundError(NOT_FOUND.manufacturer);

  const euResponsible = euResponsibleId === null ? null : (byId.get(euResponsibleId) ?? null);
  if (euResponsibleId !== null && !euResponsible) throw new NotFoundError(NOT_FOUND.euResponsible);

  assertEuRule(manufacturer, euResponsible);
}

export type ProductParties = {
  manufacturer: ProductPartyDto;
  euResponsible: ProductPartyDto | null;
};

// the parties of the products of an answer, read once for all of them; a party is read by
// everybody, so the read needs no context of its own
export async function readProductParties(
  products: Array<{ manufacturerId: number; euResponsibleId: number | null }>,
): Promise<(row: { manufacturerId: number; euResponsibleId: number | null }) => ProductParties> {
  const ids = new Set<number>();
  for (const product of products) {
    ids.add(product.manufacturerId);
    if (product.euResponsibleId !== null) ids.add(product.euResponsibleId);
  }

  const rows = ids.size
    ? await prisma.party.findMany({ where: { id: { in: [...ids] } }, select: partySelect })
    : [];
  const byId = new Map<number, ProductPartyDto>(
    rows.map((row) => [
      row.id,
      { id: row.id, name: row.name, address: row.address, email: row.email, country: row.country },
    ]),
  );

  return (row) => ({
    manufacturer: byId.get(row.manufacturerId)!,
    euResponsible: row.euResponsibleId === null ? null : (byId.get(row.euResponsibleId) ?? null),
  });
}
