import { t } from '@config/i18n.js';
import { renderTemplate } from '@services/email/renderTemplate.js';
import { sellerLineOf } from '@services/email/seller.js';

export type SubscriptionAlreadyTemplateArgs = {
  // the button "Manage the subscription"
  manageUrl: string;
  appName?: string;
  logoUrl?: string | null;
  // the language of the subscription that exists, not of the request that came
  locale?: string;
  // the subscription that exists is paused after a spam mark: the mail says so and where to resume
  // it, instead of "you are already subscribed"
  paused?: boolean;
};

// the mail itself is subscriptionAlready.html and subscriptionAlready.txt next to this file
export function buildSubscriptionAlreadyTemplate(args: SubscriptionAlreadyTemplateArgs): {
  subject: string;
  text: string;
  html: string;
} {
  const appName = args.appName?.trim() || 'Cartlify';
  const manageUrl = args.manageUrl?.trim() || '';
  const locale = args.locale || 'en';
  // the words of the mail: those of "you are already subscribed", or of "your subscription is paused"
  const words = args.paused
    ? {
        title: 'subscriptionAlready.pausedTitle',
        subject: 'subscriptionAlready.pausedSubject',
        preview: 'subscriptionAlready.pausedPreview',
        heading: 'subscriptionAlready.pausedHeading',
        body: 'subscriptionAlready.pausedBody',
      }
    : {
        title: 'subscriptionAlready.title',
        subject: 'subscriptionAlready.subject',
        preview: 'subscriptionAlready.preview',
        heading: 'subscriptionAlready.heading',
        body: 'subscriptionAlready.body',
      };

  if (!manageUrl) throw new Error('MANAGE_URL_REQUIRED');

  const values = {
    appName,
    manageUrl,
    lang: locale,
    logoUrl: args.logoUrl?.trim() || '',
    year: String(new Date().getFullYear()),
    title: t(words.title, locale, { appName }),
    preview: t(words.preview, locale, { appName }),
    heading: t(words.heading, locale),
    body: t(words.body, locale, { appName }),
    button: t('subscriptionAlready.button', locale),
    ignoreEmail: t('subscriptionAlready.ignoreEmail', locale),
    seller: sellerLineOf(locale),
    openLinkFallback: t('common.openLinkFallback', locale),
    questionsIntro: t('common.questionsIntro', locale),
    orTo: t('common.orTo', locale),
  };

  return {
    subject: t(words.subject, locale, { appName }),
    text: renderTemplate('newsletters/subscriptionAlready.txt', values),
    html: renderTemplate('newsletters/subscriptionAlready.html', values),
  };
}
