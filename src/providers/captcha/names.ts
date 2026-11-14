// the captchas this server can check the forms with; CAPTCHA_PROVIDER names the one it works with.
// No client here, the tests read it
export const CAPTCHA_PROVIDER_NAMES = ['turnstile'] as const;

export type CaptchaProviderName = (typeof CAPTCHA_PROVIDER_NAMES)[number];
