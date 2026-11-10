import { describe, expect, it } from '@jest/globals';

import { newsletterOfState } from '@routes/api/auth/services/helpers/oauthNewsletter.helper.js';

// the choice of the newsletter a login by a provider starts with: the page sends it in the query of
// the start, the signed state carries it to the callback, and only a verified state is read

describe('newsletterOfState', () => {
  it('is yes when the state carries the boolean true', () => {
    expect(newsletterOfState({ newsletter: true })).toBe(true);
  });

  it('is no for a login started without the choice', () => {
    expect(newsletterOfState({})).toBe(false);
  });

  it('is no for the boolean false', () => {
    expect(newsletterOfState({ newsletter: false })).toBe(false);
  });

  // only the value the start writes counts, whatever else a payload could hold
  it.each([['true'], [1], ['yes'], [null], [[true]], [{ yes: true }]])('is no for %j', (value) => {
    expect(newsletterOfState({ newsletter: value })).toBe(false);
  });
});
