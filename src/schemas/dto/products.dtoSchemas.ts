import { avatarIsDefaultField, avatarUrlsField } from '@schemas/avatarFields.js';
import { MAX_UPLOAD_SIZE_BYTES } from '@config/limits.js';
import {
  SAFETY_COUNTRY_PATTERN,
  SAFETY_EMAIL_PATTERN,
  SAFETY_LIMITS,
} from '@helpers/productDescription.js';
import { MAX_ID, idPathParam } from '@schemas/idPathParam.js';

// money of a request: whole cents up to what numeric(10, 2) holds
const moneyField = {
  type: 'number',
  minimum: 0,
  maximum: 99_999_999.99,
  multipleOf: 0.01,
  description: 'Whole cents, from 0 up to 99 999 999.99.',
} as const;

const MAX_IMAGE_MB = MAX_UPLOAD_SIZE_BYTES / 1_000_000;

// the image files of a product form, in their order: the first is the main image
const productImagesFormField = {
  type: 'array',
  items: { type: 'string', format: 'binary' },
  description:
    'Product images in their order, the first is the main one: jpeg, png or webp files by their ' +
    `content, each up to ${MAX_IMAGE_MB} MB.`,
} as const;

const getAllProductsQuerySchema = {
  $id: 'getAllProductsQuerySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    // cursor pagination
    limit: { type: 'integer', minimum: 1, maximum: 100 },
    cursor: {
      type: 'string',
      minLength: 1,
      pattern: '^[A-Za-z0-9_-]+$',
      description:
        'nextCursor of the previous page, with the same sort and order. A changed cursor, or one ' +
        'from another sort or order, is CURSOR_INVALID.',
    },

    // filters
    search: {
      type: 'string',
      minLength: 1,
      description:
        'Finds a product by its name, forgiving a typo and another order of the words, by the ' +
        'name of its category or by its article number (sku). Without a sort the best match ' +
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
        'A buyer: the price a product sells at now, the sale price while its sale lasts. An ' +
        'admin: the usual price, the one the field price shows.',
    },
    maxPrice: {
      type: 'number',
      minimum: 0,
      description:
        'A buyer: the price a product sells at now, the sale price while its sale lasts. An ' +
        'admin: the usual price, the one the field price shows.',
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
        'Admin and root only (FILTER_FORBIDDEN for a buyer): true lists only the products with ' +
        'a sale that is on, whatever else they have. Without any flag an admin gets only the ' +
        'plain products (not deleted, without a sale and an override that are on); with another ' +
        'flag the sale does not filter. A buyer always gets every product of the catalog.',
    },
    popularityOverridden: {
      type: 'boolean',
      description:
        'Admin and root only (FILTER_FORBIDDEN for a buyer): true lists only the products with ' +
        'a popularity override that is on, whatever else they have: an override with its end ' +
        'ahead (one without an end or past it overrides nothing). Without any flag an admin gets ' +
        'only the plain products; with another flag the override does not filter.',
    },
    inStock: {
      type: 'boolean',
      description:
        'Free units, the stock the list shows: true lists products with some free, false ' +
        'products with none. Units reserved by confirmed orders and units of batches that are ' +
        'over are not free.',
    },
    maxStock: {
      type: 'integer',
      minimum: 0,
      description:
        'Admin and root only (FILTER_FORBIDDEN for a buyer), a flag: lists every product of the ' +
        'catalog with no more free units than the number, whatever else it has (a sale, an ' +
        'override); 0 the products with none. With inStock=true the ones with some.',
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
        'name',
      ],
      description:
        'relevance (the default with a search, the best match first; without a search ' +
        'SORT_RELEVANCE_REQUIRES_SEARCH) for every role. ' +
        'A buyer sorts by createdAt, price (the price a product sells at now), popularity ' +
        '(the default without a search), avgRating, name and saleEndsAt: the products on sale first by the end of ' +
        'their sale in the order asked for, then every other one by popularity, the most popular ' +
        'first; any other sort is SORT_FORBIDDEN. An admin sorts by any field; price is the usual ' +
        'price, salePrice the sale price, stock the free units, totalStock the whole stock, ' +
        'expiredStock the units of batches that are over. A ' +
        'field only some products have comes with its flag: deletedAt with deleted, saleEndsAt ' +
        'and salePrice with onSale, popularityOverride and popularityOverrideUntil with ' +
        'popularityOverridden, otherwise SORT_DELETED_AT_REQUIRES_DELETED, ' +
        'SORT_SALE_ENDS_AT_REQUIRES_ON_SALE, SORT_SALE_PRICE_REQUIRES_ON_SALE, ' +
        'SORT_POPULARITY_OVERRIDE_REQUIRES_OVERRIDDEN.',
    },
    order: { type: 'string', enum: ['asc', 'desc'] },
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

const imageUrlsSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    url200: { type: 'string' },
    url400: { type: 'string' },
    url800: { type: 'string' },
  },
  required: ['url200', 'url400', 'url800'],
} as const;

const ADMIN_ONLY = 'Admin and root only.';

// the fields of a product every role gets, and the ones only admin and root get; images and the
// popularity differ between the card and a list item
const productFields = {
  id: { type: 'integer' },

  name: { type: 'string' },
  description: { type: 'string' },
  sku: {
    anyOf: [{ type: 'string', maxLength: 64 }, { type: 'null' }],
    description:
      'The article number, null without one. One product of the catalog has it at a time, ' +
      'whatever the case of its letters; the search finds the product by it.',
  },

  price: { type: 'number' },
  // the sale next to the price: a buyer gets it only while it lasts, an admin always
  salePrice: {
    anyOf: [{ type: 'number', minimum: 0 }, { type: 'null' }],
    description:
      'The product sells at it until saleEndsAt. A buyer gets it only while the sale lasts; ' +
      'admin and root always, as the row keeps it (a sale past its end too), null without one.',
  },
  saleEndsAt: {
    anyOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }],
    description:
      'The end of the sale. A buyer gets it only while the sale lasts; admin and root always, ' +
      'null without a sale.',
  },
  salePriorPrice: {
    anyOf: [{ type: 'number', minimum: 0 }, { type: 'null' }],
    description:
      'The lowest price the product sold at in the 30 days before the sale (a sale price of ' +
      'that time too), the price a reduction is compared with. A sale that replaces the one ' +
      'that is on keeps the lowest price of the first. A buyer gets it with the sale while it ' +
      'lasts; admin and root as the row keeps it, null without a sale or for a sale from ' +
      'before it was written.',
  },
  stock: {
    type: 'integer',
    description:
      'Free units: the stock that confirmed orders do not hold, less the units of batches ' +
      'whose last good day is behind the day of the shop.',
  },
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
  totalStock: {
    type: 'integer',
    description: `${ADMIN_ONLY} The whole stock, the reserved units with it.`,
  },
  reservedStock: {
    type: 'integer',
    description: `${ADMIN_ONLY} The units confirmed orders hold.`,
  },
  expiredStock: {
    type: 'integer',
    description: `${ADMIN_ONLY} The units of batches whose last good day is over: not sold, so not in stock; written off by the admin.`,
  },
  lastUnitCost: {
    anyOf: [{ type: 'number', minimum: 0 }, { type: 'null' }],
    description: `${ADMIN_ONLY} The cost of a unit in the latest delivery of a supplier, in the currency of the shop: what a price or a sale is set against. A surplus an inventory found or goods a buyer brought back are no purchase; null for a product no supplier delivered.`,
  },
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
  'sku',
  'price',
  'stock',
  'category',
  'images',
  'avgRating',
  'reviewsCount',
  'createdAt',
] as const;

