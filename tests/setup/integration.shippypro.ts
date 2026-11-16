import { afterAll, afterEach } from '@jest/globals';

import { closeShippyPro, installShippyPro, resetShippyPro } from '../helpers/shippyPro.js';

// every integration test file: ShippyPro answers from a mock, or asks the real service whatever it
// can without a label when the run names it (service:shippypro; tests/helpers/shippyPro.ts); the
// carriers, an outage and the refusals a test sets end with it
installShippyPro();
afterEach(resetShippyPro);
afterAll(closeShippyPro);
