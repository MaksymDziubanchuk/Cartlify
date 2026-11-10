import { shopSettings } from '@config/shopSettings.js';
import { siteDomain } from '@helpers/siteDomain.js';
import { webOrigin } from '@helpers/webOrigin.js';

// The sites a text of a newsletter may name besides the links of the shop (helpers/foreignAddress.ts
// judges an address by these): the shop's own, which are the domain of the site (SITE_DOMAIN) and the
// host of the frontend (WEB_ORIGIN, where every link of a mail leads), and the ones root trusts
// (`newsletterTrustedDomains` of the data of the shop, read at each call: root changes them while the
// server runs). A domain lets in its subdomains, `api.` and `www.` of the shop's among them. Without a
// site domain, a frontend and a trusted domain the list is empty and no address passes
export function newsletterAllowedDomains(): string[] {
  const own = [siteDomain, webOrigin ? new URL(webOrigin).hostname : null].filter(
    (domain): domain is string => Boolean(domain),
  );

  return [...new Set([...own, ...newsletterTrustedDomains()])];
}

// The sites root trusts and nothing else, read at each call too. A link of the markup or a button may
// lead to one (shopLink.ts) besides the shop itself, which has its origin to be judged by; a subdomain
// of the shop is no trusted site
export function newsletterTrustedDomains(): readonly string[] {
  return shopSettings().newsletterTrustedDomains;
}
