import type { FastifySchema } from 'fastify';

import { openApiSecurity } from '@config/openapi.js';
import { withOpenApiSecurity } from '@helpers/withOpenApiSecurity.js';
import { withOpenApiTag } from '@helpers/withOpenApiTag.js';

// The routes of the people who run the newsletters: root, and an admin whom root allowed. The guard
// (403 `NEWSLETTER_MANAGER_REQUIRED`, and `INSUFFICIENT_ROLE` for a visitor and a user) is written into
// every route by sharedRefusals (src/plugins/openapi.plugin.ts)

// ---- examples ----

const summaryExample = {
  active: 1520,
  byLocale: [
    { locale: 'uk', count: 900 },
    { locale: 'en', count: 480 },
    { locale: 'es', count: 90 },
    { locale: null, count: 50 },
  ],
  bySource: { form: 1100, account: 420 },
  pending: 37,
  pausedComplaint: 4,
  stoppedBounce: 12,
};

const subscribersQueryExample = {
  status: 'active,paused_complaint',
  source: 'form',
  locale: 'uk,none',
  email: 'reader',
  limit: 20,
};

const subscribersExample = {
  items: [
    {
      id: 4812,
      email: 'reader@example.com',
      source: 'form',
      locale: 'uk',
      status: 'active',
      userId: null,
      createdAt: '2026-11-09T10:00:00.000Z',
      confirmedAt: '2026-11-09T10:05:00.000Z',
      endedAt: null,
      endReason: null,
    },
    {
      id: 4790,
      email: 'buyer@example.com',
      source: 'account',
      locale: null,
      status: 'ended',
      userId: 311,
      createdAt: '2026-10-30T08:12:00.000Z',
      confirmedAt: '2026-10-30T08:12:00.000Z',
      endedAt: '2026-11-02T17:40:00.000Z',
      endReason: 'unsubscribed',
    },
  ],
  limit: 20,
  nextCursor: 'eyJpZCI6NDc5MCwidiI6bnVsbH0',
  total: 57,
};

const subscriberParamsExample = { subscriberId: '4812' };
const subscriberErasedExample = { erased: true, subscriptions: 2 };

const blockEntryExample = {
  id: 31,
  createdAt: '2026-11-09T11:20:00.000Z',
  blockedById: 7,
  byPerson: false,
  reason: 'asked through support: strangers keep subscribing the address',
};
const blocklistQueryExample = { email: 'reader@example.com' };
const blockLookupExample = { blocked: true, entry: blockEntryExample };
const notBlockedExample = { blocked: false, entry: null };
const blocklistBodyExample = {
  email: 'reader@example.com',
  reason: 'asked through support: strangers keep subscribing the address',
};
const blockParamsExample = { blockId: '31' };
const blockRemovedExample = { removed: true };

// ---- the subscribers ----

const SUBSCRIBERS_TEXT =
  'For root and for an admin whom root allowed. The answer holds the addresses of the subscribers: ' +
  'it is personal data, and the privacy policy of the shop has to say that the people who run the ' +
  'newsletters see it.';

