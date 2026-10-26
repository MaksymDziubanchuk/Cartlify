import { statSync } from 'node:fs';
import path from 'node:path';

import * as dotenv from 'dotenv';

declare global {
  namespace NodeJS {
    // type process.env keys
    interface ProcessEnv {
      NODE_ENV: 'development' | 'production' | 'test';
      PORT?: string;
      HOST?: string;

      WEB_ORIGIN: string;
      SITE_DOMAIN: string;

      DATABASE_URL: string;

      JWT_ACCESS_SECRET: string;
      JWT_ACCESS_TTL_SHORT: string;
      JWT_ACCESS_TTL_LONG: string;

      JWT_REFRESH_SECRET: string;
      JWT_REFRESH_TTL_SHORT: string;
      JWT_REFRESH_TTL_LONG: string;

      GUEST_ID_TTL: string;

      RESET_TTL_MS: string;

      BCRYPT_ROUNDS: string;

      AVATAR_REMOVALS_LIMIT?: string;
      REVIEW_REMOVALS_LIMIT?: string;

      RATE_LIMIT_MAX?: string;
      REQUEST_LIMITS_SCALE?: string;
      TRUST_PROXY_HOPS?: string;
      LOG_REQUEST_ADDRESSES?: string;

      LIMIT_LOGIN_PER_ADDRESS?: string;
      LIMIT_LOGIN_PER_EMAIL?: string;
      LIMIT_REGISTER_PER_ADDRESS?: string;
      LIMIT_MAIL_PER_ADDRESS?: string;
      LIMIT_MAIL_PER_EMAIL?: string;
      LIMIT_CHECKOUT_PER_USER?: string;
      LIMIT_PASSWORD_CHANGE_PER_USER?: string;
      LIMIT_EXPORT_PER_USER?: string;
      LIMIT_REVIEW_PER_USER?: string;
      LOGIN_FAILURES_BEFORE_PAUSE?: string;

      UPLOAD_MAX_BYTES?: string;
      PRODUCT_IMAGES_MAX?: string;
      VERIFY_TTL_MS?: string;
      ORDER_RESERVATION_MINUTES?: string;
      STRIPE_PAGE_AFTER_RESERVATION_MINUTES?: string;
      REVIEW_CHECK_ENABLED?: string;

      SHOP_TIME_ZONE?: string;
      SHOP_NAME?: string;
      SHOP_LOGO_PATH?: string;

      WEB_PAGE_OAUTH_CALLBACK?: string;
      WEB_PAGE_LOGIN?: string;
      WEB_PAGE_VERIFY_EMAIL?: string;
      WEB_PAGE_PASSWORD_RESET?: string;
      WEB_PAGE_CHECKOUT_SUCCESS?: string;
      WEB_PAGE_CHECKOUT_CANCEL?: string;
      WEB_PAGE_ORDER?: string;
      WEB_PAGE_PRODUCT_REVIEWS?: string;

      CLOUDINARY_CLOUD_NAME: string;
      CLOUDINARY_API_KEY: string;
      CLOUDINARY_API_SECRET: string;
      CLOUDINARY_URL: string;

      OPENAI_API_KEY: string;
      OPENAI_MODEL?: string;
      OPENAI_TIMEOUT_MS?: string;
      OPENAI_MAX_OUTPUT_TOKENS?: string;
      CHAT_BOT_GUEST_DAILY_TURNS?: string;
      CHAT_BOT_USER_DAILY_TURNS?: string;

      SENDGRID_API_KEY: string;

      EMAIL_FROM: string;
      EMAIL_FROM_NAME: string;
      EMAIL_REPLY_TO: string;

      GOOGLE_CLIENT_ID: string;
      GOOGLE_CLIENT_SECRET: string;
      GOOGLE_REDIRECT_URI: string;
      GOOGLE_STATE_SECRET: string;

      GITHUB_CLIENT_ID: string;
      GITHUB_CLIENT_SECRET: string;
      GITHUB_REDIRECT_URI: string;
      GITHUB_STATE_SECRET: string;

      LINKEDIN_CLIENT_ID: string;
      LINKEDIN_CLIENT_SECRET: string;
      LINKEDIN_REDIRECT_URI: string;
      LINKEDIN_STATE_SECRET: string;

      REDIS_URL: string;
      REDIS_ORDER_TIMEOUT_WORKER_MS?: string;

      STRIPE_SECRET_KEY: string;
      STRIPE_WEBHOOK_SECRET: string;
      STRIPE_CURRENCY: string;
    }
  }
}

