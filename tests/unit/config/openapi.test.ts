import { describe, expect, it } from '@jest/globals';

import { openApiInfo } from '@config/openapi.js';

// the title names the shop. shopName can change at runtime (root, PUT /api/root/shop-settings);
// the title is read once, when the server starts the swagger plugin, before the current data of
// the shop is loaded (src/app.ts registers it ahead of loadShopSettings), so it is fixed in code
// instead of reflecting the live name
describe('openApiInfo', () => {
  it('names the shop, fixed in code', () => {
    expect(openApiInfo).toMatchObject({
      title: 'Cartlify REST API',
      description: 'REST API documentation for Cartlify.',
    });
  });
});
