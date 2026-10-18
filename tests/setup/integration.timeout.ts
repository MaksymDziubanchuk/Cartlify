import { jest } from '@jest/globals';

// real database, redis and services answer slower than plain functions. jest-circus takes the
// timeout only from the global config or from here, a testTimeout of a project is ignored
jest.setTimeout(30_000);
