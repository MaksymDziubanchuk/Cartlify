import { readFile } from 'node:fs/promises';
import path from 'node:path';

import env from '@config/env.js';

// the picture the html of a mail shows the logo by (cid:...)
export const SHOP_LOGO_CID = 'cartlify-logo';

// the logo of the shop as an inline attachment of a mail: the file SHOP_LOGO_PATH names (the logo
// of the project unless set), read for each mail
export async function shopLogoAttachment() {
  const file = path.resolve(process.cwd(), env.SHOP_LOGO_PATH);

  return {
    content: (await readFile(file)).toString('base64'),
    type: /\.png$/i.test(file) ? 'image/png' : 'image/jpeg',
    filename: path.basename(file),
    disposition: 'inline' as const,
    content_id: SHOP_LOGO_CID,
  };
}
