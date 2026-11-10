import { avatarIsDefaultField, avatarUrlsField } from '@schemas/avatarFields.js';
import { MAX_PRODUCT_VARIANTS, MAX_UPLOAD_SIZE_BYTES } from '@config/limits.js';
import { PARTY_LIMITS, WARNINGS_MAX } from '@helpers/party.js';
import { WITHDRAWAL_RULES } from '@helpers/withdrawal.js';
import { MAX_ID, idPathParam } from '@schemas/idPathParam.js';

// money of a request: whole cents up to what numeric(10, 2) holds (the price of a variant)
export const moneyField = {
  type: 'number',
  minimum: 0,
  maximum: 99_999_999.99,
  multipleOf: 0.01,
  description: 'Whole cents, from 0 up to 99 999 999.99.',
} as const;

const MAX_IMAGE_MB = MAX_UPLOAD_SIZE_BYTES / 1_000_000;

// the image files of a product form, in their order: the gallery of the product, a variant names a
// file by its number (from 0)
const productImagesFormField = {
  type: 'array',
  items: { type: 'string', format: 'binary' },
  description:
    'The gallery of the product: jpeg, png or webp files by their content, each up to ' +
    `${MAX_IMAGE_MB} MB, in their order; the number of a file (from 0) is how a variant names it. ` +
    'Every file is shown by some variant (GALLERY_IMAGE_UNUSED).',
} as const;

const getAllProductsQuerySchema = {
  $id: 'getAllProductsQuerySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    // cursor pagination
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: 100,
      description: 'The most rows a page holds, from 1 to 100.',
    },
    cursor: {
      type: 'string',
      minLength: 1,
      pattern: '^[A-Za-z0-9_-]+$',
      description:
        'nextCursor of the previous page, with the same sort and order and rows of the same kind ' +
        '(products or variants, see GET /api/products). A changed cursor, or one from another ' +
        'sort, order or kind of rows, is CURSOR_INVALID.',
    },

    // filters
    search: {
      type: 'string',
      minLength: 1,
      description:
        'Finds a product by its name, forgiving a typo and another order of the words, by the ' +
        'name of its category or by the article number (sku) of one of its variants, whatever the ' +
        'case of its letters; admin and root by a barcode too. A product row then shows the ' +
        'variant that has the code, a variant row is that variant. Without a sort the best match ' +
        'comes first (sort relevance).',
    },
    categoryIds: {
      type: 'string',
      pattern: '^[0-9]+(,[0-9]+)*$',
      description:
        'Category ids separated by commas, for example 1,2: the products of each category and ' +
        'of its whole branch (see branch). Ids that are not positive are dropped; a list with no ' +
        'valid id is CATEGORY_IDS_INVALID.',
    },
    branch: {
      type: 'boolean',
      description:
        'With categoryIds: true (the default) takes the products of the categories below each ' +
        'category too, false only the products of each category itself.',
    },
    minPrice: {
      type: 'number',
      minimum: 0,
      description:
        'The price of a variant; the rows are variants then, each variant that fits. A buyer: ' +
        'the price a variant sells at now, the sale price while its sale lasts. An admin: the ' +
        'usual price, the one the field price shows.',
    },
    maxPrice: {
      type: 'number',
      minimum: 0,
      description:
        'The price of a variant; the rows are variants then, each variant that fits. A buyer: ' +
        'the price a variant sells at now, the sale price while its sale lasts. An admin: the ' +
        'usual price, the one the field price shows.',
    },

    deleted: {
      type: 'boolean',
      description:
        'Admin and root only (DELETED_PRODUCTS_FORBIDDEN for a buyer): true lists only deleted ' +
        'products. Without it, or with false, every role gets products that are not deleted.',
    },
    onSale: {
      type: 'boolean',
      description:
        'Admin and root only (FILTER_FORBIDDEN for a buyer): true lists only the variants with ' +
        'a sale that is on (the rows are variants), whatever else they have. Without any flag an ' +
        'admin gets only the plain products (not deleted, without a sale on any variant and an ' +
        'override that are on); with another flag the sale does not filter. A buyer always gets ' +
        'every variant of the catalog.',
    },
    popularityOverridden: {
      type: 'boolean',
      description:
        'Admin and root only (FILTER_FORBIDDEN for a buyer): true lists only the products with ' +
        'a popularity override that is on, whatever else they have: an override with its end ' +
        'ahead (one without an end or past it overrides nothing). Without any flag an admin gets ' +
        'only the plain products; with another flag the override does not filter.',
    },
    withoutShippingData: {
      type: 'boolean',
      description:
        'Admin and root only (FILTER_FORBIDDEN for a buyer), a flag: true lists every variant ' +
        'of the catalog that lacks the weight or the sizes, whatever else it has (a sale, an ' +
        'override); the variants whose data the shipping waits for. The rows are variants.',
    },
    missingRequired: {
      type: 'boolean',
      description:
        'Admin and root only (FILTER_FORBIDDEN for a buyer when true), a flag: true lists every ' +
        'live variant that has no value of a characteristic the set of its category marks ' +
        'required (the set of a category is its own and its parents, the nearest category ' +
        'winning for a characteristic: GET /api/categories/{categoryId}/attributes), whatever ' +
        'else it has. A variant taken out of sale, and every variant of a removed product, is ' +
        'none of them. The rows are variants (groups unless group=false). The alert ' +
        '`variants_missing_required` counts the same variants.',
    },
    withoutWeight: {
      type: 'boolean',
      description:
        'Admin and root only (FILTER_FORBIDDEN for a buyer when true), a flag: true lists every ' +
        'live variant with no weight. The rows are variants. withoutShippingData lists the ones ' +
        'that lack the weight or the sizes.',
    },
    withoutDimensions: {
      type: 'boolean',
      description:
        'Admin and root only (FILTER_FORBIDDEN for a buyer when true), a flag: true lists every ' +
        'live variant that lacks the length, the width or the height (the sizes are known all ' +
        'three or none). The rows are variants.',
    },
    withoutBarcode: {
      type: 'boolean',
      description:
        'Admin and root only (FILTER_FORBIDDEN for a buyer when true), a flag: true lists every ' +
        'live variant with no barcode. The rows are variants.',
    },
    withoutImages: {
      type: 'boolean',
      description:
        'Admin and root only (FILTER_FORBIDDEN for a buyer when true), a flag: true lists every ' +
        'live variant with no picture bound, the ones a buyer does not see. The rows are variants.',
    },
    hiddenFromBuyers: {
      type: 'boolean',
      description:
        'Admin and root only (FILTER_FORBIDDEN for a buyer when true; false is what a buyer ' +
        'sees anyway), a flag: true lists the products a buyer does not see, false the products ' +
        'he sees. A product is hidden from buyers when it is removed from the catalog or none of ' +
        'its variants is one a buyer sees (a variant is seen when it is alive and has a ' +
        'picture). Like every list, the removed products come only with deleted=true (all of ' +
        'them are hidden, so false lists none there); without it the list holds the products of ' +
        'the catalog. A row is a product, with its first variant (a product none of whose ' +
        'variants is alive keeps its first one), unless the query asks something of a variant ' +
        '(group=false lists the live variants of the products). The alert ' +
        '`products_hidden_from_buyers` counts the products of the catalog that are hidden.',
    },
    hasDeletedVariants: {
      type: 'boolean',
      description:
        'Admin and root only (FILTER_FORBIDDEN for a buyer when true), a flag: true lists the ' +
        'products that have at least one variant taken out of sale (the variants of a removed ' +
        'product are taken out of sale with it, so deleted=true lists the removed products). ' +
        'The rows stay products.',
    },
    manufacturerId: {
      type: 'integer',
      minimum: 1,
      maximum: MAX_ID,
      description:
        'Admin and root only (FILTER_FORBIDDEN for a buyer), a flag: the products of this ' +
        'manufacturer of the directory (GET /api/admin/parties). A party that is not there is ' +
        'MANUFACTURER_NOT_FOUND.',
    },
    euResponsibleId: {
      type: 'integer',
      minimum: 1,
      maximum: MAX_ID,
      description:
        'Admin and root only (FILTER_FORBIDDEN for a buyer), a flag: the products that name ' +
        'this party of the directory as the person responsible in the EU. A party that is not ' +
        'there is EU_RESPONSIBLE_NOT_FOUND.',
    },
    documentId: {
      type: 'integer',
      minimum: 1,
      maximum: MAX_ID,
      description:
        'Admin and root only (FILTER_FORBIDDEN for a buyer), a flag: the products that hold ' +
        'this document of the directory (GET /api/admin/documents). A document that is not ' +
        'there is DOCUMENT_NOT_FOUND.',
    },
    inStock: {
      type: 'boolean',
      description:
        'Free units, the stock the list shows: true lists products with some free (a product ' +
        'row: some variant of it has them), false products with none. With a filter or a sort ' +
        'of a variant the rows are variants, and the filter keeps the variants with some free ' +
        'units or with none. Units reserved by confirmed orders and units of batches that are ' +
        'over are not free.',
    },
    maxStock: {
      type: 'integer',
      minimum: 0,
      description:
        'Admin and root only (FILTER_FORBIDDEN for a buyer), a flag: lists every variant of the ' +
        'catalog with no more free units than the number, whatever else it has (a sale, an ' +
        'override); 0 the variants with none. With inStock=true the ones with some. The rows ' +
        'are variants.',
    },

    f: {
      anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
      description:
        'The filter by characteristics (the panel GET /api/products/filters tells which): one entry ' +
        'for a characteristic, `<attributeId>:<value>`, the parameter may repeat: `f=12:45,46&f=15:128..512&f=20:yes`. ' +
        'A choice from a list (a colour too) is the ids of the values separated by commas, any of ' +
        'them fits (`12:45,46`); a number is a range with both ends included (`15:128..512`, `128..` ' +
        'from, `..512` up to, decimals `6.1..6.7`); yes/no is `yes` or `no`. Values of one ' +
        'characteristic are OR, different characteristics are AND; a variant without a value of the ' +
        'characteristic fits none of its values. A filter makes the rows variants (groups, see the ' +
        'route). A text cannot be filtered. Nothing in the entry is encoded in the url. A wrong ' +
        'entry is FILTER_INVALID, `details.reason` says why.',
    },
    group: {
      type: 'boolean',
      description:
        'Admin and root only (FILTER_FORBIDDEN for a buyer when false): false lists every variant on a ' +
        'row of its own (the rows are variants, `stock` is the free units of the variant); true, ' +
        'the default, gives the rows a buyer gets: products, or groups of variants with the same ' +
        'main characteristics when the query asks something of a variant.',
    },

    // the period of the sort by sales
    salesFrom: {
      type: 'string',
      format: 'date-time',
      description:
        'The start of the period the sort by sales counts (taken in): the orders paid from it on. ' +
        'Without it the 30 days before salesTo. Used only with sort=sales.',
    },
    salesTo: {
      type: 'string',
      format: 'date-time',
      description:
        'The end of the period the sort by sales counts (left out). Without it the end of today ' +
        '(UTC). A period that does not end after it starts is SALES_PERIOD_INVALID. Used only ' +
        'with sort=sales; pass both to page through a fixed period.',
    },

    // sorting
    sort: {
      type: 'string',
      enum: [
        'relevance',
        'createdAt',
        'updatedAt',
        'deletedAt',
        'price',
        'popularity',
        'views',
        'avgRating',
        'reviewsCount',
        'stock',
        'totalStock',
        'reservedStock',
        'expiredStock',
        'popularityOverride',
        'popularityOverrideUntil',
        'saleEndsAt',
        'salePrice',
        'discount',
        'sales',
        'name',
      ],
      description:
        'relevance (the default with a search, the best match first; without a search ' +
        'SORT_RELEVANCE_REQUIRES_SEARCH) for every role. ' +
        'A sort by price, salePrice, discount, saleEndsAt, stock, totalStock, reservedStock or ' +
        'expiredStock is a sort of a variant: the rows are variants then. Every other sort ' +
        'orders products, and sales orders the variants of a product by the sales of the product. ' +
        'A buyer sorts by createdAt, price (the price a variant sells at now), popularity ' +
        '(the default without a search), avgRating, name, saleEndsAt and discount: the variants on ' +
        'sale first by the end of their sale (saleEndsAt) or by the part of the price the sale ' +
        'takes off (discount, the biggest discount first with order desc) in the order asked for, ' +
        'then every other one by the popularity of its product, the most popular first; and ' +
        'sales: the units sold in the period (salesFrom, salesTo), ' +
        'the best selling first with order desc; any other sort is SORT_FORBIDDEN. An admin sorts ' +
        'by any field; price is the usual price, salePrice the sale price, stock the free units, ' +
        'totalStock the whole stock, expiredStock the units of batches that are over (all of a ' +
        'variant). A field only some products have comes with its flag: deletedAt with deleted, ' +
        'saleEndsAt and salePrice and discount with onSale, popularityOverride and ' +
        'popularityOverrideUntil with popularityOverridden, otherwise ' +
        'SORT_DELETED_AT_REQUIRES_DELETED, SORT_SALE_ENDS_AT_REQUIRES_ON_SALE, ' +
        'SORT_SALE_PRICE_REQUIRES_ON_SALE, SORT_DISCOUNT_REQUIRES_ON_SALE, ' +
        'SORT_POPULARITY_OVERRIDE_REQUIRES_OVERRIDDEN.',
    },
    order: {
      type: 'string',
      enum: ['asc', 'desc'],
      description: 'The direction of sort: desc (the default) or asc.',
    },
  },
} as const;

