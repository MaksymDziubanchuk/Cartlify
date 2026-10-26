import { renderTemplate } from '@services/email/renderTemplate.js';

export type ReviewRemovedTemplateArgs = {
  // the product the review was of
  productName: string;
  // which removal of a review of the author by a moderator this is, this one counted
  removals: number;
  // the removals the rules allow (REVIEW_REMOVALS_LIMIT)
  limit: number;
  userName?: string | null;
  appName?: string;
  logoCid?: string;
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

  const values = {
    appName,
    productName: args.productName,
    userName: args.userName?.trim() || '',
    logoCid: args.logoCid?.trim() || '',
    year: String(new Date().getFullYear()),
    removals: String(args.removals),
    limit: String(args.limit),
    beforeLimit: args.removals < args.limit ? 'yes' : '',
    atLimit: args.removals === args.limit ? 'yes' : '',
    pastLimit: args.removals > args.limit ? 'yes' : '',
  };

  return {
    subject: `${appName} — Your review was removed`,
    text: renderTemplate('users/reviewRemoved.txt', values),
    html: renderTemplate('users/reviewRemoved.html', values),
  };
}
