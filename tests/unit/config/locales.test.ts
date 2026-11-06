import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from '@jest/globals';

import { AVAILABLE_LOCALES, isAvailableLocale, localesIn } from '@config/locales.js';

// one dictionary file per language the server answers in (src/locales/*.json); the folder is
// read once, at import, the way the mail templates and (until step 4) the logo are

describe('AVAILABLE_LOCALES', () => {
  it('lists the real folder of dictionaries, en among them', () => {
    expect(AVAILABLE_LOCALES).toContain('en');
    expect(isAvailableLocale('en')).toBe(true);
    expect(isAvailableLocale('xx')).toBe(false);
  });
});

describe('localesIn', () => {
  const dirs: string[] = [];

  const folderWith = (...files: string[]) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cartlify-locales-'));
    dirs.push(dir);
    for (const file of files) writeFileSync(path.join(dir, file), '{}');
    return dir;
  };

  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  it('lists the two-letter json files, sorted, and leaves out anything else', () => {
    const dir = folderWith('en.json', 'uk.json', 'README.md', 'ES.json', 'abc.json', 'e.json');

    expect(localesIn(dir)).toEqual(['en', 'uk']);
  });

  it('stops the start when the base dictionary is missing', () => {
    const dir = folderWith('uk.json');

    expect(() => localesIn(dir)).toThrow(/the base dictionary \(en\.json\) is missing/);
  });

  it('takes a folder of en alone', () => {
    const dir = folderWith('en.json');

    expect(localesIn(dir)).toEqual(['en']);
  });
});
