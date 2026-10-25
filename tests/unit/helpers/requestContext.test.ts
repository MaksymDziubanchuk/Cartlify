import { describe, expect, it } from '@jest/globals';

import { currentRequest, requestContext, requestContextOf } from '@helpers/requestContext.js';

// the request the work of the server is done for: its address and its browser go with the work,
// the admin log keeps them with each line
describe('requestContextOf', () => {
  it('takes the address and the browser of a request', () => {
    expect(
      requestContextOf({ ip: '203.0.113.7', headers: { 'user-agent': '  Test browser  ' } }),
    ).toEqual({ ip: '203.0.113.7', userAgent: 'Test browser' });
  });

  it('keeps no empty browser, and 500 signs of a long one', () => {
    expect(requestContextOf({ ip: '127.0.0.1', headers: { 'user-agent': '   ' } }).userAgent).toBe(
      null,
    );
    expect(requestContextOf({ ip: '127.0.0.1', headers: {} }).userAgent).toBe(null);
    expect(
      requestContextOf({ ip: '127.0.0.1', headers: { 'user-agent': 'x'.repeat(600) } }).userAgent,
    ).toHaveLength(500);
  });
});

describe('currentRequest', () => {
  it('is the request the work runs for, and none outside one', async () => {
    expect(currentRequest()).toBeNull();

    const inside = await requestContext.run({ ip: '198.51.100.1', userAgent: null }, async () => {
      await Promise.resolve();
      return currentRequest();
    });

    expect(inside).toEqual({ ip: '198.51.100.1', userAgent: null });
  });
});
