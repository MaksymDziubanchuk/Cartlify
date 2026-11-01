import util from 'node:util';
import { afterEach } from '@jest/globals';

// The driver of postgres takes one statement at a time on a connection, and a transaction has one
// connection. A statement sent while another runs waits in the queue of the driver; pg@9 refuses
// it, and pg@8 says so with a deprecation notice ("Calling client.query() when the client is
// already executing a query"), once for each load of the driver. The notice means the code sends
// statements of one transaction side by side: Promise.all over its queries, or a query of Prisma
// that asks for several relations (Prisma loads them together). A test that gets the notice fails,
// so a new place of this kind is found by the test that runs it, not by a line in the output.
//
// The driver makes the notice with util.deprecate when it loads, so this file runs before every
// other file of the setup that loads it (jest.config.js lists it first); util is the same module for
// all the files of a worker, so it is wrapped once and the notices of the file that runs are taken
// after each of its tests. The driver makes the notice when a statement is sent while another waits
// in its queue: with a statement running and one more it is silent, a third one speaks.
const NOTICES = Symbol.for('cartlify.pgQueueNotices');
const WRAPPED = Symbol.for('cartlify.pgQueueNoticesWrapped');
const REFUSED = 'already executing a query';

type Noticed = typeof util & { [NOTICES]?: string[]; [WRAPPED]?: boolean };
const shared = util as Noticed;

shared[NOTICES] ??= [];

if (!shared[WRAPPED]) {
  const deprecate = util.deprecate.bind(util);

  shared.deprecate = ((fn: (...args: unknown[]) => unknown, message: string, code?: string) => {
    const wrapped = deprecate(fn, message, code);
    if (!message.includes(REFUSED)) return wrapped;

    return (...args: unknown[]) => {
      shared[NOTICES]!.push(message);
      return wrapped(...args);
    };
  }) as typeof util.deprecate;
  shared[WRAPPED] = true;
}

afterEach(() => {
  const notices = shared[NOTICES]!.splice(0);

  if (notices.length) {
    throw new Error(
      'the test sent a statement on a connection that was running one (the driver of postgres ' +
        'refuses that from pg@9): a transaction runs its statements one after another, and a ' +
        `query of Prisma asks for two relations at most.\n${notices[0]}`,
    );
  }
});
