import { shopSettings } from '@config/shopSettings.js';
import { maskUrlSecrets } from '@helpers/maskUrlSecrets.js';

import type { FastifyBaseLogger } from 'fastify';

// the picture the html of a mail shows the logo by (cid:...); the template falls back to the
// name of the shop as text when there is none (src/services/email/templates/**/*.html)
export const SHOP_LOGO_CID = 'cartlify-logo';

// how long the fetch of the file from Cloudinary may take; a mail goes without the logo past it
const SHOP_LOGO_FETCH_TIMEOUT_MS = 8_000;

// after a failed fetch the mails of the next minute go without the logo at once: while Cloudinary
// is out of reach, each of them would otherwise wait the whole timeout first
const SHOP_LOGO_RETRY_AFTER_MS = 60_000;

export type ShopLogoAttachment = {
  content: string;
  type: string;
  filename: string;
  disposition: 'inline';
  content_id: string;
};

// the logo already fetched, kept by the url it came from: a new logo is always a new url
// (setShopLogo.service.ts), so a stale file is never served; removing the logo (url null) leaves
// the entry be, nothing asks for it again until a new logo gets the same url, which never happens
let cached: { url: string; attachment: ShopLogoAttachment } | null = null;
let failed: { url: string; at: number } | null = null;

function filenameOf(type: string): string {
  if (type === 'image/png') return 'logo.png';
  if (type === 'image/webp') return 'logo.webp';
  return 'logo.jpg';
}

// the logo of the shop as an inline attachment of a mail, fetched from Cloudinary and cached in
// memory until it changes; null while the shop has none, or when the fetch fails (the mail still
// goes, without it; the failure is only logged, src/services/email/sendEmail.helper.ts callers,
// and the next minute does not try again)
export async function shopLogoAttachment(
  log: Pick<FastifyBaseLogger, 'warn'>,
): Promise<ShopLogoAttachment | null> {
  const url = shopSettings().logoUrl;
  if (!url) return null;
  if (cached?.url === url) return cached.attachment;
  if (failed?.url === url && Date.now() - failed.at < SHOP_LOGO_RETRY_AFTER_MS) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SHOP_LOGO_FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`logo fetch answered ${res.status}`);

    const type = res.headers.get('content-type')?.split(';')[0]?.trim() || 'image/png';
    const content = Buffer.from(await res.arrayBuffer()).toString('base64');

    const attachment: ShopLogoAttachment = {
      content,
      type,
      filename: filenameOf(type),
      disposition: 'inline',
      content_id: SHOP_LOGO_CID,
    };
    cached = { url, attachment };
    failed = null;
    return attachment;
  } catch (err) {
    failed = { url, at: Date.now() };
    log.warn({ err, url: maskUrlSecrets(url) }, 'logo of the shop was not fetched for a mail');
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
