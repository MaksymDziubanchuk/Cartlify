import { captchaProvider } from '@providers/captcha/index.js';

// the answer of the captcha in the body of a form (src/middlewares/requireCaptcha.ts): every route
// with a captcha asks for it in the field captchaToken and lists it among the required ones

// the longest answer the widget of the captcha gives
export const CAPTCHA_TOKEN_MAX_LENGTH = captchaProvider.tokenMaxLength;

export const captchaTokenField = {
  type: 'string',
  minLength: 1,
  maxLength: CAPTCHA_TOKEN_MAX_LENGTH,
  description:
    `The answer of the ${captchaProvider.label} widget the visitor solved on the page (up to ` +
    `${CAPTCHA_TOKEN_MAX_LENGTH} characters). It works once: take a new one for every request, also ` +
    'after a refusal. A wrong, used or expired answer is `400 CAPTCHA_INVALID`; when the captcha ' +
    'cannot be asked the request is ' +
    '`503 CAPTCHA_UNAVAILABLE`. The check comes after the validation of the body and before the route ' +
    'does anything.',
} as const;
