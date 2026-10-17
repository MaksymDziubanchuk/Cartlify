import { isolateEnv } from './isolateEnv.js';
import { assertTestServices } from '../helpers/guard.js';

// docker test stack from docker-compose.test.yml, built by npm run db:test:up
isolateEnv({
  DATABASE_URL:
    'postgresql://cartlify_app:cartlify_app@127.0.0.1:54329/cartlify_test?schema=cartlify',
  REDIS_URL: 'redis://127.0.0.1:63799',
  // the one site the cors and websocket origin checks let in, oauth logins return to it
  WEB_ORIGIN: 'https://shop.example.com',
  // a made-up github oauth app: the provider answers come from a fetch stub in the tests
  GITHUB_CLIENT_ID: 'test-github-client',
  GITHUB_CLIENT_SECRET: 'test-github-secret',
  GITHUB_REDIRECT_URI: 'https://api.example.com/api/auth/github/callback',
  GITHUB_STATE_SECRET: 'test-github-state-secret',
});

// stop before any test file imports the app
assertTestServices();
