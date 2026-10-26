import { describe, expect, it } from '@jest/globals';

import {
  acceptedOfState,
  documentIdsOfQuery,
} from '@routes/api/auth/services/helpers/oauthConsent.helper.js';

// the versions of the terms and of the contract a login by a provider starts with: the page sends
// them in the query of the start, the signed state carries them to the callback

describe('documentIdsOfQuery', () => {
  it('reads the ids of the start through commas, each once', () => {
    expect(documentIdsOfQuery('17,12,17')).toEqual([17, 12]);
  });

  it('gives none without the query', () => {
    expect(documentIdsOfQuery(undefined)).toEqual([]);
    expect(documentIdsOfQuery('')).toEqual([]);
  });
});

describe('acceptedOfState', () => {
  it('takes the ids the state carries', () => {
    expect(acceptedOfState({ accepted: [17, 12] })).toEqual([17, 12]);
  });

  it('gives none for a login started without them', () => {
    expect(acceptedOfState({})).toEqual([]);
  });

  it('leaves out what is not an id', () => {
    expect(acceptedOfState({ accepted: [1, '2', 0, 1.5, -3, null] })).toEqual([1]);
  });

  it('gives none for a value that is not a list', () => {
    expect(acceptedOfState({ accepted: '1,2' })).toEqual([]);
  });
});
