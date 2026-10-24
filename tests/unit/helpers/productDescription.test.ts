import { describe, expect, it } from '@jest/globals';

import {
  normalizeProductSafety,
  parseProductDescription,
  safetyFromFormFields,
  serializeProductDescription,
} from '@helpers/productDescription.js';

import { thrownBy } from '../../helpers/errors.js';

// the description of a product keeps its text and its safety and origin data (the EU GPSR) in one
// column: a json document of its own version with the data, the text alone without them

const maker = {
  name: 'Lampwerk GmbH',
  address: 'Lichtstrasse 4, Berlin',
  email: 'safety@lampwerk.example.com',
  country: 'DE',
};
const safety = { manufacturer: maker, responsiblePerson: null, warnings: null };

describe('parseProductDescription and serializeProductDescription', () => {
  it('keeps the text and the data in a json of version 1 and reads them back', () => {
    const raw = serializeProductDescription({ text: 'Warm light', safety });

    expect(JSON.parse(raw!)).toEqual({ v: 1, text: 'Warm light', safety });
    expect(parseProductDescription(raw)).toEqual({ text: 'Warm light', safety });
  });

  it('keeps a text without data as the text alone, and nothing as null', () => {
    expect(serializeProductDescription({ text: 'Warm light', safety: null })).toBe('Warm light');
    expect(serializeProductDescription({ text: null, safety: null })).toBeNull();
  });

  // a description from before the data, or a text that only looks like json
  it.each([
    ['a plain text', 'Warm light'],
    ['a text that starts like json', '{ not json'],
    ['json of another shape', '{"text":"x"}'],
  ])('reads %s as the text, with no data', (_case, raw) => {
    expect(parseProductDescription(raw)).toEqual({ text: raw, safety: null });
  });

  it('reads no description as nothing', () => {
    expect(parseProductDescription(null)).toEqual({ text: null, safety: null });
    expect(parseProductDescription('')).toEqual({ text: null, safety: null });
  });

  // a document of the version with a text that is no text, or data that are no object
  it('reads an empty or a not text text of the document as none, and a list as no data', () => {
    expect(parseProductDescription(JSON.stringify({ v: 1, text: '', safety }))).toEqual({
      text: null,
      safety,
    });
    expect(parseProductDescription(JSON.stringify({ v: 1, text: 5, safety }))).toEqual({
      text: null,
      safety,
    });
    expect(
      parseProductDescription(JSON.stringify({ v: 1, text: 'Lamp', safety: [maker] })),
    ).toEqual({ text: 'Lamp', safety: null });
  });
});