// the suggestions of the search: a text from 2 signs
const productSuggestionsQuerySchema = {
  $id: 'productSuggestionsQuerySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    q: { type: 'string', minLength: 2, maxLength: 100, description: 'What a person types.' },
  },
  required: ['q'],
} as const;

const productSuggestionsResponseSchema = {
  $id: 'productSuggestionsResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    items: {
      type: 'array',
      maxItems: 8,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { id: { type: 'integer' }, name: { type: 'string' } },
        required: ['id', 'name'],
      },
    },
  },
  required: ['items'],
} as const;

// the panel of the filter of a category: GET /api/products/filters
const catalogFiltersQuerySchema = {
  $id: 'catalogFiltersQuerySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    categoryId: {
      type: 'integer',
      minimum: 1,
      maximum: MAX_ID,
      description: `The category: a whole number from 1 to ${MAX_ID}.`,
    },
    branch: {
      type: 'boolean',
      description:
        'true (the default): the products of the category and of everything below it; false: ' +
        'only the products of the category itself.',
    },
  },
  required: ['categoryId'],
} as const;

const catalogFilterBase = {
  id: { type: 'integer', description: 'The characteristic: the number before the colon of f.' },
  name: { type: 'string' },
  unit: { type: ['string', 'null'], description: 'A label of the values ("GB"); null for none.' },
  group: {
    type: 'object',
    additionalProperties: false,
    properties: { id: { type: 'integer' }, name: { type: 'string' } },
    required: ['id', 'name'],
    description: 'The section of the card the characteristic belongs to.',
  },
} as const;

