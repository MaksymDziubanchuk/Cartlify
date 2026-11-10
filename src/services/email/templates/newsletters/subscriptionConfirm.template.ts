import { t } from '@config/i18n.js';
import { NEWSLETTER_CONFIRM_DAYS } from '@helpers/newsletterTokens.js';
import { renderTemplate } from '@services/email/renderTemplate.js';
import { sellerLineOf } from '@services/email/seller.js';

export type SubscriptionConfirmTemplateArgs = {
  // the button that confirms the subscription
  confirmUrl: string;
  // the second button, "this is not me": blocks the address for the form
  declineUrl: string;
  appName?: string;
  logoUrl?: string | null;
  // the language the subscription asked for
  locale?: string;
};

// the mail itself is subscriptionConfirm.html and subscriptionConfirm.txt next to this file
export function buildSubscriptionConfirmTemplate(args: SubscriptionConfirmTemplateArgs): {
  subject: string;
  text: string;
  html: string;
} {
  const appName = args.appName?.trim() || 'Cartlify';
  const confirmUrl = args.confirmUrl?.trim() || '';
  const declineUrl = args.declineUrl?.trim() || '';
  const locale = args.locale || 'en';

  if (!confirmUrl) throw new Error('CONFIRM_URL_REQUIRED');
  if (!declineUrl) throw new Error('DECLINE_URL_REQUIRED');

  const values = {
    appName,
    confirmUrl,
    declineUrl,
    lang: locale,
    logoUrl: args.logoUrl?.trim() || '',
    year: String(new Date().getFullYear()),
    title: t('subscriptionConfirm.title', locale, { appName }),
    preview: t('subscriptionConfirm.preview', locale, { appName }),
    heading: t('subscriptionConfirm.heading', locale),
    body: t('subscriptionConfirm.body', locale, { appName }),
    button: t('subscriptionConfirm.button', locale),
    declineButton: t('subscriptionConfirm.declineButton', locale),
    ignoreEmail: t('subscriptionConfirm.ignoreEmail', locale),
    seller: sellerLineOf(locale),
    validity: t('common.validity', locale, {
      expiresInText: t('common.daysCount', locale, { count: NEWSLETTER_CONFIRM_DAYS }),
    }),
    openLinkFallback: t('common.openLinkFallback', locale),
    questionsIntro: t('common.questionsIntro', locale),
    orTo: t('common.orTo', locale),
  };

  return {
    subject: t('subscriptionConfirm.subject', locale, { appName }),
    text: renderTemplate('newsletters/subscriptionConfirm.txt', values),
    html: renderTemplate('newsletters/subscriptionConfirm.html', values),
  };
}
