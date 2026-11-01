import { Prisma } from '@prisma/client';
import { getPgCode, prisma } from '@db/client.js';
import { ConflictError } from '@utils/errors.js';

import type { PartyDto, PartyUsageDto } from 'types/dto/parties.dto.js';

// how many product ids a refusal names, the rest is counted in details.total
export const NAMED_PRODUCTS_MAX = 20;

export const partySelect = {
  id: true,
  name: true,
  address: true,
  email: true,
  country: true,
  createdAt: true,
  updatedAt: true,
} as const;

type PartyRow = {
  id: number;
  name: string;
  address: string;
  email: string;
  country: string;
  createdAt: Date;
  updatedAt: Date;
};

export const mapPartyRow = (row: PartyRow): PartyDto => ({
  id: row.id,
  name: row.name,
  address: row.address,
  email: row.email,
  country: row.country,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

// how many products name each party, as their manufacturer and as their person in the EU. The
// products taken out of the catalog count: they still name the party and hold it in the directory
export async function usageOf(
  tx: Prisma.TransactionClient,
  partyIds: number[],
): Promise<Map<number, PartyUsageDto>> {
  const usage = new Map<number, PartyUsageDto>(
    partyIds.map((id) => [id, { manufacturerOf: 0, euResponsibleOf: 0 }]),
  );
  if (!partyIds.length) return usage;

  const makers = await tx.product.groupBy({
    by: ['manufacturerId'],
    where: { manufacturerId: { in: partyIds } },
    _count: { _all: true },
  });
  for (const row of makers) usage.get(row.manufacturerId)!.manufacturerOf = row._count._all;

  const persons = await tx.product.groupBy({
    by: ['euResponsibleId'],
    where: { euResponsibleId: { in: partyIds } },
    _count: { _all: true },
  });
  for (const row of persons) {
    if (row.euResponsibleId !== null)
      usage.get(row.euResponsibleId)!.euResponsibleOf = row._count._all;
  }

  return usage;
}

// what the products that name a party hold against a refusal: the ids of some of them and how many
export type NamingProducts = { manufacturerOf: number[]; euResponsibleOf: number[]; total: number };

// the products that name the party as their manufacturer (only the ones with no person in the EU
// when onlyBare is set) and the products that name it as their person in the EU, each as many ids
// as NAMED_PRODUCTS_MAX
export async function productsNaming(
  tx: Prisma.TransactionClient,
  partyId: number,
  scope: { manufacturer: boolean; euResponsible: boolean; onlyBare?: boolean },
): Promise<NamingProducts> {
  const makerWhere = {
    manufacturerId: partyId,
    ...(scope.onlyBare ? { euResponsibleId: null } : {}),
  };

  const makerIds = scope.manufacturer
    ? await tx.product.findMany({
        where: makerWhere,
        select: { id: true },
        orderBy: { id: 'asc' },
        take: NAMED_PRODUCTS_MAX,
      })
    : [];
  const makerTotal = scope.manufacturer ? await tx.product.count({ where: makerWhere }) : 0;

  const personIds = scope.euResponsible
    ? await tx.product.findMany({
        where: { euResponsibleId: partyId },
        select: { id: true },
        orderBy: { id: 'asc' },
        take: NAMED_PRODUCTS_MAX,
      })
    : [];
  const personTotal = scope.euResponsible
    ? await tx.product.count({ where: { euResponsibleId: partyId } })
    : 0;

  return {
    manufacturerOf: makerIds.map((row) => row.id),
    euResponsibleOf: personIds.map((row) => row.id),
    total: makerTotal + personTotal,
  };
}

// the row of the directory that a name, an address and a country already hold (letter case
// ignored), another than skipId; null when none
export async function findSameParty(
  values: { name: string; address: string; country: string },
  skipId?: number,
): Promise<number | null> {
  const rows = await prisma.$queryRaw<{ id: number }[]>(Prisma.sql`
    SELECT id FROM cartlify.parties
    WHERE lower(name) = lower(${values.name})
      AND lower(address) = lower(${values.address})
      AND country = ${values.country}
      ${skipId === undefined ? Prisma.empty : Prisma.sql`AND id <> ${skipId}`}
    LIMIT 1
  `);

  return rows[0]?.id ?? null;
}

const isUniqueViolation = (err: unknown) =>
  (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') ||
  getPgCode(err) === '23505';

// a failed write that is the unique index of the directory is 409 PARTY_ALREADY_EXISTS naming the
// party that holds the values; any other failure is returned as it is
export async function partyConflictOf(
  err: unknown,
  values: { name: string; address: string; country: string },
  skipId?: number,
): Promise<unknown> {
  if (!isUniqueViolation(err)) return err;

  const partyId = await findSameParty(values, skipId);
  return partyId === null ? err : new ConflictError('PARTY_ALREADY_EXISTS', { partyId });
}

export const isForeignKeyViolation = (err: unknown) =>
  (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2003') ||
  getPgCode(err) === '23503';
