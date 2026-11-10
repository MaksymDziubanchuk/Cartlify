import { idPathParam } from '@schemas/idPathParam.js';
import {
  NO_LOCALE_FILTER,
  SUBSCRIBERS_DEFAULT_LIMIT,
  SUBSCRIBER_SOURCES,
  SUBSCRIBER_STATUSES,
} from '@routes/api/newsletters/services/helpers/subscribersList.helper.js';

// The schemas of the routes of the people who run the newsletters (root, and an admin whom root
// allowed): the numbers and the list of subscribers, and the blocklist of the public form

// The longest text an address may be written in: the address (254, the limit of RFC 5321) and the spaces
// the route cuts around it, which the schema lets through
export const NEWSLETTER_BLOCK_EMAIL_MAX_LENGTH = 320;

// The longest reason a request may carry. The list keeps 200 characters and cuts the rest, so a text
// a little longer than that is no mistake; one far longer is
export const NEWSLETTER_BLOCK_REASON_MAX_LENGTH = 1000;

const dateTime = { type: 'string', format: 'date-time' } as const;
const nullableDateTime = { anyOf: [dateTime, { type: 'null' }] } as const;

// one name of the list or several through commas
const namesPattern = (names: readonly string[]) => {
  const one = `(${names.join('|')})`;
  return `^${one}(,${one})*$`;
};

// ---- the numbers ----

const localeBucketSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    locale: {
      type: ['string', 'null'],
      description:
        'The language, two small letters. null is the bucket of the subscriptions that have none: ' +
        'their mails go in the language of the shop, and the page shows it as "shop language".',
    },
    count: { type: 'integer', description: 'How many subscriptions in force have it.' },
  },
  required: ['locale', 'count'],
} as const;

const newslettersSubscribersSummaryResponseSchema = {
  $id: 'newslettersSubscribersSummaryResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    active: {
      type: 'integer',
      description: 'The subscriptions in force (`active`): the people who get the newsletters.',
    },
    byLocale: {
      type: 'array',
      description:
        'The subscriptions in force by language, the largest first, equal ones by language and the ' +
        'one without a language last. A language nobody has is not in the list.',
      items: localeBucketSchema,
    },
    bySource: {
      type: 'object',
      additionalProperties: false,
      description: 'The subscriptions in force by where they were made.',
      properties: {
        form: { type: 'integer', description: 'Made on the public page, confirmed by mail.' },
        account: {
          type: 'integer',
          description: 'Made by a signed-in user for their address, or by a registration.',
        },
      },
      required: ['form', 'account'],
    },
    pending: {
      type: 'integer',
      description: 'Requests that wait for their confirmation by mail: not subscribers yet.',
    },
    pausedComplaint: {
      type: 'integer',
      description:
        'Subscriptions a complaint paused (`paused_complaint`): the person marked a mail as spam, ' +
        'no mail goes out until they resume.',
    },
    stoppedBounce: {
      type: 'integer',
      description:
        'Subscriptions a bounce stopped (`stopped_bounce`): the mail provider said the address does ' +
        'not exist.',
    },
  },
  required: ['active', 'byLocale', 'bySource', 'pending', 'pausedComplaint', 'stoppedBounce'],
} as const;

// ---- the list ----

const newslettersSubscribersQuerySchema = {
  $id: 'newslettersSubscribersQuerySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: 100,
      description: `Rows on a page, ${SUBSCRIBERS_DEFAULT_LIMIT} unless given.`,
    },
    cursor: {
      type: 'string',
      minLength: 1,
      pattern: '^[A-Za-z0-9_-]+$',
      description: 'nextCursor of the page before.',
    },
    status: {
      type: 'string',
      pattern: namesPattern(SUBSCRIBER_STATUSES),
      description:
        `The state of the subscription, one or several through commas (no spaces): ` +
        `${SUBSCRIBER_STATUSES.join(', ')}. Every state unless given.`,
    },
    source: {
      type: 'string',
      pattern: namesPattern(SUBSCRIBER_SOURCES),
      description: `Where it was made, one or both through a comma: ${SUBSCRIBER_SOURCES.join(', ')}. Both unless given.`,
    },
    locale: {
      type: 'string',
      pattern: namesPattern(['[a-z]{2}', NO_LOCALE_FILTER]),
      description:
        `The language of the mails, one or several through commas, two small letters each; ` +
        `\`${NO_LOCALE_FILTER}\` stands for the subscriptions that have no language. Every language ` +
        'unless given.',
    },
    email: {
      type: 'string',
      maxLength: 254,
      description:
        'A part of the address, in any case; spaces around it are cut, _ and % are the characters ' +
        'themselves.',
    },
  },
} as const;

