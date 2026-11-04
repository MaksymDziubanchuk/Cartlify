import type { FastifySchema } from 'fastify';

import env from '@config/env.js';
import { MAX_PRODUCT_IMAGES, MAX_UPLOAD_SIZE_BYTES } from '@config/limits.js';
import { openApiSecurity } from '@config/openapi.js';
import { withOpenApiSecurityFor } from '@helpers/withOpenApiSecurity.js';
import { withOpenApiTag } from '@helpers/withOpenApiTag.js';

import {
  DUPLICATE_409,
  EXAMPLE_VARIANT_ATTRIBUTES,
  EXAMPLE_VARIANT_NAME,
  EXAMPLE_VARIANT_VALUES,
  NOT_FOUND_ATTRIBUTE,
  REQUIRED_400,
  VALUES_400_WRAPPED,
} from './variantValues.docs.js';

const MAX_IMAGE_MB = MAX_UPLOAD_SIZE_BYTES / 1_000_000;

const productImageUrlsExample = {
  url200: 'https://example.com/products/headphones-200.webp',
  url400: 'https://example.com/products/headphones-400.webp',
  url800: 'https://example.com/products/headphones-800.webp',
};

// the product of a buyer: what helps to buy it (the price, the stock and the picture are the
// variant's)
const productBuyerFieldsExample = {
  id: 10,
  name: 'Wireless headphones',
  description: 'Bluetooth headphones with noise cancellation.',
  category: { id: 1, name: 'Headphones', slug: 'headphones' },
  avgRating: 4.7,
  reviewsCount: 18,
  createdAt: '2026-01-01T10:00:00.000Z',
};

// the weight and the packed sizes of a variant
const productShippingFieldsExample = {
  weightGrams: 350,
  lengthMm: 200,
  widthMm: 100,
  heightMm: 50,
};

// what an admin and root get of the product on top
const productAdminFieldsExample = {
  popularity: 120,
  views: 350,
  updatedAt: '2026-01-02T10:00:00.000Z',
  popularityOverride: null,
  popularityOverrideUntil: null,
  deletedAt: null,
};

// the product of a row of a list
const productListItemExample = {
  ...productBuyerFieldsExample,
  popularity: 120,
};

// a variant in the short form: what a list, a cart and the switch between variants show
const variantShortExample = {
  id: 31,
  position: 1,
  name: EXAMPLE_VARIANT_NAME,
  values: EXAMPLE_VARIANT_VALUES,
  price: 49.99,
  salePrice: 39.99,
  saleEndsAt: '2026-12-01T00:00:00.000Z',
  salePriorPrice: 44.99,
  stock: 15,
  image: productImageUrlsExample,
};

const variantFullExample = {
  ...variantShortExample,
  sku: 'WH-1000',
  ...productShippingFieldsExample,
  attributes: EXAMPLE_VARIANT_ATTRIBUTES,
  images: [{ id: 5, position: 1, ...productImageUrlsExample }],
};

// the card of a buyer: the product, the variant it opens, the variants to switch between
const productResponseExample = {
  product: {
    ...productBuyerFieldsExample,
    category: {
      ...productBuyerFieldsExample.category,
      path: [{ id: 3, name: 'Audio', slug: 'audio' }],
    },
    manufacturer: {
      id: 7,
      name: 'Sound GmbH',
      address: 'Klangstrasse 2, 10115 Berlin, Germany',
      email: 'safety@sound.example.com',
      country: 'DE',
    },
    euResponsible: null,
    warnings: 'Do not listen at a high volume for a long time.',
    documents: [],
    withdrawal: { rule: 'sealed_media', right: 'conditional' },
  },
  variant: variantFullExample,
  variants: [variantShortExample],
};

// the card an admin gets, the answer of every change of a product
const productAdminResponseExample = {
  product: {
    ...productResponseExample.product,
    ...productAdminFieldsExample,
    withdrawal: {
      rule: 'sealed_media',
      right: 'conditional',
      own: null,
      source: 'category',
      categoryId: 3,
    },
    gallery: [{ id: 5, position: 0, ...productImageUrlsExample, variantIds: [31] }],
  },
  variant: {
    ...variantFullExample,
    barcode: '4006381333931',
    totalStock: 17,
    reservedStock: 2,
    expiredStock: 0,
    lastUnitCost: 21.5,
    updatedAt: '2026-01-02T10:00:00.000Z',
    visible: true,
    deletedAt: null,
  },
  variants: [{ ...variantShortExample, visible: true, deletedAt: null }],
};

const productsQueryExample = {
  limit: 20,
  search: 'headphones',
  categoryIds: '1,2',
  inStock: true,
  sort: 'popularity',
  order: 'desc',
};

// a product row: the main variant, the prices of the variants of the list, their free units
const productsListResponseExample = {
  items: [
    {
      product: productListItemExample,
      variant: variantShortExample,
      minPrice: 39.99,
      maxPrice: 54.99,
      stock: 32,
    },
  ],
  limit: 20,
  total: 41,
  nextCursor: 'eyJpZCI6MTB9',
};

// a variant row, the way an admin gets it: the query asked for the sale
const productsAdminListResponseExample = {
  items: [
    {
      product: { ...productListItemExample, ...productAdminFieldsExample },
      variant: productAdminResponseExample.variant,
      stock: 15,
    },
  ],
  limit: 20,
  total: 1,
};

const productIdParamsExample = {
  productId: '10',
};

const productReviewsQueryExample = {
  limit: 10,
  cursor: 'eyJpZCI6MX0',
};

// the author of a review: a name and the pictures of the avatar
const reviewAuthorExample = {
  id: 1,
  name: 'Anna',
  avatarUrls: {
    url32: 'https://example.com/avatars/anna-32.webp',
    url64: 'https://example.com/avatars/anna-64.webp',
    url128: 'https://example.com/avatars/anna-128.webp',
    url256: 'https://example.com/avatars/anna-256.webp',
  },
  avatarIsDefault: false,
  deleted: false,
};

const reviewExample = {
  id: 1,
  productId: 10,
  rating: 5,
  comment: 'Great product.',
  userId: 1,
  user: reviewAuthorExample,
  verifiedPurchase: true,
  upVotes: 3,
  downVotes: 0,
  userVote: 'up',
  createdAt: '2026-01-01T10:00:00.000Z',
  updatedAt: '2026-01-01T10:00:00.000Z',
};

const reviewsResponseExample = {
  items: [
    reviewExample,
    // the account of the author was deleted
    {
      ...reviewExample,
      id: 2,
      userId: 7,
      user: { ...reviewAuthorExample, id: 7, name: 'Guest', avatarIsDefault: true, deleted: true },
    },
  ],
  limit: 10,
  total: 2,
  nextCursor: 'eyJpZCI6MX0',
};

const createReviewBodyExample = {
  rating: 5,
  comment: 'Great product.',
};

const updateProductBodyExample = {
  name: 'Wireless headphones Pro',
  description: 'Updated product description.',
  categoryId: 1,
  popularityOverride: 500,
  popularityOverrideUntil: '2026-02-01T10:00:00.000Z',
};

const bulkUpdateProductsPriceBodyExample = {
  mode: 'percent',
  value: 10,
  scope: {
    categoryId: 1,
    productIds: [10, 11],
    minPrice: 10,
    maxPrice: 100,
    inStock: true,
    deleted: false,
  },
  dryRun: false,
  reason: 'Seasonal price update',
};

const bulkUpdateProductsPriceResponseExample = {
  message: 'PRODUCTS_PRICE_BULK_UPDATED',
  updatedCount: 12,
};

// a dry run lists what it would change
const bulkUpdateProductsPriceDryRunExample = {
  message: 'DRY_RUN',
  updatedCount: 1,
  variants: [
    { id: 31, productId: 10, name: 'Wireless headphones', oldPrice: 49.99, newPrice: 54.99 },
  ],
};

// the answer of a sale route: each variant with its sale now and what was done to it
const variantSalesResponseExample = {
  variants: [
    {
      id: 31,
      productId: 10,
      name: 'Wireless headphones',
      price: 49.99,
      salePrice: 39.99,
      saleEndsAt: '2026-12-01T00:00:00.000Z',
      salePriorPrice: 49.99,
      status: 'set',
    },
    {
      id: 32,
      productId: 10,
      name: 'Wireless headphones',
      price: 59.99,
      salePrice: 39.99,
      saleEndsAt: '2026-12-01T00:00:00.000Z',
      salePriorPrice: 54.99,
      status: 'unchanged',
    },
  ],
};

const deleteProductReviewParamsExample = {
  productId: '10',
  reviewId: '1',
};

const updateProductCategoryBodyExample = {
  categoryId: 2,
};

const messageResponseExample = {
  message: 'Operation completed successfully.',
};

