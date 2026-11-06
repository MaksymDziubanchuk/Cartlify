import { t } from '@config/i18n.js';
import { greetingOf } from '@services/email/greeting.js';
import { renderTemplate } from '@services/email/renderTemplate.js';
import { sellerLineOf } from '@services/email/seller.js';

export type PasswordChangedTemplateArgs = {
  loginUrl: string;
  changedAt: Date;
  userName?: string;
  appName?: string;
  logoCid?: string;
  locale?: string;
};

// "2026-10-23 09:05 UTC"
const utcMinute = (date: Date) => `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;

// the mail itself is passwordChanged.html and passwordChanged.txt next to this file
export function buildPasswordChangedTemplate(args: PasswordChangedTemplateArgs): {
  subject: string;
  text: string;
  html: string;
} {
  const appName = args.appName?.trim() || 'Cartlify';
  const loginUrl = args.loginUrl?.trim() || '';
  const locale = args.locale || 'en';

  if (!loginUrl) throw new Error('LOGIN_URL_REQUIRED');

  const changedAt = utcMinute(args.changedAt);

  const values = {
    appName,
    loginUrl,
    changedAt,
    userName: args.userName?.trim() || '',
    logoCid: args.logoCid?.trim() || '',
    year: String(new Date().getFullYear()),
    title: t('passwordChanged.title', locale, { appName }),
    preview: t('passwordChanged.preview', locale, { appName }),
    heading: t('passwordChanged.heading', locale),
    body: t('passwordChanged.body', locale, { changedAt }),
    notYou: t('passwordChanged.notYou', locale),
    button: t('passwordChanged.button', locale),
    leadTxt: t('passwordChanged.leadTxt', locale, { appName, changedAt }),
    greeting: greetingOf(args.userName, locale),
    seller: sellerLineOf(locale),
    openLinkFallback: t('common.openLinkFallback', locale),
    questionsIntro: t('common.questionsIntro', locale),
    orTo: t('common.orTo', locale),
  };

  return {
    subject: t('passwordChanged.subject', locale, { appName }),
    text: renderTemplate('auth/passwordChanged.txt', values),
    html: renderTemplate('auth/passwordChanged.html', values),
  };
}
