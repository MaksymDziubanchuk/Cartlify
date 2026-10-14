import { isolateEnv } from './isolateEnv.js';
import { assertTestServices } from '../helpers/guard.js';

// docker test stack from docker-compose.test.yml, built by npm run db:test:up
isolateEnv({
  DATABASE_URL:
    'postgresql://cartlify_app:cartlify_app@127.0.0.1:54329/cartlify_test?schema=cartlify',
  REDIS_URL: 'redis://127.0.0.1:63799',
});

// stop before any test file imports the app
assertTestServices();
