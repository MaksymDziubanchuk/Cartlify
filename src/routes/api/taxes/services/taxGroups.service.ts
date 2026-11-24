import { Prisma } from '@prisma/client';

import { writeShopSettings } from '@config/shopSettings.js';
import { getPgCode, getPgMessage, tx } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { BadRequestError, ConflictError, NotFoundError } from '@utils/errors.js';

import { settingsRefusalOf } from '@helpers/settingsRefusal.js';

import type {
  GetTaxGroupsResponseDto,
  PatchTaxGroupBodyDto,
  PostTaxGroupBodyDto,
  TaxGroupDto,
} from 'types/dto/taxes.dto.js';
import type { UserId } from 'types/ids.js';

// The tax groups of the products (docs/taxes.md): a kind of products with a rate of its own in
// every country that has rates. A group is written with its rates, under the lock of the data of the
// shop (writeShopSettings, which reads the countries again for the memory of the server); a group a
// product is in does not go.

type GroupRow = {
  id: number;
  name: string;
  products: bigint;
  exceptions: bigint;
  createdAt: Date;
  updatedAt: Date;
};

const groupDtoOf = (row: GroupRow): TaxGroupDto => ({
  id: row.id,
  name: row.name,
  products: Number(row.products),
  exceptions: Number(row.exceptions),
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

async function groupRows(db: Prisma.TransactionClient, id?: number): Promise<GroupRow[]> {
  return db.$queryRaw<GroupRow[]>`
    select g.id, g.name, g."createdAt", g."updatedAt",
      (select count(*) from cartlify.products as p where p."taxGroupId" = g.id) as products,
      (select count(*) from cartlify.products as p
         where exists (select 1 from jsonb_each(p."taxExceptions") as x where x.value = to_jsonb(g.id))
      ) as exceptions
    from cartlify.tax_groups as g
    where ${id ?? null}::int is null or g.id = ${id ?? null}::int
    order by g.name
  `;
}

export async function getTaxGroups(actorId: UserId): Promise<GetTaxGroupsResponseDto> {
  const rows = await tx(async (db) => {
    await setUserContext(db, { userId: actorId, role: 'ROOT' });
    return groupRows(db);
  });
  return { items: rows.map(groupDtoOf) };
}

const nameTaken = (err: unknown) => getPgCode(err) === '23505';

// a new group with its rate in every country that has rates, in force from the start: a country with
// rates the body leaves out, and one named without rates of its own, are refused
export async function postTaxGroup(args: {
  actorId: UserId;
  body: PostTaxGroupBodyDto;
}): Promise<TaxGroupDto> {
  let id = 0;

  try {
    await writeShopSettings({
      actorId: args.actorId,
      values: {},
      countries: async (db) => {
        const countries = await db.shopCountry.findMany({ select: { country: true, rates: true } });
        const withRates = countries.filter((c) => Array.isArray(c.rates) && c.rates.length > 0);

        const missing = withRates
          .map((c) => c.country)
          .filter((c) => args.body.rates[c] === undefined);
        if (missing.length)
          throw new BadRequestError('TAX_GROUP_RATES_MISSING', { countries: missing });

        const known = new Set(withRates.map((c) => c.country));
        const unknown = Object.keys(args.body.rates).filter((c) => !known.has(c));
        if (unknown.length)
          throw new BadRequestError('TAX_GROUP_RATES_UNKNOWN', { countries: unknown });

        const group = await db.taxGroup.create({ data: { name: args.body.name } });
        id = group.id;

        for (const c of withRates) {
          const rates = [
            ...(c.rates as Prisma.JsonArray),
            { group: id, rate: args.body.rates[c.country]!, from: null },
          ];
          await db.shopCountry.update({ where: { country: c.country }, data: { rates } });
        }
      },
    });
  } catch (err) {
    if (nameTaken(err)) throw new ConflictError('TAX_GROUP_NAME_TAKEN');
    throw settingsRefusalOf(err);
  }

  return groupOf(args.actorId, id);
}

async function groupOf(actorId: UserId, id: number): Promise<TaxGroupDto> {
  const [row] = await tx(async (db) => {
    await setUserContext(db, { userId: actorId, role: 'ROOT' });
    return groupRows(db, id);
  });
  if (!row) throw new NotFoundError('TAX_GROUP_NOT_FOUND');
  return groupDtoOf(row);
}

export async function patchTaxGroup(args: {
  actorId: UserId;
  id: number;
  body: PatchTaxGroupBodyDto;
}): Promise<TaxGroupDto> {
  try {
    await writeShopSettings({
      actorId: args.actorId,
      values: {},
      countries: async (db) => {
        const renamed = await db.taxGroup.updateMany({
          where: { id: args.id },
          data: { name: args.body.name },
        });
        if (renamed.count === 0) throw new NotFoundError('TAX_GROUP_NOT_FOUND');
      },
    });
  } catch (err) {
    if (nameTaken(err)) throw new ConflictError('TAX_GROUP_NAME_TAKEN');
    throw err;
  }

  return groupOf(args.actorId, args.id);
}

// a group goes with its rates in the countries; a group a product is in, as its group or as the
// class of a country, stays (409 TAX_GROUP_IN_USE)
export async function deleteTaxGroup(args: { actorId: UserId; id: number }): Promise<void> {
  try {
    await writeShopSettings({
      actorId: args.actorId,
      values: {},
      countries: async (db) => {
        const removed = await db.taxGroup.deleteMany({ where: { id: args.id } });
        if (removed.count === 0) throw new NotFoundError('TAX_GROUP_NOT_FOUND');
      },
    });
  } catch (err) {
    if (getPgMessage(err) === 'TAX_GROUP_IN_USE' || getPgCode(err) === '23503') {
      throw new ConflictError('TAX_GROUP_IN_USE');
    }
    throw err;
  }
}