const catalogChoiceFilterSchema = {
  $id: 'catalogChoiceFilterSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    ...catalogFilterBase,
    type: { type: 'string', enum: ['option', 'options'] },
    values: {
      type: 'array',
      description:
        'The values of the list that the variants of the category have, in the order the admin ' +
        'put them (a size S, M, L, not the abc). Their ids go into f: f=<id>:<value id>,<value id>.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'integer' },
          name: { type: 'string' },
          colorCode: {
            type: ['string', 'null'],
            description: 'The colour of the swatch, #RRGGBB; null for none.',
          },
          position: { type: 'integer', minimum: 1 },
        },
        required: ['id', 'name', 'colorCode', 'position'],
      },
    },
  },
  required: ['id', 'name', 'unit', 'group', 'type', 'values'],
} as const;

const catalogNumberFilterSchema = {
  $id: 'catalogNumberFilterSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    ...catalogFilterBase,
    type: { type: 'string', enum: ['number'] },
    min: { type: 'number', description: 'The lowest value the variants of the category have.' },
    max: { type: 'number', description: 'The highest value the variants of the category have.' },
  },
  required: ['id', 'name', 'unit', 'group', 'type', 'min', 'max'],
} as const;

const catalogBooleanFilterSchema = {
  $id: 'catalogBooleanFilterSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    ...catalogFilterBase,
    type: { type: 'string', enum: ['boolean'] },
    values: {
      type: 'array',
      description:
        'The answers the variants of the category have; a characteristic is in the panel when ' +
        'both are there, so it is always yes and no. They go into f: f=<id>:yes.',
      items: { type: 'string', enum: ['yes', 'no'] },
    },
  },
  required: ['id', 'name', 'unit', 'group', 'type', 'values'],
} as const;

const catalogFiltersResponseSchema = {
  $id: 'catalogFiltersResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    items: {
      type: 'array',
      description:
        'The characteristics that tell the variants of the category apart, in the order of the ' +
        'card: the groups by their place, in a group the characteristics by theirs.',
      items: {
        anyOf: [
          { $ref: 'catalogChoiceFilterSchema#' },
          { $ref: 'catalogNumberFilterSchema#' },
          { $ref: 'catalogBooleanFilterSchema#' },
        ],
      },
    },
  },
  required: ['items'],
} as const;

const ADMIN_ONLY = 'Admin and root only.';

// the fields of a product every role gets, and the ones only admin and root get. The price, the
// sale, the stock, the weight and the article number are the variant's (variants.dtoSchemas.ts)
const productFields = {
  id: { type: 'integer' },

  name: { type: 'string' },
  description: { type: 'string' },
  category: {
    type: 'object',
    additionalProperties: false,
    properties: {
      id: { type: 'integer' },
      name: { type: 'string' },
      slug: { type: 'string' },
    },
    required: ['id', 'name', 'slug'],
  },

  avgRating: { type: 'number' },
  reviewsCount: { type: 'integer' },

  createdAt: { type: 'string', format: 'date-time' },

  views: { type: 'integer', description: ADMIN_ONLY },
  updatedAt: { type: 'string', format: 'date-time', description: ADMIN_ONLY },
  popularityOverride: {
    anyOf: [{ type: 'integer' }, { type: 'null' }],
    description: `${ADMIN_ONLY} The popularity the admin set, null when there is none; it overrides while its end is ahead.`,
  },
  popularityOverrideUntil: {
    anyOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }],
    description: `${ADMIN_ONLY} The end of the override, null when it has none.`,
  },
  deletedAt: {
    anyOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }],
    description: `${ADMIN_ONLY} The delete date, null for a product that is not deleted.`,
  },
} as const;

const productRequired = [
  'id',
  'name',
  'category',
  'avgRating',
  'reviewsCount',
  'createdAt',
] as const;

// the manufacturer and the person responsible in the EU a product names (the EU GPSR), as the
// directory of parties keeps them (src/routes/api/parties); the warnings are a text of the product
const productPartyResponseSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'integer', description: 'The party in the directory.' },
    name: { type: 'string' },
    address: { type: 'string', description: 'The postal address.' },
    email: { type: 'string', description: 'The electronic address.' },
    country: { type: 'string', description: 'The ISO 3166 code of two letters, DE for example.' },
  },
  required: ['id', 'name', 'address', 'email', 'country'],
} as const;

// a document a buyer opens from the card
const productDocumentResponseSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'integer', description: 'The document in the directory of documents.' },
    title: { type: 'string' },
    kind: { type: 'string', enum: ['instruction', 'certificate', 'declaration', 'other'] },
    url: { type: 'string', description: 'Where the PDF opens.' },
  },
  required: ['id', 'title', 'kind', 'url'],
} as const;

const documentsResponseField = {
  type: 'array',
  description:
    'The instructions and certificates of the product, PDF files, in the order an admin gave them.',
  items: productDocumentResponseSchema,
} as const;

// the ids of the documents of a request: the directory of documents (GET /api/admin/documents)
const documentIdsBodyField = {
  type: ['array', 'null'],
  items: { type: 'integer', minimum: 1, maximum: MAX_ID },
  description:
    'The documents of the product by their ids, in their order; the list is written whole, null or ' +
    '[] takes every document away. An unknown id is 404 DOCUMENTS_NOT_FOUND, an id twice 400 ' +
    'DOCUMENT_IDS_REPEATED, more than the limit 400 PRODUCT_DOCUMENTS_TOO_MANY.',
} as const;

const documentIdsFormField = {
  type: 'string',
  description:
    'The documents of the product by their ids with a comma between, in their order (1,2,3); on a ' +
    'change an empty text takes every document away (DOCUMENT_ID_INVALID for a word that is no id).',
} as const;

const SAFETY_DESCRIPTION =
  'The safety and origin data an offer shows (the EU GPSR): the manufacturer, a person ' +
  'responsible in the EU when the manufacturer is outside it, the warnings.';

const manufacturerResponseField = {
  ...productPartyResponseSchema,
  description: 'The manufacturer of the product. ' + SAFETY_DESCRIPTION,
} as const;

const euResponsibleResponseField = {
  description:
    'The person responsible in the EU, null for a manufacturer in the EU that names none.',
  anyOf: [productPartyResponseSchema, { type: 'null' }],
} as const;

const warningsResponseField = {
  type: ['string', 'null'],
  description: 'The warnings of the product, null when it has none.',
} as const;

// what the law lets a buyer do with the goods when they withdraw from the purchase
const withdrawalResponseField = {
  type: 'object',
  additionalProperties: false,
  description:
    'The rule of withdrawal of the product, the one the cart and the order keep: the rule, which ' +
    'the page words (allowed; sealed_hygiene, sealed_media and mixed only while the seal is ' +
    'unbroken; perishable, personalised and periodical not at all), and the kind it makes.',
  properties: {
    rule: { type: 'string', enum: [...WITHDRAWAL_RULES] },
    right: {
      type: 'string',
      enum: ['full', 'conditional', 'none'],
      description:
        'full: taken back freely; conditional: only while the seal is unbroken, the page warns ' +
        'the buyer; none: not taken back at all.',
    },
    own: {
      type: ['string', 'null'],
      enum: [...WITHDRAWAL_RULES, null],
      description: `${ADMIN_ONLY} The rule the product has of its own, null when it follows its category.`,
    },
    source: {
      type: 'string',
      enum: ['product', 'category', 'default'],
      description: `${ADMIN_ONLY} Where the rule comes from: the product, the nearest category above it that has one, or the default (allowed).`,
    },
    categoryId: {
      type: ['integer', 'null'],
      description: `${ADMIN_ONLY} The category the rule comes from, only when the source is a category.`,
    },
  },
  required: ['rule', 'right'],
} as const;