// init dotenv before reads; quiet, since dotenv 17 prints a line of its own on every start,
// outside the fastify logger
dotenv.config({ quiet: true });

// fail fast on missing required vars
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env variable: ${name}`);
  return value;
}

// fail fast on a numeric setting that is not a positive whole number; unset gives the default.
// Number() alone lets NaN and 0 through: a NaN or 0 interval makes node run it every 1 ms
function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;

  const value = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Invalid env variable: ${name} must be a positive whole number`);
  }

  return value;
}

const NODE_ENV_MODES = ['development', 'test', 'production'] as const;

// fail fast on a mode the app does not know: any other value used to switch on the development
// behaviour without a word (cookies without Secure, stacks in the answers of a 500); unset is
// development, as npm run dev starts it
function nodeEnv(): (typeof NODE_ENV_MODES)[number] {
  const raw = process.env.NODE_ENV?.trim();
  if (!raw) return 'development';

  const mode = NODE_ENV_MODES.find((known) => known === raw);
  if (!mode) {
    throw new Error('Invalid env variable: NODE_ENV must be development, test or production');
  }

  return mode;
}

const NODE_ENV = nodeEnv();

// currencies stripe counts without cents or with three digits after the point
// (stripe.com/docs/currencies); the prices of the catalog and every amount of the app are in cents
const CURRENCIES_WITHOUT_CENTS = new Set([
  'bif',
  'clp',
  'djf',
  'gnf',
  'isk',
  'jpy',
  'kmf',
  'krw',
  'mga',
  'pyg',
  'rwf',
  'ugx',
  'vnd',
  'vuv',
  'xaf',
  'xof',
  'xpf',
  'bhd',
  'jod',
  'kwd',
  'omr',
  'tnd',
]);

// fail fast on a currency of the shop that is not a code with cents: such a currency would be
// charged a hundred times off; read in lower case, as stripe names it
function currencyWithCents(name: string, fallback: string): string {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;

  if (!/^[a-z]{3}$/.test(raw) || CURRENCIES_WITHOUT_CENTS.has(raw)) {
    throw new Error(
      `Invalid env variable: ${name} must be a three letter code of a currency with cents`,
    );
  }

  return raw;
}

// fail fast on a count that is not a whole number from 0; unset gives the default
function wholeNumber(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;

  const value = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(value)) {
    throw new Error(`Invalid env variable: ${name} must be a whole number from 0`);
  }

  return value;
}

// fail fast on a time zone that is not a name of the iana list, as the database knows them too
// (Europe/Madrid, UTC); an offset like +03:00 or UTC+3 reads the other way round in postgres
function timeZone(name: string, fallback: string): string {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;

  let known = /^(UTC|[A-Z][A-Za-z]+(\/[A-Za-z0-9_+-]+)+)$/.test(raw);
  if (known) {
    try {
      new Intl.DateTimeFormat('en', { timeZone: raw });
    } catch {
      known = false;
    }
  }
  if (!known) {
    throw new Error(`Invalid env variable: ${name} must be a time zone like Europe/Madrid`);
  }

  return raw;
}

// fail fast on a switch that is not true or false; unset gives the default
function flag(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;

  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error(`Invalid env variable: ${name} must be true or false`);
}

// fail fast on a page of the frontend that is not a path of the site: the links of the mails and
// the redirect after a login go there, a value like //evil.example would send the people and
// their tokens to another site. A page of an order or a product names it once by {id}
function webPage(name: string, fallback: string, takesId: boolean): string {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;

  const site = 'https://shop.invalid';
  let onSite = /^\/(?![/\\])\S*$/.test(raw);
  if (onSite) {
    try {
      onSite = new URL(raw, site).origin === site;
    } catch {
      onSite = false;
    }
  }

  if (!onSite || raw.split('{id}').length - 1 !== (takesId ? 1 : 0)) {
    throw new Error(
      `Invalid env variable: ${name} must be a path of the site starting with /, ` +
        (takesId ? 'with {id} once' : 'without {id}'),
    );
  }

  return raw;
}

// fail fast on a logo that is not a png or a jpeg file: every mail carries it, a missing one
// would stop each of them. A path from the folder the server runs in
function logoFile(name: string, fallback: string): string {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;

  let isFile: boolean;
  try {
    isFile = statSync(path.resolve(process.cwd(), raw)).isFile();
  } catch {
    isFile = false;
  }

  if (!isFile || !/\.(png|jpe?g)$/i.test(raw)) {
    throw new Error(`Invalid env variable: ${name} must be a png or jpeg file`);
  }

  return raw;
}

