import env from '@config/env.js';

import { pickProvider } from '../provider.js';

import { CAPTCHA_PROVIDER_NAMES } from './names.js';
import { turnstileProvider } from './turnstile/turnstile.provider.js';

import type { CaptchaProvider } from './types.js';

export * from './names.js';
export type * from './types.js';

// every captcha this server has; CAPTCHA_PROVIDER names the one it checks the forms with
const providers: readonly CaptchaProvider[] = [turnstileProvider];

// the list the settings take the names from is the list of the providers themselves
if (
  providers.length !== CAPTCHA_PROVIDER_NAMES.length ||
  providers.some((provider, i) => provider.name !== CAPTCHA_PROVIDER_NAMES[i])
) {
  throw new Error('CAPTCHA_PROVIDER_NAMES must name the captchas in the same order');
}

export const captchaProvider: CaptchaProvider = pickProvider(
  'CAPTCHA_PROVIDER',
  env.CAPTCHA_PROVIDER,
  providers,
);