// the body of a change: a party of the directory by its id; a type list, not anyOf, because
// removeAdditional would strip the fields while ajv tries a shape
const manufacturerIdBodyField = {
  type: 'integer',
  minimum: 1,
  maximum: MAX_ID,
  description:
    'A new manufacturer of the product, by its id in the directory (GET /api/admin/parties); ' +
    'unknown is 404 MANUFACTURER_NOT_FOUND.',
} as const;

const euResponsibleIdBodyField = {
  type: ['integer', 'null'],
  minimum: 1,
  maximum: MAX_ID,
  description:
    'The person responsible in the EU, by its id in the directory; null takes it away. A person ' +
    'must be in the EU (EU_RESPONSIBLE_NOT_IN_EU), and a manufacturer outside the EU needs one ' +
    '(PRODUCT_EU_RESPONSIBLE_REQUIRED).',
} as const;

const warningsBodyField = {
  type: ['string', 'null'],
  description: `The warnings, up to ${WARNINGS_MAX} signs; empty or null takes them away.`,
} as const;

// a plain text, not an enum: a rule there is not is WITHDRAWAL_RULE_INVALID for the form and the
// body alike
const withdrawalBodyField = {
  type: ['string', 'null'],
  description:
    `The rule of withdrawal of the product of its own: ${WITHDRAWAL_RULES.join(', ')} ` +
    '(WITHDRAWAL_RULE_INVALID for any other). Empty or null gives it up, and the product follows ' +
    'its category, the nearest one above it that has a rule, and is allowed by default.',
} as const;

// the same by the text fields of a form: a party of the directory by its id
const partyIdFormFields = {
  manufacturerId: {
    type: 'string',
    description: 'The manufacturer by its id in the directory (GET /api/admin/parties).',
  },
  euResponsibleId: {
    type: 'string',
    description:
      'The person responsible in the EU by its id in the directory; empty takes it away on a ' +
      'change. A manufacturer outside the EU needs one (PRODUCT_EU_RESPONSIBLE_REQUIRED).',
  },
  warnings: {
    type: 'string',
    description: `The warnings, up to ${WARNINGS_MAX} signs (PRODUCT_WARNINGS_TOO_LONG); empty takes them away on a change.`,
  },
  withdrawal: {
    type: 'string',
    description:
      `The rule of withdrawal of the product of its own: ${WITHDRAWAL_RULES.join(', ')} ` +
      '(WITHDRAWAL_RULE_INVALID for any other); empty means none, the product follows its category.',
  },
} as const;

// a new product may name a party that is not in the directory yet: its four values, which the
// service adds to the directory; the id or the values of a party, never both
// (PARTY_CHOICE_AMBIGUOUS), and a manufacturer is required (MANUFACTURER_REQUIRED). A missing or
// empty value is PARTY_FIELDS_REQUIRED, a wrong one PARTY_FIELDS_INVALID, both with details.fields
const newPartyFormFields = {
  'manufacturer.name': {
    type: 'string',
    maxLength: PARTY_LIMITS.name,
    description: 'A manufacturer that is not in the directory yet: its name.',
  },
  'manufacturer.address': {
    type: 'string',
    maxLength: PARTY_LIMITS.address,
    description: 'The postal address of the new manufacturer.',
  },
  'manufacturer.email': {
    type: 'string',
    maxLength: PARTY_LIMITS.email,
    description: 'The electronic address of the new manufacturer.',
  },
  'manufacturer.country': {
    type: 'string',
    description: 'The ISO 3166 code of two letters, DE for example.',
  },
  'euResponsible.name': {
    type: 'string',
    maxLength: PARTY_LIMITS.name,
    description: 'A person responsible in the EU that is not in the directory yet: its name.',
  },
  'euResponsible.address': { type: 'string', maxLength: PARTY_LIMITS.address },
  'euResponsible.email': { type: 'string', maxLength: PARTY_LIMITS.email },
  'euResponsible.country': {
    type: 'string',
    description: 'The ISO 3166 code of two letters, of a country of the EU.',
  },
} as const;

// the product of the card: the way to its category, the safety and origin data, the documents;
// a buyer gets no popularity in it. An admin gets the gallery with the variants that show each
// picture
const productResponseSchema = {
  $id: 'productResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    ...productFields,
    manufacturer: manufacturerResponseField,
    euResponsible: euResponsibleResponseField,
    warnings: warningsResponseField,
    documents: documentsResponseField,
    withdrawal: withdrawalResponseField,
    category: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ...productFields.category.properties,
        path: {
          type: 'array',
          description:
            'The way from the top of the tree to the category: its parent categories, the top ' +
            'one first, without the category itself; empty for a category at the top.',
          items: productFields.category,
        },
      },
      required: ['id', 'name', 'slug', 'path'],
    },
    popularity: { type: 'integer', description: ADMIN_ONLY },
    gallery: {
      type: 'array',
      description: `${ADMIN_ONLY} Every picture of the gallery of the product, by its place, with the variants that show it (the ones taken out of sale too).`,
      items: { $ref: 'galleryImageSchema#' },
    },
  },
  required: [
    ...productRequired,
    'manufacturer',
    'euResponsible',
    'warnings',
    'documents',
    'withdrawal',
  ],
} as const;

// the card: the product, the variant it opens and the variants to switch between
const productCardResponseSchema = {
  $id: 'productCardResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    product: { $ref: 'productResponseSchema#' },
    variant: { $ref: 'variantFullSchema#' },
    variants: {
      type: 'array',
      description:
        'The short form of the variants to switch between, by their place: the ones for sale that show a picture; an admin gets all of them, the ones taken out of sale and the ones without a picture too (with visible and deletedAt).',
      items: { $ref: 'variantShortSchema#' },
    },
  },
  required: ['product', 'variant', 'variants'],
} as const;

// the product part of a row: a list, the favorites, a change of a variant. The price, the stock and
// the picture of the row are the variant's. Every role gets the popularity of a list row; the card
// of a buyer has none.
const productItemResponseSchema = {
  $id: 'productItemResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    ...productFields,
    popularity: { type: 'integer' },
  },
  required: productRequired,
} as const;

// a row of the catalog list: a product with its main variant, or a variant with its product
const productListRowSchema = {
  $id: 'productListRowSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    product: { $ref: 'productItemResponseSchema#' },
    variant: {
      $ref: 'variantListItemSchema#',
      description:
        'A product row: its main variant, the first by its place that has free units (the first of all when none has), or the variant a search by an article number named; a row of variants: the first variant by its place of the group the row is (a group of one is that variant). A buyer gets the short form, admin and root the full one.',
    },
    minPrice: {
      type: 'number',
      description:
        'A product row and a group: the lowest price the variants of the row sell at now (the sale price while a sale lasts). The same as maxPrice when they sell at one price (one variant: show it as the price). A row of a single variant (group=false) has none.',
    },
    maxPrice: {
      type: 'number',
      description:
        'A product row and a group: the highest price the variants of the row sell at now.',
    },
    stock: {
      type: 'integer',
      minimum: 0,
      description:
        'The free units of the row: the sum over the variants of the list for a product row, over the variants of the group that fit the query for a group, the units of the variant for a single variant (group=false).',
    },
  },
  required: ['product', 'variant', 'stock'],
} as const;

const productsListResponseSchema = {
  $id: 'productsListResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    items: {
      type: 'array',
      items: { $ref: 'productListRowSchema#' },
    },
    limit: { type: 'integer', minimum: 1, maximum: 100 },
    total: {
      type: 'integer',
      minimum: 0,
      description: 'The number of the rows the filters find, whatever the page the cursor is on.',
    },
    nextCursor: {
      anyOf: [{ type: 'string', pattern: '^[A-Za-z0-9_-]+$', minLength: 1 }, { type: 'null' }],
    },
  },
  required: ['items', 'limit', 'total'],
} as const;

