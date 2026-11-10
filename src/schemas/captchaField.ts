// the answer of the captcha in the body of a form (src/middlewares/requireCaptcha.ts): every route
// with a captcha asks for it in the field captchaToken and lists it among the required ones

// a token of Cloudflare Turnstile is up to 2048 characters
export const CAPTCHA_TOKEN_MAX_LENGTH = 2048;

export const captchaTokenField = {
  type: 'string',
  minLength: 1,
  maxLength: CAPTCHA_TOKEN_MAX_LENGTH,
  description:
    'The answer of the Cloudflare Turnstile widget the visitor solved on the page (up to 2048 ' +
    'characters). It works once: take a new one for every request, also after a refusal. A wrong, ' +
    'used or expired answer is `400 CAPTCHA_INVALID`; when Cloudflare cannot be asked the request is ' +
    '`503 CAPTCHA_UNAVAILABLE`. The check comes after the validation of the body and before the route ' +
    'does anything.',
} as const;
