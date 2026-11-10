import { MAX_ID, idPathParam } from '@schemas/idPathParam.js';

// The schemas of the campaigns of the newsletters, for the people who run them (root, and an admin
// whom root allowed). The content of a campaign is checked by the schema below, as it is written in
// the swagger document: the routes that take a body use the strict validator (src/helpers/
// strictValidator.ts), which turns no type into another and takes no field away. What a schema
// cannot say (a language the shop has, a link that leads to the shop) the service checks
// (services/helpers/newsletterContent.helper.ts)

// ---- the limits ----

export const NEWSLETTER_NAME_MAX = 200;
export const NEWSLETTER_SUBJECT_MAX = 150;
export const NEWSLETTER_PREVIEW_MAX = 150;
export const NEWSLETTER_TITLE_MAX = 120;
export const NEWSLETTER_TEXT_MAX = 5000;
export const NEWSLETTER_URL_MAX = 2000;
// a mail of more than about 100 KB is cut by Gmail
export const NEWSLETTER_MAX_BLOCKS = 10;
export const NEWSLETTER_MAX_PRODUCTS = 12;
// more than the languages a shop could answer in; the keys are judged by the service
export const NEWSLETTER_MAX_LANGUAGES = 20;

export const NEWSLETTER_RULES = ['new', 'sale', 'popular', 'bestsellers', 'top_rated'] as const;
export const NEWSLETTER_PERIOD_DAYS = [7, 30, 90] as const;
export const NEWSLETTER_BUTTON_KINDS = ['shop', 'sale', 'new', 'category', 'product'] as const;
export const NEWSLETTER_MISSING_LOCALE = ['shop_locale', 'skip'] as const;
export const NEWSLETTER_CAMPAIGN_STATUSES = [
  'draft',
  'scheduled',
  'sending',
  'finished',
  'cancelled',
  'stopped',
] as const;
// why the system called a campaign off (a manager's cancellation has none)
export const NEWSLETTER_CANCEL_REASONS = ['limit'] as const;
export const NEWSLETTER_CAMPAIGNS_DEFAULT_LIMIT = 20;

// the translation of the texts of a campaign into other languages: how many texts a request has, how
// long the key of a text is, and how many characters the texts of one request have in all (each
// request is paid for at the provider of the model)
export const NEWSLETTER_TRANSLATE_MAX_ITEMS = 30;
export const NEWSLETTER_TRANSLATE_KEY_MAX = 40;
export const NEWSLETTER_TRANSLATE_TOTAL_MAX = 20_000;
export const NEWSLETTER_TRANSLATE_KINDS = ['line', 'markup'] as const;
// what can be wrong with the draft of a text, or with a language of a request
export const NEWSLETTER_TRANSLATE_WARNING_CODES = [
  'MISSING',
  'TRANSLATION_FAILED',
  'LINK_CHANGED',
  'ADDRESS_NOT_ALLOWED',
  'HTML_NOT_ALLOWED',
  'TOO_LONG',
  'NOT_A_LINE',
] as const;

// a text of one line that is not blank: no control sign, no line separator
const ONE_LINE = '^(?=.*\\S)[^\\p{Cc}\\u2028\\u2029]+$';
// the same, and it may be empty
const ONE_LINE_OR_EMPTY = '^[^\\p{Cc}\\u2028\\u2029]*$';

const dateTime = { type: 'string', format: 'date-time' } as const;
const nullableDateTime = { anyOf: [dateTime, { type: 'null' }] } as const;

const namesPattern = (names: readonly string[]) => {
  const one = `(${names.join('|')})`;
  return `^${one}(,${one})*$`;
};

// ---- the content ----

// a text for each language: the key is the code of the language (two small letters, one the shop
// answers in, judged by the service), the value is the text
const perLanguage = (
  what: string,
  value: { minLength: number; maxLength: number; pattern?: string },
) =>
  ({
    type: 'object',
    maxProperties: NEWSLETTER_MAX_LANGUAGES,
    additionalProperties: { type: 'string', ...value },
    description:
      `${what} The key is the code of a language the shop answers in (GET /api/shop-settings, ` +
      '`enabledLocales`), two small letters: any other key is `LOCALE_INVALID`, except in a change ' +
      'of a campaign, which may keep a language the campaign has a subject in and root turned off ' +
      'since (`disabledLocales` of the campaign).',
  }) as const;

const subjectField = perLanguage('The subject of the mail, one line of 1 to 150 characters.', {
  minLength: 1,
  maxLength: NEWSLETTER_SUBJECT_MAX,
  pattern: ONE_LINE,
});

