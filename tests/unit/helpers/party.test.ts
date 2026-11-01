import { describe, expect, it } from '@jest/globals';

import {
  EU_COUNTRIES,
  PARTY_LIMITS,
  WARNINGS_MAX,
  isEuCountry,
  normalizeParty,
  normalizeWarnings,
  partyFromFormFields,
} from '@helpers/party.js';

import { thrownBy } from '../../helpers/errors.js';

// a manufacturer or a person responsible in the EU: a name, a postal address, an email and a
// country, all four, the way the directory keeps them

const party = {
  name: 'Lampwerk GmbH',
  address: 'Lichtstrasse 4, Berlin',
  email: 'safety@lampwerk.example.com',
  country: 'DE',
};

const failure = (run: () => unknown) => thrownBy(run);

describe('isEuCountry', () => {
  it('knows the 27 countries of the EU and no other', () => {
    expect(EU_COUNTRIES).toHaveLength(27);
    expect(isEuCountry('ES')).toBe(true);
    expect(isEuCountry('DE')).toBe(true);
    expect(isEuCountry('CN')).toBe(false);
    expect(isEuCountry('GB')).toBe(false);
    expect(isEuCountry('UA')).toBe(false);
    expect(isEuCountry('')).toBe(false);
  });
});

describe('normalizeParty', () => {
  it('keeps the four values and trims them', () => {
    expect(
      normalizeParty(
        {
          name: '  Lampwerk GmbH ',
          address: ' Lichtstrasse 4, Berlin',
          email: ' a@b.co ',
          country: 'DE',
        },
        { path: 'manufacturer', required: true },
      ),
    ).toEqual({
      name: 'Lampwerk GmbH',
      address: 'Lichtstrasse 4, Berlin',
      email: 'a@b.co',
      country: 'DE',
    });
  });

  it('writes a country in small letters in capitals', () => {
    expect(normalizeParty({ ...party, country: 'de' }, { path: 'x', required: true }).country).toBe(
      'DE',
    );
  });

  it('names every value that is missing, an empty one too, in the order of the fields', () => {
    expect(
      failure(() => normalizeParty(undefined, { path: 'manufacturer', required: true })),
    ).toMatchObject({
      errorCode: 'PARTY_FIELDS_REQUIRED',
      details: {
        fields: [
          'manufacturer.name',
          'manufacturer.address',
          'manufacturer.email',
          'manufacturer.country',
        ],
      },
    });

    expect(
      failure(() =>
        normalizeParty(
          { name: '   ', address: '', email: party.email, country: party.country },
          { path: 'euResponsible', required: true },
        ),
      ),
    ).toMatchObject({
      errorCode: 'PARTY_FIELDS_REQUIRED',
      details: { fields: ['euResponsible.name', 'euResponsible.address'] },
    });
  });

  it('keeps the longest values and refuses a sign more, counting the signs a person sees', () => {
    const email = `${'a'.repeat(PARTY_LIMITS.email - 'b@c.de'.length - 1)}@b.co`;

    expect(
      normalizeParty(
        {
          name: 'x'.repeat(PARTY_LIMITS.name),
          address: 'y'.repeat(PARTY_LIMITS.address),
          email: `${email}`.slice(0, PARTY_LIMITS.email),
          country: 'PT',
        },
        { path: 'p', required: true },
      ).name,
    ).toHaveLength(PARTY_LIMITS.name);

    // two code points that an emoji of two code units makes, 200 of them: 400 units, 200 signs
    expect(
      normalizeParty(
        { ...party, name: '\u{1F600}'.repeat(PARTY_LIMITS.name) },
        { path: 'p', required: true },
      ).name,
    ).toHaveLength(PARTY_LIMITS.name * 2);

    expect(
      failure(() =>
        normalizeParty(
          { ...party, name: 'x'.repeat(PARTY_LIMITS.name + 1) },
          { path: 'p', required: true },
        ),
      ),
    ).toMatchObject({ errorCode: 'PARTY_FIELDS_INVALID', details: { fields: ['p.name'] } });

    expect(
      failure(() =>
        normalizeParty(
          { ...party, address: 'y'.repeat(PARTY_LIMITS.address + 1) },
          { path: 'p', required: true },
        ),
      ),
    ).toMatchObject({ errorCode: 'PARTY_FIELDS_INVALID', details: { fields: ['p.address'] } });
  });

  it.each([
    ['an email without an at sign', { email: 'safety.lampwerk.com' }, 'email'],
    ['an email without a domain', { email: 'safety@lampwerk' }, 'email'],
    ['an email with a space', { email: 'saf ety@lampwerk.com' }, 'email'],
    ['an email longer than 254 signs', { email: `${'a'.repeat(250)}@b.co` }, 'email'],
    ['a country name', { country: 'Germany' }, 'country'],
    ['a country of one letter', { country: 'D' }, 'country'],
    ['a country with a digit', { country: 'D1' }, 'country'],
    ['a name that is not text', { name: 5 }, 'name'],
    ['an address that is not text', { address: ['Berlin'] }, 'address'],
  ])('refuses %s', (_case, change, field) => {
    expect(
      failure(() => normalizeParty({ ...party, ...change }, { path: 'p', required: true })),
    ).toMatchObject({
      errorCode: 'PARTY_FIELDS_INVALID',
      details: { fields: [`p.${field}`] },
    });
  });

  it('names a missing value before a wrong one when a request has both', () => {
    expect(
      failure(() =>
        normalizeParty({ ...party, name: '', email: 'wrong' }, { path: 'p', required: true }),
      ),
    ).toMatchObject({ errorCode: 'PARTY_FIELDS_REQUIRED', details: { fields: ['p.name'] } });
  });

  describe('for a change', () => {
    it('gives only the values that were named, trimmed', () => {
      expect(normalizeParty({ address: ' New Street 1 ' }, { path: '', required: false })).toEqual({
        address: 'New Street 1',
      });
      expect(normalizeParty({}, { path: '', required: false })).toEqual({});
      expect(normalizeParty(undefined, { path: '', required: false })).toEqual({});
    });

    it('refuses a value that was named and is empty, and a wrong one', () => {
      expect(
        failure(() => normalizeParty({ name: '  ' }, { path: '', required: false })),
      ).toMatchObject({
        errorCode: 'PARTY_FIELDS_INVALID',
        details: { fields: ['name'] },
      });
      expect(
        failure(() =>
          normalizeParty({ email: 'wrong', country: 'XYZ' }, { path: '', required: false }),
        ),
      ).toMatchObject({
        errorCode: 'PARTY_FIELDS_INVALID',
        details: { fields: ['email', 'country'] },
      });
    });
  });
});

