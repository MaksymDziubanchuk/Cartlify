import type { FastifySchema } from 'fastify';

import env from '@config/env.js';
import { openApiSecurity } from '@config/openapi.js';
import { withOpenApiSecurity } from '@helpers/withOpenApiSecurity.js';
import { withOpenApiTag } from '@helpers/withOpenApiTag.js';

// The routes of the campaigns of the newsletters, for the people who run them: root, and an admin
// whom root allowed. The guard (403 `NEWSLETTER_MANAGER_REQUIRED`, and `INSUFFICIENT_ROLE` for a
// visitor and a user) is written into every route by sharedRefusals (src/plugins/openapi.plugin.ts).
// The bodies are checked by the strict validator: a wrong type or a field the schema does not name is
// 400 `VALIDATION_ERROR`, nothing is converted or dropped

// ---- examples ----

const contentExample = {
  subject: {
    en: 'Spring sale: up to 30% off',
    es: 'Rebajas de primavera: hasta un 30%',
  },
  preview: { en: 'Fresh prices on more than 200 products' },
  blocks: [
    {
      type: 'text',
      text: {
        en: '# Spring is here\nThe **best** prices of the year, [see the sale](/sale).\n- free delivery\n- *new* arrivals every week',
      },
    },
    { type: 'products', title: { en: 'Our picks' }, source: 'manual', productIds: [12, 15, 21] },
    { type: 'products', source: 'rule', rule: 'bestsellers', limit: 4, periodDays: 30 },
    { type: 'category', categoryId: 3, title: { en: 'Shoes' } },
    { type: 'button', kind: 'sale', url: '/sale' },
  ],
};

const countersExample = {
  planned: 0,
  sent: 0,
  rejected: 0,
  undelivered: 0,
  complaints: 0,
  unsubscribed: 0,
};

const itemExample = {
  id: 41,
  name: 'Spring sale',
  status: 'draft',
  scheduledAt: null,
  cancelReason: null,
  missingLocale: 'shop_locale',
  counters: countersExample,
  disabledLocales: [],
  createdById: 7,
  createdAt: '2026-11-09T10:00:00.000Z',
  updatedAt: '2026-11-09T10:20:00.000Z',
};

const campaignExample = {
  ...itemExample,
  content: contentExample,
  updatedById: 7,
  copiedFromId: null,
  startedAt: null,
  finishedAt: null,
  stoppedAt: null,
  cancelledAt: null,
};

const campaignsExample = {
  items: [
    itemExample,
    {
      ...itemExample,
      id: 38,
      name: 'Autumn sale',
      status: 'finished',
      scheduledAt: '2026-10-20T08:00:00.000Z',
      counters: {
        planned: 1520,
        sent: 1518,
        rejected: 2,
        undelivered: 14,
        complaints: 1,
        unsubscribed: 9,
      },
    },
  ],
  limit: 20,
  nextCursor: 'eyJpZCI6MzgsInYiOm51bGx9',
  total: 12,
};

const createExample = {
  name: 'Spring sale',
  missingLocale: 'shop_locale',
  content: contentExample,
};
const createNameExample = { name: 'Spring sale' };
const updateExample = { name: 'Spring sale (final)', content: contentExample };
const paramsExample = { campaignId: '41' };
const queryExample = {
  status: 'sending,finished,stopped',
  startedFrom: '2026-11-01T00:00:00.000Z',
  undeliveredOver: 5,
  complaintsOver: 3,
  limit: 20,
};
const queryCancelledExample = {
  status: 'cancelled',
  cancelReason: 'limit',
  cancelledFrom: '2026-11-01T00:00:00.000Z',
};
const deletedExample = { deleted: true };
const scheduleAtExample = { scheduledAt: '2026-12-01T10:00' };
const scheduleNowExample = { runNow: true };
const scheduledExample = {
  ...campaignExample,
  status: 'scheduled',
  scheduledAt: '2026-12-01T09:00:00.000Z',
  updatedById: 9,
};
const cancelledExample = {
  ...scheduledExample,
  status: 'cancelled',
  cancelledAt: '2026-11-20T14:05:00.000Z',
};
const cancelledByLimitExample = { ...cancelledExample, cancelReason: 'limit', updatedById: 7 };
const stoppedExample = {
  ...scheduledExample,
  status: 'stopped',
  startedAt: '2026-12-01T09:00:12.000Z',
  stoppedAt: '2026-12-01T09:20:00.000Z',
  counters: { ...countersExample, planned: 1520, sent: 640 },
};