const previewField = perLanguage(
  'The line under the subject in a list of mails, one line of up to 150 characters.',
  { minLength: 0, maxLength: NEWSLETTER_PREVIEW_MAX, pattern: ONE_LINE_OR_EMPTY },
);

const titleField = perLanguage('The title over the block, one line of 1 to 120 characters.', {
  minLength: 1,
  maxLength: NEWSLETTER_TITLE_MAX,
  pattern: ONE_LINE,
});

const idField = (what: string) =>
  ({ type: 'integer', minimum: 1, maximum: MAX_ID, description: what }) as const;

const BLOCK_TEXT =
  'A block of a mail. The mail is the blocks one under another, in this order, between the logo ' +
  'and the part every mail has (the seller, why the mail came, the link to manage the subscription).';

const newslettersCampaignTextBlockSchema = {
  $id: 'newslettersCampaignTextBlockSchema',
  type: 'object',
  additionalProperties: false,
  description: `${BLOCK_TEXT} A block of text.`,
  properties: {
    type: { type: 'string', const: 'text' },
    text: perLanguage(
      'The text in the simple markup, 1 to 5000 characters: `**bold**`, `*italic*`, a line that ' +
        'starts with `# ` is a heading, lines that start with `- ` are a list, `[label](address)` ' +
        'is a link, an empty line ends a paragraph. There is no html: a `<` is a `<`. A link has ' +
        'to lead to the shop (an address of the shop or a path that starts with one slash) or to a ' +
        'domain root trusts (an absolute `http` or `https` address of that domain or a subdomain of ' +
        'it; the mail writes it as it is, with no marks of the campaign): ' +
        '`NEWSLETTER_LINK_NOT_ALLOWED` otherwise. An address written out in the text (`https://...`, ' +
        '`www....`, `example.com/page`, or a name that ends with a real top-level domain, ' +
        '`example.com`, `example.com?x=1`) has to be of the shop or of a domain root trusts: ' +
        '`NEWSLETTER_ADDRESS_NOT_ALLOWED` otherwise.',
      { minLength: 1, maxLength: NEWSLETTER_TEXT_MAX },
    ),
  },
  required: ['type', 'text'],
} as const;

const productsCommon = {
  type: { type: 'string', const: 'products' },
  title: titleField,
} as const;

const newslettersCampaignProductsManualBlockSchema = {
  $id: 'newslettersCampaignProductsManualBlockSchema',
  type: 'object',
  additionalProperties: false,
  description:
    `${BLOCK_TEXT} Products chosen by hand: the cards are made when the campaign starts, a ` +
    'product that is gone from the catalog or sold out by then drops out, and a block left empty ' +
    'is not sent.',
  properties: {
    ...productsCommon,
    source: { type: 'string', const: 'manual' },
    productIds: {
      type: 'array',
      minItems: 1,
      maxItems: NEWSLETTER_MAX_PRODUCTS,
      uniqueItems: true,
      items: idField('The id of a product.'),
      description: '1 to 12 different products, in the order of the cards.',
    },
  },
  required: ['type', 'source', 'productIds'],
} as const;

const ruleCommon = {
  ...productsCommon,
  source: { type: 'string', const: 'rule' },
  limit: {
    type: 'integer',
    minimum: 1,
    maximum: NEWSLETTER_MAX_PRODUCTS,
    description: 'How many cards, 1 to 12; 4 when left out.',
  },
  categoryId: idField('Only the products of this category (and of the ones under it).'),
} as const;

const newslettersCampaignProductsRuleBlockSchema = {
  $id: 'newslettersCampaignProductsRuleBlockSchema',
  type: 'object',
  additionalProperties: false,
  description:
    `${BLOCK_TEXT} Products taken by a rule, the same list a buyer sees in the catalog: the cards ` +
    'are made when the campaign starts. This shape is for the rules `new`, `sale`, `popular` and ' +
    '`top_rated`; the rule `bestsellers` has a period and is the next shape.',
  properties: {
    ...ruleCommon,
    rule: {
      type: 'string',
      enum: NEWSLETTER_RULES.filter((rule) => rule !== 'bestsellers'),
      description:
        '`new`: the newest products; `sale`: the ones on sale; `popular`: the most popular; ' +
        '`top_rated`: the best rated.',
    },
  },
  required: ['type', 'source', 'rule'],
} as const;

