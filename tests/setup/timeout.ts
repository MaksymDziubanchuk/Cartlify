import { jest } from '@jest/globals';

// how long one test may take, the same for the unit and the integration tests. It is a limit of
// the run, not a check of the code: a test of how long the code takes checks that time itself. A
// unit test waits for nothing, but on a busy machine (integration files and the database next to
// it) it runs many times slower. jest-circus takes the timeout only from the global config or from
// here, a testTimeout of a project is ignored
jest.setTimeout(30_000);
