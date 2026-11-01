import { MAX_PRODUCT_VARIANTS, MAX_VARIANT_IMAGES } from '@config/limits.js';
import { PRODUCT_SIZE_MAX_MM, PRODUCT_WEIGHT_MAX_GRAMS } from '@helpers/productShipping.js';
import { MAX_ID, idPathParam } from '@schemas/idPathParam.js';
import { moneyField, saleDiscountShapes } from './products.dtoSchemas.js';

// the answers that name a variant (db/05 keeps its numbers, src/types/dto/variants.dto.ts its types)

const ADMIN_ONLY = 'Admin and root only.';

const imageUrls = {
  url200: { type: 'string' },
  url400: { type: 'string' },
  url800: { type: 'string' },
} as const;

export const variantImageSchema = {
  $id: 'variantImageSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'integer', description: 'The id of the picture in the gallery of the product.' },
    position: {
      type: 'integer',
      minimum: 1,
      description: 'The place among the pictures of the variant.',
    },
    ...imageUrls,
  },
  required: ['id', 'position', 'url200', 'url400', 'url800'],
} as const;

const mainImage = {
  anyOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: imageUrls,
      required: ['url200', 'url400', 'url800'],
    },
    { type: 'null' },
  ],
  description:
    'The first picture of the variant in three sizes; null for a variant that shows none (only an admin sees such a variant).',
} as const;

// the characteristics that tell the variants of a product apart, with the label of the value the
// variant has of each (the same list the name is made of: cartlify.variant_names, db/05)
const valuesField = {
  type: 'array',
  description:
    'The characteristics that tell the variants of the product apart (the ones whose value is not ' +
    'the same in all its visible variants), in the order of the name: the main ones first, then ' +
    'by the place of the group and of the characteristic in the directory. `value` is the label ' +
    'the name shows: a text as it is, a number without trailing zeros and with its unit, the name ' +
    'of the value of a list (several: joined with a comma), yes or no. Empty when the variant is ' +
    'the only one, or all the variants are alike.',
  items: {
    type: 'object',
    additionalProperties: false,
    properties: {
      attributeId: { type: 'integer' },
      name: { type: 'string', description: 'The name of the characteristic.' },
      value: { type: 'string' },
    },
    required: ['attributeId', 'name', 'value'],
  },
} as const;

// a characteristic the variant has, for the card
const attributeItemSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    attribute: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'integer' },
        name: { type: 'string' },
        unit: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        type: { type: 'string', enum: ['text', 'number', 'boolean', 'option', 'options'] },
        isMain: { type: 'boolean' },
      },
      required: ['id', 'name', 'unit', 'type', 'isMain'],
    },
    value: {
      type: 'string',
      description:
        'The value as the card writes it: a text as it is, a number with its unit ("256 GB"), the ' +
        'name of the value of a list (several: joined with a comma), yes or no.',
    },
    raw: {
      anyOf: [
        { type: 'string' },
        { type: 'number' },
        { type: 'boolean' },
        { type: 'array', items: { type: 'integer' } },
      ],
      description:
        'The value as it is kept, what a form of an admin fills in: a text, a number, true/false, ' +
        'the id of the value of a list, the ids of the values of a set.',
    },
    colorCode: {
      type: 'string',
      description: 'The colour (#rrggbb) of the value of a list, when it has one.',
    },
  },
  required: ['attribute', 'value', 'raw'],
} as const;

const attributesField = {
  type: 'array',
  description:
    'Every characteristic the variant has (also the ones all its variants share), as the card ' +
    'shows them: the groups by their place, in a group the characteristics by theirs.',
  items: {
    type: 'object',
    additionalProperties: false,
    properties: {
      group: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'integer' },
          name: { type: 'string' },
          position: { type: 'integer', minimum: 1 },
        },
        required: ['id', 'name', 'position'],
      },
      items: { type: 'array', items: attributeItemSchema },
    },
    required: ['group', 'items'],
  },
} as const;