const newslettersCampaignProductsBestsellersBlockSchema = {
  $id: 'newslettersCampaignProductsBestsellersBlockSchema',
  type: 'object',
  additionalProperties: false,
  description: `${BLOCK_TEXT} The products that sold best in a period, taken when the campaign starts.`,
  properties: {
    ...ruleCommon,
    rule: { type: 'string', const: 'bestsellers' },
    periodDays: {
      type: 'integer',
      enum: NEWSLETTER_PERIOD_DAYS,
      description: 'The days to look back, 7, 30 or 90; 30 when left out.',
    },
  },
  required: ['type', 'source', 'rule'],
} as const;

const newslettersCampaignCategoryBlockSchema = {
  $id: 'newslettersCampaignCategoryBlockSchema',
  type: 'object',
  additionalProperties: false,
  description: `${BLOCK_TEXT} A category of the catalog, with the link to it.`,
  properties: {
    type: { type: 'string', const: 'category' },
    categoryId: idField('The id of the category.'),
    title: titleField,
  },
  required: ['type', 'categoryId'],
} as const;

const newslettersCampaignButtonBlockSchema = {
  $id: 'newslettersCampaignButtonBlockSchema',
  type: 'object',
  additionalProperties: false,
  description:
    `${BLOCK_TEXT} A button. The label is not free text: it comes from the dictionary of the ` +
    'language of the subscriber by the kind.',
  properties: {
    type: { type: 'string', const: 'button' },
    kind: {
      type: 'string',
      enum: NEWSLETTER_BUTTON_KINDS,
      description:
        'What the button says: `shop` (to the shop), `sale` (sale), `new` (new products), ' +
        '`category` (a category), `product` (a product).',
    },
    url: {
      type: 'string',
      minLength: 1,
      maxLength: NEWSLETTER_URL_MAX,
      description:
        'A page of the shop (an address of the shop or a path that starts with one slash) or of a ' +
        'domain root trusts (an absolute `http` or `https` address of that domain or a subdomain of ' +
        'it; the mail links to it as it is, with no marks of the campaign). Another address is ' +
        '`NEWSLETTER_LINK_NOT_ALLOWED`.',
    },
  },
  required: ['type', 'kind', 'url'],
} as const;

const newslettersCampaignBlockSchema = {
  $id: 'newslettersCampaignBlockSchema',
  description: `${BLOCK_TEXT} The shape is told by \`type\` (and for products by \`source\`).`,
  oneOf: [
    { $ref: 'newslettersCampaignTextBlockSchema#' },
    { $ref: 'newslettersCampaignProductsManualBlockSchema#' },
    { $ref: 'newslettersCampaignProductsRuleBlockSchema#' },
    { $ref: 'newslettersCampaignProductsBestsellersBlockSchema#' },
    { $ref: 'newslettersCampaignCategoryBlockSchema#' },
    { $ref: 'newslettersCampaignButtonBlockSchema#' },
  ],
} as const;

const newslettersCampaignContentSchema = {
  $id: 'newslettersCampaignContentSchema',
  type: 'object',
  additionalProperties: false,
  description:
    'The content of a campaign: the subject and the preview for each language, and the blocks, one ' +
    'structure for all languages (the texts inside them are for each language). A language is in ' +
    'the campaign when it has a subject; a preview, a text or a title in a language without a ' +
    'subject is `NEWSLETTER_LOCALE_WITHOUT_SUBJECT`. A draft may be incomplete: the shop language ' +
    'may still lack a text. Whether the content is whole is judged when the campaign is scheduled.',
  properties: {
    subject: subjectField,
    preview: previewField,
    blocks: {
      type: 'array',
      maxItems: NEWSLETTER_MAX_BLOCKS,
      items: { $ref: 'newslettersCampaignBlockSchema#' },
      description: 'Up to 10 blocks, in the order they stand in the mail.',
    },
  },
  required: ['subject', 'blocks'],
} as const;

// ---- the body of a request ----

const nameField = {
  type: 'string',
  minLength: 1,
  maxLength: NEWSLETTER_NAME_MAX,
  pattern: ONE_LINE,
  description:
    'The name the people who run the newsletters see in the lists, one line of 1 to 200 ' +
    'characters; spaces around it are cut.',
} as const;

const missingLocaleField = {
  type: 'string',
  enum: NEWSLETTER_MISSING_LOCALE,
  description:
    'What to do with a subscriber whose language has no text in the campaign: `shop_locale`: send ' +
    'the text of the language of the shop (the default); `skip`: send nothing to them.',
} as const;

const newslettersCampaignCreateBodySchema = {
  $id: 'newslettersCampaignCreateBodySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    name: nameField,
    missingLocale: missingLocaleField,
    content: {
      $ref: 'newslettersCampaignContentSchema#',
      description:
        'The content. Left out, the draft has no language and no block: write it with PATCH.',
    },
  },
  required: ['name'],
} as const;

