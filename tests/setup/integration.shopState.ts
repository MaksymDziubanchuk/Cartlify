import { afterAll, beforeAll, expect } from '@jest/globals';
import pg from 'pg';

// the state of the whole shop. The integration files share one database and run a few at a time,
// each making and checking only its own rows; a file that changes what the shop does for everybody
// (a version of the terms every registration and every order has to accept, which nobody can take
// back) would break the files running next to it. So every integration file holds a shared lock of
// postgres while it runs, and a file named *.shopwide.test.ts an exclusive one: postgres gives it
// when the files running now are done, and no other file starts while it runs. The sequencer
// (tests/setup/sequencer.mjs) puts such files last, so no other file waits for them
const SHOP_STATE_LOCK = 72_401_031;

// a shop-wide file may wait for the files before it as long as they run
const WAIT_MS = 10 * 60_000;

let client: pg.Client | null = null;

beforeAll(async () => {
  // the url of the test database; pg knows no schema parameter, prisma takes it
  const url = new URL(process.env.DATABASE_URL ?? '');
  url.searchParams.delete('schema');

  client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  // the role of the app stops a statement after 15 s; waiting for the lock is no work of the app
  await client.query('set statement_timeout = 0');

  const exclusive = (expect.getState().testPath ?? '').endsWith('.shopwide.test.ts');
  await client.query(
    exclusive ? 'select pg_advisory_lock($1)' : 'select pg_advisory_lock_shared($1)',
    [SHOP_STATE_LOCK],
  );
}, WAIT_MS);

// the end of the session gives the lock back
afterAll(async () => {
  await client?.end();
  client = null;
});
