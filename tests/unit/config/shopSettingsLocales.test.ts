import { describe, expect, it } from '@jest/globals';

import { removedLocalesOf } from '@config/shopSettings.js';

// The languages a write of the data of the shop takes away: the ones the rows held that the new set
// does not have. Each of them is a language whose people are left with no language (the reset of the
// newsletters, in the same transaction as the write)

describe('removedLocalesOf', () => {
  it('names the languages the new set leaves out, in the order the old set had them', () => {
    expect(removedLocalesOf(['en', 'uk', 'es'], ['en'])).toEqual(['uk', 'es']);
    expect(removedLocalesOf(['en', 'uk', 'es'], ['es', 'en'])).toEqual(['uk']);
  });

  it('names none when the set stays as it is, in whatever order', () => {
    expect(removedLocalesOf(['en', 'uk'], ['en', 'uk'])).toEqual([]);
    expect(removedLocalesOf(['en', 'uk'], ['uk', 'en'])).toEqual([]);
  });

  it('names none when languages are only added', () => {
    expect(removedLocalesOf(['en'], ['en', 'uk', 'es'])).toEqual([]);
  });

  it('names the one that goes when another comes in its place', () => {
    expect(removedLocalesOf(['en', 'uk'], ['en', 'es'])).toEqual(['uk']);
  });

  it('names a language once', () => {
    expect(removedLocalesOf(['uk', 'uk', 'en'], ['en'])).toEqual(['uk']);
  });

  it('names all of them when nothing is left', () => {
    expect(removedLocalesOf(['en', 'uk'], [])).toEqual(['en', 'uk']);
    expect(removedLocalesOf([], [])).toEqual([]);
  });
});
