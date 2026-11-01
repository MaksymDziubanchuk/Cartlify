import { afterAll } from '@jest/globals';

// Jest gives every test file its own copy of every module it loads (native esm runs in a vm context
// of the file). When the file is done that copy is garbage, but v8 still reaches it from its caches of
// compiled code, and an ordinary full collection keeps them: a worker grew by the size of the app,
// about 70 MB a file, until it met the heap limit. The collection v8 makes before it gives up (the last
// resort one) clears those caches too; one after every file keeps a worker at the size of a file or
// two, for about 0.3 s. The runner starts node with --expose-gc (tests/run.mjs); jest started another
// way has no gc here, and the worker memory limit of jest.config.js stays the fallback
type GcOptions = { type: 'major'; execution: 'sync'; flavor: 'last-resort' };

const gc = (globalThis as { gc?: (options: GcOptions) => void }).gc;

afterAll(() => {
  gc?.({ type: 'major', execution: 'sync', flavor: 'last-resort' });
});
