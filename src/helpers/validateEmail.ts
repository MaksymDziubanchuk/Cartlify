import { BadRequestError } from '@utils/errors.js';
import type { Email } from 'types/common.js';

// the same pattern as format: 'email' in the request schemas (ajv-formats, full mode),
// so services and schemas accept exactly the same addresses
const EMAIL_PATTERN =
  /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i;

// basic email format check
export function isEmail(value: unknown): value is Email {
  return typeof value === 'string' && EMAIL_PATTERN.test(value);
}

// throw on invalid email
export function assertEmail(value: unknown): asserts value is Email {
  if (typeof value !== 'string' || !EMAIL_PATTERN.test(value)) {
    throw new BadRequestError('INVALID_EMAIL');
  }
}

export { EMAIL_PATTERN };
