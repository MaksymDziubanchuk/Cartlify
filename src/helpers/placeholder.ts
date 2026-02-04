import crypto from 'node:crypto';
import { AppError } from '@utils/errors.js';

export type PlaceholderEncoding = 'hex' | 'base64url';

export const DEFAULT_PLACEHOLDER_BYTES = 32 as const;

// generate random placeholder string
export function createPlaceholder(
  bytes: number = DEFAULT_PLACEHOLDER_BYTES,
  encoding: PlaceholderEncoding = 'hex',
): string {
  if (!Number.isInteger(bytes) || bytes <= 0) {
    throw new AppError(`Invalid placeholder bytes: ${bytes}`, 500);
  }
  return crypto.randomBytes(bytes).toString(encoding);
}

// decode and validate internal token
export function decodePlaceholderInternal(
  value: string,
  encoding: PlaceholderEncoding = 'hex',
): Buffer {
  if (typeof value !== 'string' || value.length === 0) {
    throw new AppError('Internal placeholder is empty or not a string', 500);
  }

  // validate placeholder format by encoding
  if (encoding === 'hex') {
    if (value.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(value)) {
      throw new AppError('Internal hex placeholder is invalid', 500);
    }
  } else {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) {
      throw new AppError('Internal base64url placeholder is invalid', 500);
    }
  }

  // decode placeholder to bytes
  try {
    return Buffer.from(value, encoding);
  } catch {
    throw new AppError('Failed to decode internal placeholder', 500);
  }
}
