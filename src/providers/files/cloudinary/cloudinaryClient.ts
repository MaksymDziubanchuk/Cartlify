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

// the shape of a url for logs: the scheme and the separators stay, every part becomes [hidden]
function urlShape(raw: string): string {
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(raw)?.[0] ?? '';

  return scheme + raw.slice(scheme.length).replace(/[^:@/]+/g, '[hidden]');
}

// parses cloudinary://<api_key>:<api_secret>@<cloud_name>
function parseCloudinaryUrl(raw: string): CloudinaryCreds {
  let u: URL;

  try {
    u = new URL(raw);
  } catch (err) {
    // node puts the whole url, the secret included, into the error; only its shape is kept
    if (typeof err === 'object' && err !== null && 'input' in err) {
      (err as { input: unknown }).input = urlShape(raw);
    }

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

// the SDK reads CLOUDINARY_URL itself when it loads, and on a broken one throws a node error
// with the whole url, the secret included. So the url is checked above first, and the SDK
// loads without it in the environment; it gets the checked parts below instead
const rawCloudinaryUrl = process.env.CLOUDINARY_URL;
delete (process.env as Record<string, string | undefined>).CLOUDINARY_URL;

let cloudinary: typeof import('cloudinary').v2;

try {
  ({ v2: cloudinary } = await import('cloudinary'));
} finally {
  if (rawCloudinaryUrl !== undefined) process.env.CLOUDINARY_URL = rawCloudinaryUrl;
}

cloudinary.config({
  cloud_name: creds.cloudName,
  api_key: creds.apiKey,
  api_secret: creds.apiSecret,
  secure: true,
});

export { cloudinary };
export default cloudinary;
