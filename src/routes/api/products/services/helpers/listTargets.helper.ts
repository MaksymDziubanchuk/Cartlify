import { Prisma } from '@prisma/client';

import { NotFoundError } from '@utils/errors.js';

import type { ProductListQuery } from './getAllProducts.helper.js';

// the records the filters by a party and by a document name have to be there: an id that is none of
// the directory is 404 (MANUFACTURER_NOT_FOUND, EU_RESPONSIBLE_NOT_FOUND, DOCUMENT_NOT_FOUND, as
// the neighbouring routes of the product say), not a list that happens to be empty. The first one
// that is missing is named, `details` holds its id. One query for the ids asked for
export async function assertListTargets(
  db: Pick<Prisma.TransactionClient, '$queryRaw'>,
  q: Pick<ProductListQuery, 'manufacturerId' | 'euResponsibleId' | 'documentId'>,
): Promise<void> {
  if (
    q.manufacturerId === undefined &&
    q.euResponsibleId === undefined &&
    q.documentId === undefined
  ) {
    return;
  }

  const [found] = await db.$queryRaw<
    { manufacturer: boolean | null; euResponsible: boolean | null; document: boolean | null }[]
  >(Prisma.sql`
    SELECT ${
      q.manufacturerId === undefined
        ? Prisma.sql`NULL::boolean`
        : Prisma.sql`EXISTS (SELECT 1 FROM "parties" WHERE "id" = ${q.manufacturerId})`
    } AS "manufacturer",
    ${
      q.euResponsibleId === undefined
        ? Prisma.sql`NULL::boolean`
        : Prisma.sql`EXISTS (SELECT 1 FROM "parties" WHERE "id" = ${q.euResponsibleId})`
    } AS "euResponsible",
    ${
      q.documentId === undefined
        ? Prisma.sql`NULL::boolean`
        : Prisma.sql`EXISTS (SELECT 1 FROM "documents" WHERE "id" = ${q.documentId})`
    } AS "document"
  `);

  if (found?.manufacturer === false) {
    throw new NotFoundError('MANUFACTURER_NOT_FOUND', { manufacturerId: q.manufacturerId });
  }
  if (found?.euResponsible === false) {
    throw new NotFoundError('EU_RESPONSIBLE_NOT_FOUND', { euResponsibleId: q.euResponsibleId });
  }
  if (found?.document === false) {
    throw new NotFoundError('DOCUMENT_NOT_FOUND', { documentId: q.documentId });
  }
}