// the card of a product page: every image; a buyer gets no popularity in it
// the safety and origin data of a product (the EU GPSR): the manufacturer with its postal and
// electronic address and its country, a person responsible in the EU for a manufacturer outside
// it, the warnings. The database keeps them in the description, with its text
const safetyPersonProperties = {
  name: { type: 'string', minLength: 1, maxLength: SAFETY_LIMITS.name },
  address: {
    type: 'string',
    minLength: 1,
    maxLength: SAFETY_LIMITS.address,
    description: 'The postal address.',
  },
  email: {
    type: 'string',
    minLength: 3,
    maxLength: SAFETY_LIMITS.email,
    pattern: SAFETY_EMAIL_PATTERN.source,
    description: 'The electronic address.',
  },
} as const;

const safetyManufacturerSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ...safetyPersonProperties,
    country: {
      type: 'string',
      pattern: SAFETY_COUNTRY_PATTERN.source,
      description:
        'The country of the manufacturer, its ISO 3166 code of two letters, DE for example; ' +
        'outside the EU a responsible person in the EU is required (PRODUCT_EU_RESPONSIBLE_REQUIRED).',
    },
  },
  required: ['name', 'address', 'email', 'country'],
} as const;

const safetyPersonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: safetyPersonProperties,
  required: ['name', 'address', 'email'],
} as const;

const SAFETY_DESCRIPTION =
  'The safety and origin data an offer shows (the EU GPSR): the manufacturer, a person ' +
  'responsible in the EU when the manufacturer is outside it, the warnings.';

// the data of a json body, whole: they replace the ones of the product
const productSafetyBodyField = {
  type: 'object',
  additionalProperties: false,
  description: `${SAFETY_DESCRIPTION} They replace the ones the product has, whole.`,
  properties: {
    manufacturer: safetyManufacturerSchema,
    // a type list, not anyOf: removeAdditional would strip the fields while ajv tries a shape
    responsiblePerson: { ...safetyPersonSchema, type: ['object', 'null'] },
    warnings: { type: ['string', 'null'], maxLength: SAFETY_LIMITS.warnings },
  },
  required: ['manufacturer'],
} as const;

const productSafetyResponseField = {
  description: `${SAFETY_DESCRIPTION} Null for a product from before them.`,
  anyOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        manufacturer: safetyManufacturerSchema,
        responsiblePerson: { anyOf: [safetyPersonSchema, { type: 'null' }] },
        warnings: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      },
      required: ['manufacturer', 'responsiblePerson', 'warnings'],
    },
    { type: 'null' },
  ],
} as const;

// the same data as the text fields of a form; a new product needs those of the manufacturer
// (PRODUCT_SAFETY_REQUIRED), a wrong value is PRODUCT_SAFETY_INVALID, both with details.fields
const safetyFormFields = {
  'safety.manufacturer.name': { type: 'string', maxLength: SAFETY_LIMITS.name },
  'safety.manufacturer.address': {
    type: 'string',
    maxLength: SAFETY_LIMITS.address,
    description: 'The postal address of the manufacturer.',
  },
  'safety.manufacturer.email': {
    type: 'string',
    maxLength: SAFETY_LIMITS.email,
    description: 'The electronic address of the manufacturer.',
  },
  'safety.manufacturer.country': {
    type: 'string',
    description: 'The ISO 3166 code of two letters, DE for example.',
  },
  'safety.responsiblePerson.name': {
    type: 'string',
    maxLength: SAFETY_LIMITS.name,
    description: 'For a manufacturer outside the EU: the person responsible in the EU.',
  },
  'safety.responsiblePerson.address': { type: 'string', maxLength: SAFETY_LIMITS.address },
  'safety.responsiblePerson.email': { type: 'string', maxLength: SAFETY_LIMITS.email },
  'safety.warnings': { type: 'string', maxLength: SAFETY_LIMITS.warnings },
} as const;

