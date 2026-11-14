import type { Provider } from '../provider.js';

import type { CaptchaProviderName } from './names.js';

// what a failed check is logged with: the logger of the request
export type CaptchaLogger = { warn: (obj: unknown, msg?: string) => void };

// What the rest of the app asks of the captcha of the forms that send a mail or open an account for
// anybody: the page shows the widget of the provider, the visitor who solved it gets an answer (a
// token) the page sends in captchaToken, and the provider says whether it is good. How it says it is
// its own
export interface CaptchaProvider extends Provider<CaptchaProviderName> {
  // the longest answer its widget gives
  tokenMaxLength: number;
  // resolves when the answer is good; 400 CAPTCHA_INVALID when it is missing or refused, 503
  // CAPTCHA_UNAVAILABLE when the provider gives no verdict (no answer in time, a failure, the secret
  // of the shop not taken): a captcha that cannot be checked lets nothing through. The address of
  // the visitor goes along when it is known; the log never holds the answer or the secret
  verify(input: { token: unknown; ip: string | undefined; log: CaptchaLogger }): Promise<void>;
}
