import { afterEach, beforeEach } from '@jest/globals';

import { hideSecrets } from '../helpers/hideSecrets.js';
import { drainLogs, type LogEntry } from '../helpers/logs.js';

// the app logs into tests/helpers/logs.ts; around every test this decides what reaches the output

const line = (entry: LogEntry) => hideSecrets(JSON.stringify(entry));

const print = (entries: LogEntry[]) => {
  for (const entry of entries) process.stdout.write(`${line(entry)}\n`);
};

// lines from the start of the file (beforeAll) belong to no test, they are shown as they are
beforeEach(() => {
  const { unexpected, other } = drainLogs();
  print([...unexpected, ...other]);
});

// a warning or an error the test did not take with takeLogs is a failure of the test
afterEach(() => {
  const { unexpected, other } = drainLogs();
  print(other);

  if (unexpected.length) {
    throw new Error(
      'the test logged a warning or an error it does not check with takeLogs:\n' +
        unexpected.map(line).join('\n'),
    );
  }
});