// stripe keeps a payment page at least 30 minutes and at most 24 hours from its opening; a page is
// opened while the order is reserved and closes the minutes after the end of the reservation
const STRIPE_PAGE_MIN_MINUTES = 30;
const STRIPE_PAGE_MAX_MINUTES = 24 * 60;

function reservationMinutes(): {
  ORDER_RESERVATION_MINUTES: number;
  STRIPE_PAGE_AFTER_RESERVATION_MINUTES: number;
} {
  const reservation = positiveInt('ORDER_RESERVATION_MINUTES', 15);
  const pageAfter = positiveInt('STRIPE_PAGE_AFTER_RESERVATION_MINUTES', 30);

  if (pageAfter < STRIPE_PAGE_MIN_MINUTES) {
    throw new Error(
      `Invalid env variable: STRIPE_PAGE_AFTER_RESERVATION_MINUTES must be at least ${STRIPE_PAGE_MIN_MINUTES}`,
    );
  }
  if (reservation + pageAfter > STRIPE_PAGE_MAX_MINUTES) {
    throw new Error(
      'Invalid env variable: ORDER_RESERVATION_MINUTES and STRIPE_PAGE_AFTER_RESERVATION_MINUTES ' +
        `together must be at most ${STRIPE_PAGE_MAX_MINUTES} (24 hours)`,
    );
  }

  return {
    ORDER_RESERVATION_MINUTES: reservation,
    STRIPE_PAGE_AFTER_RESERVATION_MINUTES: pageAfter,
  };
}