const newslettersCampaignUpdateBodySchema = {
  $id: 'newslettersCampaignUpdateBodySchema',
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    name: nameField,
    missingLocale: missingLocaleField,
    content: {
      $ref: 'newslettersCampaignContentSchema#',
      description:
        'The whole new content. It replaces the content of the campaign, it is not merged with it.',
    },
  },
} as const;

// A campaign is scheduled for a time, or for now: exactly one of the two. Two forms rather than a rule
// that one of two fields is wanted, which Swagger 3.0 cannot say; the time itself is judged by the
// service (src/helpers/shopTime.ts), the one place that knows what a time of the shop is
export const NEWSLETTER_SCHEDULE_AT_MAX = 40;

const newslettersCampaignScheduleAtBodySchema = {
  $id: 'newslettersCampaignScheduleAtBodySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    scheduledAt: {
      type: 'string',
      minLength: 1,
      maxLength: NEWSLETTER_SCHEDULE_AT_MAX,
      description:
        'The time the campaign goes out, ISO 8601, to the minute or the second. With an offset ' +
        '(`Z` or `+02:00`) it is that exact instant; without one it is read in the time zone of ' +
        'the shop, so `2026-12-01T10:00` is ten in the morning in the shop. It must not be in the past.',
    },
  },
  required: ['scheduledAt'],
} as const;

const newslettersCampaignScheduleNowBodySchema = {
  $id: 'newslettersCampaignScheduleNowBodySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    runNow: {
      type: 'boolean',
      const: true,
      description:
        'Send as soon as the system picks it up: the time of the campaign is the moment of the ' +
        'request, and the limit is checked for that moment.',
    },
  },
  required: ['runNow'],
} as const;

const newslettersCampaignScheduleBodySchema = {
  $id: 'newslettersCampaignScheduleBodySchema',
  description:
    'Exactly one of `scheduledAt` (a time) and `runNow` (`true`); both, neither or any other ' +
    'field is refused.',
  oneOf: [
    { $ref: 'newslettersCampaignScheduleAtBodySchema#' },
    { $ref: 'newslettersCampaignScheduleNowBodySchema#' },
  ],
} as const;

// ---- the preview and the test mail ----

// The longest address an email may have (RFC 5321), the same limit the database keeps
export const NEWSLETTER_TEST_EMAIL_MAX = 254;
// the longest language the body takes; the service reads the code out of it (en, EN, en-GB)
export const NEWSLETTER_LOCALE_PARAM_MAX = 35;

const localeParam = {
  type: 'string',
  minLength: 1,
  maxLength: NEWSLETTER_LOCALE_PARAM_MAX,
  description:
    'The language of the mail: the code of a language the shop answers in (GET /api/shop-settings, ' +
    '`enabledLocales`), two letters; the case and a region (`ES`, `en-GB`) are left aside. ' +
    'Another one is `LOCALE_INVALID`; one the campaign has no subject in is ' +
    '`NEWSLETTER_LOCALE_NOT_IN_CAMPAIGN`.',
} as const;

const newslettersCampaignPreviewBodySchema = {
  $id: 'newslettersCampaignPreviewBodySchema',
  type: 'object',
  additionalProperties: false,
  properties: { locale: localeParam },
  required: ['locale'],
} as const;

const newslettersCampaignTestBodySchema = {
  $id: 'newslettersCampaignTestBodySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    email: {
      type: 'string',
      minLength: 1,
      maxLength: NEWSLETTER_TEST_EMAIL_MAX,
      description:
        'Where the test mail goes: the address of an account of an admin or of root (the own one ' +
        'or another), as the account keeps it, spaces round it and its case are left aside. Any ' +
        'other text, an address nobody has included, is `NEWSLETTER_TEST_RECIPIENT_NOT_ALLOWED`.',
    },
    locale: localeParam,
  },
  required: ['email', 'locale'],
} as const;

const NEWSLETTER_WARNING_CODES = [
  'PRODUCT_UNAVAILABLE',
  'BLOCK_EMPTY',
  'CATEGORY_MISSING',
  'LINK_NOT_ALLOWED',
  'TEXT_MISSING',
  'TITLE_MISSING',
  'MAIL_EMPTY',
  'MAIL_TOO_LARGE',
] as const;

