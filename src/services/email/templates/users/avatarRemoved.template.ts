import { t } from '@config/i18n.js';
import { greetingOf } from '@services/email/greeting.js';
import { renderTemplate } from '@services/email/renderTemplate.js';
import { sellerLineOf } from '@services/email/seller.js';

export type AvatarRemovedTemplateArgs = {
  // which removal by a moderator this is, this one counted
  removals: number;
  // the removals the rules allow (avatarRemovalsLimit, root sets it)
  limit: number;
  userName?: string | null;
  appName?: string;
  logoUrl?: string | null;
  locale?: string;
};

// the mail itself is avatarRemoved.html and avatarRemoved.txt next to this file. Before the limit
// it counts the removal, at the limit it warns it was the last one, past it it says the account
// can be deleted now
export function buildAvatarRemovedTemplate(args: AvatarRemovedTemplateArgs): {
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
    userName: args.userName?.trim() || '',
    logoUrl: args.logoUrl?.trim() || '',
    year: String(new Date().getFullYear()),
    beforeLimit:
      args.removals < args.limit ? t('common.removalBeforeLimit', locale, { removals, limit }) : '',
    atLimit: args.removals === args.limit ? t('common.removalAtLimit', locale, { limit }) : '',
    pastLimit:
      args.removals > args.limit ? t('common.removalPastLimit', locale, { removals, limit }) : '',
    title: t('avatarRemoved.subject', locale, { appName }),
    preview: t('avatarRemoved.preview', locale, { appName }),
    heading: t('avatarRemoved.heading', locale),
    body: t('avatarRemoved.body', locale, { appName }),
    greeting: greetingOf(args.userName, locale),
    seller: sellerLineOf(locale),
    questionsIntro: t('common.questionsIntro', locale),
    orTo: t('common.orTo', locale),
  };

  return {
    subject: values.title,
    text: renderTemplate('users/avatarRemoved.txt', values),
    html: renderTemplate('users/avatarRemoved.html', values),
  };
}
