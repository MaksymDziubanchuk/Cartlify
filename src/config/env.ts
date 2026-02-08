import * as dotenv from 'dotenv';

declare global {
  namespace NodeJS {
    // type process.env keys
    interface ProcessEnv {
      NODE_ENV: 'development' | 'production' | 'test';
      PORT?: string;
      HOST?: string;

      WEB_ORIGIN: string;

      DATABASE_URL: string;

      SUPABASE_URL: string;
      SUPABASE_ANON_KEY: string;
      SUPABASE_SERVICE_ROLE_KEY: string;

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

      SENDGRID_API_KEY: string;

      EMAIL_FROM: string;
      EMAIL_FROM_NAME: string;
      EMAIL_REPLY_TO: string;

      COOKIE_SECRET: string;

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
    }
  }
}

// init dotenv before reads
dotenv.config();

export default {
  // runtime mode and server bind
  NODE_ENV: process.env.NODE_ENV || 'development',
  PORT: process.env.PORT ? Number(process.env.PORT) : 3000,

  // host bind and db url
  HOST: process.env.HOST ? process.env.HOST : '0.0.0.0',
  DATABASE_URL: process.env.DATABASE_URL || '',
  WEB_ORIGIN: process.env.WEB_ORIGIN || '',

  // supabase client keys
  SUPABASE_URL: process.env.SUPABASE_URL || '',
  SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY || '',
  // supabase admin key
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY || '',

  // access token config
  JWT_ACCESS_SECRET: process.env.JWT_ACCESS_SECRET || 'changeme',
  // access ttl presets
  JWT_ACCESS_TTL_SHORT: process.env.JWT_ACCESS_TTL_SHORT || '1200',

  JWT_ACCESS_TTL_LONG: process.env.JWT_ACCESS_TTL_LONG || '3600',
  // refresh token config
  JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET || 'changeme',
  JWT_REFRESH_TTL_SHORT: process.env.JWT_REFRESH_TTL_SHORT || '86400',
  JWT_REFRESH_TTL_LONG: process.env.JWT_REFRESH_TTL_LONG || '2592000',
  // guest cookie lifetime
  GUEST_ID_TTL: process.env.GUEST_ID_TTL || '157680000',

  RESET_TTL_MS: process.env.RESET_TTL_MS ? Number(process.env.RESET_TTL_MS) : 3600000,
  // bcrypt cost factor
  BCRYPT_ROUNDS: process.env.BCRYPT_ROUNDS ? Number(process.env.BCRYPT_ROUNDS) : 12,
  // cloudinary api keys
  CLOUDINARY_CLOUD_NAME: process.env.CLOUDINARY_CLOUD_NAME || '',
  CLOUDINARY_API_KEY: process.env.CLOUDINARY_API_KEY || '',
  CLOUDINARY_API_SECRET: process.env.CLOUDINARY_API_SECRET || '',
  CLOUDINARY_URL: process.env.CLOUDINARY_URL || '',

  // openai and cookie secret
  OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',

  // SendGrid variables
  SENDGRID_API_KEY: process.env.SENDGRID_API_KEY || '',
  EMAIL_FROM: process.env.EMAIL_FROM || '',
  EMAIL_FROM_NAME: process.env.EMAIL_FROM_NAME || '',
  EMAIL_REPLY_TO: process.env.EMAIL_REPLY_TO || '',

  // cookie signing secret
  COOKIE_SECRET: process.env.COOKIE_SECRET || 'changeme',

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
};
