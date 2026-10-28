// the countries a shop may deliver to: the ones whose address the app takes whole, with a postal
// code of a form it knows and no region or state to ask for. The member states of the EU, the
// United Kingdom, Switzerland, Norway, Iceland, Liechtenstein and Ukraine. A shop names the ones it
// delivers to (DELIVERY_COUNTRIES), the others are refused

type PostalRule = {
  // the form of a code as a buyer writes it: capital letters, one space where spaces are
  pattern: RegExp;
  // the code as it is kept and printed
  format: string;
};

const digits = (count: number): PostalRule => ({
  pattern: new RegExp(`^(\\d{${count}})$`),
  format: '$1',
});

// two groups with a separator the buyer may leave out
const split = (first: RegExp, second: RegExp, separator: string): PostalRule => ({
  pattern: new RegExp(`^(${first.source})${separator === ' ' ? ' ?' : '-?'}(${second.source})$`),
  format: `$1${separator}$2`,
});

const RULES: Record<string, PostalRule> = {
  AT: digits(4),
  BE: digits(4),
  BG: digits(4),
  HR: digits(5),
  CY: digits(4),
  CZ: split(/\d{3}/, /\d{2}/, ' '),
  DK: digits(4),
  EE: digits(5),
  FI: digits(5),
  FR: digits(5),
  DE: digits(5),
  GR: split(/\d{3}/, /\d{2}/, ' '),
  HU: digits(4),
  // an Eircode: a routing key (the one of Dublin 6W apart) and a unique identifier
  IE: split(/[AC-FHKNPRTV-Y]\d{2}|D6W/, /[0-9AC-FHKNPRTV-Y]{4}/, ' '),
  IT: digits(5),
  LV: { pattern: /^(?:LV-?)?(\d{4})$/, format: 'LV-$1' },
  LT: { pattern: /^(?:LT-?)?(\d{5})$/, format: 'LT-$1' },
  LU: digits(4),
  MT: split(/[A-Z]{3}/, /\d{2,4}/, ' '),
  NL: split(/\d{4}/, /[A-Z]{2}/, ' '),
  PL: split(/\d{2}/, /\d{3}/, '-'),
  PT: split(/\d{4}/, /\d{3}/, '-'),
  RO: digits(6),
  SK: split(/\d{3}/, /\d{2}/, ' '),
  SI: digits(4),
  ES: digits(5),
  SE: split(/\d{3}/, /\d{2}/, ' '),
  GB: {
    // the outward code and the inward code; the one of the Girobank apart
    pattern: /^(GIR) ?(0AA)$|^([A-Z]{1,2}\d[A-Z\d]?) ?(\d[A-Z]{2})$/,
    format: '$1$3 $2$4',
  },
  CH: digits(4),
  NO: digits(4),
  IS: digits(3),
  LI: digits(4),
  UA: digits(5),
};

export const SUPPORTED_DELIVERY_COUNTRIES: readonly string[] = Object.keys(RULES);

export function isSupportedDeliveryCountry(code: string): boolean {
  return Object.hasOwn(RULES, code);
}

// the postal code of a country in the form it is kept in, or null when it is not a code of that
// country (a typo, a code of another country, a country the app does not know)
export function normalizePostalCode(country: string, raw: string): string | null {
  if (!isSupportedDeliveryCountry(country)) return null;

  const rule = RULES[country]!;
  const code = raw.trim().toUpperCase().replace(/\s+/g, ' ');
  if (!rule.pattern.test(code)) return null;

  return code.replace(rule.pattern, rule.format);
}
