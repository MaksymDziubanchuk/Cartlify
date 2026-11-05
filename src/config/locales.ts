import { readdirSync } from 'node:fs';
import path from 'node:path';

// the languages the server can answer in: one dictionary file per language, read from src the
// way the mail templates and the logo (until step 4) are, so a new language is a file plus a
// deploy, no change of code or of the database (notes/i18n-shop-steps.md, step 5). "en" is the
// base language and must be there; shopSettings.ts defaults enabledLocales to this whole list

export const LOCALES_DIR = path.join(process.cwd(), 'src', 'locales');

const LOCALE_FILE = /^([a-z]{2})\.json$/;

// the codes a folder of dictionaries gives, sorted, "en" required; a plain function of a path
// (not of LOCALES_DIR alone) so a test can give it a folder of its own, no mock of the filesystem
export function localesIn(dir: string): readonly string[] {
  const codes = readdirSync(dir)
    .map((name) => LOCALE_FILE.exec(name)?.[1])
    .filter((code): code is string => code !== undefined)
    .sort();

  if (!codes.includes('en')) {
    throw new Error(`the base dictionary (en.json) is missing in ${dir}`);
  }

  return codes;
}

export const AVAILABLE_LOCALES: readonly string[] = localesIn(LOCALES_DIR);

export function isAvailableLocale(code: string): boolean {
  return AVAILABLE_LOCALES.includes(code);
}