const productResponseSchema = {
  $id: 'productResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    ...productFields,
    safety: productSafetyResponseField,
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
    images: { type: 'array', items: imageUrlsSchema },
    popularity: { type: 'integer', description: ADMIN_ONLY },
  },
  required: productRequired,
} as const;

// a product of a list: the primary image only; every role gets the popularity it sorts by
const productItemResponseSchema = {
  $id: 'productItemResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    ...productFields,
    images: {
      ...imageUrlsSchema,
      nullable: true,
      description:
        'The primary image. A buyer lists only the products with one; an admin lists a product ' +
        'without one too, with null here.',
    },
    popularity: { type: 'integer' },
  },
  required: productRequired,
} as const;

const productsListResponseSchema = {
  $id: 'productsListResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    items: {
      type: 'array',
      items: { $ref: 'productItemResponseSchema#' },
    },
    limit: { type: 'integer', minimum: 1, maximum: 100 },
    nextCursor: {
      anyOf: [{ type: 'string', pattern: '^[A-Za-z0-9_-]+$', minLength: 1 }, { type: 'null' }],
    },
  },
  required: ['items', 'limit'],
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
      description: 'nextCursor of the previous page, of the same sort (CURSOR_INVALID otherwise).',
    },
    limit: { type: 'integer', minimum: 1, maximum: 100 },
    sort: {
      type: 'string',
      enum: ['newest', 'helpful', 'ratingHigh', 'ratingLow'],
      description:
        'newest (the default), helpful (the most votes up first), ratingHigh, ratingLow; a ' +
        'review without a rating comes last, the newest first among the same values.',
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
      description: 'Admin or root only: the removals the rules allow (REVIEW_REMOVALS_LIMIT).',
    },
  },
  required: ['message'],
} as const;

// the article number of a product: one product of the catalog has it at a time
const skuField = {
  type: ['string', 'null'],
  maxLength: 64,
  description:
    'The article number, up to 64 signs of any kind, trimmed; empty or null takes it away. One ' +
    'product of the catalog has it at a time, whatever the case of its letters ' +
    '(PRODUCT_SKU_TAKEN); a product taken out of the catalog lets it go. A longer one in a form ' +
    'is PRODUCT_SKU_TOO_LONG.',
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
    sku: { ...skuField, type: 'string' },
    ...safetyFormFields,
    price: moneyField,
    categoryId: { type: 'integer', minimum: 1 },
    images: productImagesFormField,
  },
  required: [
    'name',
    'price',
    'categoryId',
    'images',
    'safety.manufacturer.name',
    'safety.manufacturer.address',
    'safety.manufacturer.email',
    'safety.manufacturer.country',
  ],
} as const;

const saleEndsAtField = {
  type: 'string',
  format: 'date-time',
  description: 'When the sale ends, in the future; the sale starts right away.',
} as const;

// a percent of the price or an amount off it, never both: the shapes leave out
// additionalProperties, ajv strips an unknown field while it tries a shape of anyOf (fastify
// removeAdditional) and would let a percent and an amount through as a percent
const saleDiscountShapes = [
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
      description: 'The text of the description; empty takes it away, the safety data stay.',
    },
    sku: skuField,
    safety: productSafetyBodyField,

    price: moneyField,

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

    // null first: with coerceTypes the string shape would turn null into ""
    sale: {
      description:
        'With a price, what happens to the sale that is on: keep keeps it (a price down to the ' +
        'sale price or below cannot, PRODUCT_SALE_NOT_BELOW_PRICE), null takes it off, a new ' +
        'sale takes the old one off and is put on from the new price. Each step writes every ' +
        'line of the logs. A new price of a product on sale without it is ' +
        'PRODUCT_SALE_DECISION_REQUIRED; without a price it is PRODUCT_SALE_REQUIRES_PRICE.',
      anyOf: [{ type: 'null' }, { type: 'string', enum: ['keep'] }, ...saleDiscountShapes],
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
      items: { $ref: 'productResponseSchema#' },
    },
  },
  required: ['products'],
} as const;

