import { captchaTokenField } from '@schemas/captchaField.js';

// The longest language code a request may carry (a BCP 47 tag such as uk-UA is far shorter); the
// shape and the shop's languages are checked by the route, so a wrong code is LOCALE_INVALID
export const NEWSLETTER_LOCALE_MAX_LENGTH = 35;

// The longest address an email may have (RFC 5321), the same limit the database keeps
export const NEWSLETTER_EMAIL_MAX_LENGTH = 254;

// The longest segment of an address the router takes (maxParamLength of fastify, 100): a longer
// token in a path is turned away by the router itself, before the route
const NEWSLETTER_PATH_TOKEN_MAX_LENGTH = 100;

// The longest token a request may carry in its body; the tokens the server makes are 43 characters. A token
// that is longer, or that nobody was given, is the same refusal as a dead link
export const NEWSLETTER_TOKEN_MAX_LENGTH = 512;

const emailField = {
  type: 'string',
  format: 'email',
  maxLength: NEWSLETTER_EMAIL_MAX_LENGTH,
  description:
    'The address to subscribe. A guest must give it. A signed-in user may leave it out, or give ' +
    'their own address: they are subscribed at once, with no captcha. Any other address is a ' +
    'request that waits for the confirmation by mail, whoever asks.',
} as const;

const localeField = {
  type: 'string',
  maxLength: NEWSLETTER_LOCALE_MAX_LENGTH,
  description:
    'The language of the mails of the subscription, one the shop answers in (GET ' +
    '/api/shop-settings, enabledLocales), case and a region ignored: uk-UA and UK both read as ' +
    'uk. A guest must give it; a language the shop does not answer in is `LOCALE_INVALID`, no ' +
    'other is put in its place. A signed-in user may leave it out: their own language is taken if ' +
    'the shop answers in it, otherwise the subscription has no language and the mails go in the ' +
    "shop's own (for a request about another address, the language of the shop).",
} as const;

const newslettersSubscribeBodySchema = {
  $id: 'newslettersSubscribeBodySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    email: emailField,
    locale: localeField,
    captchaToken: {
      ...captchaTokenField,
      description:
        'The answer of the Cloudflare Turnstile widget. Required for a guest and for a signed-in ' +
        'user who asks about another address; a signed-in user who subscribes their own address ' +
        'sends none. ' +
        captchaTokenField.description,
    },
  },
} as const;

const tokenField = (where: string) =>
  ({
    type: 'string',
    minLength: 1,
    maxLength: NEWSLETTER_TOKEN_MAX_LENGTH,
    description: `The token from the \`token\` parameter of the link in ${where}. It travels in the body, never in an address.`,
  }) as const;

const newslettersConfirmBodySchema = {
  $id: 'newslettersConfirmBodySchema',
  type: 'object',
  additionalProperties: false,
  properties: { token: tokenField('the mail of the confirmation') },
  required: ['token'],
} as const;

const newslettersManageBodySchema = {
  $id: 'newslettersManageBodySchema',
  type: 'object',
  additionalProperties: false,
  properties: { token: tokenField('a mail of the newsletters, "Manage the subscription"') },
  required: ['token'],
} as const;

const newslettersManageLocaleBodySchema = {
  $id: 'newslettersManageLocaleBodySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    token: tokenField('a mail of the newsletters, "Manage the subscription"'),
    locale: {
      ...localeField,
      description:
        'The new language of the subscription, one the shop answers in (GET /api/shop-settings, ' +
        'enabledLocales), case and a region ignored. A language the shop does not answer in is ' +
        '`LOCALE_INVALID`.',
    },
  },
  required: ['token', 'locale'],
} as const;

const newslettersProfileLocaleBodySchema = {
  $id: 'newslettersProfileLocaleBodySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    locale: {
      ...localeField,
      description:
        'The new language of the subscription, one the shop answers in (GET /api/shop-settings, ' +
        'enabledLocales), case and a region ignored. A language the shop does not answer in is ' +
        '`LOCALE_INVALID`.',
    },
  },
  required: ['locale'],
} as const;

const newslettersOneClickParamsSchema = {
  $id: 'newslettersOneClickParamsSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    token: {
      type: 'string',
      minLength: 1,
      maxLength: NEWSLETTER_PATH_TOKEN_MAX_LENGTH,
      description:
        'The unsubscribe token of the subscription, the one the header `List-Unsubscribe` of its ' +
        'mails carries. It is not the token of the link "Manage the subscription" (that one opens ' +
        'more and is never put in an address of the API). It is in the address because RFC 8058 ' +
        'asks for it; the logs of the server hide it.',
    },
  },
  required: ['token'],
} as const;

