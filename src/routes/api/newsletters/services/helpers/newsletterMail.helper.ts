import { randomBytes } from 'node:crypto';

import { newsletterManageUrl, newsletterUnsubscribeUrl } from '@helpers/newsletterLinks.js';
import { shopSettings } from '@config/shopSettings.js';
import { renderCampaignMail } from '@services/email/templates/newsletters/campaign.template.js';
import type {
  NewsletterContentDto,
  NewsletterSnapshotDto,
  NewsletterWarningDto,
} from 'types/dto/newsletters.dto.js';

// What the sender of the newsletters takes for one reader: the subject, the two bodies, the headers of
// the one-click unsubscribe and what was wrong with the mail. The marks of the campaign and of the
// reader that come back with the events of SendGrid (custom_args: the ids of the campaign and of the
// recipient, never an address or a token) are for the one who sends, who knows the recipient. The mail
// carries no attachment: the logo is shown by its address
export type NewsletterMail = {
  subject: string;
  text: string;
  html: string;
  headers: Record<string, string>;
  warnings: NewsletterWarningDto[];
};

// A token no subscription has: 32 random bytes, the size of a real one. The page behind the link says
// the link is not valid and the one-click unsubscribe does nothing, so a mail made with it touches no
// subscription (the same token stands for both links of a test mail)
export const deadManageToken = (): string => randomBytes(32).toString('base64url');

// The mail of a campaign for a reader, ready for sendNewsletterEmail. With `subscriber` the links of
// the subscription are the reader's own: the page "Manage the subscription" on the token of
// management (manageTokenOf) and the one-click unsubscribe on the token of the unsubscribe
// (unsubscribeTokenOf), two tokens of one subscription (newsletterTokens.ts). Without it they carry
// a token no subscription has (the test mail of an admin: the mail is the reader's, and pressing its
// links harms nobody). `test` marks it as that test mail: the subject starts with the word "test" of
// the language and a line at the top says the subscribers did not get it. The logo is shown by its
// address (shopSettings().logoUrl); a shop without one has its name in its place
export function newsletterMailFor(args: {
  campaign: { id: number; content: NewsletterContentDto };
  snapshot: NewsletterSnapshotDto;
  locale: string;
  subscriber?: { manageToken: string; unsubscribeToken: string };
  test?: boolean;
}): NewsletterMail {
  const dead = deadManageToken();
  const manageToken = args.subscriber?.manageToken ?? dead;
  const unsubscribeToken = args.subscriber?.unsubscribeToken ?? dead;

  const mail = renderCampaignMail({
    content: args.campaign.content,
    snapshot: args.snapshot,
    locale: args.locale,
    campaignId: args.campaign.id,
    manageUrl: newsletterManageUrl(manageToken),
    unsubscribeUrl: newsletterUnsubscribeUrl(unsubscribeToken, args.campaign.id),
    logoUrl: shopSettings().logoUrl,
    ...(args.test ? { test: true } : {}),
  });

  return {
    subject: mail.subject,
    text: mail.text,
    html: mail.html,
    headers: mail.headers,
    warnings: mail.warnings,
  };
}
