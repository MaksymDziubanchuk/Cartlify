import { afterAll, afterEach, beforeEach } from '@jest/globals';

import { takeContractViolations } from '../helpers/contract.js';

// answers from the start of the file (beforeAll) belong to no test; their gaps show up in the
// first test of the file
beforeEach(() => {
  const early = takeContractViolations();
  if (early.length) {
    throw new Error(
      'the file setup got answers the swagger document does not describe:\n' + early.join('\n'),
    );
  }
});

// an answer the swagger document does not describe is a failure of the test that got it
afterEach(() => {
  const found = takeContractViolations();
  if (found.length) {
    throw new Error(
      'the test got answers the swagger document does not describe ' +
        '(tests/helpers/contract.ts):\n' +
        found.join('\n'),
    );
  }
});

// answers of the cleanup after the last test
afterAll(() => {
  const late = takeContractViolations();
  if (late.length) {
    throw new Error(
      'the file cleanup got answers the swagger document does not describe:\n' + late.join('\n'),
    );
  }
});