const shortFields = {
  id: { type: 'integer' },
  position: {
    type: 'integer',
    minimum: 1,
    description: 'The place among the variants of the product, set by an admin.',
  },
  name: {
    type: 'string',
    description:
      'The name of the variant: the name of the product, then a dash and the values that tell its variants apart ("Phone X — 256 GB, black"); the plain name of the product when it has one variant. A position of an order that is confirmed keeps the name it was bought under.',
  },
  price: { type: 'number', description: 'The regular price, in the currency of the shop.' },
  salePrice: {
    anyOf: [{ type: 'number', minimum: 0 }, { type: 'null' }],
    description:
      'The variant sells at it until saleEndsAt. A buyer gets it only while the sale lasts; admin and root always, as the row keeps it (a sale past its end too), null without one.',
  },
  saleEndsAt: {
    anyOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }],
    description:
      'The end of the sale. A buyer gets it only while the sale lasts; admin and root always, null without a sale.',
  },
  salePriorPrice: {
    anyOf: [{ type: 'number', minimum: 0 }, { type: 'null' }],
    description:
      'The lowest price the variant sold at in the 30 days before the sale, the price a reduction is compared with. A buyer gets it with the sale while it lasts; admin and root as the row keeps it, null without a sale or for a sale from before it was written.',
  },
  stock: {
    type: 'integer',
    minimum: 0,
    description:
      'Free units: the stock that confirmed orders do not hold, less the units of batches whose last good day is behind the day of the shop.',
  },
  image: mainImage,
  visible: {
    type: 'boolean',
    description: `${ADMIN_ONLY} Whether a buyer sees the variant: it is for sale and shows a picture.`,
  },
  deletedAt: {
    anyOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }],
    description: `${ADMIN_ONLY} When the variant was taken out of sale, null while it is for sale.`,
  },
} as const;

export const variantShortSchema = {
  $id: 'variantShortSchema',
  type: 'object',
  additionalProperties: false,
  properties: { ...shortFields, values: valuesField },
  required: ['id', 'position', 'name', 'values', 'price', 'stock', 'image'],
} as const;

export const variantFullSchema = {
  $id: 'variantFullSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    ...shortFields,
    values: valuesField,
    attributes: attributesField,
    sku: {
      anyOf: [{ type: 'string', maxLength: 64 }, { type: 'null' }],
      description:
        'The article number, null without one. One variant of the catalog has it at a time, whatever the case of its letters; the search finds the variant by it.',
    },
    weightGrams: {
      anyOf: [{ type: 'integer', minimum: 1, maximum: PRODUCT_WEIGHT_MAX_GRAMS }, { type: 'null' }],
      description: 'The weight packed, in grams; null while it is not known.',
    },
    lengthMm: {
      anyOf: [{ type: 'integer', minimum: 1, maximum: PRODUCT_SIZE_MAX_MM }, { type: 'null' }],
      description:
        'The length packed, in millimetres; the three sizes are known together or not at all.',
    },
    widthMm: {
      anyOf: [{ type: 'integer', minimum: 1, maximum: PRODUCT_SIZE_MAX_MM }, { type: 'null' }],
      description: 'The width packed, in millimetres, see lengthMm.',
    },
    heightMm: {
      anyOf: [{ type: 'integer', minimum: 1, maximum: PRODUCT_SIZE_MAX_MM }, { type: 'null' }],
      description: 'The height packed, in millimetres, see lengthMm.',
    },
    images: {
      type: 'array',
      items: { $ref: 'variantImageSchema#' },
      description: 'The pictures of the gallery the variant shows, by their place.',
    },
    barcode: {
      anyOf: [{ type: 'string', pattern: '^([0-9]{8}|[0-9]{12,14})$' }, { type: 'null' }],
      description: `${ADMIN_ONLY} The barcode: 8, 12, 13 or 14 digits with a good check digit; null without one.`,
    },
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
      description: `${ADMIN_ONLY} The cost of a unit in the latest delivery of a supplier, in the currency of the shop: what a price or a sale is set against; null for a variant no supplier delivered.`,
    },
    updatedAt: {
      type: 'string',
      format: 'date-time',
      description: `${ADMIN_ONLY} The last edit of an admin.`,
    },
  },
  required: [
    'id',
    'position',
    'name',
    'values',
    'price',
    'stock',
    'image',
    'attributes',
    'sku',
    'weightGrams',
    'lengthMm',
    'widthMm',
    'heightMm',
    'images',
  ],
} as const;

// a variant of a position of a cart, an order or the favorites: the short variant and whether it is
// still for sale
export const variantOfItemSchema = {
  $id: 'variantOfItemSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    ...shortFields,
    forSale: {
      type: 'boolean',
      description:
        'false when the variant is not for sale any more (taken out of sale, or its product is removed): a paid order keeps it as history.',
    },
  },
  required: ['id', 'position', 'name', 'price', 'stock', 'image', 'forSale'],
} as const;

