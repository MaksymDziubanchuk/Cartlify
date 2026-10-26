import { describe, expect, it } from '@jest/globals';

import { importWithEnv } from '../../helpers/freshImport.js';

type OpenApiConfig = typeof import('@config/openapi.js');

// the documentation names the shop it serves (SHOP_NAME, Cartlify unless set)
describe('openApiInfo', () => {
  it('names the shop', async () => {
    const { openApiInfo } = await importWithEnv<OpenApiConfig>('@config/openapi.js', {
      SHOP_NAME: 'Lamp House',
    });

    expect(openApiInfo).toMatchObject({
      title: 'Lamp House REST API',
      description: 'REST API documentation for Lamp House.',
    });
  });

  it('names Cartlify without the setting', async () => {
    const { openApiInfo } = await importWithEnv<OpenApiConfig>('@config/openapi.js', {
      SHOP_NAME: '',
    });

    expect(openApiInfo.title).toBe('Cartlify REST API');
  });
});