// documentation only: the form of PATCH /api/products/:productId, the fields of the json body
// and the images; empty or null clears a popularity override and its end, which go together
const productUpdateFormSchema = {
  $id: 'productUpdateFormSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1 },
    description: { type: 'string' },
    sku: { ...skuField, type: 'string' },
    // any of them replaces the safety data whole, the ones of the manufacturer are required then
    ...safetyFormFields,
    price: moneyField,
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
    sale: {
      type: 'string',
      enum: ['keep', 'remove'],
      description:
        'With a price, what happens to the sale that is on: keep it or remove it ' +
        '(PRODUCT_SALE_ACTION_INVALID for any other word). A new sale comes as JSON or through ' +
        'PATCH /api/products/{productId}/sale.',
    },
    images: {
      ...productImagesFormField,
      description: `${productImagesFormField.description} They replace all images of the product.`,
    },
  },
} as const;

const productSaleBodySchema = {
  $id: 'productSaleBodySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    sale: {
      description:
        'The discount until endsAt, by a percent of the price or by an amount of money off it; ' +
        'the sale price is rounded to cents and stays below the price, 0 gives the product ' +
        'away. A new sale writes over the one there is. null takes the sale off.',
      anyOf: [...saleDiscountShapes, { type: 'null' }],
    },
  },
  required: ['sale'],
} as const;

// sales of many products at once: a sale for each product, or one sale for the products of a
// category. One of the two shapes; the fields sit on the object itself and the shapes only name
// what they need, so that fastify removeAdditional strips nothing while ajv tries a shape
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
        'A sale for each product, each product once (SALE_PRODUCTS_REPEATED); without categoryId.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          productId: { type: 'integer', minimum: 1, maximum: MAX_ID },
          sale: salesSaleField,
        },
        required: ['productId', 'sale'],
      },
    },
    categoryId: {
      type: 'integer',
      minimum: 1,
      maximum: MAX_ID,
      description:
        'One sale for the products of the catalog of the category, with sale; without items.',
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

const productSalesResponseSchema = {
  $id: 'productSalesResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    products: {
      type: 'array',
      description:
        'The products of the request: in the order of the items, or by id for a category.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'integer' },
          name: { type: 'string' },
          price: { type: 'number' },
          salePrice: { type: 'number' },
          saleEndsAt: { type: 'string', format: 'date-time' },
          salePriorPrice: {
            anyOf: [{ type: 'number' }, { type: 'null' }],
            description: 'The lowest price of the 30 days before the sale.',
          },
          status: {
            type: 'string',
            enum: ['set', 'unchanged'],
            description: 'set: the sale was put on; unchanged: the product had this sale already.',
          },
        },
        required: ['id', 'name', 'price', 'salePrice', 'saleEndsAt', 'salePriorPrice', 'status'],
      },
    },
  },
  required: ['products'],
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
        },

        minPrice: { type: 'number', minimum: 0 },
        maxPrice: { type: 'number', minimum: 0 },

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
  allOf: [{ $ref: 'productResponseSchema#' }],
} as const;

// STOCK: a delivery takes in a batch of each item, a write-off takes free units out
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

// an item names its product by the id or by the article number the papers of a supplier name,
// one of the two
const stockSkuField = {
  type: 'string',
  minLength: 1,
  maxLength: 64,
  description:
    'The article number of a product of the catalog, in place of productId, whatever the case of ' +
    'its letters; a number no product of the catalog has is PRODUCT_NOT_FOUND with details.skus.',
} as const;

