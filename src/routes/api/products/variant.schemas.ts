import type { FastifySchema } from 'fastify';

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
  VALUES_400,
  VALUES_400_WRAPPED,
  VALUE_CODES,
} from './variantValues.docs.js';

// the route schemas of the variants of a product and of its gallery (the routes: products.routes.ts)

const MAX_IMAGE_MB = MAX_UPLOAD_SIZE_BYTES / 1_000_000;

const imageUrlsExample = {
  url200: 'https://example.com/products/headphones-200.webp',
  url400: 'https://example.com/products/headphones-400.webp',
  url800: 'https://example.com/products/headphones-800.webp',
};

const variantFullExample = {
  id: 31,
  position: 1,
  name: EXAMPLE_VARIANT_NAME,
  values: EXAMPLE_VARIANT_VALUES,
  price: 49.99,
  stock: 15,
  image: imageUrlsExample,
  sku: 'WH-1000',
  weightGrams: 350,
  lengthMm: 200,
  widthMm: 100,
  heightMm: 50,
  attributes: EXAMPLE_VARIANT_ATTRIBUTES,
  images: [{ id: 5, position: 1, ...imageUrlsExample }],
};

const variantAdminExample = {
  ...variantFullExample,
  barcode: '4006381333931',
  totalStock: 17,
  reservedStock: 2,
  expiredStock: 0,
  lastUnitCost: 21.5,
  updatedAt: '2026-01-02T10:00:00.000Z',
  visible: true,
  deletedAt: null,
  salePrice: null,
  saleEndsAt: null,
  salePriorPrice: null,
};

const productPartExample = {
  id: 10,
  name: 'Wireless headphones',
  category: { id: 1, name: 'Headphones', slug: 'headphones' },
  avgRating: 4.7,
  reviewsCount: 18,
  createdAt: '2026-01-01T10:00:00.000Z',
  popularity: 120,
  views: 350,
  updatedAt: '2026-01-02T10:00:00.000Z',
  popularityOverride: null,
  popularityOverrideUntil: null,
  deletedAt: null,
};

const variantParamsExample = { productId: '10', variantId: '31' };

const createVariantsBodyExample = {
  variants: [
    {
      price: 54.99,
      sku: 'WH-1000-BLK',
      barcode: '4006381333931',
      weightGrams: 360,
      lengthMm: 200,
      widthMm: 100,
      heightMm: 50,
      images: [{ imageId: 5, position: 1 }],
    },
  ],
};

const updateVariantBodyExample = {
  sku: 'WH-1000-BLK',
  weightGrams: 360,
  position: 2,
  images: [
    { imageId: 6, position: 1 },
    { imageId: 5, position: 2 },
  ],
};

// a price with the word on its sale: the sale that is on is taken off and a new one is put on
const updateVariantPriceBodyExample = {
  price: 54.99,
  sale: { percent: 10, endsAt: '2026-12-01T00:00:00.000Z' },
};

const updateVariantsBodyExample = {
  variantIds: [31, 32],
  price: 54.99,
  sale: 'remove',
  weightGrams: 360,
};

// the same pictures of the gallery for every variant of the product
const updateVariantsImagesBodyExample = {
  images: [
    { imageId: 6, position: 1 },
    { imageId: 5, position: 2 },
  ],
};

const updateVariantsBatchBodyExample = {
  items: [
    { variantId: 31, price: 54.99, sale: 'keep' },
    { variantId: 40, weightGrams: 200, lengthMm: 100, widthMm: 80, heightMm: 20 },
  ],
};

// any field of one variant in an item: the codes, the place, the pictures
const updateVariantsBatchFieldsBodyExample = {
  items: [
    { variantId: 31, sku: 'WH-1000-BLK', barcode: '4006381333931', position: 1 },
    { variantId: 40, images: [{ imageId: 12, position: 1 }] },
  ],
};

