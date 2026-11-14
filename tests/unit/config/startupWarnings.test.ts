import { describe, expect, it } from '@jest/globals';

import { startupWarnings } from '@config/startupWarnings.js';

const READY = { label: 'Models Inc', configured: true };
const NO_KEY = { label: 'Models Inc', configured: false };
const SET = { ai: READY, reviewCheckEnabled: true };

// the secrets of the webhook and of the codes of withdrawal stop the start instead, in every mode
// but the tests (tests/unit/config/env.test.ts); reviewCheckEnabled is read from the data of the
// shop (@config/shopSettings.js, root sets it), startupWarnings only names what it was at the
// moment src/index.ts called it
describe('startupWarnings', () => {
  // the shop runs without the models, production too: the bot and the check of comments are off
  it('warns that the bot and the check of the comments of reviews are off without the key of the provider of the models', () => {
    expect(startupWarnings({ ...SET, ai: NO_KEY })).toEqual([
      'Models Inc, the provider of the models, has no key: the chat bot answers with a fixed text ' +
        'and the comments of reviews are published unchecked',
    ]);
  });

  // a shop may keep the bot and leave the comments unchecked, production too
  it('warns that the comments of reviews go unchecked when the check is off', () => {
    expect(startupWarnings({ ...SET, reviewCheckEnabled: false })).toEqual([
      'reviewCheckEnabled is false (root set it, PUT /api/root/shop-settings): the comments of ' +
        'reviews are published unchecked',
    ]);
  });

  it('names each thing that is off once', () => {
    expect(startupWarnings({ ai: NO_KEY, reviewCheckEnabled: false })).toEqual([
      'Models Inc, the provider of the models, has no key: the chat bot answers with a fixed text',
      'reviewCheckEnabled is false (root set it, PUT /api/root/shop-settings): the comments of ' +
        'reviews are published unchecked',
    ]);
  });

  it('says nothing when the settings are set', () => {
    expect(startupWarnings(SET)).toEqual([]);
  });
});
