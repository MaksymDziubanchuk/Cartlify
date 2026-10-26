import { describe, expect, it } from '@jest/globals';

import {
  checkChosenVersions,
  requiredKinds,
} from '@routes/api/legal/services/helpers/legalConsent.helper.js';

import { thrownBy } from '../../../../../../helpers/errors.js';

// which kinds a customer still has to accept, and what a list of versions a customer sends means:
// every one has to be in force; a version that is no longer in force is LEGAL_VERSION_OUTDATED
// with the ones in force, one that is not there LEGAL_DOCUMENT_NOT_FOUND; a registration has to
// name every kind in force (LEGAL_ACCEPTANCE_REQUIRED). A refusal names the versions in force with
// their titles: the page shows a checkbox for each and opens its text by its id

const current = [
  { id: 7, kind: 'terms' as const, version: 3, title: 'Terms of use' },
  { id: 9, kind: 'contract' as const, version: 2, title: 'Sales contract' },
];

describe('requiredKinds', () => {
  it('names the kinds whose version in force the customer did not accept, terms first', () => {
    expect(requiredKinds(current, new Map())).toEqual(['terms', 'contract']);
    expect(requiredKinds(current, new Map([['contract', 9]]))).toEqual(['terms']);
    expect(
      requiredKinds(
        current,
        new Map([
          ['terms', 7],
          ['contract', 9],
        ]),
      ),
    ).toEqual([]);
  });

  it('takes an older version accepted as not accepted', () => {
    expect(
      requiredKinds(
        current,
        new Map([
          ['terms', 5],
          ['contract', 9],
        ]),
      ),
    ).toEqual(['terms']);
  });

  it('asks for nothing while no version is in force', () => {
    expect(requiredKinds([], new Map())).toEqual([]);
  });
});

describe('checkChosenVersions', () => {
  const known = new Set([5, 7, 9]);

  it('takes versions in force', () => {
    expect(() => checkChosenVersions(current, [9, 7], known, { every: true })).not.toThrow();
    expect(() => checkChosenVersions(current, [7], known, { every: false })).not.toThrow();
  });

  it('answers LEGAL_DOCUMENT_NOT_FOUND for a version that is not there', () => {
    expect(
      thrownBy(() => checkChosenVersions(current, [7, 40], known, { every: false })),
    ).toMatchObject({
      statusCode: 404,
      errorCode: 'LEGAL_DOCUMENT_NOT_FOUND',
      details: { documentIds: [40] },
    });
  });

  it('answers LEGAL_VERSION_OUTDATED with the versions in force for an older one', () => {
    expect(thrownBy(() => checkChosenVersions(current, [5, 9], known, { every: false }))).toEqual(
      expect.objectContaining({
        statusCode: 409,
        errorCode: 'LEGAL_VERSION_OUTDATED',
        details: { current },
      }),
    );
  });

  it('asks a registration for every kind in force and names the versions in force', () => {
    expect(thrownBy(() => checkChosenVersions(current, [7], known, { every: true }))).toEqual(
      expect.objectContaining({
        statusCode: 400,
        errorCode: 'LEGAL_ACCEPTANCE_REQUIRED',
        details: { kinds: ['contract'], current },
      }),
    );
    expect(thrownBy(() => checkChosenVersions(current, [], known, { every: true }))).toMatchObject({
      details: { kinds: ['terms', 'contract'], current },
    });
  });

  it('asks nothing while no version is in force', () => {
    expect(() => checkChosenVersions([], [], new Set(), { every: true })).not.toThrow();
  });
});
