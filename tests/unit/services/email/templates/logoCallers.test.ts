import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from '@jest/globals';

// The logo goes into every mail of the project, and the template of a mail shows it only when the code
// that builds the mail gives it the address (logoUrl). This reads the code that builds mails and
// holds each place to it: a mail added later, or a call that forgot the logo, is found here and not
// in a mailbox

const SRC = path.join(process.cwd(), 'src');
const TEMPLATES = path.join(SRC, 'services', 'email', 'templates');

const filesUnder = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? filesUnder(path.join(dir, entry.name)) : [path.join(dir, entry.name)],
  );

const relative = (file: string) => path.relative(SRC, file).replaceAll('\\', '/');

// a file that imports the builder of the page of a mail
const IMPORTS_BUILDER =
  /\{[^}]*\b(?:build[A-Za-z]+Template|renderCampaignMail)\b[^}]*\} from '@services\/email\/templates\//g;
// a direct call of such a builder: buildOrderPaidTemplate({ ... }), renderCampaignMail({ ... })
const BUILDER_CALL = /\b(?:build[A-Za-z]+Template|renderCampaignMail)\(/g;
// what gives the logo to a call: the line itself, or the shared part of the arguments of a file that
// builds several mails the same way (the spread of common())
const GIVES_LOGO = /\blogoUrl: shopSettings\(\)\.logoUrl\b/g;
const SHARED_ARGUMENTS = /\.\.\.common\(/g;

const count = (source: string, pattern: RegExp) => (source.match(pattern) ?? []).length;

const builders = filesUnder(SRC)
  .filter((file) => file.endsWith('.ts') && !file.startsWith(TEMPLATES))
  .map((file) => ({ file, source: readFileSync(file, 'utf8') }))
  .filter(({ source }) => count(source, IMPORTS_BUILDER) > 0);

describe('the code that builds the mails', () => {
  it('finds the places that build the mails of the project', () => {
    // a rename of the builders must not make this test pass on nothing
    expect(builders.length).toBeGreaterThanOrEqual(16);
  });

  it.each(builders.map(({ file, source }) => [relative(file), source]))(
    '%s gives the address of the logo to every mail it builds',
    (_name, source) => {
      const gives = count(source!, GIVES_LOGO) + count(source!, SHARED_ARGUMENTS);

      // a file that picks its builder from a table (the status of an order) calls none by name
      expect(gives).toBeGreaterThanOrEqual(Math.max(1, count(source!, BUILDER_CALL)));
    },
  );

  it('has no attachment shown by a content id left in any of them', () => {
    for (const { source } of builders) {
      expect(source).not.toMatch(/logoCid|shopLogo|content_id/);
    }
  });
});
