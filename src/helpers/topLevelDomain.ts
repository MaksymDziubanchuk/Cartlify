import { createRequire } from 'node:module';
import { domainToASCII } from 'node:url';

// Whether a label is a top-level domain of the root zone of the internet. The list is the package
// `tlds` (it follows the list of IANA and is renewed with the package), which holds the names of
// other alphabets in their letters; the set holds both forms, the letters and the punycode, so a name
// is found by whichever way it is written. A package whose main file is a list in JSON is not read by
// an `import` of the module system of node without a mark, so it is required
const nodeRequire = createRequire(import.meta.url);

const ZONES: ReadonlySet<string> = new Set(
  (nodeRequire('tlds') as string[]).flatMap((zone) => [zone, domainToASCII(zone)]),
);

// the zone is a bare label: a name with a dot, a space or nothing in it is none
export function isTopLevelDomain(label: string): boolean {
  if (!label) return false;

  return ZONES.has(label.toLowerCase());
}
