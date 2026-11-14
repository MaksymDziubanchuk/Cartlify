import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from '@jest/globals';

// Every provider of an outside service lives in its own folder (src/providers/<kind>/<name>/,
// src/providers/provider.ts): its name, its sdk and its addresses stay there, and the rest of the
// app knows only the interface of its kind. This reads the code and holds every file to it, so a
// provider can be replaced or joined by another one without touching the rest of the app

const SRC = path.join(process.cwd(), 'src');
const PROVIDERS = path.join(SRC, 'providers');

// the kinds of outside services; a kind keeps the names of its providers in names.ts
const KINDS = ['payments', 'mail', 'files', 'ai', 'captcha', 'identity'] as const;

// the files that may name a provider though they are not its own: the settings of env (the names
// of the variables of each provider), and the registry and the names of its kind
const ALLOWED = (kind: string) => [
  'config/env.ts',
  `providers/${kind}/index.ts`,
  `providers/${kind}/names.ts`,
];

// the files that name a word of a provider for something else than the provider: the mail domain
// googlemail.com, which is gmail.com (the addresses of the newsletters), and the wallet Google Pay of
// the payment page of Stripe
const OTHER_MEANING: Record<string, readonly string[]> = {
  google: [
    'helpers/newsletterTokens.ts',
    'plugins/requestLimits.ts',
    'routes/api/newsletters/newsletters.schemas.ts',
    'providers/payments/stripe/stripeCheckout.helper.ts',
  ],
};

const filesUnder = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? filesUnder(path.join(dir, entry.name)) : [path.join(dir, entry.name)],
  );

const relative = (file: string) => path.relative(SRC, file).replaceAll('\\', '/');

const sources = filesUnder(SRC)
  .filter((file) => file.endsWith('.ts'))
  .map((file) => ({ file: relative(file), source: readFileSync(file, 'utf8') }));

// the providers of each kind, as its names.ts lists them: every exported list of names
async function providersOf(kind: string): Promise<string[]> {
  const file = path.join(PROVIDERS, kind, 'names.ts');
  if (!existsSync(file)) return [];

  const names = (await import(`@providers/${kind}/names.js`)) as Record<string, unknown>;
  return Object.entries(names)
    .filter(([key, value]) => key.endsWith('_PROVIDER_NAMES') && Array.isArray(value))
    .flatMap(([, value]) => value as string[]);
}

describe('the providers of the outside services', () => {
  it('has a folder of its own for every provider a kind names', async () => {
    const kinds = await Promise.all(KINDS.map(async (kind) => [kind, await providersOf(kind)]));
    // a rename of the lists must not make the other test pass on nothing
    expect(kinds.flatMap(([, names]) => names).length).toBeGreaterThan(0);

    for (const [kind, names] of kinds as [string, string[]][]) {
      for (const name of names) {
        expect(existsSync(path.join(PROVIDERS, kind, name))).toBe(true);
      }
    }
  });

  it('keeps the name of a provider in its own folder', async () => {
    const outside: string[] = [];

    for (const kind of KINDS) {
      for (const name of await providersOf(kind)) {
        const home = `providers/${kind}/${name}/`;
        const word = new RegExp(name, 'i');

        for (const { file, source } of sources) {
          if (file.startsWith(home) || ALLOWED(kind).includes(file)) continue;
          if (OTHER_MEANING[name]?.includes(file)) continue;
          if (word.test(source)) outside.push(`${name}: ${file}`);
        }
      }
    }

    expect(outside).toEqual([]);
  });
});