// the variant of a row of the catalog list: the short form for a buyer, the full one (the shipping
// data, the pictures, the stock and the cost of the latest delivery) for admin and root
export const variantListItemSchema = {
  $id: 'variantListItemSchema',
  type: 'object',
  additionalProperties: false,
  properties: variantFullSchema.properties,
  required: variantShortSchema.required,
} as const;

export const galleryImageSchema = {
  $id: 'galleryImageSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'integer' },
    position: { type: 'integer', minimum: 0 },
    ...imageUrls,
    variantIds: {
      type: 'array',
      items: { type: 'integer' },
      description: 'The variants that show the picture.',
    },
  },
  required: ['id', 'position', 'url200', 'url400', 'url800', 'variantIds'],
} as const;

// ---- the bodies and the answers of the routes of the variants and of the gallery ----

// the article number of a variant: one live variant of the catalog has it at a time
const skuField = {
  type: ['string', 'null'],
  maxLength: 64,
  description:
    'The article number, up to 64 signs of any kind, trimmed; empty or null takes it away. One ' +
    'live variant of the catalog has it at a time, whatever the case of its letters ' +
    '(PRODUCT_SKU_TAKEN); a variant taken out of sale lets it go.',
} as const;

const barcodeField = {
  type: ['string', 'null'],
  description:
    'The barcode: 8, 12, 13 or 14 digits (EAN-8, UPC-A, EAN-13, GTIN-14) with a good check digit ' +
    '(VARIANT_BARCODE_INVALID); empty or null takes it away. One live variant of the catalog has ' +
    'it at a time (VARIANT_BARCODE_TAKEN).',
} as const;

// the weight and the sizes of a variant in a json body: whole grams and whole millimetres, null
// clears them (PRODUCT_SHIPPING_DATA_REQUIRED unless withoutShippingData is true). The three sizes
// are known together or not at all (PRODUCT_SIZES_INCOMPLETE)
const shippingBodyFields = {
  weightGrams: {
    type: ['integer', 'null'],
    description: `The weight packed, in grams, from 1 to ${PRODUCT_WEIGHT_MAX_GRAMS} (PRODUCT_WEIGHT_INVALID). Null clears it, which needs withoutShippingData.`,
  },
  lengthMm: {
    type: ['integer', 'null'],
    description: `The length packed, in millimetres, from 1 to ${PRODUCT_SIZE_MAX_MM} (PRODUCT_SIZES_INVALID). The three sizes are known together or not at all (PRODUCT_SIZES_INCOMPLETE); null clears them, which needs withoutShippingData.`,
  },
  widthMm: {
    type: ['integer', 'null'],
    description: 'The width packed, in millimetres, see lengthMm.',
  },
  heightMm: {
    type: ['integer', 'null'],
    description: 'The height packed, in millimetres, see lengthMm.',
  },
  withoutShippingData: {
    type: 'boolean',
    description:
      'True says that the weight and the sizes come later (or are cleared): the variant is ' +
      'saved without them. It is not kept; the variants that lack them are listed with the ' +
      'filter withoutShippingData and in an alert.',
  },
} as const;

// the price of a variant and the word on its sale, in the body of a change. The bounds of the price
// are the service's (PRODUCT_PRICE_INVALID), so that a request of many names the variant that is
// wrong
const priceBodyFields = {
  // a type list, not anyOf: with coerceTypes ajv turns a null into 0 in the number shape of an anyOf,
  // and a 0 into null in a null shape put first; a type list leaves a null a null
  price: {
    type: ['number', 'null'],
    description: `The regular price (PRODUCT_PRICE_INVALID, null too). ${moneyField.description} A new price of a variant with a sale that is on needs a word on the sale (PRODUCT_SALE_DECISION_REQUIRED).`,
  },
  sale: {
    description:
      'With a price, what happens to the sale that is on (without a price it is ' +
      'PRODUCT_SALE_REQUIRES_PRICE; the sale alone is changed by PATCH ' +
      '/api/products/{productId}/sale): `keep` keeps it (a price down to the sale price or below ' +
      'cannot, PRODUCT_SALE_NOT_BELOW_PRICE), `remove` takes it off, a new sale ' +
      '`{ percent | amount, endsAt }` takes the old one off and is put on from the new price. ' +
      'Each step writes every line of the logs. A new price of a variant on sale without a word ' +
      'is PRODUCT_SALE_DECISION_REQUIRED.',
    anyOf: [{ type: 'string', enum: ['keep', 'remove'] }, ...saleDiscountShapes],
  },
} as const;

