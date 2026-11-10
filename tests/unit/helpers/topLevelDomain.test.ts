import { describe, expect, it } from '@jest/globals';

import { isTopLevelDomain } from '@helpers/topLevelDomain.js';

// Whether the last label of a name is a real top-level domain (the list of the package `tlds`, which
// follows the root zone of IANA): the matcher of the addresses in the texts of the newsletters reads
// a name with no path (`example.com`) as an address only when it ends with one
describe('isTopLevelDomain', () => {
  it.each([
    ['a country', 'de'],
    ['a generic zone', 'com'],
    ['a new generic zone', 'shop'],
    ['a zone that is also a file extension', 'zip'],
    ['a zone that is also a file extension (Moldova)', 'md'],
    ['a zone that is also a word', 'next'],
    ['capitals', 'COM'],
    ['mixed case', 'Org'],
    ['a name in letters of another alphabet', 'рф'],
    ['the same in capitals', 'РФ'],
    ['the punycode form of that name', 'xn--p1ai'],
    ['the punycode form in capitals', 'XN--P1AI'],
  ])('knows %s', (_name, label) => {
    expect(isTopLevelDomain(label)).toBe(true);
  });

  it.each([
    ['an empty label', ''],
    ['a letter', 'e'],
    ['a file extension', 'jpg'],
    ['a file extension of a page', 'html'],
    ['a reserved zone of tests', 'test'],
    ['a reserved zone of examples', 'example'],
    ['a name of a person', 'smith'],
    ['digits', '5'],
    ['a label with a dot', 'co.uk'],
    ['a punycode form of nothing known', 'xn--nothing'],
    ['spaces around a real zone', ' com '],
  ])('does not know %s', (_name, label) => {
    expect(isTopLevelDomain(label)).toBe(false);
  });
});