const newslettersCampaignWarningSchema = {
  $id: 'newslettersCampaignWarningSchema',
  type: 'object',
  additionalProperties: false,
  description:
    'Something in the mail that is wrong or was left out. A block that cannot be shown is left out of ' +
    'the mail, never an error.',
  properties: {
    blockIndex: {
      anyOf: [{ type: 'integer', minimum: 0 }, { type: 'null' }],
      description:
        'The place of the block in `content.blocks`; null for a fault of the whole mail.',
    },
    code: {
      type: 'string',
      enum: NEWSLETTER_WARNING_CODES,
      description:
        '`PRODUCT_UNAVAILABLE`: a product of a block by hand is deleted, hidden or out of stock now ' +
        '(`productId`), it is left out. `BLOCK_EMPTY`: a block of products has no card left, it is ' +
        'left out. `CATEGORY_MISSING`: the category of a block of a category, or of a rule, is gone; ' +
        'the block is left out. `LINK_NOT_ALLOWED`: a link of a text, or a button, does not lead to ' +
        'the shop or to a domain root trusts as they are now; a button is left out, a link of a text ' +
        'is written as words. ' +
        '`TEXT_MISSING`: a block of text has no text in this language, it is left out. ' +
        '`TITLE_MISSING`: a block has titles in other languages and none in this one, it goes ' +
        'without a title. `MAIL_EMPTY`: no block is left. `MAIL_TOO_LARGE`: the html is over ' +
        'about 100 KB, where Gmail cuts a mail and hides its foot.',
    },
    productId: {
      type: 'integer',
      description: '`PRODUCT_UNAVAILABLE` only: the product that was left out.',
    },
  },
  required: ['blockIndex', 'code'],
} as const;

const newslettersCampaignPreviewResponseSchema = {
  $id: 'newslettersCampaignPreviewResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    subject: { type: 'string', description: 'The subject of the mail in the language asked.' },
    preheader: {
      type: 'string',
      description: 'The line under the subject in a list of mails; empty when there is none.',
    },
    html: {
      type: 'string',
      description:
        'The html of the mail as a reader would get it. Show it in an iframe with a sandbox: it is ' +
        'built of data that people typed, escaped, but it is a page of its own.',
    },
    text: { type: 'string', description: 'The plain text of the mail.' },
    warnings: { type: 'array', items: { $ref: 'newslettersCampaignWarningSchema#' } },
    takenAt: { ...dateTime, description: 'When the products of the blocks were taken.' },
  },
  required: ['subject', 'preheader', 'html', 'text', 'warnings', 'takenAt'],
} as const;

const newslettersCampaignTestSentResponseSchema = {
  $id: 'newslettersCampaignTestSentResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    sent: { type: 'boolean', const: true, description: 'The mail provider took the mail.' },
  },
  required: ['sent'],
} as const;

const translateLocale = (what: string) =>
  ({
    type: 'string',
    minLength: 1,
    maxLength: NEWSLETTER_LOCALE_PARAM_MAX,
    description:
      `${what} The code of a language the shop answers in (GET /api/shop-settings, ` +
      '`enabledLocales`), written as the keys of the texts of a campaign are: two small letters, ' +
      'no region (`es`, not `ES` or `es-ES`). Another one is `LOCALE_INVALID`.',
  }) as const;

const newslettersTranslateItemSchema = {
  $id: 'newslettersTranslateItemSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    key: {
      type: 'string',
      minLength: 1,
      maxLength: NEWSLETTER_TRANSLATE_KEY_MAX,
      pattern: '^[A-Za-z0-9._-]+$',
      description:
        'The name the draft comes back under, 1 to 40 letters, digits, dots, dashes or underscores. ' +
        'Chosen by the caller (`subject`, `block0`, `block2.title`); each is used once in a request.',
    },
    text: {
      type: 'string',
      minLength: 1,
      maxLength: NEWSLETTER_TEXT_MAX,
      pattern: '\\S',
      description: 'The text to translate, 1 to 5000 characters, not only spaces.',
    },
    kind: {
      type: 'string',
      enum: NEWSLETTER_TRANSLATE_KINDS,
      description:
        '`line`: one line (a subject, a line under it, a title); the draft is one line too. ' +
        '`markup`: a text of a block of text, with the simple markup of the campaigns; the markup ' +
        'and every address in it are kept, and no html is written.',
    },
    maxChars: {
      type: 'integer',
      minimum: 1,
      maximum: NEWSLETTER_TEXT_MAX,
      description:
        'The most characters the draft may have, when it must be shorter than the limit of its ' +
        'kind (150 for a `line`: pass 120 for a title; 5000 for a `markup`). A draft over it is ' +
        '`TOO_LONG`. A limit above that of the kind changes nothing.',
    },
  },
  required: ['key', 'text', 'kind'],
} as const;