const getProductReviewsQuerySchema = {
  $id: 'getProductReviewsQuerySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    cursor: {
      type: 'string',
      minLength: 1,
      pattern: '^[A-Za-z0-9_-]+$',
      description:
        'nextCursor of the previous page, of the same sort and the same verifiedPurchase ' +
        '(CURSOR_INVALID otherwise).',
    },
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: 100,
      description: 'The most rows a page holds, from 1 to 100.',
    },
    sort: {
      type: 'string',
      enum: ['newest', 'helpful', 'ratingHigh', 'ratingLow'],
      description:
        'newest (the default), helpful (the most votes up first), ratingHigh, ratingLow; a ' +
        'review without a rating comes last, the newest first among the same values.',
    },
    verifiedPurchase: {
      type: 'boolean',
      description:
        'true lists only the reviews whose author bought the product, false only the others; ' +
        'without it every review is listed. The rule is that of the mark verifiedPurchase of a ' +
        'review: the author has an order of the product that is paid, shipped or delivered (a ' +
        'cancelled one, or one that waits for its payment, does not count). It works with every ' +
        'sort; total counts the reviews the filter keeps. true and false are the only values ' +
        '(VALIDATION_ERROR otherwise).',
    },
  },
} as const;

const reviewResponseSchema = {
  $id: 'reviewResponseSchema',
  type: 'object',
  properties: {
    id: { type: 'integer' },
    productId: { type: 'integer' },
    rating: { type: 'integer', minimum: 1, maximum: 5 },
    comment: { type: 'string' },
    userId: { anyOf: [{ type: 'string' }, { type: 'number' }] },
    user: {
      type: 'object',
      additionalProperties: false,
      description:
        'The author. A deleted account stays as the author with deleted: true and the name Guest.',
      properties: {
        id: { type: 'integer' },
        name: { type: 'string' },
        avatarUrls: avatarUrlsField,
        avatarIsDefault: avatarIsDefaultField,
        deleted: { type: 'boolean' },
      },
      required: ['id', 'avatarUrls', 'avatarIsDefault', 'deleted'],
    },

    verifiedPurchase: {
      type: 'boolean',
      description:
        'The author bought the product: a paid order of it, shipped or delivered too, not ' +
        'cancelled.',
    },
    upVotes: { type: 'integer', minimum: 0 },
    downVotes: { type: 'integer', minimum: 0 },
    // null in the enum too: swagger shows the field as nullable, and openapi 3.0 lets null
    // through a nullable enum only when the enum names it
    userVote: { type: 'string', enum: ['up', 'down', null], nullable: true },

    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
  required: ['id', 'productId', 'userId', 'user', 'verifiedPurchase', 'createdAt', 'updatedAt'],
  additionalProperties: false,
} as const;

const reviewsResponseSchema = {
  $id: 'reviewsResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    items: {
      type: 'array',
      items: { $ref: 'reviewResponseSchema#' },
    },
    limit: { type: 'integer' },
    total: { type: 'integer' },
    nextCursor: { type: 'string', pattern: '^[A-Za-z0-9_-]+$', minLength: 1 },
  },
  required: ['items', 'limit', 'total'],
} as const;

const deleteProductReviewParamsSchema = {
  $id: 'deleteProductReviewParamsSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    productId: idPathParam('the product'),
    reviewId: idPathParam('the review'),
  },
  required: ['productId', 'reviewId'],
} as const;

// the answer of a deletion; a removal by a moderator counts the removals of the author
const deleteProductReviewResponseSchema = {
  $id: 'deleteProductReviewResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    message: { type: 'string', enum: ['REVIEW_DELETED'] },
    reviewRemovals: {
      type: 'integer',
      description:
        'Admin or root only: how many reviews of the author a moderator removed, this one ' +
        'included. Past reviewRemovalsLimit the page tells the admin to take the account to root.',
    },
    reviewRemovalsLimit: {
      type: 'integer',
      description:
        'Admin or root only: the removals the rules allow (reviewRemovalsLimit, root sets it).',
    },
  },
  required: ['message'],
} as const;

// documentation only: the form of POST /api/products. A form is not checked against a schema,
// the controller and the service check its fields
const productCreateFormSchema = {
  $id: 'productCreateFormSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1 },
    description: { type: 'string', description: 'The text of the description.' },
    ...partyIdFormFields,
    ...newPartyFormFields,
    documentIds: documentIdsFormField,
    categoryId: { type: 'integer', minimum: 1 },
    variants: {
      type: 'string',
      description:
        'The variants of the product, the text of a JSON list of 1 to PRODUCT_VARIANTS_MAX ' +
        'elements; the place of a variant is its place in the list. An element: ' +
        '{ "price": 49.99, "sku": "WH-1000", "barcode": "4006381333931", "weightGrams": 350, ' +
        '"lengthMm": 200, "widthMm": 100, "heightMm": 50, "withoutShippingData": false, ' +
        '"images": [{ "file": 0, "position": 1 }] }. Only price and images are required; the ' +
        'weight and the sizes are required too unless withoutShippingData is true. `file` is the ' +
        'number of a file of `images` (from 0), `position` the place of the picture among the ' +
        'pictures of the variant (from 1, each place once). Every variant shows a picture ' +
        '(VARIANT_IMAGE_REQUIRED) and every file is shown by some variant (GALLERY_IMAGE_UNUSED). ' +
        'A variant that is wrong is named with its error (VARIANTS_INVALID, details.variants).',
    },
    stock: {
      type: 'string',
      description:
        'Not accepted (PRODUCT_STOCK_NOT_ALLOWED): the stock comes with a delivery, POST ' +
        '/api/products/stock/deliveries.',
    },
    images: productImagesFormField,
  },
  required: ['name', 'categoryId', 'variants', 'images'],
} as const;

const saleEndsAtField = {
  type: 'string',
  format: 'date-time',
  description: 'When the sale ends, in the future; the sale starts right away.',
} as const;

// a percent of the price or an amount off it, never both: the shapes leave out
// additionalProperties, ajv strips an unknown field while it tries a shape of anyOf (fastify
// removeAdditional) and would let a percent and an amount through as a percent
export const saleDiscountShapes = [
  {
    type: 'object',
    properties: {
      percent: {
        type: 'number',
        exclusiveMinimum: 0,
        maximum: 100,
        description: 'A percent of the price, above 0 and up to 100.',
      },
      endsAt: saleEndsAtField,
    },
    required: ['percent', 'endsAt'],
    not: { required: ['amount'] },
  },
  {
    type: 'object',
    properties: {
      amount: {
        type: 'number',
        exclusiveMinimum: 0,
        description: 'Money off the price, above 0 and up to the price.',
      },
      endsAt: saleEndsAtField,
    },
    required: ['amount', 'endsAt'],
    not: { required: ['percent'] },
  },
] as const;

