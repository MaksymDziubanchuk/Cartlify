import { t } from '@config/i18n.js';
import { shopSettings } from '@config/shopSettings.js';
import { greetingOf } from '@services/email/greeting.js';
import { renderTemplate } from '@services/email/renderTemplate.js';
import { sellerLineOf } from '@services/email/seller.js';

// root reset the second step of the login of an admin, or an admin or root logged in with a
// recovery code (how many are left goes along)
export type TwoFactorNoticeKind = 'reset' | 'recovery';

export type TwoFactorNoticeTemplateArgs = {
  kind: TwoFactorNoticeKind;
  loginUrl: string;
  at: Date;
  recoveryCodesLeft?: number;
  userName?: string;
  appName?: string;
  logoUrl?: string | null;
  locale?: string;
};

// "2026-11-25 09:05 UTC"
const utcMinute = (date: Date) => `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;

// the mail itself is twoFactorNotice.html and twoFactorNotice.txt next to this file
export function buildTwoFactorNoticeTemplate(args: TwoFactorNoticeTemplateArgs): {
  subject: string;
  text: string;
  html: string;
} {
  const appName = args.appName?.trim() || shopSettings().shopName;
  const loginUrl = args.loginUrl?.trim() || '';
  const locale = args.locale || 'en';

  if (!loginUrl) throw new Error('LOGIN_URL_REQUIRED');

  const key = (name: string) => `twoFactorNotice.${args.kind}${name}`;
  const words = { appName, at: utcMinute(args.at), left: String(args.recoveryCodesLeft ?? 0) };

  const values = {
    appName,
    loginUrl,
    userName: args.userName?.trim() || '',
    logoUrl: args.logoUrl?.trim() || '',
    year: String(new Date().getFullYear()),
    title: t(key('Title'), locale, words),
    preview: t(key('Preview'), locale, words),
    heading: t(key('Heading'), locale, words),
    body: t(key('Body'), locale, words),
    notYou: t('twoFactorNotice.notYou', locale),
    button: t('twoFactorNotice.button', locale),
    leadTxt: t(key('LeadTxt'), locale, words),
    greeting: greetingOf(args.userName, locale),
    seller: sellerLineOf(locale),
    openLinkFallback: t('common.openLinkFallback', locale),
    questionsIntro: t('common.questionsIntro', locale),
    orTo: t('common.orTo', locale),
  };

  return {
    subject: t(key('Subject'), locale, words),
    text: renderTemplate('auth/twoFactorNotice.txt', values),
    html: renderTemplate('auth/twoFactorNotice.html', values),
  };
}