// a stock is never taken here: kept in the schema so that it is refused, not dropped without a word
const stockRefusedField = {
  description:
    'Not accepted (PRODUCT_STOCK_NOT_ALLOWED): the stock changes only with a delivery or a ' +
    'write-off, POST /api/products/stock/deliveries and /write-offs.',
} as const;

// the pictures of a variant: pictures of the gallery of its product with a place of their own. The
// service says what is wrong with them (VARIANT_IMAGE_REQUIRED, VARIANT_IMAGES_TOO_MANY,
// VARIANT_IMAGES_REPEATED, VARIANT_IMAGE_POSITION_INVALID, VARIANT_IMAGE_NOT_FOUND). The bounds are
// told in the texts and not kept by the schema (no maxItems, no minimum): a schema that refused
// them would answer VALIDATION_ERROR and lose the code that names the trouble (and, in a request of
// many variants, the variant it is in). Only the shape is the schema's: a list of objects
const variantImagesBodyField = {
  type: 'array',
  description:
    'The pictures the variant shows, [{ imageId, position }]: imageId is a picture of the ' +
    'gallery of the product (GET the card of an admin, product.gallery; a number that is no ' +
    'picture of this gallery is VARIANT_IMAGE_NOT_FOUND), position its place among the pictures ' +
    'of the variant, a whole number from 1 (VARIANT_IMAGE_POSITION_INVALID), each place and each ' +
    'picture once (VARIANT_IMAGES_REPEATED); the first by place is the picture of the variant in ' +
    `lists. A variant shows ${MAX_VARIANT_IMAGES} pictures at most (VARIANT_IMAGES_TOO_MANY, ` +
    '`details.max`).',
  items: {
    type: 'object',
    additionalProperties: false,
    properties: {
      imageId: {
        type: 'integer',
        description: 'The id of a picture of the gallery of the product, from 1.',
      },
      position: {
        type: 'integer',
        description: 'The place among the pictures of the variant, from 1.',
      },
    },
  },
} as const;

// the values of the characteristics of a variant in a json body. The service says what is wrong with
// a value (ATTRIBUTE_VALUE_INVALID and the others): the schema holds the shape only
const attributesBodyField = {
  type: 'array',
  maxItems: 200,
  description:
    'The values of characteristics of the directory, [{ attributeId, value }], each ' +
    'characteristic once (VARIANT_ATTRIBUTES_REPEATED). `value` fits the type of the ' +
    'characteristic: a text (trimmed, up to 500 signs) for a text, a number for a number (the ' +
    'digits after the point and the bounds of the characteristic: ATTRIBUTE_VALUE_TOO_PRECISE, ' +
    'ATTRIBUTE_VALUE_TOO_SMALL, ATTRIBUTE_VALUE_TOO_LARGE), true or false for yes/no, the id of ' +
    'a value of its list for a choice, an array of ids of values of its list for a set (no value ' +
    'twice, at most ATTRIBUTE_MULTI_VALUES_MAX of them); anything else is ATTRIBUTE_VALUE_INVALID, ' +
    'a value of the list of another characteristic ATTRIBUTE_OPTION_NOT_FOUND, a characteristic ' +
    'that is not in the directory 404 ATTRIBUTE_NOT_FOUND. The characteristics the category of ' +
    'the product asks as required must have a value (ATTRIBUTE_REQUIRED), and no variant of the ' +
    'product may have the same values of all the characteristics as another (409 ' +
    'VARIANT_DUPLICATE). In a change `value: null` (or an empty array for a set) takes the value ' +
    'away, a characteristic that is not named stays; in a new variant it is no value.',
  items: {
    type: 'object',
    additionalProperties: false,
    properties: {
      attributeId: { type: 'integer', minimum: 1, maximum: MAX_ID },
      value: {
        description:
          'A string, a number, a boolean, the id of a value of a list, an array of such ids, or null.',
      },
    },
    required: ['attributeId', 'value'],
  },
} as const;