const newslettersOneClickQuerySchema = {
  $id: 'newslettersOneClickQuerySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    c: {
      type: 'string',
      maxLength: 64,
      description:
        'The id of the campaign whose mail the person unsubscribed from, to count the ' +
        'unsubscribe for it. A value that is no id of a campaign that went out is ignored: ' +
        'the unsubscribe works all the same.',
    },
  },
} as const;

const newslettersOneClickBodySchema = {
  $id: 'newslettersOneClickBodySchema',
  type: 'object',
  additionalProperties: false,
  description:
    'The form a mail client posts (RFC 8058), content type application/x-www-form-urlencoded. The ' +
    'route does not insist on it: an empty body, or none at all, unsubscribes as well.',
  properties: {
    'List-Unsubscribe': {
      type: 'string',
      maxLength: 64,
      description: 'One-Click, as the header List-Unsubscribe-Post of the mail says.',
    },
  },
} as const;

// ---- answers ----

const newslettersAcceptedResponseSchema = {
  $id: 'newslettersAcceptedResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    message: { type: 'string', description: 'A fixed sentence, the same for every address.' },
  },
  required: ['message'],
} as const;

const sourceField = {
  type: 'string',
  enum: ['form', 'account'],
  description:
    '`form`: made on the public page (a request confirmed by mail); `account`: made by a ' +
    'signed-in user for their own address, or by the registration.',
} as const;

const liveStatusField = {
  type: 'string',
  enum: ['active', 'paused_complaint'],
  description:
    '`active`: the person gets the newsletters; `paused_complaint`: a mail provider told that the ' +
    'person marked a mail as spam, so none are sent until the person resumes the subscription.',
} as const;

const localeAnswerField = {
  type: ['string', 'null'],
  description:
    'The language of the mails of the subscription; null means none is chosen and the mails go in ' +
    "the shop's own language.",
} as const;

const canChangeLocaleField = {
  type: 'boolean',
  description:
    'Whether the language of this subscription is changed where the answer came from: a ' +
    'subscription of an account is changed in the profile (PATCH /api/newsletters/me), one of the ' +
    'form on the page "Manage the subscription" (POST /api/newsletters/manage/locale).',
} as const;

const newslettersSubscriptionResponseSchema = {
  $id: 'newslettersSubscriptionResponseSchema',
  type: 'object',
  additionalProperties: false,
  description:
    'The subscription of the address of the signed-in user: `{ subscribed: false }` when none is in ' +
    'force (a request that waits for its confirmation is not one yet), otherwise the fields below.',
  properties: {
    subscribed: { type: 'boolean', description: 'Whether a subscription is in force.' },
    source: sourceField,
    status: liveStatusField,
    locale: localeAnswerField,
    canChangeLocale: {
      ...canChangeLocaleField,
      description:
        'Whether the language is changed in the profile (PATCH /api/newsletters/me): true for a ' +
        'subscription of an account, false for one of the form, whose language is changed on the ' +
        'page "Manage the subscription" its mails link to.',
    },
    subscribedAt: {
      type: 'string',
      format: 'date-time',
      description: 'When the subscription came into force.',
    },
  },
  required: ['subscribed'],
} as const;

const newslettersConfirmResponseSchema = {
  $id: 'newslettersConfirmResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { type: 'string', const: 'active', description: 'The subscription is in force.' },
    locale: localeAnswerField,
  },
  required: ['status', 'locale'],
} as const;

const newslettersDeclineResponseSchema = {
  $id: 'newslettersDeclineResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    blocked: {
      type: 'boolean',
      const: true,
      description:
        'The address is on the blocklist of the form: requests about it get the usual answer ' +
        'and no mail.',
    },
  },
  required: ['blocked'],
} as const;

const newslettersManageStateResponseSchema = {
  $id: 'newslettersManageStateResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    email: { type: 'string', description: 'The subscribed address, in lower case.' },
    source: sourceField,
    locale: localeAnswerField,
    status: liveStatusField,
    canChangeLocale: canChangeLocaleField,
  },
  required: ['email', 'source', 'locale', 'status', 'canChangeLocale'],
} as const;

