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
      LIMIT_CHAT_CALL_ADMIN_PER_USER?: string;
      LIMIT_WITHDRAWAL_PER_USER?: string;
      LIMIT_WITHDRAWAL_FORM_PER_ADDRESS?: string;
      LIMIT_WITHDRAWAL_FORM_PER_ORDER?: string;
      LIMIT_WITHDRAWAL_FORM_PER_DATA?: string;
      LOGIN_FAILURES_BEFORE_PAUSE?: string;

      UPLOAD_MAX_BYTES?: string;
      PRODUCT_IMAGES_MAX?: string;
      PRODUCT_VARIANTS_MAX?: string;
      VARIANT_IMAGES_MAX?: string;
      DOCUMENT_MAX_BYTES?: string;
      PRODUCT_DOCUMENTS_MAX?: string;
      ATTRIBUTE_OPTIONS_MAX?: string;
      ATTRIBUTE_MULTI_VALUES_MAX?: string;
      VERIFY_TTL_MS?: string;

      SHOP_TIME_ZONE?: string;

      WEB_PAGE_OAUTH_CALLBACK?: string;
      WEB_PAGE_LOGIN?: string;
      WEB_PAGE_VERIFY_EMAIL?: string;
      WEB_PAGE_PASSWORD_RESET?: string;
      WEB_PAGE_CHECKOUT_SUCCESS?: string;
      WEB_PAGE_CHECKOUT_CANCEL?: string;
      WEB_PAGE_ORDER?: string;
      WEB_PAGE_WITHDRAWAL?: string;
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
      CHAT_BOT_IP_DAILY_TURNS?: string;
      CHAT_BOT_SHOP_DAILY_TURNS?: string;

      SENDGRID_API_KEY: string;

      EMAIL_FROM: string;

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
      WITHDRAWAL_CODE_SECRET: string;
      STRIPE_CURRENCY: string;
    }
  }
}

// init dotenv before reads; quiet, since dotenv 17 prints a line of its own on every start,
// outside the fastify logger
dotenv.config({ quiet: true });

// fail fast on missing required vars; a value of spaces only is missing too
function required(name: string): string {
  const value = process.env[name];
  if (!value?.trim()) throw new Error(`Missing required env variable: ${name}`);
  return value;
}

// the code of a link of withdrawal is an HMAC of the number of the order, which every buyer reads in
// their mail: a short secret could be found by trying them offline, and with it the code of every
// order, so a secret is at least this long. The start stops without one in development as in
// production (the dev server is a copy of production); only the tests may go without, then the
// links carry no code
const WITHDRAWAL_CODE_SECRET_MIN = 32;
function withdrawalCodeSecret(nodeEnv: string): string {
  const value =
    nodeEnv === 'test'
      ? process.env.WITHDRAWAL_CODE_SECRET?.trim() || ''
      : required('WITHDRAWAL_CODE_SECRET').trim();

  if (value && value.length < WITHDRAWAL_CODE_SECRET_MIN) {
    throw new Error(
      `Invalid env variable: WITHDRAWAL_CODE_SECRET must be at least ${WITHDRAWAL_CODE_SECRET_MIN} characters`,
    );
  }
  return value;
}