const getSubscribersSummarySchema = {
  operationId: 'getNewsletterSubscribersSummary',
  summary: 'The numbers of the newsletter subscribers',
  description:
    'How many people the newsletters reach: the subscriptions in force (`active`) in all, by ' +
    'language and by where they were made, and how many wait for their confirmation, are paused by ' +
    'a complaint or were stopped by a bounce. A subscription that ended is counted nowhere. The ' +
    'subscriptions that have no language are one bucket of the languages (`locale` is null): their ' +
    'mails go in the language of the shop. ' +
    SUBSCRIBERS_TEXT,

  response: {
    200: {
      description: 'The numbers.',
      $ref: 'newslettersSubscribersSummaryResponseSchema#',
      examples: [summaryExample],
    },
    500: {
      description: 'Unexpected server error while counting the subscribers.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

const getSubscribersSchema = {
  operationId: 'getNewsletterSubscribers',
  summary: 'List the newsletter subscribers',
  description:
    'The subscriptions of every state (also the ones that ended, until their term of keeping ' +
    'passes), a page at a time, the newest first. The filters go together: the state (`status`), ' +
    'where it was made (`source`), the language (`locale`, `none` for the ones without) and a part ' +
    'of the address (`email`, in any case, spaces around it cut, _ and % are the characters ' +
    'themselves). `total` counts the rows of the filters on all pages. A row names its fields one ' +
    'by one: the id, the address, the source, the language, the state, the account (null for the ' +
    'form) and the dates; no token, hash or salt of a subscription is ever part of it. To remove ' +
    'a subscriber on the word of the person use DELETE /api/newsletters/subscribers/{subscriberId} ' +
    'with the `id` of the row. ' +
    SUBSCRIBERS_TEXT,

  querystring: { $ref: 'newslettersSubscribersQuerySchema#', examples: [subscribersQueryExample] },

  response: {
    200: {
      description: 'A page of the subscriptions the filters find.',
      $ref: 'newslettersSubscribersResponseSchema#',
      examples: [subscribersExample],
    },
    400: {
      description: '`CURSOR_INVALID`: the cursor is not one the list gave.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while listing the subscribers.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

const eraseSubscriberSchema = {
  operationId: 'eraseNewsletterSubscriber',
  summary: 'Erase a subscriber: make the address anonymous',
  description:
    'On the word of the person (the request comes to support@): nothing is deleted, the address ' +
    'is erased. Every subscription the address ever had (the one named by the id and the other ' +
    'ones of the same address, whatever their state) is made anonymous in place: the address ' +
    'becomes the placeholder `deleted+<id>@deleted.invalid`, the hash of the address and the ' +
    'links of the mails are replaced (no link of a mail it was sent opens anything any more), ' +
    'what is live (waiting, in force, paused) ends with the reason `removed_by_admin` and one that ' +
    'ended or was stopped by a bounce keeps its state, its reason and its time, and the address ' +
    'and the browser of every line of the journal are emptied. The rows stay as the proof that ' +
    'there was a consent, with the dates and the states, and no way to say who gave it. The mails ' +
    'made for the subscriptions in the campaigns, the totals of the campaigns, the blocklist of ' +
    'the form and the account of a subscriber are not touched. The line of the admin log names ' +
    'the subscriber by the id of the subscription and never by the address. No mail goes to the ' +
    'person. The same request again answers 404: there is nothing left to erase. ' +
    SUBSCRIBERS_TEXT,

  params: { $ref: 'newslettersSubscriberParamsSchema#', examples: [subscriberParamsExample] },

  response: {
    200: {
      description: 'The address is erased: its subscriptions are made anonymous.',
      $ref: 'newslettersSubscriberErasedResponseSchema#',
      examples: [subscriberErasedExample],
    },
    404: {
      description:
        '`NEWSLETTER_SUBSCRIBER_NOT_FOUND`: there is no subscription with this id, or its ' +
        'address was erased already (nothing is left to erase).',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while erasing the subscriber.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// ---- the blocklist ----

const BLOCKLIST_TEXT =
  'The blocklist is for the public form: a request of the form about a blocked address is answered ' +
  'as ever and no mail goes out (a signed-in user who subscribes their own address is not stopped, ' +
  'and a subscription in force is not ended). The list keeps an HMAC of the address and not the ' +
  'address, so an admin finds an entry by typing the address and cannot read the list. For root and ' +
  'for an admin whom root allowed.';

const getBlocklistSchema = {
  operationId: 'findBlockedNewsletterAddress',
  summary: 'Find an address on the blocklist of the form',
  description:
    'Says whether the address is blocked and gives its entry: when, by whom and why. The address ' +
    'is written any way, the case and the spaces around it do not matter. `INVALID_EMAIL` when it ' +
    'is not an address. ' +
    BLOCKLIST_TEXT,

  querystring: { $ref: 'newslettersBlocklistQuerySchema#', examples: [blocklistQueryExample] },

  response: {
    200: {
      description: 'Whether the address is blocked, and its entry.',
      $ref: 'newslettersBlockLookupResponseSchema#',
      examples: [blockLookupExample, notBlockedExample],
    },
    400: {
      description: '`INVALID_EMAIL`: the text is not an email address.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while looking the address up.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

const postBlocklistSchema = {
  operationId: 'blockNewsletterAddress',
  summary: 'Block an address for the form',
  description:
    'On the word of the person (the request comes to support@) whose address strangers keep ' +
    'subscribing. The entry names the admin who made it. A request of the address that waits for ' +
    'its confirmation is removed at once, and the button in the mail already sent stops working; a ' +
    'subscription in force stays. An address that is blocked already is no error: the answer is ' +
    '200 with the first entry, and its reason stays. A line of the admin log is written for an ' +
    'entry made now. ' +
    BLOCKLIST_TEXT,

  body: { $ref: 'newslettersBlocklistBodySchema#', examples: [blocklistBodyExample] },

  response: {
    201: {
      description: 'The entry was made now.',
      $ref: 'newslettersBlockAddedResponseSchema#',
      examples: [{ created: true, entry: blockEntryExample }],
    },
    200: {
      description: 'The address was blocked already; this is its first entry.',
      $ref: 'newslettersBlockAddedResponseSchema#',
      examples: [{ created: false, entry: blockEntryExample }],
    },
    400: {
      description: '`INVALID_EMAIL`: the text is not an email address.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while blocking the address.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

const deleteBlocklistSchema = {
  operationId: 'unblockNewsletterAddress',
  summary: 'Take an address off the blocklist of the form',
  description:
    'On the word of the person, through support@. Requests of the form about the address are ' +
    'mailed again. A line of the admin log is written. ' +
    BLOCKLIST_TEXT,

  params: { $ref: 'newslettersBlockParamsSchema#', examples: [blockParamsExample] },

  response: {
    200: {
      description: 'The entry is taken off.',
      $ref: 'newslettersBlockRemovedResponseSchema#',
      examples: [blockRemovedExample],
    },
    404: {
      description:
        '`NEWSLETTER_BLOCK_NOT_FOUND`: there is no entry with this id (it was taken off ' +
        'already, or never was).',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while taking the entry off.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

const tagged = withOpenApiTag(
  {
    getSubscribersSummarySchema,
    getSubscribersSchema,
    eraseSubscriberSchema,
    getBlocklistSchema,
    postBlocklistSchema,
    deleteBlocklistSchema,
  },
  'newsletters',
);

export const newslettersAdminSchema = withOpenApiSecurity(
  tagged,
  openApiSecurity.accessTokenCookie,
);