const updateProductBodySchema = {
  $id: 'updateProductBodySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1 },
    description: {
      type: 'string',
      description: 'The text of the description; empty takes it away.',
    },
    manufacturerId: manufacturerIdBodyField,
    euResponsibleId: euResponsibleIdBodyField,
    warnings: warningsBodyField,
    withdrawal: withdrawalBodyField,
    documentIds: documentIdsBodyField,

    // kept in the schema so that a stock sent is refused, not dropped without a word
    stock: {
      description:
        'Not accepted (PRODUCT_STOCK_NOT_ALLOWED): the stock changes only with a delivery or a ' +
        'write-off, POST /api/products/stock/deliveries and /write-offs.',
    },

    categoryId: { type: 'integer', minimum: 1 },

    // a type list, not anyOf: with coerceTypes ajv turns null into 0 in the integer shape of an
    // anyOf, and null would set an override of 0 instead of taking it off
    popularityOverride: {
      type: ['integer', 'null'],
      minimum: 0,
      description:
        'The popularity the product shows while popularityOverrideUntil is ahead; it goes with an end: after the change the product has both or neither (POPULARITY_OVERRIDE_UNTIL_REQUIRED, POPULARITY_OVERRIDE_REQUIRED). Null takes it off, together with its end.',
    },

    popularityOverrideUntil: {
      type: ['string', 'null'],
      format: 'date-time',
      description:
        'The end of the popularity override, in the future (POPULARITY_OVERRIDE_UNTIL_INVALID); it goes with an override. Null takes it off, together with the override.',
    },
  },
} as const;

// PATCH /api/products/batch: for each product the fields of the json body of PATCH
// /api/products/:productId, the ones left out stay as they are
const updateProductsBatchBodySchema = {
  $id: 'updateProductsBatchBodySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    items: {
      type: 'array',
      minItems: 1,
      maxItems: 100,
      description:
        'The products to change, each once (PRODUCTS_REPEATED), each with the fields it changes.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          productId: { type: 'integer', minimum: 1, maximum: MAX_ID },
          ...updateProductBodySchema.properties,
        },
        required: ['productId'],
      },
    },
  },
  required: ['items'],
} as const;

const updateProductsBatchResponseSchema = {
  $id: 'updateProductsBatchResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    products: {
      type: 'array',
      description: 'The cards of an admin of the products changed, in the order of the items.',
      items: { $ref: 'productCardResponseSchema#' },
    },
  },
  required: ['products'],
} as const;

// documentation only: the form of PATCH /api/products/:productId, the fields of the json body;
// empty or null clears a popularity override and its end, which go together. The pictures are the
// business of the gallery (POST and DELETE /api/products/{productId}/images)
const productUpdateFormSchema = {
  $id: 'productUpdateFormSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1 },
    description: { type: 'string' },
    ...partyIdFormFields,
    documentIds: documentIdsFormField,
    categoryId: { type: 'integer', minimum: 1 },
    popularityOverride: {
      type: 'string',
      description:
        'A whole number from 0, with popularityOverrideUntil; empty or null clears it, together ' +
        'with its end.',
    },
    popularityOverrideUntil: {
      type: 'string',
      description:
        'A date-time in the future, with popularityOverride; empty or null clears it, together ' +
        'with the override.',
    },
  },
} as const;

const productSaleBodySchema = {
  $id: 'productSaleBodySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    variantIds: {
      type: 'array',
      minItems: 1,
      maxItems: MAX_PRODUCT_VARIANTS,
      uniqueItems: true,
      items: { type: 'integer', minimum: 1, maximum: MAX_ID },
      description:
        'The variants of the product to put on sale or take off, each one that is for sale ' +
        '(VARIANT_NOT_FOUND for another). Without it every variant for sale of the product.',
    },
    sale: {
      description:
        'The discount until endsAt, by a percent of the price or by an amount of money off it, ' +
        'counted from the price of each variant; the sale price is rounded to cents and stays ' +
        'below the price, 0 gives the variant away. A new sale writes over the one there is. ' +
        'null takes the sale off.',
      anyOf: [...saleDiscountShapes, { type: 'null' }],
    },
  },
  required: ['sale'],
} as const;

// sales of many variants at once: a sale for each variant or product, or one sale for the variants
// of the products of a category. One of the two shapes; the fields sit on the object itself and the
// shapes only name what they need, so that fastify removeAdditional strips nothing while ajv tries
// a shape
const salesSaleField = {
  description:
    'The discount until endsAt, by a percent of the price or by an amount of money off it, the ' +
    'way PATCH /api/products/{productId}/sale takes it.',
  anyOf: saleDiscountShapes,
} as const;

const productSalesBodySchema = {
  $id: 'productSalesBodySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    items: {
      type: 'array',
      minItems: 1,
      maxItems: 100,
      description:
        'A sale for each item, without categoryId. An item names one variant (`variantId`) or a ' +
        'product (`productId`: all its variants for sale), and a variant once in the request ' +
        '(SALE_VARIANTS_REPEATED).',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          variantId: { type: 'integer', minimum: 1, maximum: MAX_ID },
          productId: { type: 'integer', minimum: 1, maximum: MAX_ID },
          sale: salesSaleField,
        },
        required: ['sale'],
        oneOf: [
          { required: ['variantId'], not: { required: ['productId'] } },
          { required: ['productId'], not: { required: ['variantId'] } },
        ],
      },
    },
    categoryId: {
      type: 'integer',
      minimum: 1,
      maximum: MAX_ID,
      description:
        'One sale for the variants of the products of the catalog of the category, with sale; ' +
        'without items.',
    },
    branch: {
      type: 'boolean',
      description:
        'With categoryId: true (the default) takes the products of the categories below it too, ' +
        'false only the products of the category itself.',
    },
    sale: salesSaleField,
  },
  oneOf: [
    {
      required: ['items'],
      not: {
        anyOf: [{ required: ['categoryId'] }, { required: ['branch'] }, { required: ['sale'] }],
      },
    },
    { required: ['categoryId', 'sale'], not: { required: ['items'] } },
  ],
} as const;

// the answer of the routes of a sale: every variant with its sale now and what was done to it
const productSalesResponseSchema = {
  $id: 'productSalesResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    variants: {
      type: 'array',
      description:
        'The variants of the request: in the order of the request (the ones named, or by their ' +
        'place; in the order of the items; by id for a category).',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'integer' },
          productId: { type: 'integer' },
          name: { type: 'string' },
          price: { type: 'number', description: 'The usual price.' },
          salePrice: {
            anyOf: [{ type: 'number' }, { type: 'null' }],
            description: 'The sale price while the sale lasts, null without a sale.',
          },
          saleEndsAt: { anyOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }] },
          salePriorPrice: {
            anyOf: [{ type: 'number' }, { type: 'null' }],
            description: 'The lowest price of the 30 days before the sale.',
          },
          status: {
            type: 'string',
            enum: ['set', 'unchanged', 'removed'],
            description:
              'set: the sale was put on; unchanged: the variant had this sale already (or had ' +
              'no sale to take off); removed: the sale was taken off.',
          },
        },
        required: [
          'id',
          'productId',
          'name',
          'price',
          'salePrice',
          'saleEndsAt',
          'salePriorPrice',
          'status',
        ],
      },
    },
  },
  required: ['variants'],
} as const;

