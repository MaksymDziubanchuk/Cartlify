const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost']);

// docker test stack ports, see docker-compose.test.yml
const TEST_DB_PORT = '54329';
const TEST_DB_NAME = 'cartlify_test';
const TEST_REDIS_PORT = '63799';

function parseUrl(name: string): URL {
  const raw = process.env[name];

  try {
    return new URL(raw ?? '');
  } catch {
    throw new Error(`Test guard: ${name} is not a valid url`);
  }
}

// integration tests write and delete data, so they may only reach the disposable docker stack
export function assertTestServices(): void {
  const db = parseUrl('DATABASE_URL');
  const dbName = db.pathname.replace(/^\//, '');

  // the messages never quote the url: a wrong one may hold a real host and password
  if (!LOCAL_HOSTS.has(db.hostname) || db.port !== TEST_DB_PORT || dbName !== TEST_DB_NAME) {
    throw new Error(
      `Test guard: DATABASE_URL must point to ${TEST_DB_NAME} on 127.0.0.1:${TEST_DB_PORT}, ` +
        'it points to another database',
    );
  }

  const redis = parseUrl('REDIS_URL');

  if (!LOCAL_HOSTS.has(redis.hostname) || redis.port !== TEST_REDIS_PORT) {
    throw new Error(
      `Test guard: REDIS_URL must point to 127.0.0.1:${TEST_REDIS_PORT}, it points to another server`,
    );
  }
}