const previewBodyExample = { locale: 'en' };
const testBodyExample = { email: 'admin@shop.example.com', locale: 'en' };
const previewExample = {
  subject: 'Spring sale: up to 30% off',
  preheader: 'Fresh prices on more than 200 products',
  html: '<!doctype html><html lang="en">...</html>',
  text:
    'Spring is here\n\nLinen shirt: €19.90\n' +
    'https://shop.example.com/products/12?utm_source=newsletter&utm_campaign=41',
  warnings: [
    { blockIndex: 1, code: 'PRODUCT_UNAVAILABLE', productId: 15 },
    { blockIndex: 3, code: 'LINK_NOT_ALLOWED' },
  ],
  takenAt: '2026-11-09T10:25:00.000Z',
};
const testSentExample = { sent: true };

const translateBodyExample = {
  from: 'en',
  to: ['es', 'uk'],
  items: [
    { key: 'subject', kind: 'line', text: 'Spring sale: up to 30% off' },
    { key: 'preview', kind: 'line', text: 'Fresh prices on more than 200 products' },
    { key: 'block0.title', kind: 'line', text: 'Our picks', maxChars: 120 },
    {
      key: 'block0',
      kind: 'markup',
      text: '# Spring is here\nThe **best** prices of the year, [see the sale](/sale).\n- free delivery',
    },
  ],
};
const translateExample = {
  translations: {
    es: {
      subject: 'Rebajas de primavera: hasta un 30% de descuento',
      preview: 'Precios frescos en más de 200 productos',
      'block0.title': 'Nuestra selección',
      block0:
        '# Llega la primavera\nLos **mejores** precios del año, [ver las rebajas](/sale).\n- envío gratis',
    },
    uk: {},
  },
  warnings: [
    { locale: 'uk', key: 'subject', code: 'TRANSLATION_FAILED' },
    { locale: 'uk', key: 'preview', code: 'TRANSLATION_FAILED' },
    { locale: 'uk', key: 'block0.title', code: 'TRANSLATION_FAILED' },
    { locale: 'uk', key: 'block0', code: 'TRANSLATION_FAILED' },
  ],
};

// ---- the text every route shares ----

const CAMPAIGNS_TEXT =
  'For root and for an admin whom root allowed. All of them see and change every campaign.';

const CONTENT_ERRORS =
  '`LOCALE_INVALID`: a key of a text is not the code of a language the shop answers in (' +
  '`details` name the place and the key; a change of a campaign may keep a language the campaign ' +
  'already has a subject in and root turned off since, see `disabledLocales`, but not bring a ' +
  'new one in); `NEWSLETTER_LOCALE_WITHOUT_SUBJECT`: a preview, a text ' +
  'or a title is written in a language that has no subject; `NEWSLETTER_LINK_NOT_ALLOWED`: a ' +
  'link of a text, or the address of a button, leads neither to the shop nor to a domain root ' +
  'trusts (`newsletterTrustedDomains` of the data of the shop; an absolute `http` or `https` ' +
  'address of that domain or a subdomain of it) (`details` name the place and the address); ' +
  '`NEWSLETTER_ADDRESS_NOT_ALLOWED`: a text (the subject, the preview, a ' +
  'title, the text of a block) writes out an address of another site, with a scheme (`https://`), ' +
  'with `www.`, as a domain with a path (`example.com/page`) or as a name that ends with a real ' +
  'top-level domain, with no path or with a `?` or `#` after it (`example.com`, `example.com?x=1`), ' +
  'that is not of the shop and not of a domain root trusts (a domain lets in its subdomains), ' +
  '`details` name the place (`field`) and the address (`address`); `VALIDATION_ERROR`: the shape is wrong (a type, a limit, a field that ' +
  'is not known, a block of a kind there is none of).';