export default {
  // runtime mode and server bind
  NODE_ENV,
  PORT: positiveInt('PORT', 3000),

  // host bind and db url
  HOST: process.env.HOST ? process.env.HOST : '0.0.0.0',
  DATABASE_URL: process.env.DATABASE_URL || '',
  WEB_ORIGIN: process.env.WEB_ORIGIN || '',
  // domain the site lives on, the address of a deleted account is built on it
  SITE_DOMAIN: process.env.SITE_DOMAIN || '',

  // the pages of the frontend (on WEB_ORIGIN) the server sends the browser back to and the mails
  // link to; a page of an order or of a product names it by {id}
  // the browser comes back from a login with google, github or linkedin
  WEB_PAGE_OAUTH_CALLBACK: webPage('WEB_PAGE_OAUTH_CALLBACK', '/auth/callback', false),
  // the mail after a change of the password links to the login
  WEB_PAGE_LOGIN: webPage('WEB_PAGE_LOGIN', '/web/login', false),
  // the link of the verification of an email, with ?token=
  WEB_PAGE_VERIFY_EMAIL: webPage('WEB_PAGE_VERIFY_EMAIL', '/web/login', false),
  // the link of a password reset, with ?token=
  WEB_PAGE_PASSWORD_RESET: webPage('WEB_PAGE_PASSWORD_RESET', '/web/auth/reset', false),
  // the stripe payment page sends the buyer back, with ?session_id= or ?orderId=
  WEB_PAGE_CHECKOUT_SUCCESS: webPage('WEB_PAGE_CHECKOUT_SUCCESS', '/checkout/success', false),
  WEB_PAGE_CHECKOUT_CANCEL: webPage('WEB_PAGE_CHECKOUT_CANCEL', '/checkout/cancel', false),
  // the mails of an order link to it
  WEB_PAGE_ORDER: webPage('WEB_PAGE_ORDER', '/orders/{id}', true),
  // the mail of a delivered order asks to rate each product there
  WEB_PAGE_PRODUCT_REVIEWS: webPage('WEB_PAGE_PRODUCT_REVIEWS', '/products/{id}#reviews', true),

  // access token config
  JWT_ACCESS_SECRET: required('JWT_ACCESS_SECRET'),

  // access ttl presets, seconds
  JWT_ACCESS_TTL_SHORT: positiveInt('JWT_ACCESS_TTL_SHORT', 1200),
  JWT_ACCESS_TTL_LONG: positiveInt('JWT_ACCESS_TTL_LONG', 3600),

  // refresh token config, seconds
  JWT_REFRESH_SECRET: required('JWT_REFRESH_SECRET'),
  JWT_REFRESH_TTL_SHORT: positiveInt('JWT_REFRESH_TTL_SHORT', 86400),
  JWT_REFRESH_TTL_LONG: positiveInt('JWT_REFRESH_TTL_LONG', 2592000),

  // guest cookie lifetime, seconds
  GUEST_ID_TTL: positiveInt('GUEST_ID_TTL', 157680000),

  // password reset ttl
  RESET_TTL_MS: positiveInt('RESET_TTL_MS', 3600000),

  // the life of the link of an email verification, a day unless given
  VERIFY_TTL_MS: positiveInt('VERIFY_TTL_MS', 86_400_000),

  // bcrypt cost factor
  BCRYPT_ROUNDS: process.env.BCRYPT_ROUNDS ? Number(process.env.BCRYPT_ROUNDS) : 12,

  // the avatar removals by a moderator the rules allow an account; past them the page tells the
  // admin to ask root about the account
  AVATAR_REMOVALS_LIMIT: positiveInt('AVATAR_REMOVALS_LIMIT', 5),

  // the removals of the reviews of an author by a moderator the rules allow; past them the page
  // tells the admin to ask root about the account
  REVIEW_REMOVALS_LIMIT: positiveInt('REVIEW_REMOVALS_LIMIT', 5),

  // the requests a minute one address may make (@fastify/rate-limit)
  RATE_LIMIT_MAX: positiveInt('RATE_LIMIT_MAX', 100),

  // multiplies every limit of a route (src/plugins/requestLimits.ts); the integration tests raise
  // them, all their requests come from one address
  REQUEST_LIMITS_SCALE: positiveInt('REQUEST_LIMITS_SCALE', 1),

  // the most requests of each limit of a route in its window (src/plugins/requestLimits.ts): the
  // logins from one address and of one email in 10 minutes, the registrations from one address in
  // an hour, the mails of a reset or a verification from one address in 15 minutes and to one
  // address in 3 minutes, the payment pages of a user in a minute, the changes of the password of
  // a user in 15 minutes, the exports of the data of a user and the reviews of a user in an hour
  LIMIT_LOGIN_PER_ADDRESS: positiveInt('LIMIT_LOGIN_PER_ADDRESS', 30),
  LIMIT_LOGIN_PER_EMAIL: positiveInt('LIMIT_LOGIN_PER_EMAIL', 10),
  LIMIT_REGISTER_PER_ADDRESS: positiveInt('LIMIT_REGISTER_PER_ADDRESS', 10),
  LIMIT_MAIL_PER_ADDRESS: positiveInt('LIMIT_MAIL_PER_ADDRESS', 10),
  LIMIT_MAIL_PER_EMAIL: positiveInt('LIMIT_MAIL_PER_EMAIL', 1),
  LIMIT_CHECKOUT_PER_USER: positiveInt('LIMIT_CHECKOUT_PER_USER', 10),
  LIMIT_PASSWORD_CHANGE_PER_USER: positiveInt('LIMIT_PASSWORD_CHANGE_PER_USER', 10),
  LIMIT_EXPORT_PER_USER: positiveInt('LIMIT_EXPORT_PER_USER', 1),
  LIMIT_REVIEW_PER_USER: positiveInt('LIMIT_REVIEW_PER_USER', 30),
  // the wrong passwords of an account before its login pauses for a minute, doubling after
  LOGIN_FAILURES_BEFORE_PAUSE: positiveInt('LOGIN_FAILURES_BEFORE_PAUSE', 5),

  // the biggest file of a form (an avatar, a picture of a product) and the most pictures of a
  // product; a bigger file is cut off with 413 before cloudinary
  UPLOAD_MAX_BYTES: positiveInt('UPLOAD_MAX_BYTES', 5_000_000),
  PRODUCT_IMAGES_MAX: positiveInt('PRODUCT_IMAGES_MAX', 10),

  // the minutes a confirmed order holds its units for the payment, and the minutes stripe keeps
  // its payment page open after them
  ...reservationMinutes(),

  // the comments of reviews are checked by the model and the moderation of openai before they are
  // written (src/routes/api/products/services/helpers/reviewCheck.helper.ts); false publishes
  // them unchecked
  REVIEW_CHECK_ENABLED: flag('REVIEW_CHECK_ENABLED', true),

  // the proxies in front of the server whose x-forwarded-for is trusted: railway puts one, so the
  // address of a client is the one it names (0 trusts none, the address of the connection counts)
  TRUST_PROXY_HOPS: wholeNumber('TRUST_PROXY_HOPS', 1),

  // a line for each request with the addresses the server reads from it, to see on a new host how
  // many proxies stand in front of it; off unless true
  LOG_REQUEST_ADDRESSES: process.env.LOG_REQUEST_ADDRESSES?.trim() === 'true',

  // the days, weeks and months of the reports are the ones of the shop
  SHOP_TIME_ZONE: timeZone('SHOP_TIME_ZONE', 'Europe/Madrid'),

  // the name of the shop on a payment and in the mails, Cartlify unless given
  SHOP_NAME: process.env.SHOP_NAME?.trim() || 'Cartlify',

  // the logo every mail shows, a png or jpeg file from the folder the server runs in
  SHOP_LOGO_PATH: logoFile('SHOP_LOGO_PATH', 'src/static/images/logo3.png'),

  // cloudinary api keys
  CLOUDINARY_CLOUD_NAME: process.env.CLOUDINARY_CLOUD_NAME || '',
  CLOUDINARY_API_KEY: process.env.CLOUDINARY_API_KEY || '',
  CLOUDINARY_API_SECRET: process.env.CLOUDINARY_API_SECRET || '',
  CLOUDINARY_URL: process.env.CLOUDINARY_URL || '',

  // openai api settings
  OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
  OPENAI_MODEL: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
  OPENAI_TIMEOUT_MS: process.env.OPENAI_TIMEOUT_MS ? Number(process.env.OPENAI_TIMEOUT_MS) : 12000,
  OPENAI_MAX_OUTPUT_TOKENS: process.env.OPENAI_MAX_OUTPUT_TOKENS
    ? Number(process.env.OPENAI_MAX_OUTPUT_TOKENS)
    : 450,

  // the answers of the chat bot one guest or one user gets in 24 hours, each one a paid call of
  // the model; past them the bot answers with a text of its own and asks the model nothing
  CHAT_BOT_GUEST_DAILY_TURNS: positiveInt('CHAT_BOT_GUEST_DAILY_TURNS', 30),
  CHAT_BOT_USER_DAILY_TURNS: positiveInt('CHAT_BOT_USER_DAILY_TURNS', 100),

  // sendgrid variables
  SENDGRID_API_KEY: process.env.SENDGRID_API_KEY || '',
  EMAIL_FROM: process.env.EMAIL_FROM || '',
  EMAIL_FROM_NAME: process.env.EMAIL_FROM_NAME || '',
  EMAIL_REPLY_TO: process.env.EMAIL_REPLY_TO || '',

  // google oauth client config
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID || '',
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET || '',
  GOOGLE_REDIRECT_URI: process.env.GOOGLE_REDIRECT_URI || '',
  GOOGLE_STATE_SECRET: process.env.GOOGLE_STATE_SECRET || '',

  // github oauth client config
  GITHUB_CLIENT_ID: process.env.GITHUB_CLIENT_ID || '',
  GITHUB_CLIENT_SECRET: process.env.GITHUB_CLIENT_SECRET || '',
  GITHUB_REDIRECT_URI: process.env.GITHUB_REDIRECT_URI || '',
  GITHUB_STATE_SECRET: process.env.GITHUB_STATE_SECRET || '',

  // linkedin oauth client config
  LINKEDIN_CLIENT_ID: process.env.LINKEDIN_CLIENT_ID || '',
  LINKEDIN_CLIENT_SECRET: process.env.LINKEDIN_CLIENT_SECRET || '',
  LINKEDIN_REDIRECT_URI: process.env.LINKEDIN_REDIRECT_URI || '',
  LINKEDIN_STATE_SECRET: process.env.LINKEDIN_STATE_SECRET || '',

  // redis
  REDIS_URL: process.env.REDIS_URL || '',
  REDIS_ORDER_TIMEOUT_WORKER_MS: positiveInt('REDIS_ORDER_TIMEOUT_WORKER_MS', 3000),

  // stripe
  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY || '',
  // without it every stripe event is refused and no order becomes paid: production does not
  // start, elsewhere the start only warns (startupWarnings)
  STRIPE_WEBHOOK_SECRET:
    NODE_ENV === 'production'
      ? required('STRIPE_WEBHOOK_SECRET')
      : process.env.STRIPE_WEBHOOK_SECRET || '',
  STRIPE_CURRENCY: currencyWithCents('STRIPE_CURRENCY', 'eur'),
};