export const productVariantParamsSchema = {
  $id: 'productVariantParamsSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    productId: idPathParam('the product'),
    variantId: idPathParam('the variant'),
  },
  required: ['productId', 'variantId'],
} as const;

export const productImageParamsSchema = {
  $id: 'productImageParamsSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    productId: idPathParam('the product'),
    imageId: idPathParam('the picture of the gallery'),
  },
  required: ['productId', 'imageId'],
} as const;

export const productCardQuerySchema = {
  $id: 'productCardQuerySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    variantId: {
      type: 'integer',
      minimum: 1,
      maximum: MAX_ID,
      description:
        'The variant to open. Without it the card opens the main variant: the first by its ' +
        'place that has free units, the first of all when none has.',
    },
  },
} as const;

// the body of a new variant, the same where a variant is added to a product that is there
// A variant of the list is checked by the service one by one, so that every variant that is wrong is
// named with its own error (VARIANTS_INVALID): the schema checks the types only, the bounds of the
// price and of the article number are the service's (PRODUCT_PRICE_INVALID, PRODUCT_SKU_TOO_LONG)
const newVariantProperties = {
  price: {
    type: 'number',
    description: `The regular price (required, PRODUCT_PRICE_INVALID). ${moneyField.description}`,
  },
  sku: { type: ['string', 'null'], description: skuField.description },
  barcode: barcodeField,
  ...shippingBodyFields,
  images: {
    ...variantImagesBodyField,
    description: `${variantImagesBodyField.description} A new variant shows at least one (VARIANT_IMAGE_REQUIRED).`,
  },
  attributes: attributesBodyField,
  stock: stockRefusedField,
} as const;

export const createVariantsBodySchema = {
  $id: 'createVariantsBodySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    variants: {
      type: 'array',
      minItems: 1,
      maxItems: 100,
      description:
        'The variants to add, 1 to 100, all of them or none; each takes the next free place of the ' +
        'product, in the order of the list. Only price and images are required; a variant needs ' +
        'its weight and its sizes unless it says withoutShippingData. A variant that is wrong is ' +
        'named with its error (VARIANTS_INVALID, details.variants).',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: newVariantProperties,
      },
    },
  },
  required: ['variants'],
} as const;

export const createVariantsResponseSchema = {
  $id: 'createVariantsResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    variants: {
      type: 'array',
      description: 'The variants made, in the order of the request, as an admin sees them.',
      items: { $ref: 'variantFullSchema#' },
    },
  },
  required: ['variants'],
} as const;

// The fields of a change of one variant: what is sent changes, the rest stays. The route of one
// variant (PATCH .../variants/{variantId}) takes them, and so does each item of a batch (PATCH
// /api/products/variants/batch)
const changeOneFields = {
  sku: skuField,
  barcode: barcodeField,
  ...priceBodyFields,
  ...shippingBodyFields,
  position: {
    type: 'integer',
    description:
      'The new place of the variant among the variants of its product, from 1 (VARIANT_POSITION_INVALID); ' +
      'the others move around it and keep a place of their own. A place past the last one is the last.',
  },
  images: {
    ...variantImagesBodyField,
    description: `${variantImagesBodyField.description} The list is written whole: the pictures of the variant become exactly these; an empty list takes them all away, and a variant with none is hidden from buyers.`,
  },
  attributes: attributesBodyField,
  stock: stockRefusedField,
} as const;

// A change of a variant: what is sent changes, the rest stays
export const updateVariantBodySchema = {
  $id: 'updateVariantBodySchema',
  type: 'object',
  additionalProperties: false,
  properties: changeOneFields,
} as const;

// The same change for several variants of a product: the fields that fit every variant. The article
// number and the barcode are one variant's (a code is unique) and so is the place, they are not here
const changeManyFields = {
  ...priceBodyFields,
  ...shippingBodyFields,
  images: {
    ...variantImagesBodyField,
    description: `${variantImagesBodyField.description} The same list is written for every variant of the change: the pictures of each become exactly these, chosen from the gallery of the product; an empty list takes them all away from each, and a variant with none is hidden from buyers.`,
  },
  attributes: attributesBodyField,
  stock: stockRefusedField,
} as const;

