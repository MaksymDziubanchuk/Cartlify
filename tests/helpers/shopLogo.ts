import path from 'node:path';

import env from '@config/env.js';

// the logo of the mails: the file SHOP_LOGO_PATH names, the one by default unless it is set.
// src/config/env.ts keeps it inside src/static, so /static serves it too
export const shopLogoFile = (): string => env.SHOP_LOGO_PATH;

export const shopLogoName = (): string => path.basename(env.SHOP_LOGO_PATH);

export const shopLogoType = (): string =>
  /\.png$/i.test(env.SHOP_LOGO_PATH) ? 'image/png' : 'image/jpeg';

// the address of the logo under /static
export const shopLogoUrl = (): string =>
  '/static/' +
  path
    .relative(path.resolve('src', 'static'), path.resolve(env.SHOP_LOGO_PATH))
    .split(path.sep)
    .join('/');
