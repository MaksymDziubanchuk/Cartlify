import { jest } from '@jest/globals';

// src/config/env.ts and the modules that read it take their values once, at import;
// this imports a module again, with its own copy of env built from the given values.
// Classes come from the new copy too, so check errors by their fields, not with instanceof
export async function importWithEnv<T>(
  specifier: string,
  values: Record<string, string>,
): Promise<T> {
  const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));

  Object.assign(process.env, values);
  jest.resetModules();

  try {
    return (await import(specifier)) as T;
  } finally {
    // never delete a key: dotenv would then take it from the local .env
    for (const [key, value] of Object.entries(saved)) process.env[key] = value ?? '';
  }
}
