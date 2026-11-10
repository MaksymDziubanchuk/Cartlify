import type { FastifySchema } from 'fastify';

import { openApiSecurity } from '@config/openapi.js';
import { withOpenApiSecurity } from '@helpers/withOpenApiSecurity.js';
import { withOpenApiTag } from '@helpers/withOpenApiTag.js';

import { SUBSCRIPTION_REQUEST_ACCEPTED } from './newsletters.messages.js';

// ---- examples ----

const TOKEN_EXAMPLE = 'q3RkVZk0xW2e5pXb8nYgJ1sLhUo7aCtFdE4iMmBwP9A';

const subscribeBodyExample = {
  email: 'reader@example.com',
  locale: 'uk',
  captchaToken: 'XXXX.DUMMY.TOKEN.XXXX',
};
const subscribeOwnBodyExample = { locale: 'uk' };
const acceptedExample = { message: SUBSCRIPTION_REQUEST_ACCEPTED };

const subscriptionExample = {
  subscribed: true,
  source: 'account',
  status: 'active',
  locale: 'uk',
  canChangeLocale: true,
  subscribedAt: '2026-11-09T10:15:00.000Z',
};
const noSubscriptionExample = { subscribed: false };

const tokenBodyExample = { token: TOKEN_EXAMPLE };
const confirmExample = { status: 'active', locale: 'uk' };
const declineExample = { blocked: true };
const manageStateExample = {
  email: 'reader@example.com',
  source: 'form',
  locale: 'uk',
  status: 'active',
  canChangeLocale: true,
};
const manageLocaleBodyExample = { token: TOKEN_EXAMPLE, locale: 'es' };
const unsubscribedExample = { unsubscribed: true };
const exportExample = {
  subscriptions: [
    {
      email: 'reader@example.com',
      source: 'form',
      locale: 'uk',
      status: 'active',
      createdAt: '2026-11-09T10:00:00.000Z',
      confirmedAt: '2026-11-09T10:05:00.000Z',
      endedAt: null,
      endReason: null,
      events: [
        {
          event: 'requested',
          place: 'form',
          ip: '203.0.113.7',
          userAgent: 'Mozilla/5.0',
          locale: 'uk',
          campaignId: null,
          privacyVersion: 3,
          createdAt: '2026-11-09T10:00:00.000Z',
        },
        {
          event: 'confirmed',
          place: 'form',
          ip: '203.0.113.7',
          userAgent: 'Mozilla/5.0',
          locale: 'uk',
          campaignId: null,
          privacyVersion: 3,
          createdAt: '2026-11-09T10:05:00.000Z',
        },
      ],
    },
  ],
};
const oneClickParamsExample = { token: TOKEN_EXAMPLE };
const oneClickQueryExample = { c: '12' };
const oneClickBodyExample = { 'List-Unsubscribe': 'One-Click' };
const profileLocaleBodyExample = { locale: 'es' };

// ---- shared texts ----

const LINK_TEXT =
  '`NEWSLETTER_LINK_INVALID`: no subscription is behind the token: nobody was given it, or the ' +
  'subscription is over. The answer is the same for both.';

const LOCALE_TEXT =
  '`LOCALE_INVALID`: the language is not one the shop answers in (GET /api/shop-settings, ' +
  'enabledLocales).';

const LINK_LIMIT_TEXT =
  '`RATE_LIMITED`: too many requests from this address to the pages behind the links of the ' +
  'mails of the newsletters (60 in 10 minutes unless the shop set another limit, ' +
  '`LIMIT_NEWSLETTER_LINK_PER_ADDRESS`; the unsubscribe button of the mails counts apart); the ' +
  'retry-after header tells how many seconds to wait.';

const UNSUBSCRIBE_LIMIT_TEXT =
  '`RATE_LIMITED`: too many requests from this address to the unsubscribe button of the mails ' +
  '(1000 in 10 minutes unless the shop set another limit, ' +
  '`LIMIT_NEWSLETTER_UNSUBSCRIBE_PER_ADDRESS`; the POST of a mail client and the GET of the link ' +
  'count together, apart from the pages behind the other links; the general limit of the API does ' +
  'not count this button); the retry-after header tells how many seconds to wait.';

const NOT_VERIFIED_TEXT =
  '`NEWSLETTER_EMAIL_NOT_VERIFIED`: the address of the account is not verified yet; a ' +
  'subscription sits on an address, and only its proved owner sees or changes it.';