const bulkUpdateProductsPriceBodySchema = {
  $id: 'bulkUpdateProductsPriceBodySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    mode: { type: 'string', enum: ['percent', 'fixed'] },
    value: { type: 'number' },

    scope: {
      type: 'object',
      additionalProperties: false,
      properties: {
        categoryId: { type: 'integer', minimum: 1 },
        productIds: {
          type: 'array',
          items: { type: 'integer', minimum: 1 },
          minItems: 1,
          uniqueItems: true,
          description: 'The variants of these products.',
        },
        variantIds: {
          type: 'array',
          items: { type: 'integer', minimum: 1 },
          minItems: 1,
          uniqueItems: true,
          description: 'These variants.',
        },

        minPrice: {
          type: 'number',
          minimum: 0,
          description: 'The usual price of the variant at least, not the sale price.',
        },
        maxPrice: {
          type: 'number',
          minimum: 0,
          description: 'The usual price of the variant at most, not the sale price.',
        },

        f: {
          anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
          description:
            'The variants that have these characteristics: the entries of the filter f of the ' +
            'catalog, `<attributeId>:<value>` (`12:45,46`, `15:128..512`, `20:yes`), a text or a ' +
            'list of them; the values of one characteristic are OR, different ones AND. A wrong ' +
            'entry is FILTER_INVALID.',
        },

        inStock: { type: 'boolean' },
        deleted: { type: 'boolean' },
      },
    },

    dryRun: { type: 'boolean' },
    sale: {
      type: 'string',
      enum: ['keep', 'remove'],
      description:
        'The same for the sale that is on of every product of the scope: keep it (a new price ' +
        'down to a sale price or below cannot, PRODUCT_SALE_NOT_BELOW_PRICE, and no product ' +
        'changes), or remove it the way it goes for one product, then the price. Needed when the ' +
        'scope has a product on sale (PRODUCT_SALE_DECISION_REQUIRED); a dry run needs none.',
    },
    reason: { type: 'string', minLength: 1, maxLength: 200 },
  },
  required: ['mode', 'value'],
} as const;

const bulkUpdateProductsPriceResponseSchema = {
  $id: 'bulkUpdateProductsPriceResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    message: { type: 'string' },
    updatedCount: { type: 'integer', minimum: 0 },
    variants: {
      type: 'array',
      description:
        'A dry run lists the variants it would change with their old and new price; a real run ' +
        'leaves this out.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'integer' },
          productId: { type: 'integer' },
          name: { type: 'string' },
          oldPrice: { type: 'number' },
          newPrice: { type: 'number' },
        },
        required: ['id', 'productId', 'name', 'oldPrice', 'newPrice'],
      },
    },
  },
  required: ['message', 'updatedCount'],
} as const;

const createReviewBodySchema = {
  $id: 'createReviewBodySchema',
  type: 'object',
  properties: {
    rating: { type: 'integer', minimum: 1, maximum: 5 },
    // a review is a few lines: a megabyte of text went into the row of each product
    comment: { type: 'string', maxLength: 2000 },
  },
  // the same rule as the db: a review has a rating, a comment or both
  anyOf: [{ required: ['rating'] }, { required: ['comment'] }],
  additionalProperties: false,
} as const;

const productsUpdateCategoryParamsSchema = {
  $id: 'productsUpdateCategoryParamsSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    productId: idPathParam('the product'),
  },
  required: ['productId'],
} as const;

const productsUpdateCategoryBodySchema = {
  $id: 'productsUpdateCategoryBodySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    categoryId: { type: 'number' },
  },
  required: ['categoryId'],
} as const;

const productsUpdateCategoryResponseSchema = {
  $id: 'productsUpdateCategoryResponseSchema',
  allOf: [{ $ref: 'productCardResponseSchema#' }],
} as const;

// STOCK: a delivery takes in a batch of each item, a write-off takes free units out. An item names
// the variant it is about: by its id, by its article number or by its barcode
const stockIdField = (description: string) =>
  ({
    type: 'integer',
    minimum: 1,
    maximum: MAX_ID,
    description: `${description}: a whole number from 1 to ${MAX_ID}.`,
  }) as const;

const stockQuantityField = {
  type: 'integer',
  minimum: 1,
  maximum: 1_000_000,
  description: 'Units, a whole number from 1.',
} as const;

const STOCK_SOURCES = ['supplier', 'surplus', 'customer_return'] as const;

// an item names its variant by the id, by the article number or by the barcode the papers of a
// supplier name, one of the three
const stockSkuField = {
  type: 'string',
  minLength: 1,
  maxLength: 64,
  description:
    'The article number of a variant of the catalog, in place of variantId, whatever the case of ' +
    'its letters; a number no variant of the catalog has is VARIANT_NOT_FOUND with details.skus.',
} as const;

const stockBarcodeField = {
  type: 'string',
  pattern: '^[0-9]{8,14}$',
  description:
    'The barcode of a variant of the catalog, 8 to 14 digits, in place of variantId; a barcode ' +
    'no variant of the catalog has is VARIANT_NOT_FOUND with details.barcodes.',
} as const;

const STOCK_VARIANT_REF = [
  { required: ['variantId'] },
  { required: ['sku'] },
  { required: ['barcode'] },
] as const;

const stockDeliveryBodySchema = {
  $id: 'stockDeliveryBodySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    source: {
      type: 'string',
      enum: STOCK_SOURCES,
      description:
        'Where the goods come from: a delivery of a supplier, a surplus an inventory found, ' +
        'goods a buyer brought back.',
    },
    supplier: { type: 'string', maxLength: 200, description: 'The supplier, for the admin log.' },
    document: { type: 'string', maxLength: 100, description: 'The number of the invoice.' },
    note: { type: 'string', maxLength: 500 },
    unitCost: {
      type: 'number',
      minimum: 0,
      maximum: 99_999_999.99,
      description:
        'The cost of a unit of every item that names none of its own, in the currency of the ' +
        'shop, to the cent (finer is BATCH_UNIT_COST_INVALID).',
    },
    expiresAt: {
      type: 'string',
      format: 'date',
      description:
        'The last good day of every item that names none of its own (an item with null has no ' +
        'end), yyyy-mm-dd, today or later by the calendar of the shop (BATCH_EXPIRES_AT_INVALID).',
    },
    items: {
      type: 'array',
      minItems: 1,
      maxItems: 100,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          variantId: stockIdField('Id of the variant, or sku or barcode in its place'),
          sku: stockSkuField,
          barcode: stockBarcodeField,
          quantity: stockQuantityField,
          unitCost: {
            type: 'number',
            minimum: 0,
            maximum: 99_999_999.99,
            description:
              'The cost of a unit in the currency of the shop, to the cent (finer is ' +
              'BATCH_UNIT_COST_INVALID); 0 for a gift or a sample. Without it the cost of the ' +
              'delivery stands in; an item with neither is BATCH_UNIT_COST_REQUIRED.',
          },
          expiresAt: {
            type: ['string', 'null'],
            format: 'date',
            description:
              'The last day the goods are good for, yyyy-mm-dd, today or later by the calendar ' +
              'of the shop (BATCH_EXPIRES_AT_INVALID). A sale takes the batch that ends first. ' +
              'Without it the last day of the delivery stands in; null has no end.',
          },
          supplierBatchNumber: {
            type: 'string',
            maxLength: 100,
            description: 'The number the supplier gave the batch.',
          },
        },
        required: ['quantity'],
        oneOf: STOCK_VARIANT_REF,
      },
    },
  },
  required: ['source', 'items'],
} as const;

// the product and the variant a line of an answer is about, by name
const stockLineRefProperties = {
  productId: { type: 'integer' },
  variantId: { type: 'integer' },
  product: {
    type: 'object',
    additionalProperties: false,
    properties: { id: { type: 'integer' }, name: { type: 'string' } },
    required: ['id', 'name'],
  },
  variant: {
    type: 'object',
    additionalProperties: false,
    description: 'The variant as it is now: its place, its name and its article number.',
    properties: {
      id: { type: 'integer' },
      position: { type: 'integer' },
      name: { type: 'string' },
      sku: { type: ['string', 'null'] },
    },
    required: ['id', 'position', 'name', 'sku'],
  },
} as const;

const STOCK_LINE_REF_REQUIRED = ['productId', 'variantId', 'product', 'variant'] as const;

const stockVariantSummarySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    variantId: { type: 'integer' },
    productId: { type: 'integer' },
    stock: {
      type: 'integer',
      description:
        'Free units: the stock the waiting orders do not hold, without the units that are over.',
    },
    totalStock: { type: 'integer', description: 'The whole stock.' },
    reservedStock: { type: 'integer', description: 'The units the waiting orders hold.' },
    expiredStock: {
      type: 'integer',
      description: 'The units of batches whose last good day is over.',
    },
  },
  required: ['variantId', 'productId', 'stock', 'totalStock', 'reservedStock', 'expiredStock'],
} as const;

