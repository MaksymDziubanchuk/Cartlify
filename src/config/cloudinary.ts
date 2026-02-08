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
  } catch {
    throw new AppError('Server misconfigured: CLOUDINARY_URL invalid', 500);
  }

  if (u.protocol !== 'cloudinary:') {
    throw new AppError('Server misconfigured: CLOUDINARY_URL protocol', 500);
  }

  const apiKey = decodeURIComponent(u.username || '').trim();
  const apiSecret = decodeURIComponent(u.password || '').trim();
  const cloudName = (u.hostname || '').trim();

  if (!apiKey || !apiSecret || !cloudName) {
    throw new AppError('Server misconfigured: CLOUDINARY_URL incomplete', 500);
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
    throw new AppError('Server misconfigured: CLOUDINARY credentials', 500);
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
