import { afterEach } from '@jest/globals';

import { installSendGrid, resetSendGrid } from '../helpers/mail.js';

// every integration test file: SendGrid answers from a mock, or for real in sandbox mode when the
// run names it; the mails a test watches and the refusal it asks for end with that test
installSendGrid();
afterEach(resetSendGrid);