const newslettersTranslateBodySchema = {
  $id: 'newslettersTranslateBodySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    from: translateLocale(
      'The language the texts are in; the language of the shop (`shopLocale`) unless given.',
    ),
    to: {
      type: 'array',
      minItems: 1,
      maxItems: NEWSLETTER_MAX_LANGUAGES,
      items: translateLocale(
        'A language to translate into: not the one the texts are in, and each once.',
      ),
      description:
        'The languages to translate into, at least one. A language that is the language of the ' +
        'texts, is asked twice or is not one of the shop is `LOCALE_INVALID`, naming it.',
    },
    items: {
      type: 'array',
      minItems: 1,
      maxItems: NEWSLETTER_TRANSLATE_MAX_ITEMS,
      items: { $ref: 'newslettersTranslateItemSchema#' },
      description:
        'The texts, 1 to 30, in all at most 20000 characters (`NEWSLETTER_TRANSLATE_TOO_MUCH_TEXT`).',
    },
  },
  required: ['to', 'items'],
} as const;

const newslettersTranslateWarningSchema = {
  $id: 'newslettersTranslateWarningSchema',
  type: 'object',
  additionalProperties: false,
  description:
    'A draft that is not in `translations`, and why. Every text asked has either its draft in a ' +
    'language or a warning for it, never both.',
  properties: {
    locale: { type: 'string', description: 'The language of the draft.' },
    key: { type: 'string', description: 'The `key` of the text.' },
    field: {
      type: 'string',
      description:
        'Only with `ADDRESS_NOT_ALLOWED`: the place of the text, the `key` and the language, ' +
        '`<key>.<locale>`, as `details.field` of `NEWSLETTER_ADDRESS_NOT_ALLOWED` names it when ' +
        'the draft is saved under that key.',
    },
    address: {
      type: 'string',
      description:
        'Only with `ADDRESS_NOT_ALLOWED`: the first address of the draft that is not allowed, as ' +
        'it is written (up to 200 characters), the same as `details.address` of ' +
        '`NEWSLETTER_ADDRESS_NOT_ALLOWED`.',
    },
    code: {
      type: 'string',
      enum: NEWSLETTER_TRANSLATE_WARNING_CODES,
      description:
        '`MISSING`: the model gave no usable text for it. `TRANSLATION_FAILED`: the request for ' +
        'this language failed (the other languages may have come); ask again for it. ' +
        '`LINK_CHANGED`: a link or an address of the text was changed, added or left out (an ' +
        'address is never translated). `ADDRESS_NOT_ALLOWED`: the draft names an address of a ' +
        'site that neither belongs to the shop nor is trusted by root, the rule the content of a ' +
        'campaign is saved under (`NEWSLETTER_ADDRESS_NOT_ALLOWED`); the warning also has `field` ' +
        'and `address`, which the other warnings do not. `HTML_NOT_ALLOWED`: the ' +
        'draft had html in it. `TOO_LONG`: ' +
        'over 150 characters for a `line`, over 5000 for a `markup`, or over `maxChars`. ' +
        '`NOT_A_LINE`: the draft of a `line` had a line break or a control sign.',
    },
  },
  required: ['locale', 'key', 'code'],
} as const;

const newslettersTranslateResponseSchema = {
  $id: 'newslettersTranslateResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    translations: {
      type: 'object',
      additionalProperties: { type: 'object', additionalProperties: { type: 'string' } },
      description:
        'The drafts: for each language asked (it is there even when empty) the texts by their `key`. ' +
        'A draft is written to be edited by a person and saved in the campaign by them: nothing is ' +
        'saved here.',
    },
    warnings: {
      type: 'array',
      items: { $ref: 'newslettersTranslateWarningSchema#' },
      description: 'The drafts that were left out, by language and then by the order of the texts.',
    },
  },
  required: ['translations', 'warnings'],
} as const;

const newslettersCampaignParamsSchema = {
  $id: 'newslettersCampaignParamsSchema',
  type: 'object',
  additionalProperties: false,
  properties: { campaignId: idPathParam('the campaign') },
  required: ['campaignId'],
} as const;

