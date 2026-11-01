import { describe, expect, it, jest } from '@jest/globals';

import { assertListTargets } from '@routes/api/products/services/helpers/listTargets.helper.js';

import { rejectedBy } from '../../../../../../helpers/errors.js';

// the party and the document an admin filters the list of products by have to be there: one query
// finds out, the first missing one is a 404 that names its id. The database is replaced here (the
// filters themselves: tests/integration/api/products/adminFilters.test.ts)

type Found = {
  manufacturer: boolean | null;
  euResponsible: boolean | null;
  document: boolean | null;
};

const dbThatFinds = (found: Found) => {
  const queryRaw = jest.fn<(...args: unknown[]) => Promise<Found[]>>(async () => [found]);
  return { db: { $queryRaw: queryRaw } as never, queryRaw };
};

const ALL_THERE: Found = { manufacturer: true, euResponsible: true, document: true };

describe('assertListTargets', () => {
  it('asks nothing when the list names no party and no document', async () => {
    const { db, queryRaw } = dbThatFinds(ALL_THERE);

    await assertListTargets(db, {});

    expect(queryRaw).not.toHaveBeenCalled();
  });

  it('asks once for everything the list names', async () => {
    const { db, queryRaw } = dbThatFinds(ALL_THERE);

    await assertListTargets(db, { manufacturerId: 1, euResponsibleId: 2, documentId: 3 });

    expect(queryRaw).toHaveBeenCalledTimes(1);
  });

  it('lets a list through when what it names is there', async () => {
    const { db } = dbThatFinds(ALL_THERE);

    await expect(assertListTargets(db, { manufacturerId: 1 })).resolves.toBeUndefined();
  });

  it.each([
    ['manufacturerId', { manufacturerId: 11 }, { manufacturer: false }, 'MANUFACTURER_NOT_FOUND'],
    [
      'euResponsibleId',
      { euResponsibleId: 12 },
      { euResponsible: false },
      'EU_RESPONSIBLE_NOT_FOUND',
    ],
    ['documentId', { documentId: 13 }, { document: false }, 'DOCUMENT_NOT_FOUND'],
  ] as const)(
    'answers 404 for a %s that is not there, and names its id',
    async (key, ids, missing, errorCode) => {
      const { db } = dbThatFinds({
        manufacturer: null,
        euResponsible: null,
        document: null,
        ...missing,
      });

      const err = await rejectedBy(() => assertListTargets(db, ids));

      expect(err).toMatchObject({
        statusCode: 404,
        errorCode,
        details: { [key]: ids[key as keyof typeof ids] },
      });
    },
  );

  // the first one of the manufacturer, the person responsible and the document that is missing
  it('names the manufacturer before the person responsible and the document', async () => {
    const { db } = dbThatFinds({ manufacturer: false, euResponsible: false, document: false });

    const err = await rejectedBy(() =>
      assertListTargets(db, { manufacturerId: 1, euResponsibleId: 2, documentId: 3 }),
    );

    expect(err).toMatchObject({
      errorCode: 'MANUFACTURER_NOT_FOUND',
      details: { manufacturerId: 1 },
    });
  });

  it('names the person responsible before the document', async () => {
    const { db } = dbThatFinds({ manufacturer: true, euResponsible: false, document: false });

    const err = await rejectedBy(() =>
      assertListTargets(db, { manufacturerId: 1, euResponsibleId: 2, documentId: 3 }),
    );

    expect(err).toMatchObject({
      errorCode: 'EU_RESPONSIBLE_NOT_FOUND',
      details: { euResponsibleId: 2 },
    });
  });

  it('passes the ids it was given to the query as parameters, never inside the text', async () => {
    const { db, queryRaw } = dbThatFinds(ALL_THERE);

    await assertListTargets(db, { manufacturerId: 4, documentId: 6 });

    const sql = queryRaw.mock.calls[0]![0] as { sql: string; values: unknown[] };
    expect(sql.values).toEqual([4, 6]);
    expect(sql.sql).not.toMatch(/\b[46]\b/);
  });
});
