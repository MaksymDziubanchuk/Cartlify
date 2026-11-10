import { t } from '@config/i18n.js';
import { greetingOf } from '@services/email/greeting.js';
import { renderTemplate } from '@services/email/renderTemplate.js';
import { sellerLineOf } from '@services/email/seller.js';

export type ResetPasswordTemplateArgs = {
  resetUrl: string;
  userName?: string;
  appName?: string;
  logoUrl?: string | null;
  expiresInText?: string;
  locale?: string;
};

// the mail itself is resetPassword.html and resetPassword.txt next to this file
export function buildResetPasswordTemplate(args: ResetPasswordTemplateArgs): {
  subject: string;
  text: string;
  html: string;
} {
  const appName = args.appName?.trim() || 'Cartlify';
  const resetUrl = args.resetUrl?.trim() || '';
  const locale = args.locale || 'en';

  if (!resetUrl) throw new Error('RESET_URL_REQUIRED');

  const values = {
    appName,
    resetUrl,
    userName: args.userName?.trim() || '',
    logoUrl: args.logoUrl?.trim() || '',
    expiresInText: args.expiresInText?.trim() || '',
    year: String(new Date().getFullYear()),
    title: t('resetPassword.title', locale, { appName }),
    preview: t('resetPassword.preview', locale, { appName }),
    heading: t('resetPassword.heading', locale),
    body: t('resetPassword.body', locale),
    button: t('resetPassword.button', locale),
    leadTxt: t('resetPassword.leadTxt', locale, { appName }),
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
    subject: t('resetPassword.subject', locale, { appName }),
    text: renderTemplate('auth/resetPassword.txt', values),
    html: renderTemplate('auth/resetPassword.html', values),
  };
}
