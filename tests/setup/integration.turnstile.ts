import { afterEach } from '@jest/globals';

import { installTurnstile, resetTurnstile } from '../helpers/turnstile.js';

// every integration test file: Cloudflare Turnstile answers from a mock, or for real with the dummy
// secrets when the run names it (service:turnstile); the secret a test puts in place of the app's,
// the outage it asks for and the requests it watches end with that test
installTurnstile();
afterEach(resetTurnstile);
