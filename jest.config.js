import { readFileSync } from 'node:fs';

// tsconfig.json is plain json, path aliases are read from it so a new alias needs no change here
const tsconfig = JSON.parse(readFileSync(new URL('./tsconfig.json', import.meta.url), 'utf8'));

// '@config/*': ['./src/config/*'] -> '^@config/(.*)\.js$': '<rootDir>/src/config/$1';
// only imports with .js match, the npm scope @redis/* used inside the redis package has none
const aliasMapper = Object.fromEntries(
  Object.entries(tsconfig.compilerOptions.paths).map(([alias, [target]]) => [
    `^${alias.replace('/*', '')}/(.*)\\.js$`,
    `<rootDir>/${target.replace(/^\.\//, '').replace('/*', '')}/$1`,
  ]),
);

// coverage counts every source file, not only the ones a test imported
const coverageFrom = ['src/**/*.ts', '!src/index.ts', '!src/types/**'];

// options every project needs, inline projects do not inherit them from the root config
const shared = {
  testEnvironment: 'node',

  // the transformed files are kept here between runs; the tests workflow caches this folder,
  // a run with an empty one takes about 13 s longer
  cacheDirectory: '<rootDir>/node_modules/.cache/jest',

  // run typescript as native esm, so top-level await in src/app.ts works
  extensionsToTreatAsEsm: ['.ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { useESM: true, tsconfig: 'tsconfig.test.json' }],
  },

  moduleNameMapper: {
    ...aliasMapper,
    // source imports keep the .js suffix that points to the .ts file
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },

  // the project list instruments files the tests import
  collectCoverageFrom: coverageFrom,
};

/** @type {import('jest').Config} */
export default {
  // the root list adds the files no test imported
  collectCoverageFrom: coverageFrom,
  // the report lives next to the tests instead of the project root
  coverageDirectory: 'tests/coverage',
  coverageReporters: ['text-summary', 'lcov'],

  // how long a worker may take to exit after the run: jest gives 500 ms and then kills it with a
  // warning about leaking tests. On Windows a worker that ran integration files often needs more
  // with nothing left open (--detectOpenHandles finds nothing); a real leak still holds it past
  // this time and gets the warning
  workerGracefulExitTimeout: 5_000,

  projects: [
    {
      ...shared,
      displayName: 'unit',
      testMatch: ['<rootDir>/tests/unit/**/*.test.ts'],
      setupFiles: ['<rootDir>/tests/setup/unit.setup.ts'],
    },
    {
      ...shared,
      displayName: 'integration',
      testMatch: ['<rootDir>/tests/integration/**/*.test.ts'],
      setupFiles: ['<rootDir>/tests/setup/integration.setup.ts'],
      // the app logs go to the tests, an unexpected warning or error fails its test;
      // cloudinary calls stay in its test/ folder; a longer timeout for real services
      setupFilesAfterEnv: [
        '<rootDir>/tests/setup/integration.logs.ts',
        '<rootDir>/tests/setup/integration.cloudinary.ts',
        '<rootDir>/tests/setup/integration.timeout.ts',
      ],
    },
  ],
};
