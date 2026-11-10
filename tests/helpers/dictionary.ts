import { readFileSync } from 'node:fs';
import path from 'node:path';

// The text a dictionary of the server (src/locales/<language>.json) gives for a key such as
// accountDeleted.newsletterEnded, no values filled in. A test of a mail in a language asks the
// dictionary for the sentence it expects, so a translation a native speaker corrects later does not
// break it, and a mail that came out in the wrong language still does
export function dictionaryText(locale: string, key: string): string {
  const file = path.join(process.cwd(), 'src', 'locales', `${locale}.json`);
  const dictionary: unknown = JSON.parse(readFileSync(file, 'utf8'));

  const text = key
    .split('.')
    .reduce<unknown>(
      (node, part) =>
        node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined,
      dictionary,
    );

  if (typeof text !== 'string' || text === '') throw new Error(`no text for ${key} in ${locale}`);
  return text;
}