const newslettersUnsubscribedResponseSchema = {
  $id: 'newslettersUnsubscribedResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    unsubscribed: {
      type: 'boolean',
      const: true,
      description: 'The subscription is over; it is true also when it had ended already.',
    },
  },
  required: ['unsubscribed'],
} as const;

const exportEventSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    event: {
      type: 'string',
      description:
        'What happened: requested, confirmed, subscribed, locale_changed, locale_reset, ' +
        'unsubscribed, complaint, restored, bounced, account_deleted, removed_by_admin, expired.',
    },
    place: {
      type: 'string',
      description:
        'Where: form, registration, profile, manage_page, mail_client, webhook, admin or system.',
    },
    ip: { type: ['string', 'null'], description: 'The address the request came from.' },
    userAgent: { type: ['string', 'null'], description: 'The browser of the request.' },
    locale: { type: ['string', 'null'], description: 'The language at that moment.' },
    campaignId: {
      type: ['integer', 'null'],
      description: 'The campaign whose mail the unsubscribe came from.',
    },
    privacyVersion: {
      type: ['integer', 'null'],
      description: 'The version of the privacy policy in force when a consent was given.',
    },
    createdAt: { type: 'string', description: 'When, in UTC.' },
  },
  required: [
    'event',
    'place',
    'ip',
    'userAgent',
    'locale',
    'campaignId',
    'privacyVersion',
    'createdAt',
  ],
} as const;

const exportItemSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    email: { type: 'string', description: 'The address.' },
    source: sourceField,
    locale: localeAnswerField,
    status: {
      type: 'string',
      description: 'active, paused_complaint, stopped_bounce or ended.',
    },
    createdAt: { type: 'string', description: 'When the subscription was asked for, in UTC.' },
    confirmedAt: {
      type: ['string', 'null'],
      description: 'When it came into force, in UTC.',
    },
    endedAt: { type: ['string', 'null'], description: 'When it ended or was stopped, in UTC.' },
    endReason: {
      type: ['string', 'null'],
      description:
        'Why: unsubscribed, account_deleted, removed_by_admin, expired, not_me, bounced.',
    },
    events: {
      type: 'array',
      description: 'The journal of the subscription, the oldest line first.',
      items: exportEventSchema,
    },
  },
  required: [
    'email',
    'source',
    'locale',
    'status',
    'createdAt',
    'confirmedAt',
    'endedAt',
    'endReason',
    'events',
  ],
} as const;

const newslettersExportResponseSchema = {
  $id: 'newslettersExportResponseSchema',
  type: 'object',
  additionalProperties: false,
  description:
    'Everything the shop keeps about the subscription behind the link and its journal, the ' +
    'subscriptions of the address that were confirmed (a request that was never confirmed is not ' +
    'given). No token, hash or other secret of the server is part of it.',
  properties: {
    subscriptions: { type: 'array', items: exportItemSchema },
  },
  required: ['subscriptions'],
} as const;

const newslettersSendGridWebhookResponseSchema = {
  $id: 'newslettersSendGridWebhookResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    received: { type: 'boolean', const: true },
    applied: {
      type: 'integer',
      minimum: 0,
      description:
        'How many events were applied to a mail of the campaigns of this environment (a bounce, a block, a drop or a spam report); an event that came before counts again, applying it twice changes nothing.',
    },
    skipped: {
      type: 'integer',
      minimum: 0,
      description:
        'How many events were left alone: a kind of event the shop does not keep (delivered, open, click, ...), a mail of the orders or of another environment, an item that is no event, a recipient this database does not have.',
    },
  },
  required: ['received', 'applied', 'skipped'],
} as const;

export const newslettersDtoSchemas = [
  newslettersSubscribeBodySchema,
  newslettersConfirmBodySchema,
  newslettersManageBodySchema,
  newslettersManageLocaleBodySchema,
  newslettersProfileLocaleBodySchema,
  newslettersOneClickParamsSchema,
  newslettersOneClickQuerySchema,
  newslettersOneClickBodySchema,
  newslettersAcceptedResponseSchema,
  newslettersSubscriptionResponseSchema,
  newslettersConfirmResponseSchema,
  newslettersDeclineResponseSchema,
  newslettersManageStateResponseSchema,
  newslettersUnsubscribedResponseSchema,
  newslettersExportResponseSchema,
  newslettersSendGridWebhookResponseSchema,
];
