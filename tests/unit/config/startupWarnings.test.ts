import { describe, expect, it } from '@jest/globals';

import { startupWarnings } from '@config/startupWarnings.js';

const SET = {
  NODE_ENV: 'development',
  STRIPE_WEBHOOK_SECRET: 'whsec_local',
  OPENAI_API_KEY: 'sk-x',
  REVIEW_CHECK_ENABLED: true,
};

describe('startupWarnings', () => {
  // in production env.ts stops the start instead, see tests/unit/config/env.test.ts
  it.each(['development', 'test'])(
    'warns in %s that stripe events are refused without the webhook secret',
    (mode) => {
      expect(startupWarnings({ ...SET, NODE_ENV: mode, STRIPE_WEBHOOK_SECRET: '' })).toEqual([
        'STRIPE_WEBHOOK_SECRET is not set: every stripe event is refused, no order becomes paid',
      ]);
    },
  );

  // the shop runs without openai, production too: the bot and the check of comments are off
  it.each(['development', 'test', 'production'])(
    'warns in %s that the bot and the check of the comments of reviews are off without the key of openai',
    (mode) => {
      expect(startupWarnings({ ...SET, NODE_ENV: mode, OPENAI_API_KEY: ' ' })).toEqual([
        'OPENAI_API_KEY is not set: the chat bot answers with a fixed text and the comments of ' +
          'reviews are published unchecked',
      ]);
    },
  );

  // a shop may keep the bot and leave the comments unchecked, production too
  it.each(['development', 'production'])(
    'warns in %s that the comments of reviews go unchecked when the check is off',
    (mode) => {
      expect(startupWarnings({ ...SET, NODE_ENV: mode, REVIEW_CHECK_ENABLED: false })).toEqual([
        'REVIEW_CHECK_ENABLED is false: the comments of reviews are published unchecked',
      ]);
    },
  );

  it('names each thing that is off once', () => {
    expect(startupWarnings({ ...SET, OPENAI_API_KEY: '', REVIEW_CHECK_ENABLED: false })).toEqual([
      'OPENAI_API_KEY is not set: the chat bot answers with a fixed text',
      'REVIEW_CHECK_ENABLED is false: the comments of reviews are published unchecked',
    ]);
  });

  it('says nothing when the settings are set', () => {
    expect(startupWarnings(SET)).toEqual([]);
  });

  it('never quotes a value of the settings', () => {
    const warnings = startupWarnings({ ...SET, STRIPE_WEBHOOK_SECRET: '', OPENAI_API_KEY: '' });

    expect(warnings).toHaveLength(2);
    expect(warnings.join(' ')).not.toContain('whsec_');
  });
});