// ---- the form of the public page ----

const postSubscriptionSchema = {
  operationId: 'subscribeToNewsletter',
  summary: 'Subscribe to the newsletters',
  description:
    'The form of the public page. Two ways in, by who asks and about which address.\n\n' +
    '**A signed-in user for their own address** (no `email`, or their own): the subscription of ' +
    'the account comes into force at once, no captcha and no mail; the answer is 201 with the ' +
    'subscription, the same object GET /api/newsletters/me gives. `locale` is optional: the ' +
    'language asked, otherwise the one of the account if the shop answers in it, otherwise none ' +
    '(the mails then go in the language of the shop). A request that waits for its confirmation ' +
    'on the address becomes this subscription. `NEWSLETTER_ALREADY_SUBSCRIBED` (409) when a ' +
    'subscription is in force already, whoever made it; `NEWSLETTER_EMAIL_NOT_VERIFIED` (403) ' +
    'when the account has not verified its address.\n\n' +
    '**Anybody else**, a guest or a signed-in user about another address: `email`, `captchaToken` ' +
    'and `locale` are required (the language of an account is the language of its owner, not of ' +
    'the person whose address this is, so a signed-in user names one too). The captcha is checked ' +
    'after the cheap checks and before anything is done. A request is recorded and, by the state of the address, a mail goes ' +
    'out (always after the request is saved): a confirmation with two buttons, "Confirm the ' +
    'subscription" and "This is not me, do not send more" (the link lives 3 days; asking again ' +
    'sends a new one, the old one dies), or "You are already subscribed" with the link to manage ' +
    'the subscription (for a subscription a spam mark paused, a mail that says so and where to ' +
    'resume it, "Manage the subscription"; the address is taken off the list of spam reports of the ' +
    'mail provider first, a failure of that is only logged), or nothing (a subscription of an ' +
    'account is in the profile of its owner, and an address the person blocked or an admin blocked ' +
    'gets no mail). The blocklist knows a mailbox, not a spelling: a `+tag` is cut for every ' +
    'domain, and for gmail.com and googlemail.com the dots of the name too (googlemail.com is ' +
    'gmail.com); the subscription keeps the address as it was typed. A mail goes to an address at ' +
    'most once a day, and a mail the provider does not take does not count: the next request ' +
    'mails again. **The answer is the same whatever the state of the address is: 202 with a ' +
    'fixed message, the same body and the same headers**, so it cannot be used to find out who is ' +
    'subscribed. A mail the provider does not take is only logged. The requests about one email ' +
    'are counted after the captcha, so an answer of the captcha that is refused spends none.\n\n' +
    'The page shows the same "check your mailbox" for every answer.',

  body: {
    $ref: 'newslettersSubscribeBodySchema#',
    examples: [subscribeBodyExample],
  },

  response: {
    201: {
      description:
        'A signed-in user subscribed their own address: the subscription is in force. The same ' +
        'object as GET /api/newsletters/me.',
      $ref: 'newslettersSubscriptionResponseSchema#',
      examples: [{ ...subscriptionExample, ...subscribeOwnBodyExample }],
    },
    202: {
      description:
        'The request was accepted. The answer is the same for every address and every state of it.',
      $ref: 'newslettersAcceptedResponseSchema#',
      examples: [acceptedExample],
    },
    400: {
      description:
        '`EMAIL_REQUIRED`: a guest sent no address. ' +
        LOCALE_TEXT +
        ' A request about an address that is not the own address of the person must name a ' +
        'language (a guest, and a signed-in user about another address alike), and no other is put ' +
        'in its place. ' +
        '`CAPTCHA_INVALID`: the answer of the captcha in `captchaToken` is missing, wrong, ' +
        'expired or used before (an answer works once); reset the widget and send the new one, ' +
        'nothing was changed.',
      $ref: 'errorResponseSchema#',
    },
    403: {
      description:
        NOT_VERIFIED_TEXT + ' `NEWSLETTER_FORBIDDEN`: the account is not there any more.',
      $ref: 'errorResponseSchema#',
    },
    409: {
      description:
        '`NEWSLETTER_ALREADY_SUBSCRIBED`: a subscription is in force on the address of the ' +
        'signed-in user already, made by the account or by the form; change or end it in the ' +
        'profile.',
      $ref: 'errorResponseSchema#',
    },
    429: {
      description:
        '`RATE_LIMITED`: too many requests from this address (10 in 15 minutes, counted before ' +
        'the captcha), or a request about the same email within 3 minutes (counted after the ' +
        'captcha); the retry-after header tells how many seconds to wait.',
      $ref: 'errorResponseSchema#',
    },
    503: {
      description:
        '`CAPTCHA_UNAVAILABLE`: the captcha could not be checked right now (Cloudflare did not ' +
        'answer in time or failed, or the shop secret of the captcha is not taken); nothing was ' +
        'changed. Reset the widget and repeat the request with a new answer in a moment.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while subscribing.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// ---- the buttons of the mail of a confirmation ----

const postConfirmSchema = {
  operationId: 'confirmNewsletterSubscription',
  summary: 'Confirm a subscription by the link of its mail',
  description:
    'The button "Confirm the subscription" of the mail of a confirmation. The page of the ' +
    'frontend that the link opens (`WEB_PAGE_NEWSLETTER_CONFIRM`) reads `token` from the ' +
    'fragment of the address (`#token=<token>`, after the `#`, which no server and no log ever ' +
    'sees) and posts it here when the person presses the button; the link opened alone changes nothing, ' +
    'because mail scanners open every link. The request that waited becomes a subscription in ' +
    'force, in the language it asked for. A token works once, for 3 days, and only the newest ' +
    'mail has a working one. Open to anybody who has the token: no captcha.',

  body: { $ref: 'newslettersConfirmBodySchema#', examples: [tokenBodyExample] },

  response: {
    200: {
      description: 'The subscription is in force.',
      $ref: 'newslettersConfirmResponseSchema#',
      examples: [confirmExample],
    },
    400: {
      description: LINK_TEXT.replace(
        'the subscription is over',
        'the request was confirmed, replaced by a newer mail, or is older than 3 days',
      ),
      $ref: 'errorResponseSchema#',
    },
    429: { description: LINK_LIMIT_TEXT, $ref: 'errorResponseSchema#' },
    500: {
      description: 'Unexpected server error while confirming.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

const postDeclineSchema = {
  operationId: 'declineNewsletterSubscription',
  summary: 'Block an address for the form by the link of a confirmation mail',
  description:
    'The button "This is not me, do not send more" of the mail of a confirmation. The page it ' +
    'opens (`WEB_PAGE_NEWSLETTER_DECLINE`) posts the same `token` the confirmation uses when the ' +
    'person presses the button. The address goes to the blocklist of the form (the server keeps ' +
    'only an HMAC of it): later requests about it from the form get the usual answer and no mail. ' +
    'The request that waited is removed with its journal. A subscription the person confirmed ' +
    'earlier is not touched; they can unsubscribe from any mail. The token works as long as the ' +
    'confirmation does. Open to anybody who has the token: no captcha.',

  body: { $ref: 'newslettersConfirmBodySchema#', examples: [tokenBodyExample] },

  response: {
    200: {
      description: 'The address is blocked for the form.',
      $ref: 'newslettersDeclineResponseSchema#',
      examples: [declineExample],
    },
    400: {
      description: LINK_TEXT.replace(
        'the subscription is over',
        'the request was confirmed or declined, replaced by a newer mail, or is older than 3 days',
      ),
      $ref: 'errorResponseSchema#',
    },
    429: { description: LINK_LIMIT_TEXT, $ref: 'errorResponseSchema#' },
    500: {
      description: 'Unexpected server error while declining.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// ---- the page "Manage the subscription" ----

const MANAGE_TEXT =
  'The page of the frontend behind the link "Manage the subscription" of every mail to a ' +
  'subscriber (`WEB_PAGE_NEWSLETTER_MANAGE`) reads `token` from the fragment of the address ' +
  '(`#token=<token>`, after the `#`, which no server and no log ever sees) and posts it here. The ' +
  'token is always in the body of a request to the API, never in an address. The link works while the subscription is in ' +
  'force or paused by a complaint; opening the page changes nothing, each change is a button. ' +
  'Open to anybody who has the token: no captcha.';

const postManageSchema = {
  operationId: 'getNewsletterSubscriptionByLink',
  summary: 'Show the subscription behind a link of management',
  description: MANAGE_TEXT,

  body: { $ref: 'newslettersManageBodySchema#', examples: [tokenBodyExample] },

  response: {
    200: {
      description: 'The subscription behind the link.',
      $ref: 'newslettersManageStateResponseSchema#',
      examples: [manageStateExample],
    },
    400: { description: LINK_TEXT, $ref: 'errorResponseSchema#' },
    429: { description: LINK_LIMIT_TEXT, $ref: 'errorResponseSchema#' },
    500: {
      description: 'Unexpected server error while reading the subscription.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

const postManageLocaleSchema = {
  operationId: 'setNewsletterLocaleByLink',
  summary: 'Change the language of a subscription of the form',
  description:
    'Changes the language of the mails of a subscription that the form made. The language of a ' +
    'subscription of an account is changed in the profile. ' +
    MANAGE_TEXT,

  body: { $ref: 'newslettersManageLocaleBodySchema#', examples: [manageLocaleBodyExample] },

  response: {
    200: {
      description: 'The subscription with its new language.',
      $ref: 'newslettersManageStateResponseSchema#',
      examples: [{ ...manageStateExample, locale: 'es' }],
    },
    400: {
      description: `${LOCALE_TEXT} ${LINK_TEXT}`,
      $ref: 'errorResponseSchema#',
    },
    409: {
      description:
        '`NEWSLETTER_LOCALE_NOT_ALLOWED`: the subscription is the one of an account, whose ' +
        'language is changed in the profile (PATCH /api/newsletters/me).',
      $ref: 'errorResponseSchema#',
    },
    429: { description: LINK_LIMIT_TEXT, $ref: 'errorResponseSchema#' },
    500: {
      description: 'Unexpected server error while changing the language.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

const postManageUnsubscribeSchema = {
  operationId: 'unsubscribeFromNewslettersByLink',
  summary: 'Unsubscribe from the page of management',
  description:
    'Ends the subscription at once; no more mails go to the address, and the link stops opening ' +
    'the page. A second press answers the same (200) and writes nothing. ' +
    MANAGE_TEXT,

  body: { $ref: 'newslettersManageBodySchema#', examples: [tokenBodyExample] },

  response: {
    200: {
      description: 'The subscription is over.',
      $ref: 'newslettersUnsubscribedResponseSchema#',
      examples: [unsubscribedExample],
    },
    400: { description: LINK_TEXT, $ref: 'errorResponseSchema#' },
    429: { description: LINK_LIMIT_TEXT, $ref: 'errorResponseSchema#' },
    500: {
      description: 'Unexpected server error while unsubscribing.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

const postManageResumeSchema = {
  operationId: 'resumeNewsletterSubscriptionByLink',
  summary: 'Resume a subscription a complaint paused',
  description:
    'A mail provider told the shop that the person marked a mail as spam: the subscription is ' +
    'paused (`status` is `paused_complaint`) and no mail goes to the address. This puts it back in ' +
    'force and takes the address off the list of complaints of the mail provider (a failure of ' +
    'that last step is only logged). A subscription that is in force already is left as it is ' +
    '(200). ' +
    MANAGE_TEXT,

  body: { $ref: 'newslettersManageBodySchema#', examples: [tokenBodyExample] },

  response: {
    200: {
      description: 'The subscription, in force.',
      $ref: 'newslettersManageStateResponseSchema#',
      examples: [manageStateExample],
    },
    400: { description: LINK_TEXT, $ref: 'errorResponseSchema#' },
    429: { description: LINK_LIMIT_TEXT, $ref: 'errorResponseSchema#' },
    500: {
      description: 'Unexpected server error while resuming.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

const postManageExportSchema = {
  operationId: 'exportNewsletterSubscriptionByLink',
  summary: 'Download the data of the subscription',
  description:
    'The data the shop keeps about the subscription behind the link and its journal (when and ' +
    'from where it was asked for, confirmed, changed), for the person to keep. ' +
    MANAGE_TEXT,

  body: { $ref: 'newslettersManageBodySchema#', examples: [tokenBodyExample] },

  response: {
    200: {
      description: 'The data of the subscription and its journal.',
      $ref: 'newslettersExportResponseSchema#',
      examples: [exportExample],
    },
    400: { description: LINK_TEXT, $ref: 'errorResponseSchema#' },
    429: { description: LINK_LIMIT_TEXT, $ref: 'errorResponseSchema#' },
    500: {
      description: 'Unexpected server error while exporting.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// ---- the one-click unsubscribe of a mail client ----

const postOneClickSchema = {
  operationId: 'oneClickUnsubscribeFromNewsletters',
  summary: 'One-click unsubscribe of a mail client (RFC 8058)',
  description:
    'Every mail of the newsletters carries the headers `List-Unsubscribe` (with this address, the ' +
    'unsubscribe token of the subscription in the path, which opens this unsubscribe and nothing ' +
    'else) and `List-Unsubscribe-Post: List-Unsubscribe=One-Click`. When the reader presses the ' +
    'unsubscribe button of their mail program, the program posts the form ' +
    '`List-Unsubscribe=One-Click` here by itself: no session, no csrf token (this route is outside ' +
    'the csrf check, as the payment webhooks are) and no captcha. The subscription ends at once; ' +
    'one that is over already answers the same (200), so a second press harms nothing. `c` is the ' +
    'campaign whose mail it was, counted in its summary. The token is in the path because the ' +
    'standard asks for it; the logs of the server hide it. The same address opened with a GET ' +
    '(GET /api/newsletters/unsubscribe/{token}) leads a person to the page of the frontend, whose ' +
    'one button posts here. The requests of this address count apart from the pages behind the ' +
    'other links of the mails (`LIMIT_NEWSLETTER_UNSUBSCRIBE_PER_ADDRESS`, 1000 in 10 minutes).',

  params: { $ref: 'newslettersOneClickParamsSchema#', examples: [oneClickParamsExample] },
  querystring: { $ref: 'newslettersOneClickQuerySchema#', examples: [oneClickQueryExample] },
  body: { $ref: 'newslettersOneClickBodySchema#', examples: [oneClickBodyExample] },
  consumes: ['application/x-www-form-urlencoded'],

  response: {
    200: {
      description: 'The subscription is over (it is also when it had ended already).',
      $ref: 'newslettersUnsubscribedResponseSchema#',
      examples: [unsubscribedExample],
    },
    400: {
      description:
        '`NEWSLETTER_LINK_INVALID`: nobody was given this token (the token of the page of ' +
        'management does not open this unsubscribe either).',
      $ref: 'errorResponseSchema#',
    },
    429: { description: UNSUBSCRIBE_LIMIT_TEXT, $ref: 'errorResponseSchema#' },
    500: {
      description: 'Unexpected server error while unsubscribing.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

const getOneClickPageSchema = {
  operationId: 'openNewsletterUnsubscribePage',
  summary: 'The link of the unsubscribe button of a mail',
  description:
    'The address of the header `List-Unsubscribe` opened with a GET: a person who follows the ' +
    'link of the unsubscribe button of a mail, or a mail scanner that follows every link. It ' +
    'changes nothing and looks nothing up, so every token gets the same answer: 303 to the page ' +
    '"Manage the subscription" of the frontend (`WEB_PAGE_NEWSLETTER_MANAGE`) with the token after ' +
    'the `#`, `#unsubscribe=<token>`, and, when the address names a campaign (`c`, an id), ' +
    '`&c=<id>` (an id that cannot be read is left out). On such an address the page shows ' +
    'nothing but the button "Unsubscribe", which posts to this same address ' +
    '(POST /api/newsletters/unsubscribe/{token}?c=<id>, the form `List-Unsubscribe=One-Click`, with ' +
    'the csrf token of the page). A token nobody was given is found out by that post (400 ' +
    '`NEWSLETTER_LINK_INVALID`), not here. The requests of this address count with those of the ' +
    'POST (`LIMIT_NEWSLETTER_UNSUBSCRIBE_PER_ADDRESS`, 1000 in 10 minutes).',

  params: { $ref: 'newslettersOneClickParamsSchema#', examples: [oneClickParamsExample] },
  querystring: { $ref: 'newslettersOneClickQuerySchema#', examples: [oneClickQueryExample] },

  response: {
    303: {
      description:
        'To the page "Manage the subscription" of the frontend, with `#unsubscribe=<token>` ' +
        '(and `&c=<id>`) in the address. The answer is not cached.',
      type: 'null',
    },
    429: { description: UNSUBSCRIBE_LIMIT_TEXT, $ref: 'errorResponseSchema#' },
    500: {
      description: 'Unexpected server error while building the address of the page.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// ---- the profile of a signed-in user ----

const PROFILE_TEXT =
  'The subscription on the address of the account, whether the account or the form made it. The ' +
  'address must be verified. Any role.';

const getProfileSchema = {
  operationId: 'getMyNewsletterSubscription',
  summary: 'My subscription to the newsletters',
  description:
    'Shows whether the address of the signed-in user is subscribed: `{ subscribed: false }`, or ' +
    'the subscription in force (a request that waits for its confirmation is not one yet). ' +
    PROFILE_TEXT,

  response: {
    200: {
      description: 'The subscription, or `{ subscribed: false }`.',
      $ref: 'newslettersSubscriptionResponseSchema#',
      examples: [subscriptionExample, noSubscriptionExample],
    },
    403: { description: NOT_VERIFIED_TEXT, $ref: 'errorResponseSchema#' },
    500: {
      description: 'Unexpected server error while reading the subscription.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

const patchProfileSchema = {
  operationId: 'setMyNewsletterLocale',
  summary: 'Change the language of my subscription',
  description:
    'Changes the language of the mails of the subscription of the account. A subscription that ' +
    'the form made keeps its language on the page "Manage the subscription" its mails link to. ' +
    PROFILE_TEXT,

  body: { $ref: 'newslettersProfileLocaleBodySchema#', examples: [profileLocaleBodyExample] },

  response: {
    200: {
      description: 'The subscription with its new language.',
      $ref: 'newslettersSubscriptionResponseSchema#',
      examples: [{ ...subscriptionExample, locale: 'es' }],
    },
    400: { description: LOCALE_TEXT, $ref: 'errorResponseSchema#' },
    403: { description: NOT_VERIFIED_TEXT, $ref: 'errorResponseSchema#' },
    404: {
      description: '`NEWSLETTER_NOT_SUBSCRIBED`: no subscription is in force on the address.',
      $ref: 'errorResponseSchema#',
    },
    409: {
      description:
        '`NEWSLETTER_LOCALE_NOT_ALLOWED`: the subscription is the one of the form, whose ' +
        'language is changed on the page "Manage the subscription" its mails link to.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while changing the language.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

const deleteProfileSchema = {
  operationId: 'unsubscribeMyNewsletterSubscription',
  summary: 'Unsubscribe my address from the newsletters',
  description:
    'Ends the subscription in force on the address, at once. With none in force the answer is the ' +
    'same (200): the person asked for it to be over and it is. A request of the form that still ' +
    'waits for its confirmation is left to its 3 days. After it POST /api/newsletters/subscriptions ' +
    'subscribes the account again. ' +
    PROFILE_TEXT,

  response: {
    200: {
      description: 'The subscription is over.',
      $ref: 'newslettersUnsubscribedResponseSchema#',
      examples: [unsubscribedExample],
    },
    403: { description: NOT_VERIFIED_TEXT, $ref: 'errorResponseSchema#' },
    500: {
      description: 'Unexpected server error while unsubscribing.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

const postProfileResumeSchema = {
  operationId: 'resumeMyNewsletterSubscription',
  summary: 'Resume my subscription a complaint paused',
  description:
    'A mail provider told the shop that the person marked a mail as spam: the subscription is ' +
    'paused (`status` is `paused_complaint`) and no mail goes to the address. This puts it back in ' +
    'force and takes the address off the list of complaints of the mail provider (a failure of ' +
    'that last step is only logged). A subscription that is in force already is left as it is ' +
    '(200). ' +
    PROFILE_TEXT,

  response: {
    200: {
      description: 'The subscription, in force.',
      $ref: 'newslettersSubscriptionResponseSchema#',
      examples: [subscriptionExample],
    },
    403: { description: NOT_VERIFIED_TEXT, $ref: 'errorResponseSchema#' },
    404: {
      description: '`NEWSLETTER_NOT_SUBSCRIBED`: no subscription is in force on the address.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while resuming.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// the routes behind a token or a link carry no cookie of the session; the form takes a session if
// there is one; the profile needs one
const taggedPublic = withOpenApiTag(
  {
    postConfirmSchema,
    postDeclineSchema,
    postManageSchema,
    postManageLocaleSchema,
    postManageUnsubscribeSchema,
    postManageResumeSchema,
    postManageExportSchema,
    postOneClickSchema,
    getOneClickPageSchema,
  },
  'newsletters',
);

const taggedForm = withOpenApiTag({ postSubscriptionSchema }, 'newsletters');

const taggedProfile = withOpenApiTag(
  { getProfileSchema, patchProfileSchema, deleteProfileSchema, postProfileResumeSchema },
  'newsletters',
);

export const newslettersSchema = {
  ...taggedPublic,
  ...withOpenApiSecurity(taggedForm, openApiSecurity.userOrGuestCookie),
  ...withOpenApiSecurity(taggedProfile, openApiSecurity.authCookies),
};
