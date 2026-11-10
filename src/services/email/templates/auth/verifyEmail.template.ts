import { t } from '@config/i18n.js';
import { shopSettings } from '@config/shopSettings.js';
import { greetingOf } from '@services/email/greeting.js';
import { renderTemplate } from '@services/email/renderTemplate.js';
import { sellerLineOf } from '@services/email/seller.js';

export type VerifyEmailTemplateArgs = {
  verifyUrl: string;
  userName?: string;
  appName?: string;
  logoUrl?: string | null;
  expiresInText?: string;
  locale?: string;
};

// the mail itself is verifyEmail.html and verifyEmail.txt next to this file
export function buildVerifyEmailTemplate(args: VerifyEmailTemplateArgs): {
  subject: string;
  text: string;
  html: string;
} {
  const appName = args.appName?.trim() || shopSettings().shopName;
  const verifyUrl = args.verifyUrl?.trim() || '';
  const locale = args.locale || 'en';

  if (!verifyUrl) throw new Error('VERIFY_URL_REQUIRED');

  const values = {
    appName,
    verifyUrl,
    userName: args.userName?.trim() || '',
    logoUrl: args.logoUrl?.trim() || '',
    expiresInText: args.expiresInText?.trim() || '',
    year: String(new Date().getFullYear()),
    title: t('verifyEmail.title', locale, { appName }),
    preview: t('verifyEmail.preview', locale, { appName }),
    heading: t('verifyEmail.heading', locale),
    body: t('verifyEmail.body', locale),
    button: t('verifyEmail.button', locale),
    leadTxt: t('verifyEmail.leadTxt', locale, { appName }),
    greeting: greetingOf(args.userName, locale),
    seller: sellerLineOf(locale),
    validity: t('common.validity', locale, { expiresInText: args.expiresInText?.trim() || '' }),
    openLinkFallback: t('common.openLinkFallback', locale),
    openLinkTxt: t('common.openLinkTxt', locale),
    ignoreEmail: t('common.ignoreEmail', locale),
    questionsIntro: t('common.questionsIntro', locale),
    orTo: t('common.orTo', locale),
  };

  return {
    subject: t('verifyEmail.subject', locale, { appName }),
    text: renderTemplate('auth/verifyEmail.txt', values),
    html: renderTemplate('auth/verifyEmail.html', values),
  };
}
