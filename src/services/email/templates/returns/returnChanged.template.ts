import { renderTemplate } from '@services/email/renderTemplate.js';

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
  logoCid?: string;
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
  const appName = args.appName?.trim() || 'Cartlify';

  const values = {
    appName,
    orderId: String(args.orderId),
    code: args.code.trim(),
    changeLine: args.allTaken
      ? 'All the goods of your statement are now handled in another statement of this order, so yours is closed.'
      : 'Some of the goods of your statement are now handled in another statement of this order; the rest of yours stays as it was.',
    supportEmail: args.supportEmail.trim(),
    userName: args.userName?.trim() || '',
    logoCid: args.logoCid?.trim() || '',
    year: String(new Date().getFullYear()),
  };

  return {
    subject: `${appName} — Your statement for order #${args.orderId} changed (${values.code})`,
    text: renderTemplate('returns/returnChanged.txt', values),
    html: renderTemplate('returns/returnChanged.html', values),
  };
}
