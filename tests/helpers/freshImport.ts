import { jest } from '@jest/globals';

import type { ShopSettingsValues } from '@config/shopSettings.js';

// src/config/env.ts and the modules that read it take their values once, at import;
// this imports a module again, with its own copy of env built from the given values.
// Classes come from the new copy too, so check errors by their fields, not with instanceof.
// jest.resetModules() gives the target its own copy of @config/shopSettings.js too, with no row
// read and no cache of its own global beforeEach (tests/setup/unit.shopSettings.ts, a different,
// earlier copy of the module): pass shopSettings to fill the fresh copy the same way, before the
// target is imported and may call shopSettings() itself at the top of a function
export async function importWithEnv<T>(
  specifier: string,
  values: Record<string, string>,
  opts: { shopSettings?: Partial<ShopSettingsValues> } = {},
): Promise<T> {
  const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));

  Object.assign(process.env, values);
  jest.resetModules();

  try {
    const { setShopSettingsForTest } = await import('@config/shopSettings.js');
    setShopSettingsForTest(opts.shopSettings);

    return (await import(specifier)) as T;
  } finally {
    // never delete a key: dotenv would then take it from the local .env
    for (const [key, value] of Object.entries(saved)) process.env[key] = value ?? '';
  }
}
