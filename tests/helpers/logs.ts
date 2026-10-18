import pino from 'pino';
import type { FastifyBaseLogger } from 'fastify';

import { hideSecrets } from './hideSecrets.js';

// what the app logs during the integration tests is kept here instead of the output. A test that
// expects a log line takes it with takeLogs and checks it; a warning or an error that no test took
// fails that test (tests/setup/integration.logs.ts), so an unexpected failure is never hidden
// and an expected one never clutters the output

export type LogEntry = {
  level: number;
  msg?: string;
  err?: { errorCode?: string; details?: { reason?: string } };
  [field: string]: unknown;
};

export type LogMatch = {
  msg?: string;
  // the errorCode of the logged error
  errorCode?: string;
  // the reason of a logged server error (its details.reason)
  reason?: string;
};

const WARN = 40;

let entries: LogEntry[] = [];
const allowed: LogMatch[] = [];

const matches = (entry: LogEntry, match: LogMatch) =>
  (match.msg === undefined || entry.msg === match.msg) &&
  (match.errorCode === undefined || entry.err?.errorCode === match.errorCode) &&
  (match.reason === undefined || entry.err?.details?.reason === match.reason);

// every logger of the app writes into the stream of the root logger, the request loggers too
export function captureLogs(log: FastifyBaseLogger): void {
  const stream = (log as unknown as Record<symbol, { write: (line: string) => boolean }>)[
    pino.symbols.streamSym
  ]!;

  stream.write = (line: string) => {
    try {
      entries.push(JSON.parse(line) as LogEntry);
    } catch {
      process.stdout.write(hideSecrets(line));
    }
    return true;
  };
}

// the log lines of the test that match, taken out so the check after the test does not report them
export function takeLogs(match: LogMatch): LogEntry[] {
  const taken = entries.filter((entry) => matches(entry, match));
  entries = entries.filter((entry) => !matches(entry, match));
  return taken;
}

// log lines a whole test file causes on purpose and does not check in every test, for example a
// mail that cannot go out without a SendGrid key; the call says why next to it. A test of its own
// still takes and checks such a line, the others leave it and it is dropped after them
export function allowLogs(match: LogMatch): void {
  allowed.push(match);
}

// what is left after a test: the warnings and errors no test took, and the rest of the lines
// (TEST_LOG_LEVEL=info brings request logs back for a look at them)
export function drainLogs(): { unexpected: LogEntry[]; other: LogEntry[] } {
  const left = entries.filter((entry) => !allowed.some((match) => matches(entry, match)));
  entries = [];
  return {
    unexpected: left.filter((entry) => entry.level >= WARN),
    other: left.filter((entry) => entry.level < WARN),
  };
}
