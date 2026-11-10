import { t } from '@config/i18n.js';
import { greetingOf } from '@services/email/greeting.js';
import { renderTemplate } from '@services/email/renderTemplate.js';
import { sellerLineOf } from '@services/email/seller.js';

export type ReviewRemovedTemplateArgs = {
  // the product the review was of
  productName: string;
  // which removal of a review of the author by a moderator this is, this one counted
  removals: number;
  // the removals the rules allow (reviewRemovalsLimit, root sets it)
  limit: number;
  userName?: string | null;
  appName?: string;
  logoUrl?: string | null;
  locale?: string;
};

// the mail itself is reviewRemoved.html and reviewRemoved.txt next to this file. Before the limit
// it counts the removal, at the limit it warns it was the last one, past it it says the account
// can be deleted now
export function buildReviewRemovedTemplate(args: ReviewRemovedTemplateArgs): {
  subject: string;
  text: string;
  html: string;
} {
  const appName = args.appName?.trim() || 'Cartlify';
  const locale = args.locale || 'en';
  const removals = String(args.removals);
  const limit = String(args.limit);

  const values = {
    appName,
    productName: args.productName,
    userName: args.userName?.trim() || '',
    logoUrl: args.logoUrl?.trim() || '',
    year: String(new Date().getFullYear()),
    beforeLimit:
      args.removals < args.limit ? t('common.removalBeforeLimit', locale, { removals, limit }) : '',
    atLimit: args.removals === args.limit ? t('common.removalAtLimit', locale, { limit }) : '',
    pastLimit:
      args.removals > args.limit ? t('common.removalPastLimit', locale, { removals, limit }) : '',
    title: t('reviewRemoved.subject', locale, { appName }),
    preview: t('reviewRemoved.preview', locale, { appName }),
    heading: t('reviewRemoved.heading', locale),
    body: t('reviewRemoved.body', locale, { appName, productName: args.productName }),
    greeting: greetingOf(args.userName, locale),
    seller: sellerLineOf(locale),
    questionsIntro: t('common.questionsIntro', locale),
    orTo: t('common.orTo', locale),
  };

  return {
    subject: values.title,
    text: renderTemplate('users/reviewRemoved.txt', values),
    html: renderTemplate('users/reviewRemoved.html', values),
  };
}