const stockDeliveryResponseSchema = {
  $id: 'stockDeliveryResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    deliveryId: {
      type: 'string',
      format: 'uuid',
      description:
        'The delivery: its batches, the lines of the stock log of its variants (GET /api/admin/stock-log, filter deliveryId) and the one line of the admin log carry it.',
    },
    batches: {
      type: 'array',
      description: 'A batch for each item, in the order of the items.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'integer', description: 'The number of the batch in the shop.' },
          ...stockLineRefProperties,
          source: { type: 'string', enum: STOCK_SOURCES },
          supplierBatchNumber: { type: ['string', 'null'] },
          unitCost: { type: 'number' },
          quantity: { type: 'integer' },
          remaining: { type: 'integer' },
          expiresAt: { type: ['string', 'null'], format: 'date' },
          createdAt: { type: 'string', format: 'date-time' },
        },
        required: [
          'id',
          ...STOCK_LINE_REF_REQUIRED,
          'source',
          'supplierBatchNumber',
          'unitCost',
          'quantity',
          'remaining',
          'expiresAt',
          'createdAt',
        ],
      },
    },
    variants: {
      type: 'array',
      description: 'The stock of each variant of the delivery after it, once, by the id.',
      items: stockVariantSummarySchema,
    },
  },
  required: ['deliveryId', 'batches', 'variants'],
} as const;

const stockWriteOffBodySchema = {
  $id: 'stockWriteOffBodySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    reason: {
      type: 'string',
      enum: ['damaged', 'defective', 'expired', 'shortage', 'returned_to_supplier', 'other'],
      description:
        'shortage: what an inventory did not find; returned_to_supplier: goods sent back; ' +
        'other needs a note (WRITE_OFF_NOTE_REQUIRED).',
    },
    note: { type: 'string', maxLength: 500 },
    items: {
      type: 'array',
      minItems: 1,
      maxItems: 100,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          variantId: stockIdField('Id of the variant, or sku or barcode in its place'),
          sku: stockSkuField,
          barcode: stockBarcodeField,
          quantity: stockQuantityField,
          batchId: stockIdField(
            'The batch of the variant to take the units from; without one they come in the ' +
              'order of a sale, the batch that ends first, then the oldest',
          ),
        },
        required: ['quantity'],
        oneOf: STOCK_VARIANT_REF,
      },
    },
  },
  required: ['reason', 'items'],
} as const;

const stockWriteOffResponseSchema = {
  $id: 'stockWriteOffResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    writeOffId: {
      type: 'string',
      format: 'uuid',
      description:
        'The write-off: the lines of the stock log of its variants (GET /api/admin/stock-log, filter writeOffId) and the one line of the admin log carry it.',
    },
    items: {
      type: 'array',
      description: 'What each item took, in the order of the items.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ...stockLineRefProperties,
          quantity: { type: 'integer' },
          batches: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                batchId: { type: 'integer' },
                quantity: { type: 'integer' },
                unitCost: { type: 'number' },
              },
              required: ['batchId', 'quantity', 'unitCost'],
            },
          },
        },
        required: [...STOCK_LINE_REF_REQUIRED, 'quantity', 'batches'],
      },
    },
    variants: {
      type: 'array',
      description: 'The stock of each variant of the write-off after it, once, by the id.',
      items: stockVariantSummarySchema,
    },
  },
  required: ['writeOffId', 'items', 'variants'],
} as const;

// the history of the price of a product
const priceHistoryQuerySchema = {
  $id: 'priceHistoryQuerySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    variantId: {
      type: 'integer',
      minimum: 1,
      maximum: MAX_ID,
      description: 'Only the changes of this variant of the product.',
    },
    limit: { type: 'integer', minimum: 1, maximum: 100, description: '50 unless given.' },
    cursor: {
      type: 'string',
      minLength: 1,
      pattern: '^[A-Za-z0-9_-]+$',
      description: 'The nextCursor of the previous page.',
    },
  },
} as const;

const priceHistoryResponseSchema = {
  $id: 'priceHistoryResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'integer' },
          variant: {
            type: 'object',
            additionalProperties: false,
            description: 'The variant whose price changed, as it is now.',
            properties: {
              id: { type: 'integer' },
              position: { type: 'integer' },
              name: { type: 'string' },
              sku: { type: ['string', 'null'] },
            },
            required: ['id', 'position', 'name', 'sku'],
          },
          oldPrice: { type: 'number' },
          newPrice: { type: 'number' },
          mode: {
            type: 'string',
            enum: ['percent', 'fixed'],
            description: 'How the change was given: by a percent or by an amount.',
          },
          value: {
            type: 'number',
            description: 'Its size in that mode, below 0 for a change down.',
          },
          endsAt: {
            anyOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }],
            description: 'A line with an end is the start of a sale until it.',
          },
          event: {
            type: 'string',
            description:
              'What made the line: price.set, price.set_batch, price.bulk, price.sale_start or ' +
              'price.sale_end, or legacy.unknown for a line written before the events ' +
              '(GET /api/admin/log-events lists them).',
          },
          actor: {
            type: 'object',
            additionalProperties: false,
            description:
              'Who did it, with the role. For an admin the account of root has the id 0 and the ' +
              'name hidden; the role stays.',
            properties: {
              id: { type: 'integer' },
              name: { type: ['string', 'null'] },
              role: { type: 'string', enum: ['USER', 'ADMIN', 'ROOT'] },
              deleted: { type: 'boolean' },
            },
            required: ['id', 'name', 'role', 'deleted'],
          },
          createdAt: { type: 'string', format: 'date-time' },
        },
        required: [
          'id',
          'variant',
          'oldPrice',
          'newPrice',
          'mode',
          'value',
          'endsAt',
          'event',
          'actor',
          'createdAt',
        ],
      },
    },
    limit: { type: 'integer' },
    nextCursor: { type: ['string', 'null'] },
  },
  required: ['items', 'limit', 'nextCursor'],
} as const;

export const productDtoSchemas = [
  getAllProductsQuerySchema,
  catalogFiltersQuerySchema,
  catalogChoiceFilterSchema,
  catalogNumberFilterSchema,
  catalogBooleanFilterSchema,
  catalogFiltersResponseSchema,
  priceHistoryQuerySchema,
  priceHistoryResponseSchema,
  productSalesBodySchema,
  productSalesResponseSchema,
  productSuggestionsQuerySchema,
  productSuggestionsResponseSchema,
  productCreateFormSchema,
  updateProductBodySchema,
  updateProductsBatchBodySchema,
  updateProductsBatchResponseSchema,
  productUpdateFormSchema,
  productSaleBodySchema,
  bulkUpdateProductsPriceBodySchema,
  bulkUpdateProductsPriceResponseSchema,
  createReviewBodySchema,
  productResponseSchema,
  productCardResponseSchema,
  getProductReviewsQuerySchema,
  reviewResponseSchema,
  reviewsResponseSchema,
  deleteProductReviewParamsSchema,
  deleteProductReviewResponseSchema,
  productsListResponseSchema,
  productListRowSchema,
  productItemResponseSchema,
  productsUpdateCategoryParamsSchema,
  productsUpdateCategoryBodySchema,
  productsUpdateCategoryResponseSchema,
  stockDeliveryBodySchema,
  stockDeliveryResponseSchema,
  stockWriteOffBodySchema,
  stockWriteOffResponseSchema,
];
