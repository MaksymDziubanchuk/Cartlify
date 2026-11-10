import { isAllowedHost, withoutEndDots } from '@helpers/allowedHost.js';
import { parseMarkup, renderMarkupText } from '@helpers/newsletterMarkup.js';
import { isTopLevelDomain } from '@helpers/topLevelDomain.js';

// The addresses of other sites in a text that is going into a mail: a person who writes the text of
// a newsletter (or a model that translates it) may not send the readers to a site that is not the
// shop's, in a link or written out as plain text, which a mail program makes into a link. An address
// is read in four forms:
// - with a scheme: `http://...`, `https://...`, any `scheme://...`;
// - with www: `www.example.com`, with or without a path;
// - a domain with a path: `example.com/page`, whatever its zone is;
// - a domain with no path, or with a `?` or a `#` right after it: `example.com`, `example.com?x=1`.
//   Such a name is a word as much as an address (`e.g.`, `Mr.Smith`, `photo.jpg`, `3.5`), so it is
//   read only when its last label is a real top-level domain (topLevelDomain.ts). The list alone
//   decides: `photo.jpg` is quiet, while `file.zip`, `readme.md` and `done.Next` (no space after the
//   full stop) end with a zone and are read as addresses
// An address after an `@` is the address of a mail box, not of a site, and is not read. An address
// right after a colon (`site:example.com`, `see:example.com/page`) is read in every form like any other.
// Its host must be one of the domains given or a subdomain of one of them (allowedHost.ts). The
// domains are the shop's own and the ones root trusts (newsletterDomains.ts), in lowercase and in the
// ASCII form
//
// Nothing here reads the environment: the text and the domains come from the caller

// the signs that end an address in a run of text: a space, a quote, a bracket of any kind
const RUN = '[^\\s<>"\'`()[\\]{}]';

// `scheme://` and what follows: a host of version 6 in square brackets, then the rest of the run
const WITH_SCHEME = new RegExp(
  `(?<![a-z0-9+.-])[a-z][a-z0-9+.-]*:\\/\\/(?:\\[[^\\]\\s]*\\])?${RUN}*`,
  'giu',
);

// `www.` and what follows; not in the middle of a word, a path or an address of mail
const WITH_WWW = new RegExp(`(?<![\\p{L}\\p{N}@./\\\\-])www\\.${RUN}+`, 'giu');

// a domain (names of letters or digits and dashes, a zone of letters or in punycode, a dot at the
// end allowed) with a port and then a slash, so a path follows. Not after a letter, a digit, an
// `@`, a dot, a slash, a backslash or a dash: that is the middle of another word or of an address that
// has its own start. A colon is no such place: `site:example.com/page` is read as `example.com/page`
// is, and so are the other forms below
const LABEL = '[\\p{L}\\p{N}](?:[\\p{L}\\p{N}-]*[\\p{L}\\p{N}])?';
const ZONE = '(?:xn--[a-z0-9-]+|\\p{L}{2,63})';
const WITH_PATH = new RegExp(
  `(?<![\\p{L}\\p{N}@./\\\\-])(?:${LABEL}\\.)+${ZONE}\\.?(?::\\d{1,5})?\\/${RUN}*`,
  'giu',
);

// A name with no path: a domain as above and then a place where a name ends (not a letter, a digit, an
// underscore, a dash or an `@` right after it, which would make it the start of a longer name or the
// name in an address of mail, and not a dot and a letter, the next label). What follows a `?` or a `#`
// is the end of the run, which the code adds: the pattern stops at the name, so that an address inside
// a name that is no address is still read by its own start. Only a name with a real zone is kept
const WITH_ZONE = new RegExp(
  `(?<![\\p{L}\\p{N}@./\\\\-])(?:${LABEL}\\.)+${ZONE}\\.?(?::\\d{1,5})?(?![\\p{L}\\p{N}_@-])(?!\\.[\\p{L}\\p{N}])`,
  'giu',
);

// one sign of a run (the same signs as RUN, for a loop)
const RUN_SIGN = new RegExp(RUN, 'u');

// the signs a sentence or the markup puts after an address, which are no part of it
const AFTER_ADDRESS = new Set([...'.,;:!?*_~…。、！？']);

// the host of a bare address ends at the first of these
const END_OF_HOST = new Set([...'/?#:\\']);

// the address without the signs after it (a loop, not a pattern: a pattern for a long run of dots
// would try every start of the run)
function withoutTail(address: string): string {
  let end = address.length;
  while (end > 0 && AFTER_ADDRESS.has(address[end - 1]!)) end -= 1;

  return address.slice(0, end);
}

// where the address starts and ends in the text (the end is that of the whole run, signs after the
// address included), the address cleaned of those signs, and its host
type Candidate = {
  start: number;
  end: number;
  address: string;
  host: string | null;
  // a name with no path: a `?` or a `#` right after it starts a query or a fragment, which belong to
  // the address and run to the end of the run (withQuery)
  queryMayFollow?: true;
};

