import { readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from '@jest/globals';

import env from '@config/env.js';
import { SHOP_LOGO_CID, shopLogoAttachment } from '@services/email/shopLogo.js';

// every mail shows the logo of the shop inline, the file SHOP_LOGO_PATH names (the logo of the
// project unless set), read for each mail

const DEFAULT_LOGO = env.SHOP_LOGO_PATH;

const base64Of = (file: string) => readFileSync(path.join(process.cwd(), file)).toString('base64');

afterEach(() => {
  env.SHOP_LOGO_PATH = DEFAULT_LOGO;
});

describe('shopLogoAttachment', () => {
  it('gives the logo of the project as an inline png', async () => {
    expect(await shopLogoAttachment()).toEqual({
      content: base64Of('src/static/images/logo3.png'),
      type: 'image/png',
      filename: 'logo3.png',
      disposition: 'inline',
      content_id: SHOP_LOGO_CID,
    });
  });

  it('gives the file the setting names, a jpeg as a jpeg', async () => {
    env.SHOP_LOGO_PATH = 'tests/fixtures/images/jpeg-baseline.jpg';

    expect(await shopLogoAttachment()).toMatchObject({
      content: base64Of('tests/fixtures/images/jpeg-baseline.jpg'),
      type: 'image/jpeg',
      filename: 'jpeg-baseline.jpg',
      disposition: 'inline',
    });
  });

  it('is the picture the html of a mail names', () => {
    expect(SHOP_LOGO_CID).toBe('cartlify-logo');
  });
});
