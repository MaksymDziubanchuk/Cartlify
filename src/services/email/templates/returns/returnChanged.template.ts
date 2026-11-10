import { t } from '@config/i18n.js';
import { shopSettings } from '@config/shopSettings.js';
import { greetingOf } from '@services/email/greeting.js';
import { renderTemplate } from '@services/email/renderTemplate.js';
import { sellerLineOf } from '@services/email/seller.js';

export type ReturnChangedTemplateArgs = {
  orderId: number;
  // the code of the statement the mail is about (W42-2), told in the subject and the text
  code: string;
  // every unit of the statement left it: nothing of it is left to handle, the database closed it
  allTaken: boolean;
  // where the person writes: the address the shop answers from
  supportEmail: string;
  userName?: string;
  appName?: string;
  logoUrl?: string | null;
  locale?: string;
};

// the mail itself is returnChanged.html and returnChanged.txt next to this file. It goes to the
// person of a statement of the form without the code when a statement of the buyer (from the
// account or with the code) takes its units over. It says they are handled in another statement,
// not who made it and not the units: the person of the form may not be the buyer
export function buildReturnChangedTemplate(args: ReturnChangedTemplateArgs): {
  subject: string;
  text: string;
  html: string;
} {
  const appName = args.appName?.trim() || shopSettings().shopName;
  const locale = args.locale || 'en';
  const orderId = String(args.orderId);
  const code = args.code.trim();

  const values = {
    appName,
    orderId,
    code,
    changeLine: args.allTaken
      ? t('returnChanged.allTaken', locale)
      : t('returnChanged.someTaken', locale),
    supportEmail: args.supportEmail.trim(),
    userName: args.userName?.trim() || '',
    logoUrl: args.logoUrl?.trim() || '',
    year: String(new Date().getFullYear()),
    title: t('returnChanged.subject', locale, { appName, orderId }),
    preview: t('returnChanged.preview', locale, { code }),
    heading: t('returnChanged.heading', locale),
    leadTxt: t('returnChanged.leadTxt', locale, { appName, orderId }),
    body: t('returnChanged.body', locale, { orderId }),
    noteLine: t('returnChanged.noteLine', locale),
    greeting: greetingOf(args.userName, locale),
    seller: sellerLineOf(locale),
    statementLine: t('common.statementLine', locale, { code }),
    questionsIntro: t('common.questionsIntro', locale),
    orTo: t('common.orTo', locale),
  };

  return {
    subject: `${values.title} (${code})`,
    text: renderTemplate('returns/returnChanged.txt', values),
    html: renderTemplate('returns/returnChanged.html', values),
  };
}
