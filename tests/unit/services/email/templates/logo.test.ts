import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from '@jest/globals';

import { renderSource } from '@services/email/renderTemplate.js';

// The logo of the shop goes into every mail of the project the same way: an image whose address is
// the address of the logo at Cloudinary (`logoUrl`), with nothing attached to the mail, and the name of
// the shop in its place while the shop has no logo. These tests read the templates themselves, so a
// mail added later with the old way (an attachment shown by a content id) or without a logo at all
// does not get in unseen

const TEMPLATES = path.join(process.cwd(), 'src', 'services', 'email', 'templates');

const filesUnder = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? filesUnder(path.join(dir, entry.name)) : [path.join(dir, entry.name)],
  );

const all = filesUnder(TEMPLATES);
// the mails that have the whole page (the logo at its top); the pieces of a mail (the blocks a
// campaign is made of) and the plain text versions have none
const pages = all.filter((file) => {
  if (!file.endsWith('.html')) return false;
  return /<!doctype html>/i.test(readFileSync(file, 'utf8'));
});
// the builders of the pages: a `x.template.ts` that has its `x.html` page
const templates = all.filter(
  (file) =>
    file.endsWith('.template.ts') && pages.includes(file.replace(/\.template\.ts$/, '.html')),
);
const relative = (file: string) => path.relative(TEMPLATES, file).replaceAll('\\', '/');

describe('the logo in the templates of the mails', () => {
  it('finds the mails of the project', () => {
    // a template moved or renamed must not make this test pass on nothing
    expect(pages.length).toBeGreaterThanOrEqual(20);
    expect(templates.length).toBeGreaterThanOrEqual(20);
  });

  it.each(pages.map((file) => [relative(file), file]))(
    '%s shows the logo by its address, or the name of the shop',
    (_name, file) => {
      const html = readFileSync(file!, 'utf8');

      expect(html).toMatch(/\{\{#logoUrl\}\}<img src="\{\{logoUrl\}\}" alt="\{\{appName\}\}"/);
      expect(html).toContain('{{^logoUrl}}');
      expect(html).toContain('{{/logoUrl}}');
    },
  );

  it.each(all.map((file) => [relative(file), file]))(
    '%s has no attachment shown by a content id',
    (_name, file) => {
      const source = readFileSync(file!, 'utf8');

      expect(source).not.toContain('cid:');
      expect(source).not.toContain('logoCid');
    },
  );

  it.each(templates.map((file) => [relative(file), file]))(
    '%s takes the address of the logo',
    (_name, file) => {
      const source = readFileSync(file!, 'utf8');

      // an argument `logoUrl` that goes into the values of the page
      expect(source).toMatch(/logoUrl\?: string \| null;/);
      expect(source).toMatch(/logoUrl: args\.logoUrl\?\.trim\(\) \|\| ''/);
    },
  );

  describe('the page, rendered', () => {
    const page = readFileSync(path.join(TEMPLATES, 'auth', 'verifyEmail.html'), 'utf8');
    const render = (logoUrl: string) =>
      renderSource(
        page,
        {
          appName: 'Shop',
          supportEmail: '',
          verifyUrl: 'https://shop.example.com/x',
          userName: '',
          logoUrl,
          expiresInText: '',
          year: '2031',
          title: 't',
          preview: 'p',
          heading: 'h',
          body: 'b',
          button: 'Go',
          leadTxt: 'l',
          greeting: 'Hi',
          seller: '',
          validity: '',
          openLinkFallback: 'o',
          openLinkTxt: 'o',
          ignoreEmail: 'i',
          questionsIntro: 'q',
          orTo: 'or',
        },
        { html: true, name: 'verifyEmail.html' },
      );

    it('puts the address in the src of the image', () => {
      const logo = 'https://res.cloudinary.com/cartlify-test/image/upload/v1/test/shop/logo/a.png';

      expect(render(logo)).toContain(`<img src="${logo}" alt="Shop"`);
    });

    it('escapes the address, which must not break out of the attribute', () => {
      const html = render('https://x.test/a.png"><script>alert(1)</script>');

      expect(html).not.toContain('"><script>');
      expect(html).toContain('&lt;script&gt;');
    });

    it('shows the name of the shop and no image while the shop has no logo', () => {
      const html = render('');

      expect(html).not.toMatch(/<img\b/);
      expect(html).toContain('Shop');
    });
  });
});
