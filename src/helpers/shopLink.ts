import { isAllowedHost } from '@helpers/allowedHost.js';

// The one place that decides where a link of a newsletter may lead: to the shop, or to a site root
// trusts (the domains of the setting newsletterTrustedDomains, subdomains included), and nowhere else.
// It judges the links in the text of an admin, the buttons and every address a mail is built with, so
// an account of an admin that was stolen cannot send the subscribers to another site
//
// A link is allowed when it is an absolute address whose origin is the one of the shop (the same
// scheme, host and port, no user name), or a path of the shop that starts with a slash but not with
// two (that is an address of another host). The text may not hold a space, a control sign, a sign
// that is invisible or a backslash: a browser reads `/\host` as `//host`, drops a tab or a new line
// inside an address (`java<tab>script:`) and a zero width sign hides what an address says, so none
// of them is left for the parser of addresses to deal with. A site root trusts is an absolute address
// of http or https, with no user name; a path is always the shop's

// the longest address a page of the shop needs
export const SHOP_LINK_MAX_LENGTH = 2000;

// the signs an address of a newsletter may not hold: controls, the invisible ones that format (zero
// width signs, marks of direction, the soft hyphen), every kind of space and a backslash
const FORBIDDEN_SIGN = /[\p{Cc}\p{Cf}\p{Z}\\]/u;

// The address a link leads to, the way the browser reads it, or null when the link is not allowed.
// origin is the origin of the shop (WEB_ORIGIN, without a path); without it no link is allowed,
// because an address cannot be built
export function shopLinkOf(url: string, origin: string | null): string | null {
  if (typeof url !== 'string' || !origin) return null;
  if (url.length === 0 || url.length > SHOP_LINK_MAX_LENGTH) return null;
  if (FORBIDDEN_SIGN.test(url)) return null;

  try {
    if (url.startsWith('/')) {
      // two slashes are an address of another host, whatever the host is
      if (url.startsWith('//')) return null;

      const resolved = new URL(url, origin);
      return resolved.origin === origin ? resolved.href : null;
    }

    if (!/^https?:\/\//i.test(url)) return null;

    const absolute = new URL(url);
    if (absolute.origin !== origin || absolute.username || absolute.password) return null;

    return absolute.href;
  } catch {
    return null;
  }
}

// The address a link leads to when it goes to a site root trusts, the way the browser reads it, or null
// when it does not: an absolute address of http or https whose host is one of the domains or a
// subdomain of one (allowedHost.ts), with no user name. The domains are lowercase, in the ASCII form
export function trustedLinkOf(url: string, domains: readonly string[]): string | null {
  if (typeof url !== 'string' || domains.length === 0) return null;
  if (url.length === 0 || url.length > SHOP_LINK_MAX_LENGTH) return null;
  if (FORBIDDEN_SIGN.test(url) || !/^https?:\/\//i.test(url)) return null;

  try {
    const absolute = new URL(url);
    if (absolute.username || absolute.password) return null;

    return isAllowedHost(absolute.hostname, domains) ? absolute.href : null;
  } catch {
    return null;
  }
}

// whether a link may be in a newsletter: of the shop (shopLinkOf) or of a site root trusts
export function isLinkAllowed(
  url: string,
  origin: string | null,
  trusted: readonly string[],
): boolean {
  return shopLinkOf(url, origin) !== null || trustedLinkOf(url, trusted) !== null;
}

// an address of the shop with the marks that tell the analytics of the shop a visit came from a
// newsletter; a mark of the address that was there is replaced, not doubled
export function markedLink(url: string, campaignId: number): string {
  const marked = new URL(url);
  marked.searchParams.set('utm_source', 'newsletter');
  marked.searchParams.set('utm_campaign', String(campaignId));

  return marked.href;
}
