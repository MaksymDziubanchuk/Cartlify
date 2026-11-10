import env from '@config/env.js';
import { apiUrl } from '@helpers/apiOrigin.js';
import { webPageUrl, webUrl } from '@helpers/webOrigin.js';

// The links of the newsletter mails, pages of the frontend (WEB_PAGE_NEWSLETTER_*) that carry the
// token of the mail after the # (#token=), never in the query: a fragment reaches no server, so no
// log and no referrer holds a token. A page only shows the state; the action is a button on it,
// because the mail scanners of the readers open every link they find. A mail from production must
// link to the live site: webPageUrl refuses to build a link without WEB_ORIGIN

// the button "Confirm the subscription" of the confirmation mail
export function newsletterConfirmUrl(token: string): string {
  return webPageUrl(env.WEB_PAGE_NEWSLETTER_CONFIRM, { fragment: { token } });
}

// the button "This is not me" of the same mail; the same token as the confirmation
export function newsletterDeclineUrl(token: string): string {
  return webPageUrl(env.WEB_PAGE_NEWSLETTER_DECLINE, { fragment: { token } });
}

// "Manage the subscription" of the mails of a subscription, with the token made from its salt
// (newsletterTokens.ts, manageTokenOf)
export function newsletterManageUrl(token: string): string {
  return webPageUrl(env.WEB_PAGE_NEWSLETTER_MANAGE, { fragment: { token } });
}

// Where the unsubscribe button of a mail leads a person (a GET on the address of the header
// List-Unsubscribe): the page "Manage the subscription" with the unsubscribe token after the #
// (#unsubscribe=) and the campaign whose mail it was (&c=, when the address named one), which the
// page shows as the one button "Unsubscribe" and posts back to the same address, ?c= included. The
// GET itself changes nothing
export function newsletterUnsubscribePageUrl(
  unsubscribeToken: string,
  campaignId?: number,
): string {
  return webPageUrl(env.WEB_PAGE_NEWSLETTER_MANAGE, {
    fragment: {
      unsubscribe: unsubscribeToken,
      ...(campaignId === undefined ? {} : { c: String(campaignId) }),
    },
  });
}

// The path of the page of a product or of a category on the frontend (WEB_PAGE_PRODUCT,
// WEB_PAGE_CATEGORY), the id in place of {id}. A path and not an address: the mail is built with the
// origin of the shop at hand and every link of it goes through shopLinkOf (helpers/shopLink.ts)
export function productPagePath(id: number): string {
  return env.WEB_PAGE_PRODUCT.replace('{id}', String(id));
}

export function categoryPagePath(id: number): string {
  return env.WEB_PAGE_CATEGORY.replace('{id}', String(id));
}

// the home page of the shop: where a link goes that must lead to the shop and nowhere in particular
// (the links of a subscription in a preview of a mail)
export function shopHomeUrl(): string {
  return webUrl('/');
}

// The address in the header List-Unsubscribe of a newsletter mail: the one-click unsubscribe (RFC
// 8058) on the API, with the token of the unsubscribe of the subscription in the path (the logs hide
// it, maskUrlSecrets; it is not the token of the page of management and opens only the unsubscribe,
// newsletterTokens.ts, unsubscribeTokenOf) and the campaign whose mail it was in ?c=
export function newsletterUnsubscribeUrl(unsubscribeToken: string, campaignId: number): string {
  return apiUrl(`/api/newsletters/unsubscribe/${encodeURIComponent(unsubscribeToken)}`, {
    c: String(campaignId),
  });
}