const newslettersSubscriberItemSchema = {
  $id: 'newslettersSubscriberItemSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    id: {
      type: 'integer',
      description: 'The id of the subscription: DELETE removes it by this id.',
    },
    email: { type: 'string', description: 'The address, in lower case.' },
    source: {
      type: 'string',
      enum: SUBSCRIBER_SOURCES,
      description: '`form`: made on the public page; `account`: made by a signed-in user.',
    },
    locale: {
      type: ['string', 'null'],
      description:
        'The language of the mails; null: none, the mails go in the language of the shop.',
    },
    status: {
      type: 'string',
      enum: SUBSCRIBER_STATUSES,
      description:
        '`pending`: waits for the confirmation; `active`: in force; `paused_complaint`: paused by a ' +
        'complaint; `stopped_bounce`: stopped by a bounce; `ended`: over (see `endReason`).',
    },
    userId: {
      type: ['integer', 'null'],
      description: 'The account of a subscription of an account; null for one of the form.',
    },
    createdAt: { ...dateTime, description: 'When it was asked for.' },
    confirmedAt: { ...nullableDateTime, description: 'When it came into force; null before that.' },
    endedAt: {
      ...nullableDateTime,
      description: 'When it ended or was stopped; null while it lives.',
    },
    endReason: {
      type: ['string', 'null'],
      enum: [
        'unsubscribed',
        'account_deleted',
        'removed_by_admin',
        'expired',
        'not_me',
        'bounced',
        null,
      ],
      description:
        'Why it ended or was stopped: the person unsubscribed, the account was deleted, an admin ' +
        'removed it, the request was not confirmed in time, "this is not me", the address bounced. ' +
        'null while it lives.',
    },
  },
  required: [
    'id',
    'email',
    'source',
    'locale',
    'status',
    'userId',
    'createdAt',
    'confirmedAt',
    'endedAt',
    'endReason',
  ],
} as const;

const newslettersSubscribersResponseSchema = {
  $id: 'newslettersSubscribersResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    items: { type: 'array', items: { $ref: 'newslettersSubscriberItemSchema#' } },
    limit: { type: 'integer' },
    nextCursor: {
      anyOf: [{ type: 'string', minLength: 1, pattern: '^[A-Za-z0-9_-]+$' }, { type: 'null' }],
      description: 'The cursor of the next page, null on the last one.',
    },
    total: {
      type: 'integer',
      description: 'How many subscriptions the filters find, on all pages.',
    },
  },
  required: ['items', 'limit', 'nextCursor', 'total'],
} as const;

// ---- the removal of a subscriber ----

const newslettersSubscriberParamsSchema = {
  $id: 'newslettersSubscriberParamsSchema',
  type: 'object',
  additionalProperties: false,
  properties: { subscriberId: idPathParam('the subscription (`id` in the list of subscribers)') },
  required: ['subscriberId'],
} as const;

const newslettersSubscriberErasedResponseSchema = {
  $id: 'newslettersSubscriberErasedResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    erased: {
      type: 'boolean',
      const: true,
      description:
        'The address is erased: every subscription it had is made anonymous in place (nothing ' +
        'is deleted).',
    },
    subscriptions: {
      type: 'integer',
      minimum: 1,
      description:
        'How many subscriptions of the address were made anonymous: the one named and the ' +
        'other ones of the same address, whatever their state.',
    },
  },
  required: ['erased', 'subscriptions'],
} as const;

// ---- the blocklist ----