// ---- the routes ----

const postCampaignSchema = {
  operationId: 'createNewsletterCampaign',
  summary: 'Make a draft of a newsletter',
  description:
    'Makes a draft in the name of the caller. The content may be left out and written later with ' +
    'PATCH, and a draft may be incomplete (the language of the shop may still lack a text): ' +
    'whether it is whole is judged when it is scheduled. The content has a shape of its own, one ' +
    'list of blocks (text, products, category, button) for all languages with the texts inside ' +
    'them for each language; see the schema. A line is written to the admin log. ' +
    CAMPAIGNS_TEXT,

  body: {
    $ref: 'newslettersCampaignCreateBodySchema#',
    examples: [createExample, createNameExample],
  },

  response: {
    201: {
      description: 'The draft.',
      $ref: 'newslettersCampaignSchema#',
      examples: [campaignExample],
    },
    400: {
      description: CONTENT_ERRORS,
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while making the draft.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

const getCampaignsSchema = {
  operationId: 'getNewsletterCampaigns',
  summary: 'List the newsletter campaigns',
  description:
    'The campaigns of every state, the newest first, a page at a time. The filter `status` takes ' +
    'one state or several through commas; `startedFrom`, `startedTo` and `scheduledTo` keep the ' +
    'campaigns by the time they started or are scheduled for; `cancelledFrom` and ' +
    '`cancelReason` keep the campaigns that were called off since a time, and the ones the ' +
    'system called off for a reason (`limit`); `undeliveredOver` and `rejectedOver` keep the ' +
    'campaigns whose share of mails that did not arrive or were not taken by the mail provider ' +
    'is over a per cent, and `complaintsOver` the ones whose share of mails marked as spam is ' +
    'over so many in a thousand (per mille, 1 to 1000, not per cent). The alerts of the ' +
    'newsletters (GET /api/admin/alerts) send to this list with these filters. A row has the ' +
    'name, the state, the time it goes out, why it was called off if the system did it ' +
    '(`cancelReason`), the rule for a language without a text, the totals and who made it, and ' +
    'no content: GET the ' +
    'campaign for it. `total` counts the rows of the filter on all pages. ' +
    CAMPAIGNS_TEXT,

  querystring: {
    $ref: 'newslettersCampaignsQuerySchema#',
    examples: [queryExample, queryCancelledExample],
  },

  response: {
    200: {
      description: 'A page of the campaigns.',
      $ref: 'newslettersCampaignsResponseSchema#',
      examples: [campaignsExample],
    },
    400: {
      description: '`CURSOR_INVALID`: the cursor is not one the list gave.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while listing the campaigns.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

const getCampaignSchema = {
  operationId: 'getNewsletterCampaign',
  summary: 'Read a newsletter campaign',
  description:
    'The whole campaign: its content and its totals. The totals are 0 until the campaign goes ' +
    'out. A cancelled campaign says in `cancelReason` whether the system called it off (`limit`: ' +
    'its time came and the limit of the campaigns left no room) or a manager did (null). ' +
    CAMPAIGNS_TEXT,

  params: { $ref: 'newslettersCampaignParamsSchema#', examples: [paramsExample] },

  response: {
    200: {
      description: 'The campaign.',
      $ref: 'newslettersCampaignSchema#',
      examples: [campaignExample, cancelledByLimitExample],
    },
    404: {
      description: '`NEWSLETTER_CAMPAIGN_NOT_FOUND`: there is no campaign with this id.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while reading the campaign.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

const patchCampaignSchema = {
  operationId: 'updateNewsletterCampaign',
  summary: 'Change a newsletter campaign',
  description:
    'Changes the name, the rule for a language without a text (`missingLocale`) or the content. ' +
    'Any of them, at least one. The content is the whole new content: it replaces the old one and ' +
    'is not merged with it, so a language or a block that is left out is gone. Only a draft and a ' +
    'scheduled campaign can be changed; one that went out, is going out, was stopped or was ' +
    'called off cannot, also when the system started it a moment before the change. The time and ' +
    'the state of a campaign are not changed here. A request that changes nothing changes nothing ' +
    'and writes no line; otherwise a line of the admin log names the fields that changed, never ' +
    'the texts. A language root turned off after the text was written (`disabledLocales` of the ' +
    'campaign) can be kept in the new content, as it is or edited, or left out; a text in a ' +
    'language that is off and that the campaign did not have is refused (`LOCALE_INVALID`). The ' +
    'content is judged before the campaign is looked for and before its state. ' +
    CAMPAIGNS_TEXT,

  params: { $ref: 'newslettersCampaignParamsSchema#', examples: [paramsExample] },
  body: { $ref: 'newslettersCampaignUpdateBodySchema#', examples: [updateExample] },

  response: {
    200: {
      description: 'The campaign after the change.',
      $ref: 'newslettersCampaignSchema#',
      examples: [campaignExample],
    },
    400: {
      description:
        CONTENT_ERRORS +
        ' `NEWSLETTER_CONTENT_INCOMPLETE`: the campaign is scheduled and the new content could not ' +
        'go out (`details.missing` as when it is scheduled); a draft may be unfinished.',
      $ref: 'errorResponseSchema#',
    },
    404: {
      description: '`NEWSLETTER_CAMPAIGN_NOT_FOUND`: there is no campaign with this id.',
      $ref: 'errorResponseSchema#',
    },
    409: {
      description:
        '`NEWSLETTER_CAMPAIGN_NOT_EDITABLE`: the campaign is not a draft and not scheduled, or ' +
        'its state changed while the request ran.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while changing the campaign.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

const deleteCampaignSchema = {
  operationId: 'deleteNewsletterCampaign',
  summary: 'Delete a draft of a newsletter',
  description:
    'Deletes a draft. A campaign in another state is kept for its totals and the logs: a ' +
    'scheduled one is called off, not deleted. A copy of the draft stays and loses the link to ' +
    'it. A line is written to the admin log. ' +
    CAMPAIGNS_TEXT,

  params: { $ref: 'newslettersCampaignParamsSchema#', examples: [paramsExample] },

  response: {
    200: {
      description: 'The draft is deleted.',
      $ref: 'newslettersCampaignDeletedResponseSchema#',
      examples: [deletedExample],
    },
    404: {
      description:
        '`NEWSLETTER_CAMPAIGN_NOT_FOUND`: there is no campaign with this id (it was deleted ' +
        'already, or never was).',
      $ref: 'errorResponseSchema#',
    },
    409: {
      description: '`NEWSLETTER_CAMPAIGN_NOT_DELETABLE`: the campaign is not a draft.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while deleting the campaign.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

const postCopyCampaignSchema = {
  operationId: 'copyNewsletterCampaign',
  summary: 'Copy a newsletter campaign into a new draft',
  description:
    'Makes a new draft with the name "Copy of" and the name of the original, cut to 200 ' +
    'characters, the same rule for a language without a text and the same content. The campaign ' +
    'to copy may be in any state. The products are not copied: their cards are made again when ' +
    'the copy starts. A line is written to the admin log. ' +
    CAMPAIGNS_TEXT,

  params: { $ref: 'newslettersCampaignParamsSchema#', examples: [paramsExample] },

  response: {
    201: {
      description: 'The new draft.',
      $ref: 'newslettersCampaignSchema#',
      examples: [{ ...campaignExample, id: 42, name: 'Copy of Spring sale', copiedFromId: 41 }],
    },
    404: {
      description: '`NEWSLETTER_CAMPAIGN_NOT_FOUND`: there is no campaign with this id.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while copying the campaign.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

const postScheduleCampaignSchema = {
  operationId: 'scheduleNewsletterCampaign',
  summary: 'Schedule a newsletter campaign, or move its time',
  description:
    'Schedules a draft, or changes the time of a campaign that is scheduled already; it stays ' +
    'scheduled. The body is exactly one of `scheduledAt` (a time, ISO 8601: with an offset it is ' +
    'that exact instant, without one it is read in the time zone of the shop) and `runNow: true` ' +
    '(the time is the moment of the request). The refusals come in this order: the body (400), the ' +
    'campaign (404), its state (409), a time in the past (400, never for `runNow`), a content that ' +
    'is not whole yet (400), the limit of the shop (409). The limit is at most so many campaigns in ' +
    'any window of so many days (the data of the shop, 2 in 7 days unless root set others): the ' +
    'scheduled ones count at their time, the ones that are going out, finished or stopped at the ' +
    'time they began; a draft and a cancelled campaign do not count, and a campaign never counts ' +
    'against itself, so moving its own time is not refused for being next to its old one. Two ' +
    'campaigns exactly so many days apart are not in one window. Scheduling is checked under a ' +
    'lock, so two managers scheduling at once cannot both pass. A line is written to the admin ' +
    'log with the old and the new time. ' +
    CAMPAIGNS_TEXT,

  params: { $ref: 'newslettersCampaignParamsSchema#', examples: [paramsExample] },
  body: {
    $ref: 'newslettersCampaignScheduleBodySchema#',
    examples: [scheduleAtExample, scheduleNowExample],
  },

  response: {
    200: {
      description: 'The campaign, scheduled.',
      $ref: 'newslettersCampaignSchema#',
      examples: [scheduledExample],
    },
    400: {
      description:
        '`NEWSLETTER_SCHEDULE_IN_PAST`: the time is before now (`details`: `scheduledAt`, ' +
        '`now`). `NEWSLETTER_CONTENT_INCOMPLETE`: the campaign cannot go out as it is, ' +
        '`details.missing` lists what is missing as `{ field, locale }` (at least one block; the ' +
        'subject of the language of the shop; in the language of the shop the text of every text ' +
        'block and the title of every block that has a title in any language; every other language ' +
        'that has a subject and that the shop answers in needs the same texts; a language root ' +
        'turned off (`disabledLocales`) is asked for nothing, its text stays and does not go ' +
        'out; a preview is not needed; `field` is the path in the content, `locale` is null for ' +
        'the list of blocks). The content is judged again against the address of the shop as it ' +
        'is now, and its languages: `LOCALE_INVALID` for a language that has no dictionary any ' +
        'more, `NEWSLETTER_LOCALE_WITHOUT_SUBJECT`, `NEWSLETTER_LINK_NOT_ALLOWED` and ' +
        '`NEWSLETTER_ADDRESS_NOT_ALLOWED` (root may have stopped trusting a domain) as when it ' +
        'was written; the languages root turned off are not refused. `VALIDATION_ERROR`: the body is not exactly a time or `runNow`, or the time is ' +
        'not one that exists.',
      $ref: 'errorResponseSchema#',
    },
    404: {
      description: '`NEWSLETTER_CAMPAIGN_NOT_FOUND`: there is no campaign with this id.',
      $ref: 'errorResponseSchema#',
    },
    409: {
      description:
        '`NEWSLETTER_CAMPAIGN_NOT_SCHEDULABLE`: the campaign is not a draft and not scheduled (it ' +
        'is going out, finished, stopped or cancelled, or the system started it a moment before). ' +
        '`NEWSLETTER_LIMIT_REACHED`: one more campaign would break the limit of the shop; ' +
        '`details.campaigns` lists the campaigns that fill the windows it would break, as ' +
        '`{ id, name, at }` by time (the time they go out or went out), so the page can offer to ' +
        'cancel or stop one of them, and `details.limit` is `{ count, days }`.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while scheduling the campaign.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

const postCancelCampaignSchema = {
  operationId: 'cancelNewsletterCampaign',
  summary: 'Call off a scheduled newsletter campaign',
  description:
    'Calls off a campaign that is scheduled: it becomes cancelled, never goes out and no longer ' +
    'counts against the limit of the shop, which frees its window. A campaign in any other state ' +
    'cannot be called off: one that is going out is stopped (POST .../stop), a draft is deleted. ' +
    'A line is written to the admin log. ' +
    CAMPAIGNS_TEXT,

  params: { $ref: 'newslettersCampaignParamsSchema#', examples: [paramsExample] },

  response: {
    200: {
      description: 'The campaign, cancelled.',
      $ref: 'newslettersCampaignSchema#',
      examples: [cancelledExample],
    },
    404: {
      description: '`NEWSLETTER_CAMPAIGN_NOT_FOUND`: there is no campaign with this id.',
      $ref: 'errorResponseSchema#',
    },
    409: {
      description:
        '`NEWSLETTER_CAMPAIGN_NOT_CANCELLABLE`: the campaign is not scheduled (also when the ' +
        'system started it a moment before).',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while cancelling the campaign.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

const postStopCampaignSchema = {
  operationId: 'stopNewsletterCampaign',
  summary: 'Stop a newsletter campaign that is going out',
  description:
    'Stops a campaign that is going out: it becomes stopped. What was sent stays sent; whoever has ' +
    'not been sent the mail yet will not be. A stopped campaign keeps counting against the limit ' +
    'of the shop, at the time it began. A campaign in any other state cannot be stopped: a ' +
    'scheduled one is called off (POST .../cancel). A line is written to the admin log. ' +
    CAMPAIGNS_TEXT,

  params: { $ref: 'newslettersCampaignParamsSchema#', examples: [paramsExample] },

  response: {
    200: {
      description: 'The campaign, stopped.',
      $ref: 'newslettersCampaignSchema#',
      examples: [stoppedExample],
    },
    404: {
      description: '`NEWSLETTER_CAMPAIGN_NOT_FOUND`: there is no campaign with this id.',
      $ref: 'errorResponseSchema#',
    },
    409: {
      description:
        '`NEWSLETTER_CAMPAIGN_NOT_STOPPABLE`: the campaign is not going out (also when it ' +
        'finished a moment before).',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while stopping the campaign.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

const postPreviewCampaignSchema = {
  operationId: 'previewNewsletterCampaign',
  summary: 'Preview the mail of a newsletter campaign',
  description:
    'Builds the mail of the campaign as a reader of the language asked would get it, and gives it back: ' +
    'the subject, the line under it, the html, the plain text, and the warnings. The products of the ' +
    'blocks are taken from the catalog at the moment of the request, the list a buyer sees: a product ' +
    'that is deleted, hidden or out of stock is left out (`PRODUCT_UNAVAILABLE`), and a block with ' +
    'nothing left is left out (`BLOCK_EMPTY`). The links of the subscription ("Manage the ' +
    'subscription", the unsubscribe of the mail program) lead to the home page of the shop. Nothing is ' +
    'sent or written, and a campaign in any state can be looked at. The refusals come in this order: ' +
    'the body (400), the campaign (404), the language (400 `LOCALE_INVALID`, then 400 ' +
    '`NEWSLETTER_LOCALE_NOT_IN_CAMPAIGN`). ' +
    CAMPAIGNS_TEXT,

  params: { $ref: 'newslettersCampaignParamsSchema#', examples: [paramsExample] },
  body: { $ref: 'newslettersCampaignPreviewBodySchema#', examples: [previewBodyExample] },

  response: {
    200: {
      description: 'The mail, with what is wrong or left out in it.',
      $ref: 'newslettersCampaignPreviewResponseSchema#',
      examples: [previewExample],
    },
    400: {
      description:
        '`LOCALE_INVALID`: the language is not one the shop answers in. ' +
        '`NEWSLETTER_LOCALE_NOT_IN_CAMPAIGN`: the shop answers in it but the campaign has no ' +
        'subject in it, so no mail in that language can be made. `VALIDATION_ERROR`: the body is not ' +
        'exactly `{ locale }`.',
      $ref: 'errorResponseSchema#',
    },
    404: {
      description: '`NEWSLETTER_CAMPAIGN_NOT_FOUND`: there is no campaign with this id.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while building the mail.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

const postTestCampaignSchema = {
  operationId: 'sendNewsletterCampaignTest',
  summary: 'Send the test mail of a newsletter campaign',
  description:
    'Sends the mail of the campaign for real, through the stream of the newsletters, to the address ' +
    'given, which must be the address of an account of an admin or of root that was not deleted (the ' +
    'own one or another); every other address, an address nobody has included, gets the same ' +
    '`NEWSLETTER_TEST_RECIPIENT_NOT_ALLOWED`. The mail is what a subscriber gets in the language ' +
    'chosen, the products taken now, with two marks of a test in that language: its subject starts ' +
    'with a word "test" (`[Test]`) and a line at the top says that it is a test mail the ' +
    'subscribers did not get (the preview has neither). Its links of the subscription ' +
    'are dead: the page "Manage the subscription" says the link is not valid and the one-click ' +
    'unsubscribe does nothing, so no subscription is read or changed. A campaign in any state can be ' +
    'tried, with no wait between two; a user may send ' +
    env.LIMIT_NEWSLETTER_TEST_PER_USER +
    ' test mails an hour in all campaigns together (`LIMIT_NEWSLETTER_TEST_PER_USER`; 429). A line is ' +
    'written to the admin log with the campaign and the account of the recipient, never the address. ' +
    'The refusals come in this order: the body (400), the limit of the user (429), the campaign (404), ' +
    'the language (400), the address (403). ' +
    CAMPAIGNS_TEXT,

  params: { $ref: 'newslettersCampaignParamsSchema#', examples: [paramsExample] },
  body: { $ref: 'newslettersCampaignTestBodySchema#', examples: [testBodyExample] },

  response: {
    200: {
      description: 'The mail was sent: the mail provider took it.',
      $ref: 'newslettersCampaignTestSentResponseSchema#',
      examples: [testSentExample],
    },
    400: {
      description:
        '`LOCALE_INVALID`: the language is not one the shop answers in. ' +
        '`NEWSLETTER_LOCALE_NOT_IN_CAMPAIGN`: the campaign has no subject in it. ' +
        '`VALIDATION_ERROR`: the body is not exactly `{ email, locale }`.',
      $ref: 'errorResponseSchema#',
    },
    403: {
      description:
        '`NEWSLETTER_TEST_RECIPIENT_NOT_ALLOWED`: the address is not the address of an account of an ' +
        'admin or of root (a user, a stranger, a deleted account, a text that is no address): the ' +
        'answer does not tell which.',
      $ref: 'errorResponseSchema#',
    },
    404: {
      description: '`NEWSLETTER_CAMPAIGN_NOT_FOUND`: there is no campaign with this id.',
      $ref: 'errorResponseSchema#',
    },
    429: {
      description:
        '`RATE_LIMITED` with `details.limit` `newsletterTest`: the user sent more test mails in the ' +
        'last hour than the limit allows; the retry-after header tells how many seconds to wait.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while building or sending the mail.',
      $ref: 'errorResponseSchema#',
    },
    502: {
      description:
        '`NEWSLETTER_TEST_SEND_FAILED`: the mail provider did not take the mail (a refusal, or no ' +
        'answer in time). Nothing of the provider is in the answer, and no line is written to the log.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

const postTranslateSchema = {
  operationId: 'translateNewsletterTexts',
  summary: 'Translate the texts of a newsletter campaign into other languages',
  description:
    'Gives a draft of each text in each language asked, written by a language model (OpenAI). ' +
    'Nothing is saved, in the campaign or anywhere: the person edits the drafts and saves in the ' +
    'campaign (PATCH) the languages they keep. The texts are the ones of the form, each with a `key` ' +
    'the caller makes up, which its drafts come back under, and a `kind`: a `line` (a subject, the line ' +
    'under it, a title; the draft is one line, up to 150 characters, `maxChars` makes it shorter) or ' +
    'a `markup` (the text of a block of text, up to 5000 characters; its markup is kept, no address ' +
    'is translated and no html is written). `from` is the language of the texts, the language of ' +
    'the shop unless given; `to` are the languages to translate into. The model is not trusted: ' +
    'each draft is checked and one that fails is left out of `translations` and named in ' +
    '`warnings` with the reason (see the codes there; `ADDRESS_NOT_ALLOWED` also gives the `field`, ' +
    '`<key>.<locale>`, and the `address` that is not allowed, as the error of the content does); ' +
    'a language the model could not be asked for ' +
    'at all comes empty, with `TRANSLATION_FAILED` for each text, so the person can ask again for it ' +
    'alone. The refusals come in this order: the body (400 `VALIDATION_ERROR`), the languages (400 ' +
    '`LOCALE_INVALID`, `details` name the `field` (`from`, `to[1]`) and the `locale`), a key used twice ' +
    '(400 `VALIDATION_ERROR`), more than 20000 characters in all (400 ' +
    '`NEWSLETTER_TRANSLATE_TOO_MUCH_TEXT`), then the model (502). Each request is paid for at the ' +
    'provider of the model, so a user may ask ' +
    env.LIMIT_NEWSLETTER_TRANSLATE_PER_USER +
    ' times an hour (`LIMIT_NEWSLETTER_TRANSLATE_PER_USER`). ' +
    CAMPAIGNS_TEXT,

  body: { $ref: 'newslettersTranslateBodySchema#', examples: [translateBodyExample] },

  response: {
    200: {
      description:
        'The drafts by language and key, and the warnings of the drafts that were left out.',
      $ref: 'newslettersTranslateResponseSchema#',
      examples: [translateExample],
    },
    400: {
      description:
        '`LOCALE_INVALID`: a language is not one the shop answers in, or is the language of the ' +
        'texts, or is asked twice (`details`: `field`, `locale`). ' +
        '`NEWSLETTER_TRANSLATE_TOO_MUCH_TEXT`: the texts have more than 20000 characters in all ' +
        '(`details`: `limit`, `length`). `VALIDATION_ERROR`: the body has the wrong shape, a limit is ' +
        'passed, or a `key` is used twice.',
      $ref: 'errorResponseSchema#',
    },
    429: {
      description:
        '`RATE_LIMITED` with `details.limit` `newsletterTranslate`: the user asked more times in the ' +
        'last hour than the limit allows; the retry-after header tells how many seconds to wait.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while translating.',
      $ref: 'errorResponseSchema#',
    },
    502: {
      description:
        '`NEWSLETTER_TRANSLATE_FAILED`: the model could not be asked for any of the languages (OpenAI ' +
        'is not set up here, did not answer in time, refused, or gave no answer that can be used). ' +
        'Nothing of the provider is in the answer. Ask again in a moment.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

const tagged = withOpenApiTag(
  {
    postCampaignSchema,
    getCampaignsSchema,
    getCampaignSchema,
    patchCampaignSchema,
    deleteCampaignSchema,
    postCopyCampaignSchema,
    postScheduleCampaignSchema,
    postCancelCampaignSchema,
    postStopCampaignSchema,
    postPreviewCampaignSchema,
    postTestCampaignSchema,
    postTranslateSchema,
  },
  'newsletters',
);

export const newslettersCampaignsRouteSchema = withOpenApiSecurity(
  tagged,
  openApiSecurity.accessTokenCookie,
);