// Schema for the read of one variant
const getVariantRouterSchema = {
  operationId: 'getProductVariant',
  summary: 'Get a variant of a product',
  description:
    'Returns one variant of a product on its own, in the full form (the card gives it with the ' +
    'product). It is no view of the product. A buyer (guest, user) gets a variant that is for ' +
    'sale and shows a picture, of a product that is in the catalog; admin and root get any ' +
    'variant, with the stock, the reserve, the barcode, the cost of the latest delivery and the ' +
    'sale as the row keeps it.',

  params: {
    $ref: 'productVariantParamsSchema#',
    examples: [variantParamsExample],
  },

  response: {
    200: {
      description: 'The variant, as a buyer or as an admin sees it.',
      $ref: 'variantFullSchema#',
      examples: [variantFullExample, variantAdminExample],
    },
    400: { description: 'Invalid product id or variant id.', $ref: 'errorResponseSchema#' },
    401: {
      description: 'Authentication or guest session is required to read this variant.',
      $ref: 'errorResponseSchema#',
    },
    403: {
      description: 'The current actor is not allowed to read it.',
      $ref: 'errorResponseSchema#',
    },
    404: {
      description:
        '`PRODUCT_NOT_FOUND`: there is no such product, or it is deleted and the actor is not ' +
        'admin or root; `VARIANT_NOT_FOUND`: the product has no such variant, or a buyer may ' +
        'not see it (it is taken out of sale, or shows no picture).',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while loading the variant.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// Schema for the creation of variants of a product
const postVariantsRouterSchema = {
  operationId: 'createProductVariants',
  summary: 'Add variants to a product',
  description:
    'Adds 1 to 100 variants to a product that is in the catalog, all of them or none. Each ' +
    'variant has its price (required), its article number, its barcode (with a good check ' +
    'digit), its weight and sizes (required unless `withoutShippingData: true`) and the pictures ' +
    'it shows (required, at least one): pictures of the gallery of the product, each with a place ' +
    'of its own, `[{ imageId, position }]`. A new variant takes the next free place after the ' +
    'variants the product has, the ones taken out of sale too, in the order of the list; it has no ' +
    'stock, that comes with a delivery. The product has PRODUCT_VARIANTS_MAX variants at most, ' +
    'the ones taken out of sale counted. Admin and root only; each variant gets a line ' +
    '(`variant.create`) in the admin log.',

  params: {
    $ref: 'productIdParamSchema#',
    examples: [{ productId: '10' }],
  },

  body: {
    $ref: 'createVariantsBodySchema#',
    examples: [createVariantsBodyExample],
  },

  response: {
    201: {
      description: 'The variants were made, as an admin sees them.',
      $ref: 'createVariantsResponseSchema#',
      examples: [{ variants: [{ ...variantAdminExample, id: 32, position: 2 }] }],
    },
    400: {
      description:
        'A wrong request. VARIANTS_INVALID: `details.variants` names each variant that is ' +
        'wrong by its `index` with its own `errorCode` and `details`: PRODUCT_PRICE_INVALID, ' +
        'PRODUCT_SKU_TOO_LONG, VARIANT_BARCODE_INVALID, PRODUCT_SHIPPING_DATA_REQUIRED ' +
        '(`details.fields`), PRODUCT_WEIGHT_INVALID, PRODUCT_SIZES_INVALID, ' +
        'PRODUCT_SIZES_INCOMPLETE, PRODUCT_WITHOUT_SHIPPING_DATA_INVALID, ' +
        'PRODUCT_STOCK_NOT_ALLOWED, VARIANT_IMAGE_REQUIRED, VARIANT_IMAGES_TOO_MANY ' +
        '(`details.max`), VARIANT_IMAGES_REPEATED, VARIANT_IMAGE_POSITION_INVALID, ' +
        'VARIANT_IMAGE_NOT_FOUND (a picture that is not in the gallery of this product, also one ' +
        'that another request took out of it meanwhile: `details.imageIds`). ' +
        'PRODUCT_VARIANTS_TOO_MANY: the product would have more variants than the limit ' +
        '(`details.max`, `details.have`). The shape of the list is held by the schema before the ' +
        'service reads it (VALIDATION_ERROR, `details` names the field): no list, an empty one, ' +
        'more than 100 variants, an element that is no object, pictures that are no list.' +
        VALUES_400_WRAPPED +
        REQUIRED_400,
      $ref: 'errorResponseSchema#',
    },
    401: {
      description: 'Authentication is required to add variants.',
      $ref: 'errorResponseSchema#',
    },
    403: {
      description: 'Only admin and root add variants (INSUFFICIENT_ROLE).',
      $ref: 'errorResponseSchema#',
    },
    404: {
      description: 'Product was not found (PRODUCT_NOT_FOUND).' + NOT_FOUND_ATTRIBUTE,
      $ref: 'errorResponseSchema#',
    },
    409: {
      description:
        'A live variant of the catalog has an article number of the request, whatever the case ' +
        'of its letters, or two variants of the request share one (PRODUCT_SKU_TAKEN, ' +
        '`details.variants`: the index and the article number); the same for a barcode ' +
        '(VARIANT_BARCODE_TAKEN); the product is deleted (PRODUCT_DELETED: put it back first).' +
        DUPLICATE_409,
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while adding variants.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// Schema for the change of one variant
const patchVariantRouterSchema = {
  operationId: 'updateProductVariant',
  summary: 'Update a variant of a product',
  description:
    'Changes what is sent of a variant, the rest stays: the price with the word on its sale, the ' +
    'article number, the barcode, the weight and the sizes (clearing what is known needs ' +
    '`withoutShippingData: true`; the sizes are known all three or none), the place among the ' +
    'variants of the product (`position`, from 1: the others move around it and keep a place of ' +
    'their own, a place past the last one is the last), the pictures it shows (`images`, written ' +
    'whole: exactly these; none hides the variant from buyers). A new price of a variant with a ' +
    'sale that is on says what happens to the sale in `sale`: `keep` keeps it (a price down to ' +
    'the sale price or below cannot), `remove` takes it off, a new sale `{ percent | amount, ' +
    'endsAt }` takes the old one off and is put on from the new price; each step goes with every ' +
    'line of the logs (the log of prices, and the admin log about the variant), all of it or ' +
    'nothing. A new price of a variant on sale without the word is 409, and a word on the sale ' +
    'without a price is 400 (the sale alone is changed by PATCH /api/products/{productId}/sale). ' +
    'The stock changes only with a delivery or a write-off (PRODUCT_STOCK_NOT_ALLOWED). Admin and ' +
    'root only; a line (`variant.update`) names the fields that changed in the admin log.',

  params: {
    $ref: 'productVariantParamsSchema#',
    examples: [variantParamsExample],
  },

  body: {
    $ref: 'updateVariantBodySchema#',
    examples: [updateVariantBodyExample, updateVariantPriceBodyExample],
  },

  response: {
    200: {
      description: 'The variant was changed: it as an admin sees it, with its product.',
      $ref: 'variantChangeResponseSchema#',
      examples: [{ product: productPartExample, variant: variantAdminExample }],
    },
    400: {
      description:
        'A wrong request: nothing to change (NO_FIELDS_TO_UPDATE), PRODUCT_PRICE_INVALID, a word ' +
        'on the sale without a price (PRODUCT_SALE_REQUIRES_PRICE), a new sale that does not fit ' +
        'the new price (PRODUCT_SALE_AMOUNT_TOO_HIGH with `details.price`, PRODUCT_SALE_TOO_SMALL), ' +
        'an end that is not in the future (PRODUCT_SALE_ENDS_AT_INVALID), PRODUCT_SKU_TOO_LONG, ' +
        'VARIANT_BARCODE_INVALID, PRODUCT_SHIPPING_DATA_REQUIRED (`details.fields`), ' +
        'PRODUCT_WEIGHT_INVALID, PRODUCT_SIZES_INVALID, PRODUCT_SIZES_INCOMPLETE, ' +
        'PRODUCT_WITHOUT_SHIPPING_DATA_INVALID, VARIANT_POSITION_INVALID, ' +
        'PRODUCT_STOCK_NOT_ALLOWED, VARIANT_IMAGES_TOO_MANY (`details.max`), ' +
        'VARIANT_IMAGES_REPEATED, VARIANT_IMAGE_POSITION_INVALID, VARIANT_IMAGE_NOT_FOUND ' +
        '(an id that is no picture, a picture that is not in the gallery of this product, or one ' +
        'that another request took out of it meanwhile: `details.imageIds`). Pictures that are no ' +
        'list (null, a text, a number, an object) are a wrong shape, held by the schema ' +
        '(VALIDATION_ERROR, `details` names `images`): null does not take the pictures away, an ' +
        'empty list does.' +
        VALUES_400 +
        REQUIRED_400,
      $ref: 'errorResponseSchema#',
    },
    401: {
      description: 'Authentication is required to change a variant.',
      $ref: 'errorResponseSchema#',
    },
    403: {
      description: 'Only admin and root change a variant (INSUFFICIENT_ROLE).',
      $ref: 'errorResponseSchema#',
    },
    404: {
      description:
        '`PRODUCT_NOT_FOUND`: there is no such product, or a new sale goes on a product that is ' +
        'deleted; `VARIANT_NOT_FOUND`: the product has no such variant, or a new sale goes on a ' +
        'variant that is taken out of sale.' +
        NOT_FOUND_ATTRIBUTE,
      $ref: 'errorResponseSchema#',
    },
    409: {
      description:
        'A live variant of the catalog has the article number (PRODUCT_SKU_TAKEN, `details.sku`) ' +
        'or the barcode (VARIANT_BARCODE_TAKEN, `details.barcode`); a new price of a variant with ' +
        'a sale that is on without a word on the sale (PRODUCT_SALE_DECISION_REQUIRED with ' +
        '`salePrice` and `saleEndsAt`); keep for a price down to the sale price or below ' +
        '(PRODUCT_SALE_NOT_BELOW_PRICE with `salePrice` and `price`); nothing is changed.' +
        DUPLICATE_409,
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while changing the variant.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// Schema for the same change of several variants of a product
const patchVariantsRouterSchema = {
  operationId: 'updateProductVariants',
  summary: 'Update several variants of a product the same way',
  description:
    'The same change for several variants of a product: the price with the word on the sale, the ' +
    'weight and the sizes, the values of the characteristics, and the pictures (`images`, the same ' +
    'list for every variant of the change, chosen from the gallery of the product and written ' +
    'whole: the pictures of each become exactly these, an empty list takes them all away and a ' +
    'variant with none is hidden from buyers; a variant that shows them already is not written). ' +
    'The article number, the barcode and the place belong to one variant (PATCH ' +
    '/api/products/{productId}/variants/{variantId}, or an item of PATCH ' +
    '/api/products/variants/batch): they are not read here. The variants are the ' +
    'ones named in `variantIds` (any of the product, the ones taken out of sale too), or every ' +
    'variant for sale. Each variant gets the change of PATCH of one variant: the sale that is on ' +
    'is kept, taken off or replaced by the same word for each, a new price of a variant on sale ' +
    'needs the word, a new sale is counted from the new price. All of the variants or none: a ' +
    'refusal is VARIANTS_INVALID with the status of the first variant refused and ' +
    '`details.variants` naming every variant refused with its own `errorCode` and `details`. A ' +
    'line (`variant.update_batch`) for each variant in the admin log and a line (`price.set_batch`) ' +
    'in the log of prices. The answer has the variants in full, as an admin sees them. Admin and ' +
    'root only.',

  params: {
    $ref: 'productIdParamSchema#',
    examples: [{ productId: '10' }],
  },

  body: {
    $ref: 'updateVariantsBodySchema#',
    examples: [updateVariantsBodyExample, updateVariantsImagesBodyExample],
  },

  response: {
    200: {
      description: 'The variants were changed, as an admin sees them.',
      $ref: 'updateVariantsResponseSchema#',
      examples: [{ variants: [variantAdminExample] }],
    },
    400: {
      description:
        'A wrong request: nothing to change (NO_FIELDS_TO_UPDATE), PRODUCT_PRICE_INVALID, a word ' +
        'on the sale without a price (PRODUCT_SALE_REQUIRES_PRICE), an end that is not in the ' +
        'future (PRODUCT_SALE_ENDS_AT_INVALID), PRODUCT_WEIGHT_INVALID, PRODUCT_SIZES_INVALID, ' +
        'PRODUCT_SIZES_INCOMPLETE, PRODUCT_WITHOUT_SHIPPING_DATA_INVALID, ' +
        'PRODUCT_STOCK_NOT_ALLOWED. The list of pictures is one for every variant, so its ' +
        'problems are those of the request and name no variant: `VARIANT_IMAGES_TOO_MANY`: more ' +
        'pictures than a variant shows (`details.max`); `VARIANT_IMAGES_REPEATED`: a picture ' +
        'twice; `VARIANT_IMAGE_POSITION_INVALID`: a place that is not a whole number from 1, or ' +
        'one used twice; `VARIANT_IMAGE_NOT_FOUND`: a picture that is not in the gallery of this ' +
        'product, also one that another request took out of it meanwhile (`details.imageIds`). ' +
        'Pictures that are no list (null, a text, a number, an object) are a wrong shape, held by ' +
        'the schema (VALIDATION_ERROR, `details` names `images`). ' +
        'VARIANTS_INVALID: a variant the change does not fit ' +
        '(PRODUCT_SHIPPING_DATA_REQUIRED, PRODUCT_SALE_AMOUNT_TOO_HIGH with `details.price`, ' +
        'PRODUCT_SALE_TOO_SMALL, and the errors of the values of the characteristics: ' +
        VALUE_CODES +
        '), `details.variants` names each such variant.' +
        REQUIRED_400,
      $ref: 'errorResponseSchema#',
    },
    401: {
      description: 'Authentication is required to change variants.',
      $ref: 'errorResponseSchema#',
    },
    403: {
      description: 'Only admin and root change variants (INSUFFICIENT_ROLE).',
      $ref: 'errorResponseSchema#',
    },
    404: {
      description:
        '`PRODUCT_NOT_FOUND`: there is no such product, or no variants are named and it is ' +
        'deleted; `VARIANT_NOT_FOUND`: a variant named is not a variant of this product ' +
        '(`details.variantIds`), or the product has none for sale. VARIANTS_INVALID: a new sale ' +
        'goes on a variant that is taken out of sale (VARIANT_NOT_FOUND) or on a product that is ' +
        'deleted (PRODUCT_NOT_FOUND), `details.variants` names each one.' +
        NOT_FOUND_ATTRIBUTE,
      $ref: 'errorResponseSchema#',
    },
    409: {
      description:
        'VARIANTS_INVALID: variants with a sale that is on and a new price but no word on the ' +
        'sale (PRODUCT_SALE_DECISION_REQUIRED with `salePrice` and `saleEndsAt`), or keep for a ' +
        'price down to the sale price or below (PRODUCT_SALE_NOT_BELOW_PRICE with `salePrice` and ' +
        '`price`); `details.variants` names each variant refused, nothing is changed.' +
        DUPLICATE_409,
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while changing the variants.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// Schema for the change of variants of any products, each its own way
const patchVariantsBatchRouterSchema = {
  operationId: 'updateProductVariantsBatch',
  summary: 'Update many variants at once',
  description:
    'Changes up to 100 variants of any products, each with the fields of its own: any field of ' +
    'PATCH of one variant, the price with the word on the sale, the article number, the barcode, ' +
    'the weight and the sizes, the place among the variants of its product, the pictures it shows ' +
    '(chosen from the gallery of its own product and written whole), the values of the ' +
    'characteristics, with the same checks and every line of the logs (`variant.update_batch`, ' +
    '`price.set_batch`). All of them or none: the fields of every variant are checked first, then ' +
    'every variant as it is under the lock of its row (by id, so two such requests over the same ' +
    'variants wait for each other), and nothing is written while one is refused. A refusal is ' +
    'VARIANTS_INVALID with the status of the first variant refused and `details.variants` naming ' +
    'every variant refused with its own `errorCode` and `details`. The codes are checked as a ' +
    'whole: a code that a live variant has now, one in the same request included, is taken, and so ' +
    'is one that two items ask for (409 PRODUCT_SKU_TAKEN or VARIANT_BARCODE_TAKEN naming the ' +
    'items), so two variants cannot swap their codes in one request; a variant that is out of sale ' +
    'holds no code and is not checked. The places move in the order of the items, one variant at a ' +
    'time, after the other writes (the others move around it, a place past the last one is the ' +
    'last). The answer has the variants in the order of the items, each with its product, as an ' +
    'admin sees them. Admin and root only.',

  body: {
    $ref: 'updateVariantsBatchBodySchema#',
    examples: [updateVariantsBatchBodyExample, updateVariantsBatchFieldsBodyExample],
  },

  response: {
    200: {
      description: 'The variants were changed, in the order of the items.',
      $ref: 'updateVariantsBatchResponseSchema#',
      examples: [{ items: [{ product: productPartExample, variant: variantAdminExample }] }],
    },
    400: {
      description:
        'A variant named twice (VARIANTS_REPEATED, `details.variantIds`), or VARIANTS_INVALID: ' +
        '`details.variants` names each variant refused with its own `errorCode`: nothing to ' +
        'change (NO_FIELDS_TO_UPDATE), PRODUCT_PRICE_INVALID, a word on the sale without a price ' +
        '(PRODUCT_SALE_REQUIRES_PRICE), an end that is not in the future ' +
        '(PRODUCT_SALE_ENDS_AT_INVALID), PRODUCT_WEIGHT_INVALID, PRODUCT_SIZES_INVALID, ' +
        'PRODUCT_SIZES_INCOMPLETE, PRODUCT_WITHOUT_SHIPPING_DATA_INVALID, ' +
        'PRODUCT_SHIPPING_DATA_REQUIRED, PRODUCT_STOCK_NOT_ALLOWED, a new sale that does not fit ' +
        'the new price (PRODUCT_SALE_AMOUNT_TOO_HIGH with `details.price`, ' +
        'PRODUCT_SALE_TOO_SMALL, VARIANT_BARCODE_INVALID, VARIANT_POSITION_INVALID, ' +
        'VARIANT_IMAGES_TOO_MANY (`details.max`), VARIANT_IMAGES_REPEATED, ' +
        'VARIANT_IMAGE_POSITION_INVALID, VARIANT_IMAGE_NOT_FOUND (a picture that is not in the ' +
        'gallery of the product of this variant, also one that another request took out of it ' +
        'meanwhile: `details.imageIds`), and the errors of the values of the characteristics: ' +
        VALUE_CODES +
        '). Pictures that are no list are a wrong shape, held by the schema (VALIDATION_ERROR).' +
        REQUIRED_400,
      $ref: 'errorResponseSchema#',
    },
    401: {
      description: 'Authentication is required to change variants.',
      $ref: 'errorResponseSchema#',
    },
    403: {
      description: 'Only admin and root change variants (INSUFFICIENT_ROLE).',
      $ref: 'errorResponseSchema#',
    },
    404: {
      description:
        'VARIANTS_INVALID: a variant that is not there (VARIANT_NOT_FOUND), or a new sale on a ' +
        'variant that is taken out of sale (VARIANT_NOT_FOUND) or on a product that is deleted ' +
        '(PRODUCT_NOT_FOUND); `details.variants` names each one, nothing is changed.' +
        NOT_FOUND_ATTRIBUTE,
      $ref: 'errorResponseSchema#',
    },
    409: {
      description:
        'VARIANTS_INVALID: variants with a sale that is on and a new price but no word on the ' +
        'sale (PRODUCT_SALE_DECISION_REQUIRED with `salePrice` and `saleEndsAt`), or keep for a ' +
        'price down to the sale price or below (PRODUCT_SALE_NOT_BELOW_PRICE with `salePrice` and ' +
        '`price`); `details.variants` names each variant refused, nothing is changed. ' +
        "`PRODUCT_SKU_TAKEN`: a live variant of the catalog other than the item's has the " +
        'article number now (whatever the case of its letters), one of this request included, ' +
        'even if it gives the code up in the same request, or two items ask for the same one; ' +
        '`details.variants` names the items, `[{ variantId, sku }]`, in the order of the ' +
        'request. `VARIANT_BARCODE_TAKEN`: the same for a barcode, `[{ variantId, barcode }]`. ' +
        'The article numbers are named first. Nothing is changed.' +
        DUPLICATE_409,
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while changing the variants.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// Schema for taking a variant out of sale
const deleteVariantRouterSchema = {
  operationId: 'deleteProductVariant',
  summary: 'Take a variant out of sale',
  description:
    'Takes a variant out of sale: it is only marked (deletedAt). A buyer does not see it, it ' +
    'cannot be added to a cart or ordered; the orders, the carts and the batches keep it. It lets ' +
    'its article number and its barcode go and holds its place among the variants. Admin and root ' +
    'only; a line (`variant.delete`) in the admin log.',

  params: {
    $ref: 'productVariantParamsSchema#',
    examples: [variantParamsExample],
  },

  response: {
    200: {
      description: 'The variant is out of sale.',
      $ref: 'deleteVariantResponseSchema#',
      examples: [{ id: 31, deletedAt: '2026-01-03T10:00:00.000Z' }],
    },
    400: { description: 'Invalid product id or variant id.', $ref: 'errorResponseSchema#' },
    401: { description: 'Authentication is required.', $ref: 'errorResponseSchema#' },
    403: {
      description: 'Only admin and root take a variant out of sale (INSUFFICIENT_ROLE).',
      $ref: 'errorResponseSchema#',
    },
    404: {
      description:
        '`PRODUCT_NOT_FOUND`: there is no such product; `VARIANT_NOT_FOUND`: the product has no ' +
        'such variant.',
      $ref: 'errorResponseSchema#',
    },
    409: {
      description:
        'The variant is out of sale already (VARIANT_ALREADY_DELETED), the variants of a product ' +
        'that was deleted are.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while deleting the variant.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// Schema for putting a variant back on sale
const restoreVariantRouterSchema = {
  operationId: 'restoreProductVariant',
  summary: 'Put a variant back on sale',
  description:
    'Puts a variant that was taken out of sale back. Its article number and its barcode must be ' +
    'free by then. The variant of a product that is deleted is not brought back alone: the ' +
    'product comes first (POST /api/products/{productId}/restore, which puts back the variants ' +
    'that went out with it). Admin and root only; a line (`variant.restore`) in the admin log.',

  params: {
    $ref: 'productVariantParamsSchema#',
    examples: [variantParamsExample],
  },

  response: {
    200: {
      description: 'The variant is on sale again: it as an admin sees it, with its product.',
      $ref: 'variantChangeResponseSchema#',
      examples: [{ product: productPartExample, variant: variantAdminExample }],
    },
    400: { description: 'Invalid product id or variant id.', $ref: 'errorResponseSchema#' },
    401: { description: 'Authentication is required.', $ref: 'errorResponseSchema#' },
    403: {
      description: 'Only admin and root put a variant back (INSUFFICIENT_ROLE).',
      $ref: 'errorResponseSchema#',
    },
    404: {
      description:
        '`PRODUCT_NOT_FOUND`: there is no such product; `VARIANT_NOT_FOUND`: the product has no ' +
        'such variant.',
      $ref: 'errorResponseSchema#',
    },
    409: {
      description:
        'The variant is on sale (VARIANT_NOT_DELETED); its product is deleted (PRODUCT_DELETED); ' +
        'a live variant took its article number (PRODUCT_SKU_TAKEN, `details.sku`) or its barcode ' +
        '(VARIANT_BARCODE_TAKEN, `details.barcode`) meanwhile; nothing is changed.' +
        DUPLICATE_409,
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while restoring the variant.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// Schema for more pictures in the gallery
const postGalleryImagesRouterSchema = {
  operationId: 'uploadProductImages',
  summary: 'Add pictures to the gallery of a product',
  description:
    'Adds pictures to the gallery of a product from a multipart form: the files in `images`, in ' +
    'their order. They take the next places of the gallery and no variant shows them until it is ' +
    'told to (PATCH /api/products/{productId}/variants/{variantId}, `images`). The files are ' +
    'checked by their content (jpeg, png or webp); they wait under ids of their own and move to ' +
    `their places once the rows are written, a refused request leaves no files. The gallery has ` +
    `${MAX_PRODUCT_IMAGES} pictures at most. A product that is not there and a gallery that is ` +
    'full are refused before a file is read, and the files after the one the gallery has no room ' +
    'for are not uploaded; the count is made again under the lock of the product, so two uploads ' +
    'at once keep the limit and take places of their own. Admin and root only; a line ' +
    '(`product.gallery_add`) in the admin log.',

  params: {
    $ref: 'productIdParamSchema#',
    examples: [{ productId: '10' }],
  },

  response: {
    201: {
      description: 'The pictures were added: the whole gallery.',
      $ref: 'galleryResponseSchema#',
      examples: [
        {
          images: [
            { id: 5, position: 0, ...imageUrlsExample, variantIds: [31] },
            { id: 6, position: 1, ...imageUrlsExample, variantIds: [] },
          ],
        },
      ],
    },
    400: {
      description:
        'A wrong form: not a form (MULTIPART_REQUIRED), no files (PRODUCT_IMAGES_REQUIRED), ' +
        'an empty image (PRODUCT_IMAGE_STREAM_ERROR), more than the limit in the request or in ' +
        'the gallery with the pictures it has (PRODUCT_IMAGES_TOO_MANY, `details.max`, ' +
        '`details.have`: the pictures the gallery has), a file ' +
        'that is not a jpeg, png or webp image by its content (IMAGE_TYPE_NOT_ALLOWED), an image ' +
        'Cloudinary cannot read (IMAGE_INVALID).',
      $ref: 'errorResponseSchema#',
    },
    401: { description: 'Authentication is required.', $ref: 'errorResponseSchema#' },
    403: {
      description: 'Only admin and root add pictures (INSUFFICIENT_ROLE).',
      $ref: 'errorResponseSchema#',
    },
    404: {
      description: 'Product was not found (PRODUCT_NOT_FOUND).',
      $ref: 'errorResponseSchema#',
    },
    413: {
      description: `An image is over ${MAX_IMAGE_MB} MB (PAYLOAD_TOO_LARGE). Nothing was added.`,
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while adding pictures.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// Schema for taking a picture out of the gallery
const deleteGalleryImageRouterSchema = {
  operationId: 'deleteProductImage',
  summary: 'Take a picture out of the gallery of a product',
  description:
    'Takes a picture out of the gallery. The variants that showed it do not show it any more; the ' +
    'answer names the variants for sale that are left without a picture (`variantsWithoutImages`): ' +
    'a buyer does not see them until they get one. The file is deleted from Cloudinary. Admin and ' +
    'root only; a line (`product.gallery_remove`) in the admin log.',

  params: {
    $ref: 'productImageParamsSchema#',
    examples: [{ productId: '10', imageId: '5' }],
  },

  response: {
    200: {
      description: 'The picture is out of the gallery.',
      $ref: 'deleteGalleryImageResponseSchema#',
      examples: [{ id: 5, variantsWithoutImages: [31] }],
    },
    400: { description: 'Invalid product id or picture id.', $ref: 'errorResponseSchema#' },
    401: { description: 'Authentication is required.', $ref: 'errorResponseSchema#' },
    403: {
      description: 'Only admin and root change the gallery (INSUFFICIENT_ROLE).',
      $ref: 'errorResponseSchema#',
    },
    404: {
      description:
        '`PRODUCT_NOT_FOUND`: there is no such product; `PRODUCT_IMAGE_NOT_FOUND`: the gallery of ' +
        'the product has no such picture.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while deleting the picture.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

const taggedVariantSchemas = withOpenApiTag(
  {
    getVariantRouterSchema,
    postVariantsRouterSchema,
    patchVariantRouterSchema,
    patchVariantsRouterSchema,
    patchVariantsBatchRouterSchema,
    deleteVariantRouterSchema,
    restoreVariantRouterSchema,
    postGalleryImagesRouterSchema,
    deleteGalleryImageRouterSchema,
  },
  'products',
);

const variantSchemasWithGuestSecurity = withOpenApiSecurityFor(
  taggedVariantSchemas,
  openApiSecurity.userOrGuestCookie,
  ['getVariantRouterSchema'],
);

export const variantSchemas = withOpenApiSecurityFor(
  variantSchemasWithGuestSecurity,
  openApiSecurity.accessTokenCookie,
  [
    'postVariantsRouterSchema',
    'patchVariantRouterSchema',
    'patchVariantsRouterSchema',
    'patchVariantsBatchRouterSchema',
    'deleteVariantRouterSchema',
    'restoreVariantRouterSchema',
    'postGalleryImagesRouterSchema',
    'deleteGalleryImageRouterSchema',
  ],
);
