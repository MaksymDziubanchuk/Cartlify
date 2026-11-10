import { describe, expect, it } from '@jest/globals';

import { loggerOptions } from '@config/logger.js';

// the logger of the server and of the command of the newsletters (src/jobs/newsletterRun.ts) is
// configured in one place

describe('loggerOptions', () => {
  it('logs from the level info and hides the headers that carry a secret', () => {
    const options = loggerOptions();

    expect(options.level).toBe('info');
    expect(options.redact).toEqual([
      'req.headers.authorization',
      'request.headers.cookie',
      "res.headers['set-cookie']",
    ]);
  });

  it('writes plain json lines outside development (pretty lines are for a developer)', () => {
    // the tests run with NODE_ENV=test
    expect(loggerOptions().transport).toBeUndefined();
  });

  it('gives a new object every time, so one caller cannot change the config of another', () => {
    expect(loggerOptions()).not.toBe(loggerOptions());
  });
});
