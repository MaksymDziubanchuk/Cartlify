import { CLOUDINARY_PLACEHOLDERS, isolateEnv, STRIPE_PLACEHOLDER_KEY } from './isolateEnv.js';
import { assertTestServices } from '../helpers/guard.js';
import { isRealService } from '../helpers/services.js';

// cloudinary: a mock unless the run takes it for real (service:cloudinary). Cloudinary has no test
// mode, for real the uploads go to the account, into its test/ folder (tests/helpers/cloudinary.ts
// holds them there), with the keys from .env locally and the CLOUDINARY_URL secret in ci. The mock
// takes no key: the made-up ones, and no CLOUDINARY_URL of the shell
const realCloudinary = isRealService('cloudinary');
const CLOUDINARY_KEYS = [
  'CLOUDINARY_URL',
  'CLOUDINARY_CLOUD_NAME',
  'CLOUDINARY_API_KEY',
  'CLOUDINARY_API_SECRET',
];
const MOCK_CLOUDINARY = { CLOUDINARY_URL: '', ...CLOUDINARY_PLACEHOLDERS };

// stripe has a test mode: the payment tests take the key of a test sandbox from
// STRIPE_TEST_SECRET_KEY (.env locally, the secret of the same name in ci), never
// STRIPE_SECRET_KEY, which one day holds the live key; without it they are skipped
const STRIPE_TEST_KEY = 'STRIPE_TEST_SECRET_KEY';

// sendgrid: a mock unless the run takes it for real (service:sendgrid). For real the tests take the
// key of SENDGRID_API_TEST_KEY (never SENDGRID_API_KEY, the key of dev) and the addresses of the
// authenticated domain from .env locally, from the secrets of the same names in ci; every mail
// goes to SendGrid in sandbox mode (tests/helpers/mail.ts), so none reaches a mailbox
const realSendGrid = isRealService('sendgrid');
const SENDGRID_TEST_KEY = 'SENDGRID_API_TEST_KEY';
const MAIL_ADDRESS_KEYS = ['EMAIL_FROM', 'EMAIL_FROM_NAME', 'EMAIL_REPLY_TO'];
const MOCK_SENDGRID = {
  // a made-up key and the addresses of the made-up site, the mock takes any key
  SENDGRID_API_KEY: 'SG.cartlify-tests-mock',
  EMAIL_FROM: 'no-reply@shop.example.com',
  EMAIL_FROM_NAME: 'Cartlify',
  EMAIL_REPLY_TO: 'support@shop.example.com',
};

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
    // the tests sign the webhook events with this secret the way stripe signs them; the sandbox
    // has no webhook endpoint, a test delivers the event stripe recorded (tests/helpers/stripe.ts)
    STRIPE_WEBHOOK_SECRET: 'whsec_cartlify_tests',
    STRIPE_CURRENCY: 'eur',
    // a short limit of avatar removals: a test passes it in three removals
    AVATAR_REMOVALS_LIMIT: '2',
    ...(realSendGrid ? {} : MOCK_SENDGRID),
    ...(realCloudinary ? {} : MOCK_CLOUDINARY),
  },
  {
    fromLocalEnv: [
      ...(realCloudinary ? CLOUDINARY_KEYS : []),
      STRIPE_TEST_KEY,
      ...(realSendGrid ? [SENDGRID_TEST_KEY, ...MAIL_ADDRESS_KEYS] : []),
    ],
  },
);

// set here and not left to the environment: a STRIPE_SECRET_KEY of the shell may be a live key
process.env.STRIPE_SECRET_KEY = process.env[STRIPE_TEST_KEY]?.trim() || STRIPE_PLACEHOLDER_KEY;

// the same for sendgrid: the key of the app in the tests is the test key, never one of the shell
if (realSendGrid) {
  const missing = [SENDGRID_TEST_KEY, ...MAIL_ADDRESS_KEYS].filter(
    (key) => !process.env[key]?.trim(),
  );
  if (missing.length) {
    throw new Error(
      `service:sendgrid takes these from .env or the environment: ${missing.join(', ')}`,
    );
  }
  process.env.SENDGRID_API_KEY = process.env[SENDGRID_TEST_KEY]!.trim();
}

// the real account needs its url, or all three of its parts; the placeholders isolateEnv puts in
// for the import do not count
if (realCloudinary) {
  const hasUrl = Boolean(process.env.CLOUDINARY_URL?.trim());
  const missing = Object.entries(CLOUDINARY_PLACEHOLDERS)
    .filter(([key, placeholder]) => [undefined, '', placeholder].includes(process.env[key]?.trim()))
    .map(([key]) => key);
  if (!hasUrl && missing.length) {
    throw new Error(
      `service:cloudinary takes CLOUDINARY_URL, or ${missing.join(', ')}, from .env or the environment`,
    );
  }
}

// stop before any test file imports the app
assertTestServices();