// Schema for catalog product listing
const getAllProductsRouterSchema = {
  operationId: 'getProducts',
  summary: 'Get products',
  description:
    'Returns a paginated catalog list with filtering, sorting and search support. A row is ' +
    '`{ product, variant, minPrice?, maxPrice?, stock }`. It is a PRODUCT row when the query asks ' +
    'nothing of a variant (a category, a search, `sort` by `popularity`, `createdAt`, `name`, ' +
    '`avgRating`, `sales`, `relevance`, `inStock`): one row per product, with its main variant ' +
    '(the first by its place that has free units, the first of all when none has; with a search ' +
    'by an article number, the variant that has it), `minPrice` and `maxPrice` (the lowest and ' +
    'the highest price its variants sell at now, the sale price while a sale lasts) and `stock` ' +
    '(the free units of its variants). It is a row of VARIANTS when the query asks something of ' +
    'a variant (`sort` by `price`, `discount` or `saleEndsAt`, `minPrice`, `maxPrice`, the filter ' +
    '`f` by characteristics, and for an admin `salePrice`, the stock sorts, `onSale`, `maxStock`, ' +
    '`withoutShippingData`): the variants that fit the query of ONE product with the same value ' +
    'of every MAIN characteristic (a colour; a variant without a value of one is a value of its ' +
    'own, a product with no main characteristic is one group) are one row, a GROUP. A group has ' +
    'the first variant of it by its place as `variant` (its picture, the card it opens), ' +
    '`minPrice` and `maxPrice` of its variants (the same when they sell at one price: show a ' +
    'price, else from..to) and `stock` (the free units of its variants). A T-shirt with a main ' +
    'colour and a size that is not main has a row for each colour. If variants have to look ' +
    'different in a list, the characteristic that tells them apart must be main; what a buyer ' +
    'chooses by must be a choice from a list. A sort by `price` puts a group where its lowest ' +
    'price stands going up and where its highest stands going down; only the variants that fit ' +
    'the price filter are in the group. An admin who sends `group=false` gets every variant on a ' +
    'row of its own (`stock` the units of the variant, no `minPrice` or `maxPrice`). `total` is ' +
    'the number of the rows (groups) the filters find; a `cursor` of rows of one kind (products, ' +
    'groups, single variants) does not continue a list of another (`CURSOR_INVALID`). A buyer (guest, user) gets the ' +
    'short variant and only what he sees: a product that is not deleted and a variant that is for ' +
    'sale and shows a picture; a product none of whose variants he sees is in no list. Admin and ' +
    'root get the full variant, with the stock, the reserve and the cost of the latest delivery, ' +
    'the counters and the popularity override of the product, and list the variants without a ' +
    'picture too. `search` forgives a typo and another order of the words and finds a product by ' +
    'the name of its category and by the article number of a variant too (admin and root by a ' +
    'barcode as well); with it the best match comes first (`sort: relevance`). `categoryIds` ' +
    'takes the products of the whole branch of each category, `branch=false` only of each ' +
    'category itself. A buyer sorts by `relevance`, `createdAt`, `price`, `popularity`, ' +
    '`avgRating`, `name`, `sales` and `saleEndsAt` or `discount` (the variants on sale first, ' +
    'then the rest by the popularity of their product), any other sort is `SORT_FORBIDDEN`; the ' +
    'flags of an admin are `DELETED_PRODUCTS_FORBIDDEN` and `FILTER_FORBIDDEN` for a buyer. An ' +
    'admin sorts by any field. `deleted`, `onSale`, `popularityOverridden`, `maxStock` and ' +
    '`withoutShippingData` list only the products that are deleted, the variants that have a ' +
    'sale that is on, the products that have a popularity override that is on (its end ahead), ' +
    'the variants that have no more free units than the number, the variants that lack the ' +
    'weight or the sizes, whatever else they have; without any flag an admin gets only the plain ' +
    'products, not deleted, without a sale (on any variant) and an override that are on. A sort ' +
    'by the field of a flag needs the flag. The filters that find the gaps of the catalog are ' +
    'flags of an admin too (a sale or an override do not filter next to them, the removed ' +
    'products come only with `deleted`): by a variant, `missingRequired` (a characteristic its ' +
    'category requires has no value), `withoutWeight`, `withoutDimensions` (any of the three ' +
    'sizes), `withoutBarcode`, `withoutImages`, which make the rows variants (groups unless ' +
    '`group=false`); by a product, `hiddenFromBuyers` (true: removed, or none of its variants is ' +
    'one a buyer sees; false: the products he sees) and `hasDeletedVariants`, which leave the ' +
    'rows products; and `manufacturerId`, `euResponsibleId`, `documentId` (the party or the ' +
    'document of the directory, 404 when there is none). They come with every other filter, ' +
    '`f`, the search, the sorts and the cursor, and `total` counts the rows they leave. ' +
    'For a buyer `sort: price`, `minPrice` and `maxPrice` ' +
    'take the price a variant sells at now: the sale price while its sale lasts (`salePrice` ' +
    'until `saleEndsAt`, shown next to the usual `price`), the price otherwise. For an admin they ' +
    'take the usual `price`, and `sort: salePrice` (with `onSale`) sorts the variants on sale by ' +
    'their sale price.',

  querystring: {
    $ref: 'getAllProductsQuerySchema#',
    examples: [productsQueryExample],
  },

  response: {
    200: {
      description: 'Products were returned successfully, as a buyer or as an admin sees them.',
      $ref: 'productsListResponseSchema#',
      examples: [productsListResponseExample, productsAdminListResponseExample],
    },

    400: {
      description:
        'Invalid products query parameters: a sort by the field of a flag without the flag ' +
        '(`SORT_DELETED_AT_REQUIRES_DELETED`, `SORT_SALE_ENDS_AT_REQUIRES_ON_SALE`, ' +
        '`SORT_SALE_PRICE_REQUIRES_ON_SALE`, `SORT_DISCOUNT_REQUIRES_ON_SALE`, ' +
        '`SORT_POPULARITY_OVERRIDE_REQUIRES_OVERRIDDEN`), `sort: relevance` without a search ' +
        '(`SORT_RELEVANCE_REQUIRES_SEARCH`), a period of the sort by sales that does not end ' +
        'after it starts (`SALES_PERIOD_INVALID`), `CATEGORY_IDS_INVALID`, a `minPrice` above ' +
        'the `maxPrice` (`PRICE_RANGE_INVALID`), `CURSOR_INVALID`. ' +
        '`FILTER_INVALID`: the filter `f` is wrong; `details.reason` is `ENTRY_INVALID` (the text ' +
        'is no `<id>:<value>`), `VALUE_INVALID`, `RANGE_ORDER` (a range that ends before it ' +
        'starts), `ATTRIBUTE_REPEATED` (a characteristic twice), `TOO_MANY_ENTRIES`, ' +
        '`TOO_MANY_VALUES`, `ENTRY_TOO_LONG` (syntax), `ATTRIBUTE_NOT_FOUND`, ' +
        '`ATTRIBUTE_NOT_FILTERABLE` (a text), `VALUE_FORM_MISMATCH` (the entry is not of the form ' +
        'of the type, `details.expected`), `OPTION_NOT_FOUND` (values that are not of the ' +
        'characteristic, `details.optionIds`); `details.entry` and `details.index` name the entry.',
      $ref: 'errorResponseSchema#',
    },
    401: {
      description: 'Authentication or guest session is required to read products.',
      $ref: 'errorResponseSchema#',
    },
    403: {
      description:
        'A guest or a user asks for something of an admin: deleted products ' +
        '(`DELETED_PRODUCTS_FORBIDDEN`), the flag `onSale`, `popularityOverridden`, ' +
        '`maxStock`, `withoutShippingData`, `missingRequired`, `withoutWeight`, ' +
        '`withoutDimensions`, `withoutBarcode`, `withoutImages`, `hiddenFromBuyers=true`, ' +
        '`hasDeletedVariants`, `manufacturerId`, `euResponsibleId`, `documentId` or ' +
        '`group=false` (`FILTER_FORBIDDEN`, `details.filter`), a sort of an admin ' +
        '(`SORT_FORBIDDEN`, `details.sort`).',
      $ref: 'errorResponseSchema#',
    },
    404: {
      description:
        'A party or a document the filter names is not in the directory: `manufacturerId` ' +
        '(`MANUFACTURER_NOT_FOUND`), `euResponsibleId` (`EU_RESPONSIBLE_NOT_FOUND`), ' +
        '`documentId` (`DOCUMENT_NOT_FOUND`); `details` holds the id.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while loading products.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// Schema for the panel of the filter of a category
const catalogFiltersExample = {
  items: [
    {
      id: 12,
      name: 'Colour',
      unit: null,
      group: { id: 3, name: 'Appearance' },
      type: 'option',
      values: [
        { id: 45, name: 'black', colorCode: '#000000', position: 1 },
        { id: 46, name: 'white', colorCode: '#ffffff', position: 2 },
      ],
    },
    {
      id: 15,
      name: 'Memory',
      unit: 'GB',
      group: { id: 4, name: 'Memory' },
      type: 'number',
      min: 128,
      max: 512,
    },
    {
      id: 20,
      name: 'Waterproof',
      unit: null,
      group: { id: 5, name: 'Protection' },
      type: 'boolean',
      values: ['yes', 'no'],
    },
  ],
};

const getCatalogFiltersRouterSchema = {
  operationId: 'getCatalogFilters',
  summary: 'Get the filter of a category',
  description:
    'The panel of the filter for a category: the characteristics its variants are told apart ' +
    'by, made from the variants a buyer sees in it (alive, with a picture, of a product that is ' +
    'not deleted). `categoryId` is the category; the products of everything below it count too ' +
    '(a parent sees the products of its children), `branch=false` takes the products of the ' +
    'category itself only. A characteristic is in the panel when it is in the filters (`inFilters` ' +
    'of the directory), is no text and has at least two different values among those variants: ' +
    'two values of a list, two numbers, both answers of yes/no; a variant without a value is no ' +
    'value. A choice (a colour is one) gives the values that are in the category, in the order the ' +
    'admin put them, with the colour of the swatch; a number gives its lowest and highest value; ' +
    'yes/no gives the answers. There are no counts, and nothing the person chose changes the ' +
    'panel. The ids go into the filter `f` of GET /api/products. Guests, users, admin and root ' +
    'get the same. Characteristics are ordered as on the card: the groups by their place, in a ' +
    'group the characteristics by theirs.',

  querystring: {
    $ref: 'catalogFiltersQuerySchema#',
    examples: [{ categoryId: 7 }],
  },

  response: {
    200: {
      description: 'The panel was returned, maybe empty (a category whose variants do not differ).',
      $ref: 'catalogFiltersResponseSchema#',
      examples: [catalogFiltersExample],
    },
    400: {
      description:
        '`VALIDATION_ERROR`: `categoryId` is missing or is not a whole number from 1 to 2147483647, ' +
        'or `branch` is not a boolean.',
      $ref: 'errorResponseSchema#',
    },
    401: {
      description: 'Authentication or guest session is required.',
      $ref: 'errorResponseSchema#',
    },
    403: {
      description: 'The current actor is not allowed to read the catalog.',
      $ref: 'errorResponseSchema#',
    },
    404: {
      description: '`CATEGORY_NOT_FOUND`: there is no such category.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while loading the filter.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// Schema for single product lookup
const getProductByIdRouterSchema = {
  operationId: 'getProductById',
  summary: 'Get product by id',
  description:
    'Returns the card of a product: `product` (the part every variant shares), `variant` (the ' +
    'one opened, in full) and `variants` (every variant to switch between, in the short form). ' +
    '`?variantId=` opens that variant; without it the card opens the main variant: the first by ' +
    'its place that has free units, the first of all when none has. A buyer (guest, user) gets ' +
    'the fields that help to buy, without the popularity, and only the variants that are for ' +
    'sale and show a picture; admin and root get the counters, the whole stock, the reserve, the ' +
    'cost of the latest delivery, the popularity override, the gallery with the variants that ' +
    'show each picture, and every variant of the product, the ones taken out of sale and the ' +
    'ones without a picture too. A visit of a buyer counts as a view, the one of an admin does ' +
    'not. A deleted product, and a product none of whose variants a buyer may see, is shown ' +
    'only to admin and root: guests and users get 404 `PRODUCT_NOT_FOUND` for it, and ' +
    '404 `VARIANT_NOT_FOUND` for a variant of it that they may not see.',

  params: {
    $ref: 'productIdParamSchema#',
    examples: [productIdParamsExample],
  },

  querystring: {
    $ref: 'productCardQuerySchema#',
  },

  response: {
    200: {
      description: 'Product was returned successfully, as a buyer or as an admin sees it.',
      $ref: 'productCardResponseSchema#',
      examples: [productResponseExample, productAdminResponseExample],
    },

    400: {
      description: 'Invalid product id or variant id.',
      $ref: 'errorResponseSchema#',
    },
    401: {
      description: 'Authentication or guest session is required to read this product.',
      $ref: 'errorResponseSchema#',
    },
    403: {
      description: 'The current actor is not allowed to read this product.',
      $ref: 'errorResponseSchema#',
    },
    404: {
      description:
        '`PRODUCT_NOT_FOUND`: there is no such product, or it is deleted, or none of its ' +
        'variants is for sale with a picture, and the actor is not admin or root; ' +
        '`VARIANT_NOT_FOUND`: the product has no such variant, or a buyer may not see it.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while loading product.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// Schema for product reviews listing
const getProductReviewsRouterSchema = {
  operationId: 'getProductReviews',
  summary: 'Get product reviews',
  description:
    'Returns a paginated list of reviews for a product: the newest first, or `sort` helpful ' +
    '(the most votes up), ratingHigh, ratingLow (a review without a rating last). Each review ' +
    'says whether its author bought the product (`verifiedPurchase`: a paid order of it, ' +
    'shipped or delivered too, not cancelled); nothing of it is kept, it is read for the page.',

  params: {
    $ref: 'productIdParamSchema#',
    examples: [productIdParamsExample],
  },

  querystring: {
    $ref: 'getProductReviewsQuerySchema#',
    examples: [productReviewsQueryExample],
  },

  response: {
    200: {
      description: 'Product reviews were returned successfully.',
      $ref: 'reviewsResponseSchema#',
      examples: [reviewsResponseExample],
    },

    400: {
      description:
        'Invalid product reviews request: a sort it does not know (VALIDATION_ERROR), a cursor ' +
        'of another product or another sort, or a changed one (CURSOR_INVALID).',
      $ref: 'errorResponseSchema#',
    },
    401: {
      description: 'Authentication or guest session is required to read product reviews.',
      $ref: 'errorResponseSchema#',
    },
    403: {
      description: 'The current actor is not allowed to read product reviews.',
      $ref: 'errorResponseSchema#',
    },
    404: {
      description:
        'There is no such product, or for a buyer it is removed from the catalog or has no variant a buyer sees (PRODUCT_NOT_FOUND).',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while loading product reviews.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// Schema for admin product creation
const postProductRouterSchema = {
  operationId: 'createProduct',
  summary: 'Create product',
  description:
    'Creates a new product with its variants and its gallery from a multipart form: the fields ' +
    'of the product, the picture files in `images` (the gallery, in their order) and `variants`, ' +
    'a JSON list of 1 to PRODUCT_VARIANTS_MAX variants. A variant has its price, its article ' +
    'number, its barcode, its weight and sizes and the pictures it shows, each named by the ' +
    'number of its file in `images` (from 0) with a place of its own among the pictures of the ' +
    'variant (`{ "file": 0, "position": 1 }`); its place among the variants is its place in ' +
    'the list. Every variant shows a picture (VARIANT_IMAGE_REQUIRED) and every file is shown by ' +
    'some variant (GALLERY_IMAGE_UNUSED). This operation is restricted to privileged users. ' +
    'The images are checked by their content; they become the gallery of the product only when ' +
    'the product is written, a refused request leaves no files. A new product has no stock: it ' +
    'comes with a delivery, POST /api/products/stock/deliveries. It needs the safety and origin ' +
    'data of the EU GPSR: the manufacturer, by its id in the directory of parties (`manufacturerId`) ' +
    'or as a new party by its name, postal address, email and country (`manufacturer.name`, ' +
    '`manufacturer.address`, `manufacturer.email`, `manufacturer.country`), which is added to the ' +
    'directory; a person responsible in the EU for a manufacturer outside it the same way ' +
    '(`euResponsibleId` or `euResponsible.*`); the warnings (`warnings`). The card gives them as ' +
    '`manufacturer`, `euResponsible` and `warnings`. The product may have a rule of withdrawal of ' +
    'its own (`withdrawal`), otherwise it follows its category; the card gives the rule it has as ' +
    '`withdrawal`. The shipping needs what a variant weighs and ' +
    'measures packed: `weightGrams` and the three sizes `lengthMm`, `widthMm`, `heightMm`, whole ' +
    'grams and millimetres; a variant has them unless `withoutShippingData: true` says they come ' +
    'later (the flag is not kept). A variant also has the values of its characteristics of the ' +
    'directory, `attributes: [{ attributeId, value }]` (see POST /api/products/{productId}/variants); ' +
    'the characteristics the category asks as required must have one, and no two variants may ' +
    'have the same values of all of them. The answer is the card of an admin.',

  response: {
    201: {
      description: 'Product was created successfully: its card as an admin sees it.',
      $ref: 'productCardResponseSchema#',
      examples: [productAdminResponseExample],
    },

    400: {
      description:
        'Invalid product form: not a form (MULTIPART_REQUIRED), no images ' +
        '(PRODUCT_IMAGES_REQUIRED), a missing field (BODY_NOT_FULL), a wrong name or category id ' +
        '(PRODUCT_NAME_INVALID, CATEGORY_ID_INVALID), a stock (PRODUCT_STOCK_NOT_ALLOWED), ' +
        'no manufacturer (MANUFACTURER_REQUIRED), a party named by its id and by its values at once ' +
        '(PARTY_CHOICE_AMBIGUOUS, `details.field`), an id that is not a whole number ' +
        '(PARTY_ID_INVALID, `details.field`), the values of a new party missing ' +
        '(PARTY_FIELDS_REQUIRED, `details.fields`) or wrong (PARTY_FIELDS_INVALID, ' +
        '`details.fields`), warnings over 2000 signs (PRODUCT_WARNINGS_TOO_LONG, `details.max`), a ' +
        'rule of withdrawal there is not (WITHDRAWAL_RULE_INVALID, `details.allowed`), a ' +
        'manufacturer outside the EU without a person responsible in the EU ' +
        '(PRODUCT_EU_RESPONSIBLE_REQUIRED), a person that is not in the EU ' +
        '(EU_RESPONSIBLE_NOT_IN_EU), ' +
        'a document id that is no whole number (DOCUMENT_ID_INVALID), an id twice ' +
        '(DOCUMENT_IDS_REPEATED, `details.ids`), more documents than the limit ' +
        '(PRODUCT_DOCUMENTS_TOO_MANY, `details.max`); the variants: no list or an empty one ' +
        '(VARIANTS_REQUIRED), more than the limit (PRODUCT_VARIANTS_TOO_MANY, `details.max`), a ' +
        'variant that is wrong (VARIANTS_INVALID: `details.variants` names each such variant by ' +
        'its `index` with its own `errorCode` and `details`: PRODUCT_PRICE_INVALID, ' +
        'PRODUCT_SKU_TOO_LONG, VARIANT_BARCODE_INVALID, PRODUCT_SHIPPING_DATA_REQUIRED, ' +
        'PRODUCT_WEIGHT_INVALID, PRODUCT_SIZES_INVALID, PRODUCT_SIZES_INCOMPLETE, ' +
        'PRODUCT_WITHOUT_SHIPPING_DATA_INVALID, PRODUCT_STOCK_NOT_ALLOWED, VARIANT_INVALID for an ' +
        'element that is no object, VARIANT_IMAGE_REQUIRED, VARIANT_IMAGES_INVALID for pictures ' +
        'that are no list, VARIANT_IMAGES_TOO_MANY, ' +
        'VARIANT_IMAGES_REPEATED, VARIANT_IMAGE_POSITION_INVALID, VARIANT_IMAGE_NOT_FOUND for a ' +
        'file the form does not have), a file no variant shows (GALLERY_IMAGE_UNUSED, ' +
        '`details.files`: their numbers), an empty image (PRODUCT_IMAGE_STREAM_ERROR), more than ' +
        MAX_PRODUCT_IMAGES +
        ' images (PRODUCT_IMAGES_TOO_MANY, `details.max`), a file that is not a jpeg, png or webp image by its content, whatever type the form names (IMAGE_TYPE_NOT_ALLOWED), an image Cloudinary cannot read (IMAGE_INVALID), or a text of the form with a NUL sign (TEXT_NUL_FORBIDDEN).' +
        VALUES_400_WRAPPED +
        REQUIRED_400,
      $ref: 'errorResponseSchema#',
    },
    401: {
      description: 'Authentication is required to create a product.',
      $ref: 'errorResponseSchema#',
    },
    404: {
      description:
        'The category named does not exist (CATEGORY_NOT_FOUND), the manufacturer or the person ' +
        'in the EU named by an id is not in the directory (MANUFACTURER_NOT_FOUND, ' +
        'EU_RESPONSIBLE_NOT_FOUND), a document named by its id is not in the directory of ' +
        'documents (DOCUMENTS_NOT_FOUND, `details.documentIds`).' +
        NOT_FOUND_ATTRIBUTE,
      $ref: 'errorResponseSchema#',
    },
    403: {
      description: 'The authenticated user is not allowed to create products.',
      $ref: 'errorResponseSchema#',
    },
    409: {
      description:
        'A live variant of the catalog has an article number of the request, whatever the case ' +
        'of its letters, or two variants of the request share one (PRODUCT_SKU_TAKEN, ' +
        '`details.variants`: the index and the article number); the same for a barcode ' +
        '(VARIANT_BARCODE_TAKEN); or a new party the directory already has ' +
        '(PARTY_ALREADY_EXISTS, `details.partyId`: send its id instead).' +
        DUPLICATE_409,
      $ref: 'errorResponseSchema#',
    },
    413: {
      description: `An image is over ${MAX_IMAGE_MB} MB (PAYLOAD_TOO_LARGE). Nothing was created.`,
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while creating product.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// Schema for authenticated user product review creation
const postProductReviewRouterSchema = {
  operationId: 'createProductReview',
  summary: 'Create product review or add its missing part',
  description:
    'Creates a review for a product by the authenticated user (201). ' +
    'A review has a rating, a comment or both; a comment of spaces counts as no comment. ' +
    'One review per user and product: sending again adds the missing part (200), ' +
    'a rating to a comment-only review or a comment to a rating-only review; ' +
    'a rating or a comment that is already set never changes. ' +
    'A comment is checked before anything is written, by a language model with the rules of ' +
    'the shop and by the moderation of OpenAI: a negative opinion is never a reason; obscene ' +
    'words in any form, insults, dangerous content, a text about another thing, ads and ' +
    'personal data are. A refused comment writes nothing, not even the rating of the request. ' +
    'A check that is unavailable lets the comment through, REVIEW_CHECK_ENABLED false turns it ' +
    'off. At most ' +
    env.LIMIT_REVIEW_PER_USER +
    ' reviews a user an hour.',

  params: {
    $ref: 'productIdParamSchema#',
    examples: [productIdParamsExample],
  },

  body: {
    $ref: 'createReviewBodySchema#',
    examples: [createReviewBodyExample, { rating: 4 }, { comment: 'Arrived fast, works well.' }],
  },

  response: {
    200: {
      description: 'The missing rating or comment was added to the existing review.',
      $ref: 'reviewResponseSchema#',
      examples: [reviewExample],
    },
    201: {
      description: 'Product review was created successfully.',
      $ref: 'reviewResponseSchema#',
      examples: [reviewExample],
    },

    400: {
      description:
        'Invalid product review request. `REVIEW_COMMENT_REJECTED`: the check refused the ' +
        'comment, details.reasons lists each rule it breaks: profanity (obscene words in any ' +
        'form), abuse (insults, threats, hate), dangerous (calls to violence or extremism, ' +
        'crimes, sexual content, self-harm), off_topic (not about this product or buying it), ' +
        'spam (ads, links, promo codes, contacts), personal_data (phones, addresses, emails, ' +
        'cards).',
      $ref: 'errorResponseSchema#',
    },
    401: {
      description: 'Authentication is required to create a product review.',
      $ref: 'errorResponseSchema#',
    },
    403: {
      description: 'Only authenticated users with the USER role can create product reviews.',
      $ref: 'errorResponseSchema#',
    },
    404: {
      description: 'Product was not found or is removed from the catalog (PRODUCT_NOT_FOUND).',
      $ref: 'errorResponseSchema#',
    },
    409: {
      description:
        'The review already has this part: REVIEW_RATING_UPDATE_FORBIDDEN, ' +
        'REVIEW_COMMENT_UPDATE_FORBIDDEN or REVIEW_ALREADY_EXISTS when nothing new is sent.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while creating product review.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// Schema for admin product update
const updateProductByIdRouterSchema = {
  operationId: 'updateProductById',
  summary: 'Update product by id',
  description:
    'Updates the fields of a product by product id: the name, the description, the category, ' +
    'the manufacturer and the person responsible in the EU, the warnings, the rule of withdrawal ' +
    '(null gives it up: the product follows its category), the documents and the ' +
    'override of the popularity. This operation is restricted to privileged users. The price, ' +
    'the sale, the article number, the weight and the sizes belong to the variants ' +
    '(PATCH /api/products/{productId}/variants/{variantId}), the pictures to the gallery ' +
    '(POST and DELETE /api/products/{productId}/images). The stock is not changed here ' +
    '(PRODUCT_STOCK_NOT_ALLOWED): it changes only with a delivery or a write-off, POST ' +
    '/api/products/stock/deliveries and /write-offs. Takes a JSON body, or a multipart form with ' +
    'the same fields as text; a file in the form is refused (PRODUCT_IMAGES_NOT_ALLOWED). The ' +
    'answer is the card of an admin.',

  params: {
    $ref: 'productIdParamSchema#',
    examples: [productIdParamsExample],
  },

  body: {
    $ref: 'updateProductBodySchema#',
    examples: [updateProductBodyExample],
  },

  response: {
    200: {
      description: 'Product was updated successfully: its card as an admin sees it.',
      $ref: 'productCardResponseSchema#',
      examples: [
        {
          ...productAdminResponseExample,
          product: {
            ...productAdminResponseExample.product,
            name: 'Wireless headphones Pro',
            description: 'Updated product description.',
            updatedAt: '2026-01-02T10:00:00.000Z',
          },
        },
      ],
    },

    400: {
      description:
        'Invalid product update request: nothing to change (NO_FIELDS_TO_UPDATE), a wrong field ' +
        '(VALIDATION_ERROR for a JSON body, PRODUCT_NAME_INVALID, CATEGORY_ID_INVALID, ' +
        'POPULARITY_OVERRIDE_INVALID, an id of a party that is not a whole number ' +
        '(PARTY_ID_INVALID, `details.field`), warnings over 2000 signs (PRODUCT_WARNINGS_TOO_LONG, ' +
        '`details.max`), a rule of withdrawal there is not (WITHDRAWAL_RULE_INVALID, ' +
        '`details.allowed`), a manufacturer outside the EU without a person responsible in the EU ' +
        '(PRODUCT_EU_RESPONSIBLE_REQUIRED), a person that is not in the EU ' +
        '(EU_RESPONSIBLE_NOT_IN_EU), ' +
        'a document id that is no whole number (DOCUMENT_ID_INVALID), an id twice ' +
        '(DOCUMENT_IDS_REPEATED, `details.ids`), more documents than the limit ' +
        '(PRODUCT_DOCUMENTS_TOO_MANY, `details.max`), ' +
        'POPULARITY_OVERRIDE_UNTIL_INVALID for an end that is not ahead), a popularity override ' +
        'without its end or an end without an override after the change ' +
        '(POPULARITY_OVERRIDE_UNTIL_REQUIRED, POPULARITY_OVERRIDE_REQUIRED), a stock ' +
        '(PRODUCT_STOCK_NOT_ALLOWED), a file in a form (PRODUCT_IMAGES_NOT_ALLOWED), or a text of ' +
        'a form with a NUL sign (TEXT_NUL_FORBIDDEN).',
      $ref: 'errorResponseSchema#',
    },
    401: {
      description: 'Authentication is required to update a product.',
      $ref: 'errorResponseSchema#',
    },
    403: {
      description: 'The authenticated user is not allowed to update products.',
      $ref: 'errorResponseSchema#',
    },
    404: {
      description:
        '`PRODUCT_NOT_FOUND`: there is no product with this id; `CATEGORY_NOT_FOUND`: the ' +
        'category named does not exist; ' +
        '`MANUFACTURER_NOT_FOUND`, `EU_RESPONSIBLE_NOT_FOUND`: the party named is not in the directory; ' +
        '`DOCUMENTS_NOT_FOUND`: a document named is not in the directory of documents (`details.documentIds`).',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while updating product.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// Schema for a change of many products at once
const patchProductsBatchRouterSchema = {
  operationId: 'updateProductsBatch',
  summary: 'Update many products at once',
  description:
    'Changes up to 100 products, each with fields of its own: the fields of the JSON body of ' +
    'PATCH /api/products/{productId} (the name, the description, the category, the manufacturer and ' +
    'the person responsible in the EU, the warnings, the documents, the override of the ' +
    'popularity), with the same checks and every line of the logs; the fields left out stay, ' +
    'there are no images. The price, the sale, the article number and the weight are the ' +
    "variants': PATCH /api/products/variants/batch. All of them or none: the fields of every " +
    'product are checked first, then every product as it is, and nothing is written while one is ' +
    'refused. A refusal names in `details.products` every product refused the same way, ' +
    '`{ productId }` with the details PATCH of one product gives; a product refused another way ' +
    'shows once the request is fixed. The rows are locked by id, so two such requests over the ' +
    'same products wait for each other. Answers the cards of an admin in the order of the items.',

  body: {
    $ref: 'updateProductsBatchBodySchema#',
    examples: [
      {
        items: [
          { productId: 11, categoryId: 4, warnings: 'Keep dry.' },
          { productId: 12, name: 'Wireless headphones Pro' },
        ],
      },
    ],
  },

  response: {
    200: {
      description: 'The products were changed, their cards in the order of the items.',
      $ref: 'updateProductsBatchResponseSchema#',
    },
    400: {
      description:
        'Invalid request, nothing was changed: a product named twice (PRODUCTS_REPEATED, ' +
        '`details.productIds`), or a product with nothing to change (NO_FIELDS_TO_UPDATE), a ' +
        'wrong field (PRODUCT_NAME_INVALID, CATEGORY_ID_INVALID, ' +
        'POPULARITY_OVERRIDE_INVALID, POPULARITY_OVERRIDE_UNTIL_INVALID, ' +
        'PARTY_ID_INVALID, PRODUCT_WARNINGS_TOO_LONG, WITHDRAWAL_RULE_INVALID, ' +
        'PRODUCT_EU_RESPONSIBLE_REQUIRED, ' +
        'EU_RESPONSIBLE_NOT_IN_EU, DOCUMENT_ID_INVALID, DOCUMENT_IDS_REPEATED, ' +
        'PRODUCT_DOCUMENTS_TOO_MANY), a popularity override without its end ' +
        'or an end without an override after the change (POPULARITY_OVERRIDE_UNTIL_REQUIRED, ' +
        'POPULARITY_OVERRIDE_REQUIRED), a stock (PRODUCT_STOCK_NOT_ALLOWED): ' +
        '`details.products` names them.',
      $ref: 'errorResponseSchema#',
    },
    401: {
      description: 'Authentication is required to update products.',
      $ref: 'errorResponseSchema#',
    },
    403: {
      description: 'The authenticated user is not allowed to update products.',
      $ref: 'errorResponseSchema#',
    },
    404: {
      description:
        '`PRODUCT_NOT_FOUND`: a product is not there; `CATEGORY_NOT_FOUND`: the category named ' +
        'does not exist; `DOCUMENTS_NOT_FOUND`: a document named is not in the directory of ' +
        'documents; `MANUFACTURER_NOT_FOUND`, `EU_RESPONSIBLE_NOT_FOUND`: the party named is not ' +
        'in the directory. `details.products` names them, nothing was changed.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while updating products.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// Schema for admin sale of the variants of a product
const patchProductSaleRouterSchema = {
  operationId: 'setProductSale',
  summary: 'Put the variants of a product on sale or take their sale off',
  description:
    'Puts the variants of a product on sale until `endsAt`, a time in the future: the sale starts ' +
    'right away. The variants are the ones named in `variantIds`, or every variant for sale of the ' +
    'product. The discount is a percent of the price (`percent`, above 0 and up to 100) or an ' +
    'amount of money off it (`amount`, above 0); each variant is counted from its own price, an ' +
    'amount is the same money off each. The server keeps the sale price, rounded to cents (a half ' +
    'cent up) and below the price, 0 gives the variant away; if the discount does not fit the ' +
    'price of a variant (the amount is above it, or comes to nothing) the whole request is refused ' +
    'and names those variants. While the sale lasts the variant sells at the sale price: the ' +
    'cart, the confirm and its smallest payment, the sort and the price filters of the catalog take ' +
    'it, and every answer with the variant shows `salePrice` and `saleEndsAt` next to the usual ' +
    '`price`. A sale past its end is left out of the answers. A new sale writes over the one there ' +
    'is. `sale: null` takes the sales off. A price changed down to the sale price or below ends the ' +
    'sale. The log of prices gets the start of a sale (mode `percent` or `fixed` as the discount ' +
    'was given, the value negative: the percent, or the amount it came to in cents; the end in ' +
    '`endsAt`) and a sale taken off while it was on (`fixed`, from the sale price back to the ' +
    'price). The admin log gets every sale as `PRODUCT_SALE` about the variant: the event ' +
    '(`start`, `change`, `removed`; `ended_by_price` when a price down to it ends it), the price, ' +
    'the sale before and after and the discount. The answer gives the state of each variant: ' +
    '`set`, `removed`, or `unchanged` (the same sale was on already, or there was no sale to take ' +
    'off). A request that leaves every variant as it was is 409 and writes nothing. This operation ' +
    'is restricted to privileged users.',

  params: {
    $ref: 'productIdParamSchema#',
    examples: [productIdParamsExample],
  },

  body: {
    $ref: 'productSaleBodySchema#',
    examples: [
      { sale: { percent: 20, endsAt: '2026-12-01T00:00:00.000Z' } },
      { variantIds: [31], sale: { amount: 5, endsAt: '2026-12-01T00:00:00.000Z' } },
      { sale: null },
    ],
  },

  response: {
    200: {
      description: 'The sales were set or taken off; the state of each variant.',
      $ref: 'productSalesResponseSchema#',
      examples: [variantSalesResponseExample],
    },

    400: {
      description:
        'Invalid sale: a wrong body (VALIDATION_ERROR: a percent of 0 or over 100, an amount of ' +
        '0 or less, both or neither, no end, a variant named twice), a discount that does not fit ' +
        'the price of a variant: an amount above it (PRODUCT_SALE_AMOUNT_TOO_HIGH, ' +
        '`details.variants`: variantId, price), or one that rounds to nothing or a free variant ' +
        '(PRODUCT_SALE_TOO_SMALL, `details.variants`), an end that is not in the future ' +
        '(PRODUCT_SALE_ENDS_AT_INVALID). Nothing is put on.',
      $ref: 'errorResponseSchema#',
    },
    401: {
      description: 'Authentication is required to put variants on sale.',
      $ref: 'errorResponseSchema#',
    },
    403: {
      description: 'The current actor is not admin or root (INSUFFICIENT_ROLE).',
      $ref: 'errorResponseSchema#',
    },
    404: {
      description:
        'The product does not exist or is removed from the catalog (PRODUCT_NOT_FOUND); a ' +
        'variant named is not a variant for sale of this product (VARIANT_NOT_FOUND, ' +
        '`details.variantIds`), or the product has none for sale (VARIANT_NOT_FOUND).',
      $ref: 'errorResponseSchema#',
    },
    409: {
      description:
        'Done already, nothing is written: every variant has the same sale (the same sale price ' +
        'and end) on (PRODUCT_SALE_ALREADY_SET, `details.variantIds`), none has a sale that is on ' +
        'to take off (PRODUCT_SALE_ALREADY_REMOVED, `details.variantIds`). Or a variant is being ' +
        'changed by another request (RESOURCE_BUSY), try again.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while changing the sale.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// Schema for admin bulk variant price update
const patchProductsBulkPriceRouterSchema = {
  operationId: 'bulkUpdateProductPrices',
  summary: 'Bulk update variant prices',
  description:
    'Updates the prices of the variants that fit the filters of `scope` (the category of the ' +
    'product, the products, the variants, the usual price, free units), by a percent or by an ' +
    'amount of money: every variant is counted from its own price. The server always sets ' +
    'scope.deleted to false unless the request says otherwise, so variants taken out of sale (the ' +
    'ones of a deleted product too) are changed only with scope.deleted: true. Without scope every ' +
    'variant for sale is changed. The prices of the scope and of the change are the usual prices, ' +
    'not the sale prices. The sales that are on in the scope get one word in `sale`: keep them, ' +
    'or remove them the way it goes for one variant (the sale off with its lines, then the ' +
    'price); a new sale is set variant by variant. `dryRun: true` changes nothing and lists the ' +
    'variants with their old and new price.',

  body: {
    $ref: 'bulkUpdateProductsPriceBodySchema#',
    examples: [bulkUpdateProductsPriceBodyExample],
  },

  response: {
    200: {
      description: 'Variant prices were updated successfully, or listed by a dry run.',
      $ref: 'bulkUpdateProductsPriceResponseSchema#',
      examples: [bulkUpdateProductsPriceResponseExample, bulkUpdateProductsPriceDryRunExample],
    },

    400: {
      description:
        'Invalid bulk price update request: BULK_PRICE_MODE_INVALID, BULK_PRICE_VALUE_INVALID, ' +
        'BULK_PRICE_PERCENT_TOO_LOW, CATEGORY_ID_INVALID, PRODUCT_IDS_INVALID, ' +
        'VARIANT_IDS_INVALID, MIN_PRICE_INVALID, MAX_PRICE_INVALID, PRICE_RANGE_INVALID, or a ' +
        'new price below 0 for a variant (BULK_PRICE_NEGATIVE_RESULT). BULK_PRICE_TOO_LARGE_RESULT: ' +
        'a new price above 99 999 999.99, `details.variants` `[{ variantId, price }]`, `details.maximum`. FILTER_INVALID: the ' +
        '`scope.f` filter by characteristics is wrong (the same `details.reason` codes as in GET ' +
        '/api/products). A dry run lists the negative price and does not refuse it. No variant ' +
        'is changed.',
      $ref: 'errorResponseSchema#',
    },
    401: {
      description: 'Authentication is required to update variant prices.',
      $ref: 'errorResponseSchema#',
    },
    403: {
      description: 'The authenticated user is not allowed to update variant prices.',
      $ref: 'errorResponseSchema#',
    },
    409: {
      description:
        'Bulk price update conflicts with variant state: variants of the scope are on sale and ' +
        'there is no word on the sales (PRODUCT_SALE_DECISION_REQUIRED, `details.variants`), or ' +
        'keep for new prices down to their sale prices (PRODUCT_SALE_NOT_BELOW_PRICE, ' +
        '`details.variants`). No variant is changed.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while updating variant prices.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// Schema for admin product deletion
const deleteProductByIdRouterSchema = {
  operationId: 'deleteProductById',
  summary: 'Delete product by id',
  description:
    'Takes a product out of the catalog by product id: it is only marked (deletedAt), the ' +
    'orders keep their items. The variants of the product that are for sale go with it (the ' +
    'database marks them with the same date) and come back with it on restore; a variant an ' +
    'admin took out of sale before stays out. This operation is restricted to privileged users.',

  params: {
    $ref: 'productIdParamSchema#',
    examples: [productIdParamsExample],
  },

  response: {
    200: {
      description: 'Product was deleted successfully.',
      $ref: 'messageResponseSchema#',
      examples: [messageResponseExample],
    },

    400: {
      description: 'Invalid product delete request.',
      $ref: 'errorResponseSchema#',
    },
    401: {
      description: 'Authentication is required to delete a product.',
      $ref: 'errorResponseSchema#',
    },
    403: {
      description: 'The authenticated user is not allowed to delete products.',
      $ref: 'errorResponseSchema#',
    },
    404: {
      description: 'Product was not found (PRODUCT_NOT_FOUND).',
      $ref: 'errorResponseSchema#',
    },
    409: {
      description: 'The product is already out of the catalog (PRODUCT_ALREADY_DELETED).',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while deleting product.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// Schema for sales of many variants at once
const postProductSalesRouterSchema = {
  operationId: 'postProductSales',
  summary: 'Put many variants on sale',
  description:
    'Puts sales on many variants at once, all of them or none: `items` gives each variant a ' +
    'sale of its own (`variantId`), or each product (`productId`: all its variants for sale), or ' +
    '`categoryId` with `sale` gives one sale to the variants of the products of the catalog of the ' +
    'category and of the categories below it (`branch=false`: only of the category itself). Each ' +
    'sale is the one of `PATCH /api/products/{productId}/sale`: it starts right away, is counted ' +
    'from the price of its variant, writes over a sale that is on, keeps every line of the logs ' +
    'and names the lowest price of the 30 days before it. A variant that has the same sale ' +
    'already stays as it is (`status: unchanged`). A sale that does not fit the price of a ' +
    'variant refuses the whole request and names those variants. There is no planned sale yet. ' +
    'Admin and root only.',

  body: {
    $ref: 'productSalesBodySchema#',
    examples: [
      {
        items: [
          { productId: 10, sale: { percent: 20, endsAt: '2026-12-01T00:00:00.000Z' } },
          { variantId: 35, sale: { amount: 5, endsAt: '2026-12-15T00:00:00.000Z' } },
        ],
      },
      { categoryId: 1, sale: { percent: 10, endsAt: '2026-12-01T00:00:00.000Z' } },
    ],
  },

  response: {
    200: {
      description: 'The sales are on; each variant of the request with its sale.',
      $ref: 'productSalesResponseSchema#',
      examples: [variantSalesResponseExample],
    },
    400: {
      description:
        'Invalid request: a wrong body (VALIDATION_ERROR: neither items nor a category with a ' +
        'sale, or both, no items or more than 100, an item that names both a variant and a ' +
        'product or neither), a variant named twice, by itself or by its product too ' +
        '(SALE_VARIANTS_REPEATED, `details.variantIds`), an end that is not ahead ' +
        '(PRODUCT_SALE_ENDS_AT_INVALID, `details.items` for items: index and the variant or ' +
        'product), a sale that does not fit a price: an amount above it ' +
        '(PRODUCT_SALE_AMOUNT_TOO_HIGH, `details.variants`: variantId, price), a discount that ' +
        'rounds to nothing or a variant for 0 (PRODUCT_SALE_TOO_SMALL, `details.variants`). ' +
        'Nothing is put on.',
      $ref: 'errorResponseSchema#',
    },
    401: {
      description: 'Authentication is required to put variants on sale.',
      $ref: 'errorResponseSchema#',
    },
    403: {
      description: 'The current actor is not admin or root (INSUFFICIENT_ROLE).',
      $ref: 'errorResponseSchema#',
    },
    404: {
      description:
        'A product does not exist or is removed from the catalog (PRODUCT_NOT_FOUND, ' +
        '`details.productIds`), a variant is not for sale or a product has none for sale ' +
        '(VARIANT_NOT_FOUND, `details.variantIds` or `details.productIds`), or the category does ' +
        'not exist (CATEGORY_NOT_FOUND). Nothing is put on.',
      $ref: 'errorResponseSchema#',
    },
    409: {
      description: 'The variants are busy with another change (RESOURCE_BUSY), try again.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while putting the variants on sale.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// Schema for the suggestions of the search
const getProductSuggestionsRouterSchema = {
  operationId: 'getProductSuggestions',
  summary: 'Suggest product names',
  description:
    'Up to 8 names of the catalog for what a person types, from 2 signs, forgiving a typo; the ' +
    'best match first. A product taken out of the catalog is not among them, nor for a buyer ' +
    'one none of whose variants he sees (a variant is seen when it is for sale and shows a ' +
    'picture); admin and root get it.',

  querystring: {
    $ref: 'productSuggestionsQuerySchema#',
    examples: [{ q: 'headph' }],
  },

  response: {
    200: {
      description: 'The names were returned, maybe none.',
      $ref: 'productSuggestionsResponseSchema#',
      examples: [{ items: [{ id: 10, name: 'Wireless headphones' }] }],
    },
    400: {
      description: 'The text is shorter than 2 signs or longer than 100 (VALIDATION_ERROR).',
      $ref: 'errorResponseSchema#',
    },
    401: {
      description: 'Authentication or guest session is required.',
      $ref: 'errorResponseSchema#',
    },
    403: {
      description: 'The current actor is not allowed to read the catalog.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while loading the suggestions.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// Schema for the history of the price of a product
const getPriceHistoryRouterSchema = {
  operationId: 'getProductPriceHistory',
  summary: 'Get the price history of a product',
  description:
    'Each change of the price of the variants of a product, the newest first, with the variant ' +
    'and who made it: a change of the price, the start of a sale (with its end) and a sale taken ' +
    'off, in the mode it was given and its size, below 0 for a change down. `variantId` keeps the ' +
    'changes of one variant. A product taken out of the catalog keeps its history, so does a ' +
    'variant taken out of sale. Admin and root only.',

  params: {
    $ref: 'productIdParamSchema#',
    examples: [productIdParamsExample],
  },
  querystring: { $ref: 'priceHistoryQuerySchema#', examples: [{ variantId: 31, limit: 20 }] },

  response: {
    200: {
      description: 'The changes of the price of the page.',
      $ref: 'priceHistoryResponseSchema#',
    },
    400: {
      description:
        'Invalid product id or variant id, or a cursor of another list (CURSOR_INVALID).',
      $ref: 'errorResponseSchema#',
    },
    401: {
      description: 'Authentication is required to read the price history.',
      $ref: 'errorResponseSchema#',
    },
    403: {
      description: 'Only admin and root read the price history (INSUFFICIENT_ROLE).',
      $ref: 'errorResponseSchema#',
    },
    404: {
      description:
        '`PRODUCT_NOT_FOUND`: there is no such product; `VARIANT_NOT_FOUND`: the product has no ' +
        'such variant.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while reading the price history.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// Schema for putting a product back into the catalog
const restoreProductRouterSchema = {
  operationId: 'restoreProduct',
  summary: 'Restore product',
  description:
    'Puts a product taken out of the catalog back: the catalog, the search and the cart see it ' +
    'again, and so do its variants that went out with it (a variant an admin took out of sale ' +
    'before stays out, POST .../variants/{variantId}/restore puts it back). The admin log keeps ' +
    'the change of deletedAt (PRODUCT_UPDATE). Admin and root only; they find the products ' +
    'taken out with `GET /api/products?deleted=true`.',

  params: {
    $ref: 'productIdParamSchema#',
    examples: [productIdParamsExample],
  },

  response: {
    200: {
      description: 'The product is back in the catalog: its card as an admin sees it.',
      $ref: 'productCardResponseSchema#',
      examples: [productAdminResponseExample],
    },
    400: {
      description: 'Invalid product id.',
      $ref: 'errorResponseSchema#',
    },
    401: {
      description: 'Authentication is required to restore a product.',
      $ref: 'errorResponseSchema#',
    },
    403: {
      description: 'Only admin and root restore a product (INSUFFICIENT_ROLE).',
      $ref: 'errorResponseSchema#',
    },
    404: {
      description: 'Product was not found (PRODUCT_NOT_FOUND).',
      $ref: 'errorResponseSchema#',
    },
    409: {
      description:
        'The product is in the catalog (PRODUCT_NOT_DELETED), or a live variant of the catalog ' +
        'took the article number (PRODUCT_SKU_TAKEN) or the barcode (VARIANT_BARCODE_TAKEN) of one ' +
        'of its variants meanwhile; nothing is changed.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while restoring the product.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// Schema for product review deletion
const deleteProductReviewRouterSchema = {
  operationId: 'deleteProductReview',
  summary: 'Delete product review',
  description:
    'Deletes a product review by product id and review id. ' +
    'An author deletes own reviews, an admin or root deletes any review. A removal by a ' +
    'moderator goes to the journal of the admins, and the author gets a mail with the number of ' +
    'the removal and the limit the rules allow; a mail that fails is only logged. ' +
    '`reviewRemovals` counts the removals of the reviews of the author by a moderator, this one ' +
    'included; past `reviewRemovalsLimit` the page tells the admin to take the account to root, ' +
    'who alone deletes accounts (DELETE /api/users/{userId}). An author deleting an own review ' +
    'is no removal: the answer has the message alone.',

  params: {
    $ref: 'deleteProductReviewParamsSchema#',
    examples: [deleteProductReviewParamsExample],
  },

  response: {
    200: {
      description: 'Product review was deleted successfully.',
      $ref: 'deleteProductReviewResponseSchema#',
      examples: [
        { message: 'REVIEW_DELETED' },
        { message: 'REVIEW_DELETED', reviewRemovals: 3, reviewRemovalsLimit: 5 },
      ],
    },

    400: {
      description: 'Invalid product review delete request.',
      $ref: 'errorResponseSchema#',
    },
    401: {
      description: 'Authentication is required to delete a product review.',
      $ref: 'errorResponseSchema#',
    },
    403: {
      description: 'A user tries to delete a review of another user (REVIEW_DELETE_FORBIDDEN).',
      $ref: 'errorResponseSchema#',
    },
    404: {
      description:
        'There is no such review, or it is a review of another product (REVIEW_NOT_FOUND).',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while deleting product review.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// Schema for admin product category update
const patchProductCategorySchema = {
  operationId: 'updateProductCategory',
  summary: 'Update product category',
  description:
    'Moves a product to another category. This operation is restricted to privileged users.',

  params: {
    $ref: 'productsUpdateCategoryParamsSchema#',
    examples: [productIdParamsExample],
  },

  body: {
    $ref: 'productsUpdateCategoryBodySchema#',
    examples: [updateProductCategoryBodyExample],
  },

  response: {
    200: {
      description: 'Product category was updated successfully.',
      $ref: 'productsUpdateCategoryResponseSchema#',
      examples: [
        {
          ...productAdminResponseExample,
          product: {
            ...productAdminResponseExample.product,
            category: { id: 2, name: 'Earbuds', slug: 'earbuds', path: [] },
            updatedAt: '2026-01-02T10:00:00.000Z',
          },
        },
      ],
    },

    400: {
      description: 'Invalid product category update request.',
      $ref: 'errorResponseSchema#',
    },
    401: {
      description: 'Authentication is required to update product category.',
      $ref: 'errorResponseSchema#',
    },
    403: {
      description: 'The authenticated user is not allowed to update product category.',
      $ref: 'errorResponseSchema#',
    },
    404: {
      description:
        'Product was not found (PRODUCT_NOT_FOUND), or the category named does not exist (CATEGORY_NOT_FOUND).',
      $ref: 'errorResponseSchema#',
    },
    409: {
      description: 'Product category update conflicts with current product state.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while updating product category.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// Schema for a delivery taken in by an admin
const postStockDeliveryRouterSchema = {
  operationId: 'receiveStockDelivery',
  summary: 'Take in a delivery',
  description:
    'Takes in a batch of each item: units of a variant at their cost of a unit, in the currency ' +
    'of the shop, an optional last good day and the number the supplier gave the batch. An item ' +
    'names its variant by `variantId`, `sku` (its article number) or `barcode`, one of the ' +
    'three; the same variant may stand in several items, each makes a batch. The `unitCost` and ' +
    'the `expiresAt` of the delivery stand in for an item that has none of its own (an item with ' +
    'a null `expiresAt` has no end). The stock of each variant grows by its batches; this is the ' +
    'only way the stock grows, besides a cancel of a paid order that puts its units back. ' +
    '`source` says where the goods come from: `supplier`, `surplus` (an inventory found more ' +
    'than the stock says) or `customer_return` (a buyer brought goods back); the admin gives the ' +
    'cost they count at. The stock log keeps a line (`stock.delivery`) of the variant for each ' +
    'batch in the name of the admin, with the batch and its cost, the supplier, the invoice and ' +
    'the note, and the `deliveryId` the answer gives; the admin log keeps one line ' +
    '`STOCK_DELIVERY` for the whole delivery with the same id (about the variant when the ' +
    'delivery touched one variant, about no thing when it touched more). ' +
    'All of the items or none. A sale takes the batch that ends first, then the ones without an ' +
    'end, the oldest first. A variant taken out of sale takes in nothing. This operation is ' +
    'restricted to privileged users.',

  body: {
    $ref: 'stockDeliveryBodySchema#',
    examples: [
      {
        source: 'supplier',
        supplier: 'Acme',
        document: 'INV-1024',
        unitCost: 31.5,
        items: [
          {
            variantId: 1,
            quantity: 20,
            expiresAt: '2027-06-30',
            supplierBatchNumber: 'LOT-77',
          },
          { sku: 'SH-RED-M', quantity: 5, unitCost: 29 },
          { barcode: '4006381333931', quantity: 8 },
        ],
      },
    ],
  },

  response: {
    201: {
      description: 'The batches were taken in; the stock of each variant after them.',
      $ref: 'stockDeliveryResponseSchema#',
      examples: [
        {
          deliveryId: '2f6a2c3e-6c7b-4d1e-9a51-3b8f0f1d2c4a',
          batches: [
            {
              id: 12,
              productId: 1,
              variantId: 1,
              product: { id: 1, name: 'Shirt' },
              variant: { id: 1, position: 1, name: 'Shirt', sku: 'SH-RED-M' },
              source: 'supplier',
              supplierBatchNumber: 'LOT-77',
              unitCost: 31.5,
              quantity: 20,
              remaining: 20,
              expiresAt: '2027-06-30',
              createdAt: '2026-10-22T10:00:00.000Z',
            },
          ],
          variants: [
            {
              variantId: 1,
              productId: 1,
              stock: 35,
              totalStock: 38,
              reservedStock: 3,
              expiredStock: 0,
            },
          ],
        },
      ],
    },
    400: {
      description:
        'Invalid delivery: a wrong body (VALIDATION_ERROR: no items or more than 100, an item ' +
        'with none or more than one of variantId, sku and barcode, a wrong source, units or cost, ' +
        'a day that is not a day, a text too long), items with no cost of their own and none of ' +
        'the delivery (BATCH_UNIT_COST_REQUIRED, `details.items`: every such item with its place ' +
        'in the request and the way it names its variant), a cost finer than a cent ' +
        '(BATCH_UNIT_COST_INVALID), a last good day that is over (BATCH_EXPIRES_AT_INVALID). ' +
        'Nothing is taken in.',
      $ref: 'errorResponseSchema#',
    },
    401: {
      description: 'Authentication is required to take in a delivery.',
      $ref: 'errorResponseSchema#',
    },
    403: {
      description: 'The current actor is not admin or root (INSUFFICIENT_ROLE).',
      $ref: 'errorResponseSchema#',
    },
    404: {
      description:
        'A variant does not exist or is taken out of sale (VARIANT_NOT_FOUND): `details` lists ' +
        'every variantId, every sku (`skus`) and every barcode (`barcodes`) the catalog has no ' +
        'live variant for. Nothing is taken in.',
      $ref: 'errorResponseSchema#',
    },
    409: {
      description: 'The variants are busy with another change (RESOURCE_BUSY), try again.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while taking in the delivery.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// Schema for a write-off by an admin
const postStockWriteOffRouterSchema = {
  operationId: 'writeOffStock',
  summary: 'Write off stock',
  description:
    'Writes off free units of each item: from the batch the item names (`batchId`), or from the ' +
    'batches in the order of a sale, the one that ends first, then the oldest. An item names its ' +
    'variant by `variantId`, `sku` (its article number) or `barcode`, one of the three. The ' +
    'units the waiting orders hold are not written off. A batch named gives its units before ' +
    'the units of the same variant without one; the lines of one variant are counted together. ' +
    'A variant taken out of sale keeps its units until they are written off (by its id; a ' +
    'sku or a barcode names the live variants of the catalog only). The reason: `damaged`, ' +
    '`defective`, `expired`, `shortage` (an inventory did not find them), `returned_to_supplier`, ' +
    '`other` (with a note). The stock log keeps a line (`stock.write_off`) of the variant for ' +
    'each variant in the name of the admin, with the reason, the batches and their costs and the ' +
    'note, and the `writeOffId` the answer gives; the admin log keeps one line `STOCK_WRITE_OFF` ' +
    'for the whole write-off with the same id (about the variant when the write-off touched one ' +
    'variant, about no thing when it touched more). All of the items or none. This operation is restricted to privileged users.',

  body: {
    $ref: 'stockWriteOffBodySchema#',
    examples: [
      { reason: 'damaged', note: 'Wet box', items: [{ variantId: 1, batchId: 12, quantity: 2 }] },
      { reason: 'shortage', items: [{ sku: 'SH-RED-M', quantity: 1 }] },
    ],
  },

  response: {
    201: {
      description: 'The units were written off: what each item took from which batch.',
      $ref: 'stockWriteOffResponseSchema#',
      examples: [
        {
          writeOffId: '7d1f4f6e-6b1f-4a43-9a1b-0d2a3c4b5e6f',
          items: [
            {
              productId: 1,
              variantId: 1,
              product: { id: 1, name: 'Shirt' },
              variant: { id: 1, position: 1, name: 'Shirt', sku: 'SH-RED-M' },
              quantity: 2,
              batches: [{ batchId: 12, quantity: 2, unitCost: 31.5 }],
            },
          ],
          variants: [
            {
              variantId: 1,
              productId: 1,
              stock: 33,
              totalStock: 36,
              reservedStock: 3,
              expiredStock: 0,
            },
          ],
        },
      ],
    },
    400: {
      description:
        'Invalid write-off: a wrong body (VALIDATION_ERROR: no items or more than 100, an item ' +
        'with none or more than one of variantId, sku and barcode, a wrong reason or units, a ' +
        'note too long), the reason other without a note (WRITE_OFF_NOTE_REQUIRED). Nothing is ' +
        'written off.',
      $ref: 'errorResponseSchema#',
    },
    401: {
      description: 'Authentication is required to write off stock.',
      $ref: 'errorResponseSchema#',
    },
    403: {
      description: 'The current actor is not admin or root (INSUFFICIENT_ROLE).',
      $ref: 'errorResponseSchema#',
    },
    404: {
      description:
        'A variant does not exist (VARIANT_NOT_FOUND): `details` lists every variantId, every sku ' +
        '(`skus`) and every barcode (`barcodes`) the catalog has no variant for; or a batch is ' +
        'not a batch of the variant (BATCH_NOT_FOUND, `details.batchId`). Nothing is written off.',
      $ref: 'errorResponseSchema#',
    },
    409: {
      description:
        'Not enough free units: every variant short of them (INSUFFICIENT_AVAILABLE_STOCK, ' +
        '`details.variants`: variantId, available, requested, the lines of a variant counted ' +
        'together), or every batch short of units (BATCH_INSUFFICIENT, `details.batches`: ' +
        'batchId, remaining, requested); the variants are busy with another change ' +
        '(RESOURCE_BUSY, try again). Nothing is written off.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while writing off stock.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// Group product routes under the products Swagger tag
const taggedProductSchemas = withOpenApiTag(
  {
    getAllProductsRouterSchema,
    getProductSuggestionsRouterSchema,
    getCatalogFiltersRouterSchema,
    getProductByIdRouterSchema,
    getProductReviewsRouterSchema,
    getPriceHistoryRouterSchema,
    restoreProductRouterSchema,
    postProductRouterSchema,
    postProductReviewRouterSchema,
    updateProductByIdRouterSchema,
    patchProductsBatchRouterSchema,
    patchProductSaleRouterSchema,
    postProductSalesRouterSchema,
    patchProductsBulkPriceRouterSchema,
    deleteProductByIdRouterSchema,
    deleteProductReviewRouterSchema,
    patchProductCategorySchema,
    postStockDeliveryRouterSchema,
    postStockWriteOffRouterSchema,
  },
  'products',
);

// Add guest or user cookie security to catalog read routes
const productSchemasWithGuestSecurity = withOpenApiSecurityFor(
  taggedProductSchemas,
  openApiSecurity.userOrGuestCookie,
  [
    'getAllProductsRouterSchema',
    'getProductSuggestionsRouterSchema',
    'getCatalogFiltersRouterSchema',
    'getProductByIdRouterSchema',
    'getProductReviewsRouterSchema',
  ],
);

// Add access token security to product write and review write routes
export const productSchemas = withOpenApiSecurityFor(
  productSchemasWithGuestSecurity,
  openApiSecurity.accessTokenCookie,
  [
    'postProductRouterSchema',
    'postProductReviewRouterSchema',
    'updateProductByIdRouterSchema',
    'patchProductsBatchRouterSchema',
    'patchProductSaleRouterSchema',
    'postProductSalesRouterSchema',
    'patchProductsBulkPriceRouterSchema',
    'deleteProductByIdRouterSchema',
    'restoreProductRouterSchema',
    'getPriceHistoryRouterSchema',
    'deleteProductReviewRouterSchema',
    'patchProductCategorySchema',
    'postStockDeliveryRouterSchema',
    'postStockWriteOffRouterSchema',
  ],
);