describe('normalizeProductSafety', () => {
  const codeOf = (input: unknown) => thrownBy(() => normalizeProductSafety(input));

  it('keeps the data trimmed, with an empty person and warnings as null', () => {
    expect(
      normalizeProductSafety({
        manufacturer: { ...maker, name: '  Lampwerk GmbH ' },
        responsiblePerson: { name: '', address: ' ', email: '' },
        warnings: '  ',
      }),
    ).toEqual(safety);
  });

  it('names every field of the manufacturer that is missing', () => {
    expect(codeOf(undefined)).toMatchObject({
      errorCode: 'PRODUCT_SAFETY_REQUIRED',
      details: {
        fields: [
          'safety.manufacturer.name',
          'safety.manufacturer.address',
          'safety.manufacturer.email',
          'safety.manufacturer.country',
        ],
      },
    });
  });

  // one field of a person makes the person: the other two are missing, by their full names
  it.each([
    ['a name', { name: 'EU Rep' }, ['address', 'email']],
    ['an address', { address: 'Prague' }, ['name', 'email']],
    ['an email', { email: 'rep@eu.example.com' }, ['name', 'address']],
  ])('wants the rest of a person who has only %s', (_case, person, rest) => {
    expect(codeOf({ manufacturer: maker, responsiblePerson: person })).toMatchObject({
      errorCode: 'PRODUCT_SAFETY_REQUIRED',
      details: { fields: rest.map((key) => `safety.responsiblePerson.${key}`) },
    });
  });

  // the longest values are kept, a sign more is refused
  it('keeps a name, an address and an email of the longest length and warnings of 2000 signs', () => {
    const email = `${'a'.repeat(241)}@lampwerk.com`;
    expect(email).toHaveLength(254);

    const out = normalizeProductSafety({
      manufacturer: { ...maker, name: 'n'.repeat(200), address: 'a'.repeat(500), email },
      warnings: 'w'.repeat(2000),
    });

    expect(out.manufacturer).toMatchObject({ name: 'n'.repeat(200), email });
    expect(out.warnings).toHaveLength(2000);
  });

  it.each([
    ['an address of 501 signs', { address: 'a'.repeat(501) }, 'safety.manufacturer.address'],
    [
      'an email of 255 signs',
      { email: `${'a'.repeat(242)}@lampwerk.com` },
      'safety.manufacturer.email',
    ],
  ])('refuses %s', (_case, change, field) => {
    expect(codeOf({ manufacturer: { ...maker, ...change } })).toMatchObject({
      errorCode: 'PRODUCT_SAFETY_INVALID',
      details: { fields: [field] },
    });
  });

  it('wants a responsible person whole', () => {
    expect(
      codeOf({ manufacturer: maker, responsiblePerson: { name: 'EU Rep', address: 'Prague' } }),
    ).toMatchObject({
      errorCode: 'PRODUCT_SAFETY_REQUIRED',
      details: { fields: ['safety.responsiblePerson.email'] },
    });
  });

  it.each([
    ['a country in small letters', { country: 'de' }, 'safety.manufacturer.country'],
    ['a country name', { country: 'Germany' }, 'safety.manufacturer.country'],
    ['an email without a domain', { email: 'safety@lampwerk' }, 'safety.manufacturer.email'],
    ['a name of 201 signs', { name: 'x'.repeat(201) }, 'safety.manufacturer.name'],
  ])('refuses %s', (_case, change, field) => {
    expect(codeOf({ manufacturer: { ...maker, ...change } })).toMatchObject({
      errorCode: 'PRODUCT_SAFETY_INVALID',
      details: { fields: [field] },
    });
  });

  it('refuses warnings of more than 2000 signs', () => {
    expect(codeOf({ manufacturer: maker, warnings: 'x'.repeat(2001) })).toMatchObject({
      errorCode: 'PRODUCT_SAFETY_INVALID',
      details: { fields: ['safety.warnings'] },
    });
  });

  // a manufacturer outside the EU names a person responsible in it; one inside needs none
  it('wants a person responsible in the EU only for a manufacturer outside it', () => {
    const outside = { ...maker, country: 'CN' };
    const person = { name: 'EU Rep', address: 'Prague', email: 'rep@eu.example.com' };

    expect(codeOf({ manufacturer: outside })).toMatchObject({
      errorCode: 'PRODUCT_EU_RESPONSIBLE_REQUIRED',
    });
    expect(normalizeProductSafety({ manufacturer: outside, responsiblePerson: person })).toEqual({
      manufacturer: outside,
      responsiblePerson: person,
      warnings: null,
    });
  });
});

describe('safetyFromFormFields', () => {
  it('turns the text fields of a form into the object of a json body', () => {
    const fields = new Map([
      ['safety.manufacturer.name', 'Lampwerk'],
      ['safety.manufacturer.country', 'DE'],
      ['safety.responsiblePerson.email', 'rep@eu.example.com'],
      ['safety.warnings', 'Hot.'],
    ]);

    expect(safetyFromFormFields(fields)).toEqual({
      manufacturer: { name: 'Lampwerk', country: 'DE' },
      responsiblePerson: { email: 'rep@eu.example.com' },
      warnings: 'Hot.',
    });
  });

  it('reads the safety fields of a form that has other fields too', () => {
    expect(
      safetyFromFormFields(
        new Map([
          ['name', 'Lamp'],
          ['safety.manufacturer.name', 'Lampwerk'],
        ]),
      ),
    ).toEqual({ manufacturer: { name: 'Lampwerk' }, responsiblePerson: {}, warnings: null });
  });

  it('gives nothing for a form without them', () => {
    expect(safetyFromFormFields(new Map([['name', 'Lamp']]))).toBeUndefined();
  });
});
