import { afterEach } from '@jest/globals';

import { installFiskaly, resetFiskaly } from '../helpers/fiskaly.js';

// every integration test file: fiskaly answers from a mock, or the real TEST answers when the run
// names it (service:fiskaly; tests/helpers/fiskaly.ts); the outage and the refusals a test sets end
// with it
installFiskaly();
afterEach(resetFiskaly);