const STOCK_PRODUCT_REF = [{ required: ['productId'] }, { required: ['sku'] }] as const;

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
    items: {
      type: 'array',
      minItems: 1,
      maxItems: 100,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          productId: stockIdField('Id of the product, or sku in its place'),
          sku: stockSkuField,
          quantity: stockQuantityField,
          unitCost: {
            type: 'number',
            minimum: 0,
            maximum: 99_999_999.99,
            description:
              'The cost of a unit in the currency of the shop, to the cent (finer is ' +
              'BATCH_UNIT_COST_INVALID); 0 for a gift or a sample.',
          },
          expiresAt: {
            type: 'string',
            format: 'date',
            description:
              'The last day the goods are good for, yyyy-mm-dd, today or later by utc ' +
              '(BATCH_EXPIRES_AT_INVALID). A sale takes the batch that ends first.',
          },
          supplierBatchNumber: {
            type: 'string',
            maxLength: 100,
            description: 'The number the supplier gave the batch.',
          },
        },
        required: ['quantity', 'unitCost'],
        oneOf: STOCK_PRODUCT_REF,
      },
    },
  },
  required: ['source', 'items'],
} as const;

const stockProductSummarySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'integer' },
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
  required: ['id', 'stock', 'totalStock', 'reservedStock', 'expiredStock'],
} as const;

const stockDeliveryResponseSchema = {
  $id: 'stockDeliveryResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    deliveryId: {
      type: 'string',
      format: 'uuid',
      description: 'The delivery: its batches and the lines of the admin log carry it.',
    },
    batches: {
      type: 'array',
      description: 'A batch for each item, in the order of the items.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'integer', description: 'The number of the batch in the shop.' },
          productId: { type: 'integer' },
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
          'productId',
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
    products: { type: 'array', items: stockProductSummarySchema },
  },
  required: ['deliveryId', 'batches', 'products'],
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
          productId: stockIdField('Id of the product, or sku in its place'),
          sku: stockSkuField,
          quantity: stockQuantityField,
          batchId: stockIdField(
            'The batch of the product to take the units from; without one they come in the ' +
              'order of a sale, the batch that ends first, then the oldest',
          ),
        },
        required: ['quantity'],
        oneOf: STOCK_PRODUCT_REF,
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
      description: 'The write-off: the lines of the admin log carry it.',
    },
    items: {
      type: 'array',
      description: 'What each item took, in the order of the items.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          productId: { type: 'integer' },
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
        required: ['productId', 'quantity', 'batches'],
      },
    },
    products: { type: 'array', items: stockProductSummarySchema },
  },
  required: ['writeOffId', 'items', 'products'],
} as const;

// the history of the price of a product
const priceHistoryQuerySchema = {
  $id: 'priceHistoryQuerySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    limit: { type: 'integer', minimum: 1, maximum: 100, description: '50 unless given.' },
    cursor: { type: 'string', minLength: 1, pattern: '^[A-Za-z0-9_-]+$' },
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
          actor: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'integer' },
              name: { type: ['string', 'null'] },
              deleted: { type: 'boolean' },
            },
            required: ['id', 'name', 'deleted'],
          },
          createdAt: { type: 'string', format: 'date-time' },
        },
        required: ['id', 'oldPrice', 'newPrice', 'mode', 'value', 'endsAt', 'actor', 'createdAt'],
      },
    },
    limit: { type: 'integer' },
    nextCursor: { type: ['string', 'null'] },
  },
  required: ['items', 'limit', 'nextCursor'],
} as const;

export const productDtoSchemas = [
  getAllProductsQuerySchema,
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
  getProductReviewsQuerySchema,
  reviewResponseSchema,
  reviewsResponseSchema,
  deleteProductReviewParamsSchema,
  deleteProductReviewResponseSchema,
  productsListResponseSchema,
  productItemResponseSchema,
  productsUpdateCategoryParamsSchema,
  productsUpdateCategoryBodySchema,
  productsUpdateCategoryResponseSchema,
  stockDeliveryBodySchema,
  stockDeliveryResponseSchema,
  stockWriteOffBodySchema,
  stockWriteOffResponseSchema,
];