// the name with the query or the fragment after it, when there is one (the run goes on to the first
// sign that ends an address); its host is that of the name
function withQuery(text: string, name: Candidate): Candidate {
  if (text[name.end] !== '?' && text[name.end] !== '#') return name;

  let end = name.end + 1;
  while (end < text.length && RUN_SIGN.test(text[end]!)) end += 1;

  return { ...name, end, address: withoutTail(text.slice(name.start, end)) };
}

// the host of an address that has a scheme, null when the address cannot be parsed
function hostOfSchemeAddress(address: string): string | null {
  try {
    return new URL(address).hostname;
  } catch {
    return null;
  }
}

// the host of an address of the other forms: what is in front of the first slash, a port, a query
// or a fragment
function hostOfBareAddress(address: string): string {
  let end = 0;
  while (end < address.length && !END_OF_HOST.has(address[end]!)) end += 1;

  return address.slice(0, end);
}

// the last label of a host, the zone of a name
function lastLabelOf(host: string): string {
  const name = withoutEndDots(host);

  return name.slice(name.lastIndexOf('.') + 1);
}

// every place of the text that reads as an address, by its start (an address that is two of the forms
// at once, `www.example.com/x`, is one), in the order of the text
function candidatesOf(text: string): Candidate[] {
  const found = new Map<number, Candidate>();

  for (const match of text.matchAll(WITH_SCHEME)) {
    const address = withoutTail(match[0]);
    // `https://` and nothing after it is no address
    if (address.length <= address.indexOf('://') + 3) continue;

    found.set(match.index, {
      start: match.index,
      end: match.index + match[0].length,
      address,
      host: hostOfSchemeAddress(address),
    });
  }

  for (const match of text.matchAll(WITH_WWW)) {
    if (found.has(match.index)) continue;

    const address = withoutTail(match[0]);
    found.set(match.index, {
      start: match.index,
      end: match.index + match[0].length,
      address,
      host: hostOfBareAddress(address),
    });
  }

  for (const match of text.matchAll(WITH_PATH)) {
    if (found.has(match.index)) continue;

    const address = withoutTail(match[0]);
    found.set(match.index, {
      start: match.index,
      end: match.index + match[0].length,
      address,
      host: hostOfBareAddress(address),
    });
  }

  for (const match of text.matchAll(WITH_ZONE)) {
    if (found.has(match.index)) continue;

    // the name is judged by itself; the query or the fragment after it is added below, for the
    // names that are read (not for every name inside the run of another: that would read a long
    // run again at every name in it)
    const address = withoutTail(match[0]);
    const host = hostOfBareAddress(address);
    if (!isTopLevelDomain(lastLabelOf(host))) continue;

    found.set(match.index, {
      start: match.index,
      end: match.index + match[0].length,
      address,
      host,
      queryMayFollow: true,
    });
  }

  // a place inside the address before it is part of that address (a link in the query of another
  // link goes where the outer one goes), not one of its own
  const candidates: Candidate[] = [];
  let readUpTo = 0;

  for (const candidate of [...found.values()].sort((a, b) => a.start - b.start)) {
    if (candidate.start < readUpTo) continue;

    const read = candidate.queryMayFollow ? withQuery(text, candidate) : candidate;
    candidates.push(read);
    readUpTo = read.end;
  }

  return candidates;
}

// The addresses of the text that lead to a site that is not one of the domains, as they are written
// (without the signs a sentence puts after them), in the order of the text. An address that cannot be
// parsed is of another site: nobody can say where it leads
export function foreignAddressesOf(text: string, domains: readonly string[]): string[] {
  return candidatesOf(text)
    .filter(({ host }) => host === null || !isAllowedHost(host, domains))
    .map(({ address }) => address);
}

// the first address of another site in the text, or null when there is none
export function foreignAddressOf(text: string, domains: readonly string[]): string | null {
  return foreignAddressesOf(text, domains)[0] ?? null;
}

// The first address of another site in a text that is written in the markup of the newsletters, as it
// is typed and as the reader gets it. What is typed alone is not enough: a marker that splits a name
// (`ev**il**.com/deal`) or a sign the mail drops (a control sign) hides the address from the pattern,
// and the mail program of the reader, who gets `evil.com/deal`, makes a link of it. So the plain text
// of the mail (renderMarkupText, the very rendering of the text part) is read too. Its links are written
// as their labels: where a link leads is judged apart (linksOfMarkup), and the address a label spells is
// read. The text must be within the size of a markup (parseMarkup refuses a longer one)
export function foreignAddressOfMarkup(markup: string, domains: readonly string[]): string | null {
  const typed = foreignAddressOf(markup, domains);
  if (typed !== null) return typed;

  return foreignAddressOf(renderMarkupText(parseMarkup(markup), { origin: null }), domains);
}