// fail fast on a numeric setting that is not a positive whole number; unset gives the default.
// Number() alone lets NaN and 0 through: a NaN or 0 interval makes node run it every 1 ms. A setting
// with a bound a shop can have no use for beyond (a typo of an extra zero would let a request
// fill the database or the memory) names it in `max`; the message names the bound, not the value
function positiveInt(name: string, fallback: number, max?: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;

  const value = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Invalid env variable: ${name} must be a positive whole number`);
  }
  if (max !== undefined && value > max) {
    throw new Error(`Invalid env variable: ${name} must be at most ${max}`);
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

// The bounds above which the limits of the catalog and of its files stop the start (positiveInt): a
// shop has no use for more, and a value with a zero too many would let one request write thousands of
// rows, hold a transaction for minutes or fill the memory with a file. They are well above the
// defaults (5 MB, 50, 200, 10, 20 MB, 20, 500)
const UPLOAD_LIMIT_BOUNDS = {
  // the biggest file of a form or a document, in bytes (100 MB)
  bytes: 100_000_000,
  // the pictures of a gallery
  galleryImages: 1_000,
  // the variants of a product
  variantsPerProduct: 10_000,
  // the pictures one variant shows
  imagesPerVariant: 100,
  // the documents one product names
  documentsPerProduct: 100,
  // the values one characteristic of a choice has
  options: 10_000,
  // the values of a set one variant has for one characteristic
  multiValues: 1_000,
} as const;

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
  // the page of the form of withdrawal the mails link to; the code of the order follows the # of the link
  WEB_PAGE_WITHDRAWAL: webPage('WEB_PAGE_WITHDRAWAL', '/orders/{id}/withdrawal', true),
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
  LIMIT_CHAT_CALL_ADMIN_PER_USER: positiveInt('LIMIT_CHAT_CALL_ADMIN_PER_USER', 10),
  LIMIT_WITHDRAWAL_PER_USER: positiveInt('LIMIT_WITHDRAWAL_PER_USER', 10),
  LIMIT_WITHDRAWAL_FORM_PER_ADDRESS: positiveInt('LIMIT_WITHDRAWAL_FORM_PER_ADDRESS', 20),
  LIMIT_WITHDRAWAL_FORM_PER_ORDER: positiveInt('LIMIT_WITHDRAWAL_FORM_PER_ORDER', 5),
  LIMIT_WITHDRAWAL_FORM_PER_DATA: positiveInt('LIMIT_WITHDRAWAL_FORM_PER_DATA', 5),
  // the wrong passwords of an account before its login pauses for a minute, doubling after
  LOGIN_FAILURES_BEFORE_PAUSE: positiveInt('LOGIN_FAILURES_BEFORE_PAUSE', 5),

  // the biggest file of a form (an avatar, a picture of a product) and the most pictures of a
  // product (its gallery); a bigger file is cut off with 413 before cloudinary
  // (each has a bound above which the start stops, see UPLOAD_LIMIT_BOUNDS)
  UPLOAD_MAX_BYTES: positiveInt('UPLOAD_MAX_BYTES', 5_000_000, UPLOAD_LIMIT_BOUNDS.bytes),
  PRODUCT_IMAGES_MAX: positiveInt('PRODUCT_IMAGES_MAX', 50, UPLOAD_LIMIT_BOUNDS.galleryImages),
  // the variants of a product and the pictures of the gallery one variant shows
  PRODUCT_VARIANTS_MAX: positiveInt(
    'PRODUCT_VARIANTS_MAX',
    200,
    UPLOAD_LIMIT_BOUNDS.variantsPerProduct,
  ),
  VARIANT_IMAGES_MAX: positiveInt('VARIANT_IMAGES_MAX', 10, UPLOAD_LIMIT_BOUNDS.imagesPerVariant),
  DOCUMENT_MAX_BYTES: positiveInt('DOCUMENT_MAX_BYTES', 20_000_000, UPLOAD_LIMIT_BOUNDS.bytes),
  PRODUCT_DOCUMENTS_MAX: positiveInt(
    'PRODUCT_DOCUMENTS_MAX',
    20,
    UPLOAD_LIMIT_BOUNDS.documentsPerProduct,
  ),
  ATTRIBUTE_OPTIONS_MAX: positiveInt('ATTRIBUTE_OPTIONS_MAX', 500, UPLOAD_LIMIT_BOUNDS.options),
  // the values of a set (a characteristic that holds several values of its list) one variant has
  ATTRIBUTE_MULTI_VALUES_MAX: positiveInt(
    'ATTRIBUTE_MULTI_VALUES_MAX',
    50,
    UPLOAD_LIMIT_BOUNDS.multiValues,
  ),

  // the proxies in front of the server whose x-forwarded-for is trusted: railway puts one, so the
  // address of a client is the one it names (0 trusts none, the address of the connection counts)
  TRUST_PROXY_HOPS: wholeNumber('TRUST_PROXY_HOPS', 1),

  // a line for each request with the addresses the server reads from it, to see on a new host how
  // many proxies stand in front of it; off unless true
  LOG_REQUEST_ADDRESSES: process.env.LOG_REQUEST_ADDRESSES?.trim() === 'true',

  // the days, weeks and months of the reports are the ones of the shop
  SHOP_TIME_ZONE: timeZone('SHOP_TIME_ZONE', 'Europe/Madrid'),

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
  // the model; past them the bot answers with a text of its own and asks the model nothing. A user
  // who has not confirmed the email is counted as a guest
  CHAT_BOT_GUEST_DAILY_TURNS: positiveInt('CHAT_BOT_GUEST_DAILY_TURNS', 30),
  CHAT_BOT_USER_DAILY_TURNS: positiveInt('CHAT_BOT_USER_DAILY_TURNS', 100),
  // the turns of customers who are no confirmed account (guests, users with an unconfirmed email)
  // that come from one address in 24 hours: a new cookie or a new account does not reset them. An
  // IPv6 address counts by its /64 network
  CHAT_BOT_IP_DAILY_TURNS: positiveInt('CHAT_BOT_IP_DAILY_TURNS', 60),
  // the turns of the whole shop that call the model in 24 hours: the ceiling of the bill of the
  // bot whatever the number of customers and addresses; past it the bot answers with its fallback
  // text and asks the model nothing
  CHAT_BOT_SHOP_DAILY_TURNS: positiveInt('CHAT_BOT_SHOP_DAILY_TURNS', 3000),

  // sendgrid variables
  SENDGRID_API_KEY: process.env.SENDGRID_API_KEY || '',
  EMAIL_FROM: process.env.EMAIL_FROM || '',

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
  // without it every stripe event is refused and no order becomes paid: the start stops without it
  // in development as in production, only the tests may go without
  STRIPE_WEBHOOK_SECRET:
    NODE_ENV === 'test'
      ? process.env.STRIPE_WEBHOOK_SECRET || ''
      : required('STRIPE_WEBHOOK_SECRET'),
  STRIPE_CURRENCY: currencyWithCents('STRIPE_CURRENCY', 'eur'),

  // signs the number of an order into the code of the links of withdrawal in the mails; the start
  // stops without it in development as in production (withdrawalCodeSecret)
  WITHDRAWAL_CODE_SECRET: withdrawalCodeSecret(NODE_ENV),
};
