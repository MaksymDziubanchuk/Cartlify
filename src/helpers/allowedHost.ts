import { domainToASCII } from 'node:url';

// Whether the host of an address is one of the domains of a list or a subdomain of one: `shop.example`
// lets in `cdn.shop.example`, never `evilshop.example` or `shop.example.evil.test`. The one rule for
// the addresses written out in a text of a newsletter (foreignAddress.ts) and for the links to the
// sites root trusts (shopLink.ts). The domains are in lowercase and in the ASCII form (a name in
// letters of another alphabet is judged by its punycode form, as a browser reads it)

// the longest name of a host (RFC 1035): a longer one is no host of anybody
const HOST_MAX_LENGTH = 253;

// the name of a host as the address names it, without the dots at the end
export function withoutEndDots(host: string): string {
  let end = host.length;
  while (end > 0 && host[end - 1] === '.') end -= 1;

  return host.slice(0, end);
}

// The host is read the way a browser reads it (capitals, the dots at the end, a name of another
// alphabet in its punycode form); a host that cannot be read, or an address of the network (a number,
// `[::1]`), is none of them
export function isAllowedHost(host: string, domains: readonly string[]): boolean {
  if (host.length > HOST_MAX_LENGTH + 2) return false;

  const ascii = domainToASCII(withoutEndDots(host));
  if (!ascii) return false;

  return domains.some((domain) => ascii === domain || ascii.endsWith(`.${domain}`));
}
