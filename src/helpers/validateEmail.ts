import { BadRequestError } from '@utils/errors.js';
import type { Email } from 'types/common.js';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// basic email format check
export function isEmail(value: unknown): value is Email {
  return typeof value === 'string' && EMAIL_PATTERN.test(value);
}

// throw on invalid email
export function assertEmail(value: unknown): asserts value is Email {
  if (typeof value !== 'string' || !EMAIL_PATTERN.test(value)) {
    throw new BadRequestError('INVALID_EMAIL');
  } else return;
}

export { EMAIL_PATTERN };
