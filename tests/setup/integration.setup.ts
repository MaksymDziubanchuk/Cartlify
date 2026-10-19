import { isolateEnv } from './isolateEnv.js';
import { assertTestServices } from '../helpers/guard.js';

// cloudinary has no test mode: the uploads go to the real account, into its test/ folder
// (tests/setup/integration.cloudinary.ts holds them there). Locally the keys come from .env,
// in ci from the CLOUDINARY_URL secret; without them the upload tests are skipped
const CLOUDINARY_KEYS = [
  'CLOUDINARY_URL',
  'CLOUDINARY_CLOUD_NAME',
  'CLOUDINARY_API_KEY',
  'CLOUDINARY_API_SECRET',
];

// docker test stack from docker-compose.test.yml, built by npm run db:test:up
isolateEnv(
  {
    DATABASE_URL:
      'postgresql://cartlify_app:cartlify_app@127.0.0.1:54329/cartlify_test?schema=cartlify',
    REDIS_URL: 'redis://127.0.0.1:63799',
    // the one site the cors and websocket origin checks let in, oauth logins return to it
    WEB_ORIGIN: 'https://shop.example.com',
    // the domain of the site, a deleted account gets an address on it
    SITE_DOMAIN: 'shop.example.com',
    // the lowest cost the app takes: every test user gets a password hash, a cost of 12 makes
    // each one four times slower and checks nothing more
    BCRYPT_ROUNDS: '10',
    // made-up oauth apps: the provider answers come from tests/helpers/oauth.ts
    GITHUB_CLIENT_ID: 'test-github-client',
    GITHUB_CLIENT_SECRET: 'test-github-secret',
    GITHUB_REDIRECT_URI: 'https://api.example.com/api/auth/github/callback',
    GITHUB_STATE_SECRET: 'test-github-state-secret',
    GOOGLE_CLIENT_ID: 'test-google-client.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'test-google-secret',
    GOOGLE_REDIRECT_URI: 'https://api.example.com/api/auth/google/callback',
    GOOGLE_STATE_SECRET: 'test-google-state-secret',
    LINKEDIN_CLIENT_ID: 'test-linkedin-client',
    LINKEDIN_CLIENT_SECRET: 'test-linkedin-secret',
    LINKEDIN_REDIRECT_URI: 'https://api.example.com/api/auth/linkedin/callback',
    LINKEDIN_STATE_SECRET: 'test-linkedin-state-secret',
  },
  { fromLocalEnv: CLOUDINARY_KEYS },
);

// stop before any test file imports the app
assertTestServices();