describe('normalizeWarnings', () => {
  it('gives null for none, for an empty text and for text of spaces', () => {
    expect(normalizeWarnings(undefined)).toBeNull();
    expect(normalizeWarnings(null)).toBeNull();
    expect(normalizeWarnings('')).toBeNull();
    expect(normalizeWarnings('   ')).toBeNull();
  });

  it('trims the text and keeps up to 2000 signs', () => {
    expect(normalizeWarnings('  Keep away from fire ')).toBe('Keep away from fire');
    expect(normalizeWarnings('x'.repeat(WARNINGS_MAX))).toHaveLength(WARNINGS_MAX);
  });

  it('refuses more than 2000 signs and a value that is not text', () => {
    expect(failure(() => normalizeWarnings('x'.repeat(WARNINGS_MAX + 1)))).toMatchObject({
      errorCode: 'PRODUCT_WARNINGS_TOO_LONG',
      details: { max: WARNINGS_MAX },
    });
    expect(failure(() => normalizeWarnings(5))).toMatchObject({
      errorCode: 'PRODUCT_WARNINGS_INVALID',
    });
  });
});

describe('partyFromFormFields', () => {
  const fields = new Map([
    ['manufacturer.name', 'Lampwerk GmbH'],
    ['manufacturer.address', 'Lichtstrasse 4, Berlin'],
    ['manufacturer.email', 'safety@lampwerk.example.com'],
    ['manufacturer.country', 'DE'],
    ['euResponsible.name', 'EU Rep'],
    ['name', 'not a part of a party'],
  ]);

  it('gathers the fields under a prefix into an object', () => {
    expect(partyFromFormFields(fields, 'manufacturer')).toEqual(party);
    expect(partyFromFormFields(fields, 'euResponsible')).toEqual({ name: 'EU Rep' });
  });

  it('gives undefined when the form has no field under the prefix', () => {
    expect(partyFromFormFields(new Map([['name', 'x']]), 'manufacturer')).toBeUndefined();
    expect(partyFromFormFields(new Map(), 'euResponsible')).toBeUndefined();
  });

  it('does not take a prefix that only starts like the one asked', () => {
    expect(partyFromFormFields(new Map([['manufacturerId', '4']]), 'manufacturer')).toBeUndefined();
  });
});
