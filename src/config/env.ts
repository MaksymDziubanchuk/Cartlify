import * as dotenv from 'dotenv';

declare global {
  namespace NodeJS {
    interface ProcessEnv {
      NODE_ENV: 'development' | 'production' | 'test';
      PORT?: string;
      HOST?: string;

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

      CLOUDINARY_CLOUD_NAME: string;
      CLOUDINARY_API_KEY: string;
      CLOUDINARY_API_SECRET: string;

      OPENAI_API_KEY: string;

      COOKIE_SECRET: string;

      GOOGLE_CLIENT_ID: string;
      GOOGLE_CLIENT_SECRET: string;
      GOOGLE_REDIRECT_URI: string;
      GOOGLE_STATE_SECRET: string;
    }
  }
}

dotenv.config();

export default {
  NODE_ENV: process.env.NODE_ENV || 'development',
  PORT: process.env.PORT ? Number(process.env.PORT) : 3000,
  HOST: process.env.HOST ? process.env.HOST : '0.0.0.0',

  DATABASE_URL: process.env.DATABASE_URL || '',

  // Supabase
  SUPABASE_URL: process.env.SUPABASE_URL || '',
  SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY || '',
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY || '',

  // JWT
  JWT_ACCESS_SECRET: process.env.JWT_SECRET || 'changeme',
  JWT_ACCESS_TTL_SHORT: process.env.JWT_ACCESS_TTL_SHORT || '1h',
  JWT_ACCESS_TTL_LONG: process.env.JWT_ACCESS_TTL_LONG || '24h',

  JWT_REFRESH_SECRET: process.env.JWT_SECRET || 'changeme',
  JWT_REFRESH_TTL_SHORT: process.env.JWT_ACCESS_TTL_SHORT || '1d',
  JWT_REFRESH_TTL_LONG: process.env.JWT_ACCESS_TTL_LONG || '30d',

  // Cloudinary
  CLOUDINARY_CLOUD_NAME: process.env.CLOUDINARY_CLOUD_NAME || '',
  CLOUDINARY_API_KEY: process.env.CLOUDINARY_API_KEY || '',
  CLOUDINARY_API_SECRET: process.env.CLOUDINARY_API_SECRET || '',

  // OpenAI
  OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',

  // Cookie
  COOKIE_SECRET: process.env.COOKIE_SECRET || 'changeme',

  // Google OAuth
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID || '',
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET || '',
  GOOGLE_REDIRECT_URI: process.env.GOOGLE_REDIRECT_URI || '',
  GOOGLE_STATE_SECRET: process.env.GOOGLE_STATE_SECRET || '',
};
