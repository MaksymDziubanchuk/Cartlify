import { afterAll, afterEach, jest } from '@jest/globals';

import {
  closeShippyPro,
  installShippyPro,
  resetShippyPro,
  shippyProWait,
} from '../helpers/shippyPro.js';

// every integration test file: ShippyPro answers from a mock, or asks the real service whatever it
// can without a label when the run names it (service:shippypro; tests/helpers/shippyPro.ts); the
// carriers, an outage and the refusals a test sets end with it. In the real mode a test has the
// time its requests wait for their turns at the account (after tests/setup/timeout.ts)
installShippyPro();
if (shippyProWait) jest.setTimeout(shippyProWait);
afterEach(resetShippyPro);
afterAll(closeShippyPro);
