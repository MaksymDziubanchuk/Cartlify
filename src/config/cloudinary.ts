import { v2 as cloudinary } from 'cloudinary';

import env from '@config/env.js';
import { AppError } from '@utils/errors.js';

type CloudinaryCreds = {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
};

function readEnvString(key: string): string | undefined {
  const raw = (env as Record<string, unknown>)[key];
  if (typeof raw !== 'string') return undefined;

  const value = raw.trim();
  return value.length > 0 ? value : undefined;
}

// parses cloudinary://<api_key>:<api_secret>@<cloud_name>
function parseCloudinaryUrl(raw: string): CloudinaryCreds {
  let u: URL;

  try {
    u = new URL(raw);
  } catch (err) {
    throw new AppError({
      statusCode: 500,
      errorCode: 'CONFIG_INVALID',
      message: 'Internal Server Error',
      details: { key: 'CLOUDINARY_URL', reason: 'invalid_url' },
      expose: false,
      cause: err,
    });
  }

  if (u.protocol !== 'cloudinary:') {
    throw new AppError({
      statusCode: 500,
      errorCode: 'CONFIG_INVALID',
      message: 'Internal Server Error',
      details: { key: 'CLOUDINARY_URL', reason: 'invalid_protocol' },
      expose: false,
    });
  }

  const apiKey = decodeURIComponent(u.username || '').trim();
  const apiSecret = decodeURIComponent(u.password || '').trim();
  const cloudName = (u.hostname || '').trim();

  if (!apiKey || !apiSecret || !cloudName) {
    throw new AppError({
      statusCode: 500,
      errorCode: 'CONFIG_INCOMPLETE',
      message: 'Internal Server Error',
      details: { key: 'CLOUDINARY_URL', reason: 'missing_parts' },
      expose: false,
    });
  }

  return { cloudName, apiKey, apiSecret };
}

function getCloudinaryCreds(): CloudinaryCreds {
  const cloudinaryUrl = readEnvString('CLOUDINARY_URL');
  if (cloudinaryUrl) return parseCloudinaryUrl(cloudinaryUrl);

  const cloudName = readEnvString('CLOUDINARY_CLOUD_NAME');
  const apiKey = readEnvString('CLOUDINARY_API_KEY');
  const apiSecret = readEnvString('CLOUDINARY_API_SECRET');

  if (!cloudName || !apiKey || !apiSecret) {
    throw new AppError({
      statusCode: 500,
      errorCode: 'CONFIG_INCOMPLETE',
      message: 'Internal Server Error',
      details: {
        key: 'CLOUDINARY',
        reason: 'missing_env_vars',
        required: ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET'],
      },
      expose: false,
    });
  }

  return { cloudName, apiKey, apiSecret };
}

// configure SDK once at module load
const creds = getCloudinaryCreds();

cloudinary.config({
  cloud_name: creds.cloudName,
  api_key: creds.apiKey,
  api_secret: creds.apiSecret,
  secure: true,
});

export { cloudinary };
export default cloudinary;