const blockEmailField = {
  type: 'string',
  minLength: 1,
  maxLength: NEWSLETTER_BLOCK_EMAIL_MAX_LENGTH,
  description:
    'The address, written any way: spaces around it are cut and the case does not matter, ' +
    '"Reader@Example.com " and "reader@example.com" are one address. It has to be an address ' +
    '(`INVALID_EMAIL` otherwise).',
} as const;

const newslettersBlocklistQuerySchema = {
  $id: 'newslettersBlocklistQuerySchema',
  type: 'object',
  additionalProperties: false,
  properties: { email: blockEmailField },
  required: ['email'],
} as const;

const newslettersBlockEntrySchema = {
  $id: 'newslettersBlockEntrySchema',
  type: 'object',
  additionalProperties: false,
  description:
    'An entry of the blocklist. The list keeps an HMAC of the address and not the address, so the ' +
    'entry does not name it: an admin finds it by typing the address.',
  properties: {
    id: { type: 'integer', description: 'The id of the entry: DELETE takes it off by this id.' },
    createdAt: { ...dateTime, description: 'When the address was blocked.' },
    blockedById: {
      type: ['integer', 'null'],
      description: 'The admin (or root) who blocked it; null when the person blocked it herself.',
    },
    byPerson: {
      type: 'boolean',
      description:
        'true when the person blocked the address herself, with the button "This is not me" of ' +
        'the mail of a confirmation.',
    },
    reason: {
      type: ['string', 'null'],
      description: 'The note of the admin (up to 200 characters), null when there is none.',
    },
  },
  required: ['id', 'createdAt', 'blockedById', 'byPerson', 'reason'],
} as const;

const newslettersBlockLookupResponseSchema = {
  $id: 'newslettersBlockLookupResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    blocked: { type: 'boolean', description: 'Whether the address is on the blocklist.' },
    entry: {
      anyOf: [{ $ref: 'newslettersBlockEntrySchema#' }, { type: 'null' }],
      description: 'The entry of the address; null when it is not blocked.',
    },
  },
  required: ['blocked', 'entry'],
} as const;

const newslettersBlocklistBodySchema = {
  $id: 'newslettersBlocklistBodySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    email: blockEmailField,
    reason: {
      type: 'string',
      maxLength: NEWSLETTER_BLOCK_REASON_MAX_LENGTH,
      description:
        'A note for the other admins, for example that the person asked through support. Spaces ' +
        'around it are cut, it is kept up to 200 characters (the rest is cut), an empty one is none.',
    },
  },
  required: ['email'],
} as const;

const newslettersBlockAddedResponseSchema = {
  $id: 'newslettersBlockAddedResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    created: {
      type: 'boolean',
      description:
        'true: the entry was made now (201); false: the address was blocked already (200).',
    },
    entry: { $ref: 'newslettersBlockEntrySchema#' },
  },
  required: ['created', 'entry'],
} as const;

const newslettersBlockParamsSchema = {
  $id: 'newslettersBlockParamsSchema',
  type: 'object',
  additionalProperties: false,
  properties: { blockId: idPathParam('the entry of the blocklist (`entry.id`)') },
  required: ['blockId'],
} as const;

const newslettersBlockRemovedResponseSchema = {
  $id: 'newslettersBlockRemovedResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    removed: {
      type: 'boolean',
      const: true,
      description: 'The entry is taken off: the form mails the address again.',
    },
  },
  required: ['removed'],
} as const;

export const newslettersAdminDtoSchemas = [
  newslettersSubscribersSummaryResponseSchema,
  newslettersSubscribersQuerySchema,
  newslettersSubscriberItemSchema,
  newslettersSubscribersResponseSchema,
  newslettersSubscriberParamsSchema,
  newslettersSubscriberErasedResponseSchema,
  newslettersBlocklistQuerySchema,
  newslettersBlockEntrySchema,
  newslettersBlockLookupResponseSchema,
  newslettersBlocklistBodySchema,
  newslettersBlockAddedResponseSchema,
  newslettersBlockParamsSchema,
  newslettersBlockRemovedResponseSchema,
];