const newslettersCampaignsQuerySchema = {
  $id: 'newslettersCampaignsQuerySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: 100,
      description: `Rows on a page, ${NEWSLETTER_CAMPAIGNS_DEFAULT_LIMIT} unless given.`,
    },
    cursor: {
      type: 'string',
      minLength: 1,
      pattern: '^[A-Za-z0-9_-]+$',
      description: 'nextCursor of the page before.',
    },
    status: {
      type: 'string',
      pattern: namesPattern(NEWSLETTER_CAMPAIGN_STATUSES),
      description:
        'The state of the campaign, one or several through commas (no spaces): ' +
        `${NEWSLETTER_CAMPAIGN_STATUSES.join(', ')}. Every state unless given.`,
    },
    startedFrom: {
      type: 'string',
      format: 'date-time',
      description:
        'Only the campaigns that started at this time or later, taken in (a campaign that has ' +
        'not started is left out).',
    },
    startedTo: {
      type: 'string',
      format: 'date-time',
      description:
        'Only the campaigns that started before this time, left out (a campaign that has not ' +
        'started is left out).',
    },
    scheduledTo: {
      type: 'string',
      format: 'date-time',
      description:
        'Only the campaigns scheduled for a time before this one, left out; a campaign whose ' +
        'time has passed is there too. A campaign with no time (a draft) is left out.',
    },
    cancelledFrom: {
      type: 'string',
      format: 'date-time',
      description:
        'Only the campaigns called off at this time or later, taken in (a campaign that was not ' +
        'called off is left out).',
    },
    cancelReason: {
      type: 'string',
      enum: [...NEWSLETTER_CANCEL_REASONS],
      description:
        'Only the campaigns the system called off for this reason: `limit`, the limit of the ' +
        'campaigns of the shop left no room for the campaign when its time came.',
    },
    undeliveredOver: {
      type: 'integer',
      minimum: 1,
      maximum: 100,
      description:
        'Only the campaigns whose mails that did not arrive are more than this per cent of the ' +
        'mails the mail provider took, when at least 20 were taken.',
    },
    rejectedOver: {
      type: 'integer',
      minimum: 1,
      maximum: 100,
      description:
        'Only the campaigns whose mails the mail provider did not take are more than this per ' +
        'cent of the mails it answered for (taken or not), when at least 20 were answered for.',
    },
    complaintsOver: {
      type: 'integer',
      minimum: 1,
      maximum: 1000,
      description:
        'Only the campaigns whose mails marked as spam are more than this many in a thousand ' +
        '(per mille, not per cent: 3 is 0.3%) of the mails the mail provider took, when at ' +
        'least 20 were taken. A complaint is rare, so a whole per cent would be too coarse.',
    },
  },
} as const;

// ---- the answers ----

const newslettersCampaignCountersSchema = {
  $id: 'newslettersCampaignCountersSchema',
  type: 'object',
  additionalProperties: false,
  description:
    'The totals of a campaign. They are 0 until it starts, and they grow after it goes out ' +
    '(bounces, complaints and unsubscribes arrive later).',
  properties: {
    planned: { type: 'integer', description: 'How many mails were to go out.' },
    sent: { type: 'integer', description: 'How many the mail provider accepted.' },
    rejected: { type: 'integer', description: 'How many the mail provider did not accept.' },
    undelivered: { type: 'integer', description: 'How many did not reach the address.' },
    complaints: { type: 'integer', description: 'How many people marked the mail as spam.' },
    unsubscribed: {
      type: 'integer',
      description: 'How many people unsubscribed with the link of this campaign.',
    },
  },
  required: ['planned', 'sent', 'rejected', 'undelivered', 'complaints', 'unsubscribed'],
} as const;

const campaignListProperties = {
  id: { type: 'integer' },
  name: { type: 'string', description: 'The name the people who run the newsletters see.' },
  status: {
    type: 'string',
    enum: NEWSLETTER_CAMPAIGN_STATUSES,
    description:
      '`draft`: being written; `scheduled`: waits for its time; `sending`: goes out; `finished`: ' +
      'went out; `cancelled`: a scheduled one that was called off; `stopped`: one that was stopped ' +
      'while it went out. The text can be changed only in a draft and a scheduled campaign.',
  },
  scheduledAt: {
    ...nullableDateTime,
    description: 'When it goes out; null for a draft.',
  },
  cancelReason: {
    type: ['string', 'null'],
    enum: [...NEWSLETTER_CANCEL_REASONS, null],
    description:
      'Why a cancelled campaign was called off, when it was not a manager: `limit`: its time came ' +
      'and the limit of the campaigns of the shop (at most so many in so many days) left no room ' +
      'for it, so it did not go out. Copy it (POST .../copy) and schedule the copy for a time ' +
      'that fits. null for a campaign a manager called off and for every other state.',
  },
  missingLocale: missingLocaleField,
  counters: { $ref: 'newslettersCampaignCountersSchema#' },
  disabledLocales: {
    type: 'array',
    items: { type: 'string', pattern: '^[a-z]{2}$' },
    description:
      'The languages the campaign has a subject in that the shop does not answer in now, in the ' +
      'order of the codes: root turned them off after the text was written. Mark them "language ' +
      'turned off" in the form. The text of such a language stays in the campaign and does not go ' +
      'out (nobody has the language any more: the people who had it are mailed in the language of ' +
      'the shop); it goes again to the people who choose the language once it is turned on. It ' +
      'can be kept and edited, but a new text in a language that is off is `LOCALE_INVALID`. A ' +
      'campaign that is already going out sends in the languages the people had at its start. ' +
      'Empty when the shop answers in every language of the campaign.',
  },
  createdById: { type: 'integer', description: 'The account that made the campaign.' },
  createdAt: dateTime,
  updatedAt: dateTime,
} as const;

