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

      CLOUDINARY_CLOUD_NAME: string;
      CLOUDINARY_API_KEY: string;
      CLOUDINARY_API_SECRET: string;
      CLOUDINARY_URL: string;

      OPENAI_API_KEY: string;
      OPENAI_MODEL?: string;
      OPENAI_TIMEOUT_MS?: string;
      OPENAI_MAX_OUTPUT_TOKENS?: string;

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
      STRIPE_SUCCESS_URL: string;
      STRIPE_CANCEL_URL: string;
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

export default {
  // runtime mode and server bind
  NODE_ENV: process.env.NODE_ENV || 'development',
  PORT: positiveInt('PORT', 3000),

  // host bind and db url
  HOST: process.env.HOST ? process.env.HOST : '0.0.0.0',
  DATABASE_URL: process.env.DATABASE_URL || '',
  WEB_ORIGIN: process.env.WEB_ORIGIN || '',
  // domain the site lives on, the address of a deleted account is built on it
  SITE_DOMAIN: process.env.SITE_DOMAIN || '',

  // access token config
  JWT_ACCESS_SECRET: required('JWT_ACCESS_SECRET'),

  // access ttl presets
  JWT_ACCESS_TTL_SHORT: process.env.JWT_ACCESS_TTL_SHORT || '1200',
  JWT_ACCESS_TTL_LONG: process.env.JWT_ACCESS_TTL_LONG || '3600',

  // refresh token config
  JWT_REFRESH_SECRET: required('JWT_REFRESH_SECRET'),
  JWT_REFRESH_TTL_SHORT: process.env.JWT_REFRESH_TTL_SHORT || '86400',
  JWT_REFRESH_TTL_LONG: process.env.JWT_REFRESH_TTL_LONG || '2592000',

  // guest cookie lifetime
  GUEST_ID_TTL: process.env.GUEST_ID_TTL || '157680000',

  // password reset ttl
  RESET_TTL_MS: positiveInt('RESET_TTL_MS', 3600000),

  // bcrypt cost factor
  BCRYPT_ROUNDS: process.env.BCRYPT_ROUNDS ? Number(process.env.BCRYPT_ROUNDS) : 12,

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
  STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET || '',
  STRIPE_SUCCESS_URL: process.env.STRIPE_SUCCESS_URL || '',
  STRIPE_CANCEL_URL: process.env.STRIPE_CANCEL_URL || '',
  STRIPE_CURRENCY: process.env.STRIPE_CURRENCY || 'eur',
};