export const updateVariantsBodySchema = {
  $id: 'updateVariantsBodySchema',
  type: 'object',
  additionalProperties: false,
  description:
    'The fields of the change are the same for every variant. The article number, the barcode and ' +
    "the place are not here: a code is unique and a place is one variant's (PATCH " +
    '/api/products/{productId}/variants/{variantId}, or an item of PATCH ' +
    '/api/products/variants/batch); they are not read when sent.',
  properties: {
    variantIds: {
      type: 'array',
      minItems: 1,
      maxItems: MAX_PRODUCT_VARIANTS,
      uniqueItems: true,
      items: { type: 'integer', minimum: 1, maximum: MAX_ID },
      description:
        'The variants of the product to change, any of them (the ones taken out of sale too; a ' +
        'new sale goes on a variant for sale only). Without it every variant for sale of the ' +
        'product.',
    },
    ...changeManyFields,
  },
} as const;

export const updateVariantsResponseSchema = {
  $id: 'updateVariantsResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    variants: {
      type: 'array',
      description:
        'Every variant the request named, in their order, or every variant for sale by its place, as an admin sees them.',
      items: { $ref: 'variantFullSchema#' },
    },
  },
  required: ['variants'],
} as const;

// A change of variants of any products, each with the fields of its own
export const updateVariantsBatchBodySchema = {
  $id: 'updateVariantsBatchBodySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    items: {
      type: 'array',
      minItems: 1,
      maxItems: 100,
      description:
        'The variants to change, each once (VARIANTS_REPEATED), each with the fields it changes: ' +
        'any field of the change of one variant, the article number, the barcode, the place and ' +
        'the pictures too.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          variantId: { type: 'integer', minimum: 1, maximum: MAX_ID },
          ...changeOneFields,
        },
        required: ['variantId'],
      },
    },
  },
  required: ['items'],
} as const;

export const updateVariantsBatchResponseSchema = {
  $id: 'updateVariantsBatchResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    items: {
      type: 'array',
      description:
        'The variants as an admin sees them, each with its product, in the order of the items.',
      items: { $ref: 'variantChangeResponseSchema#' },
    },
  },
  required: ['items'],
} as const;

export const variantChangeResponseSchema = {
  $id: 'variantChangeResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    product: { $ref: 'productItemResponseSchema#' },
    variant: { $ref: 'variantFullSchema#' },
  },
  required: ['product', 'variant'],
} as const;

export const deleteVariantResponseSchema = {
  $id: 'deleteVariantResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'integer' },
    deletedAt: { type: 'string', format: 'date-time' },
  },
  required: ['id', 'deletedAt'],
} as const;

// documentation only: the form of POST /api/products/:productId/images
export const galleryUploadFormSchema = {
  $id: 'galleryUploadFormSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    images: {
      type: 'array',
      items: { type: 'string', format: 'binary' },
      description:
        'The pictures to add to the gallery: jpeg, png or webp files by their content, in their ' +
        'order; they take the next places of the gallery.',
    },
  },
  required: ['images'],
} as const;

export const galleryResponseSchema = {
  $id: 'galleryResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    images: {
      type: 'array',
      description:
        'The whole gallery after the request, by place, the new pictures included (no variant shows them yet).',
      items: { $ref: 'galleryImageSchema#' },
    },
  },
  required: ['images'],
} as const;

export const deleteGalleryImageResponseSchema = {
  $id: 'deleteGalleryImageResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'integer', description: 'The picture that was taken out of the gallery.' },
    variantsWithoutImages: {
      type: 'array',
      items: { type: 'integer' },
      description:
        'The variants for sale that showed only this picture. They show none now, so a buyer does not see them until they get a picture (PATCH .../variants/{variantId}, images).',
    },
  },
  required: ['id', 'variantsWithoutImages'],
} as const;

export const variantDtoSchemas = [
  variantImageSchema,
  variantShortSchema,
  variantFullSchema,
  variantOfItemSchema,
  variantListItemSchema,
  galleryImageSchema,
  productVariantParamsSchema,
  productImageParamsSchema,
  productCardQuerySchema,
  createVariantsBodySchema,
  createVariantsResponseSchema,
  updateVariantBodySchema,
  updateVariantsBodySchema,
  updateVariantsResponseSchema,
  updateVariantsBatchBodySchema,
  updateVariantsBatchResponseSchema,
  variantChangeResponseSchema,
  deleteVariantResponseSchema,
  galleryUploadFormSchema,
  galleryResponseSchema,
  deleteGalleryImageResponseSchema,
];