const newslettersCampaignItemSchema = {
  $id: 'newslettersCampaignItemSchema',
  type: 'object',
  additionalProperties: false,
  description: 'A campaign in the list: no content (GET the campaign for it).',
  properties: campaignListProperties,
  required: [
    'id',
    'name',
    'status',
    'scheduledAt',
    'cancelReason',
    'missingLocale',
    'counters',
    'disabledLocales',
    'createdById',
    'createdAt',
    'updatedAt',
  ],
} as const;

const newslettersCampaignSchema = {
  $id: 'newslettersCampaignSchema',
  type: 'object',
  additionalProperties: false,
  description: 'A campaign with its content.',
  properties: {
    ...campaignListProperties,
    content: { $ref: 'newslettersCampaignContentSchema#' },
    updatedById: { type: 'integer', description: 'The account that changed it last.' },
    copiedFromId: {
      type: ['integer', 'null'],
      description:
        'The campaign this one is a copy of; null for the others, and when that draft ' +
        'was deleted.',
    },
    startedAt: { ...nullableDateTime, description: 'When it started going out.' },
    finishedAt: { ...nullableDateTime, description: 'When it finished.' },
    stoppedAt: { ...nullableDateTime, description: 'When it was stopped.' },
    cancelledAt: { ...nullableDateTime, description: 'When it was called off.' },
  },
  required: [
    ...newslettersCampaignItemSchema.required,
    'content',
    'updatedById',
    'copiedFromId',
    'startedAt',
    'finishedAt',
    'stoppedAt',
    'cancelledAt',
  ],
} as const;

const newslettersCampaignsResponseSchema = {
  $id: 'newslettersCampaignsResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    items: { type: 'array', items: { $ref: 'newslettersCampaignItemSchema#' } },
    limit: { type: 'integer' },
    nextCursor: {
      anyOf: [{ type: 'string', minLength: 1, pattern: '^[A-Za-z0-9_-]+$' }, { type: 'null' }],
      description: 'The cursor of the next page, null on the last one.',
    },
    total: {
      type: 'integer',
      description: 'How many campaigns the filters find, on all pages.',
    },
  },
  required: ['items', 'limit', 'nextCursor', 'total'],
} as const;

const newslettersCampaignDeletedResponseSchema = {
  $id: 'newslettersCampaignDeletedResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    deleted: { type: 'boolean', const: true, description: 'The draft is deleted.' },
  },
  required: ['deleted'],
} as const;

export const newslettersCampaignDtoSchemas = [
  newslettersCampaignTextBlockSchema,
  newslettersCampaignProductsManualBlockSchema,
  newslettersCampaignProductsRuleBlockSchema,
  newslettersCampaignProductsBestsellersBlockSchema,
  newslettersCampaignCategoryBlockSchema,
  newslettersCampaignButtonBlockSchema,
  newslettersCampaignBlockSchema,
  newslettersCampaignContentSchema,
  newslettersCampaignCreateBodySchema,
  newslettersCampaignUpdateBodySchema,
  newslettersCampaignScheduleAtBodySchema,
  newslettersCampaignScheduleNowBodySchema,
  newslettersCampaignScheduleBodySchema,
  newslettersCampaignPreviewBodySchema,
  newslettersCampaignTestBodySchema,
  newslettersCampaignWarningSchema,
  newslettersCampaignPreviewResponseSchema,
  newslettersCampaignTestSentResponseSchema,
  newslettersTranslateItemSchema,
  newslettersTranslateBodySchema,
  newslettersTranslateWarningSchema,
  newslettersTranslateResponseSchema,
  newslettersCampaignParamsSchema,
  newslettersCampaignsQuerySchema,
  newslettersCampaignCountersSchema,
  newslettersCampaignItemSchema,
  newslettersCampaignSchema,
  newslettersCampaignsResponseSchema,
  newslettersCampaignDeletedResponseSchema,
];
