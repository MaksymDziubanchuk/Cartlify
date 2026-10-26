import type { FastifySchema } from 'fastify';

import { MAX_UPLOAD_SIZE_BYTES } from '@config/limits.js';
import { openApiSecurity } from '@config/openapi.js';
import { withOpenApiSecurityFor } from '@helpers/withOpenApiSecurity.js';
import { withOpenApiTag } from '@helpers/withOpenApiTag.js';

const MAX_IMAGE_MB = MAX_UPLOAD_SIZE_BYTES / 1_000_000;

const productImageUrlsExample = {
  url200: 'https://example.com/products/headphones-200.webp',
  url400: 'https://example.com/products/headphones-400.webp',
  url800: 'https://example.com/products/headphones-800.webp',
};

// the card of a buyer: what helps to buy the product
const productBuyerFieldsExample = {
  id: 10,
  name: 'Wireless headphones',
  description: 'Bluetooth headphones with noise cancellation.',
  sku: 'WH-1000',
  price: 49.99,
  salePrice: 39.99,
  saleEndsAt: '2026-12-01T00:00:00.000Z',
  salePriorPrice: 44.99,
  stock: 15,
  category: { id: 1, name: 'Headphones', slug: 'headphones' },
  avgRating: 4.7,
  reviewsCount: 18,
  createdAt: '2026-01-01T10:00:00.000Z',
};

// what an admin and root get on top
const productAdminFieldsExample = {
  popularity: 120,
  views: 350,
  updatedAt: '2026-01-02T10:00:00.000Z',
  totalStock: 17,
  reservedStock: 2,
  popularityOverride: null,
  popularityOverrideUntil: null,
  deletedAt: null,
};

const productListItemExample = {
  ...productBuyerFieldsExample,
  images: productImageUrlsExample,
  popularity: 120,
};

const productResponseExample = {
  ...productBuyerFieldsExample,
  category: {
    ...productBuyerFieldsExample.category,
    path: [{ id: 3, name: 'Audio', slug: 'audio' }],
  },
  images: [productImageUrlsExample],
  safety: {
    manufacturer: {
      name: 'Sound GmbH',
      address: 'Klangstrasse 2, 10115 Berlin, Germany',
      email: 'safety@sound.example.com',
      country: 'DE',
    },
    responsiblePerson: null,
    warnings: 'Do not listen at a high volume for a long time.',
  },
};

// the card an admin gets, the answer of every change of a product
const productAdminResponseExample = {
  ...productResponseExample,
  ...productAdminFieldsExample,
};

const productsQueryExample = {
  limit: 20,
  search: 'headphones',
  categoryIds: '1,2',
  minPrice: 10,
  maxPrice: 100,
  inStock: true,
  sort: 'popularity',
  order: 'desc',
};

const productsListResponseExample = {
  items: [productListItemExample],
  limit: 20,
  nextCursor: 'eyJpZCI6MTB9',
};

const productIdParamsExample = {
  productId: '10',
};

const productReviewsQueryExample = {
  limit: 10,
  cursor: 'eyJpZCI6MX0',
};

const reviewExample = {
  id: 1,
  productId: 10,
  rating: 5,
  comment: 'Great product.',
  userId: 1,
  user: { id: 1, name: 'Anna', deleted: false },
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
    { ...reviewExample, id: 2, userId: 7, user: { id: 7, name: 'Guest', deleted: true } },
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
  price: 59.99,
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
  message: 'Products price updated successfully.',
  updatedCount: 12,
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
    'Returns a paginated product list with filtering, sorting and search support. A buyer ' +
    '(guest, user) gets every product of the catalog that is not deleted and has an image, with ' +
    'the fields that help to buy it and its popularity; a product without an image opens only by ' +
    'its id. Admin and root list it too, with `images: null`, and get the counters, the whole stock, the ' +
    'reserve and the popularity override too. `search` forgives a typo and another order of ' +
    'the words and finds a product by the name of its category and by its article number too; ' +
    'with it the best match comes first (`sort: relevance`). `categoryIds` takes the products ' +
    'of the whole branch of each category, `branch=false` only of each category itself. ' +
    'A buyer sorts by `relevance`, `createdAt`, `price`, ' +
    '`popularity`, `avgRating`, `name` and `saleEndsAt` (the products on sale first by the end ' +
    'of their sale, then the rest by popularity), any other sort is `SORT_FORBIDDEN`; the flags ' +
    'of an admin are `DELETED_PRODUCTS_FORBIDDEN` and `FILTER_FORBIDDEN` for a buyer. An admin ' +
    'sorts by any field. `deleted`, `onSale`, `popularityOverridden` and `maxStock` list only ' +
    'the products that are deleted, have a sale that is on, have a popularity override that is ' +
    'on (its end ahead), have no more free units than the number, whatever else they have; ' +
    'without any flag an admin gets only the plain products, ' +
    'not deleted, without a sale and an override that are on. A sort by the field of a flag ' +
    'needs the flag. ' +
    'For a buyer `sort: price`, `minPrice` and `maxPrice` take the price a product sells at ' +
    'now: the sale price while its sale lasts (`salePrice` until `saleEndsAt`, shown next to ' +
    'the usual `price`), the price otherwise. For an admin they take the usual `price`, and ' +
    '`sort: salePrice` (with `onSale`) sorts the products on sale by their sale price.',

  querystring: {
    $ref: 'getAllProductsQuerySchema#',
    examples: [productsQueryExample],
  },

  response: {
    200: {
      description: 'Products were returned successfully, as a buyer or as an admin sees them.',
      $ref: 'productsListResponseSchema#',
      examples: [
        productsListResponseExample,
        {
          ...productsListResponseExample,
          items: [{ ...productListItemExample, ...productAdminFieldsExample }],
        },
      ],
    },

    400: {
      description:
        'Invalid products query parameters: a sort by the field of a flag without the flag ' +
        '(`SORT_DELETED_AT_REQUIRES_DELETED`, `SORT_SALE_ENDS_AT_REQUIRES_ON_SALE`, ' +
        '`SORT_SALE_PRICE_REQUIRES_ON_SALE`, ' +
        '`SORT_POPULARITY_OVERRIDE_REQUIRES_OVERRIDDEN`), `sort: relevance` without a search ' +
        '(`SORT_RELEVANCE_REQUIRES_SEARCH`), `CATEGORY_IDS_INVALID`, `CURSOR_INVALID`.',
      $ref: 'errorResponseSchema#',
    },
    401: {
      description: 'Authentication or guest session is required to read products.',
      $ref: 'errorResponseSchema#',
    },
    403: {
      description:
        'A guest or a user asks for something of an admin: deleted products ' +
        '(`DELETED_PRODUCTS_FORBIDDEN`), the flag `onSale`, `popularityOverridden` or ' +
        '`maxStock` ' +
        '(`FILTER_FORBIDDEN`, `details.filter`), a sort of an admin (`SORT_FORBIDDEN`, ' +
        '`details.sort`).',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while loading products.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// Schema for single product lookup
const getProductByIdRouterSchema = {
  operationId: 'getProductById',
  summary: 'Get product by id',
  description:
    'Returns product details by product id. A buyer (guest, user) gets the fields that help to ' +
    'buy it, without the popularity; admin and root get the counters, the whole stock, the ' +
    'reserve and the popularity override too. A visit of a buyer counts as a view, the one of ' +
    'an admin does not. A deleted product is shown only to admin and root, guests and users get ' +
    '404 `PRODUCT_NOT_FOUND` for it.',

  params: {
    $ref: 'productIdParamSchema#',
    examples: [productIdParamsExample],
  },

  response: {
    200: {
      description: 'Product was returned successfully, as a buyer or as an admin sees it.',
      $ref: 'productResponseSchema#',
      examples: [productResponseExample, productAdminResponseExample],
    },

    400: {
      description: 'Invalid product id.',
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
        'Product was not found, or it is deleted and the actor is not admin or root (PRODUCT_NOT_FOUND).',
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
        'There is no such product, or for a buyer it is removed from the catalog (PRODUCT_NOT_FOUND).',
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
    'Creates a new product from a multipart form: its fields and one or more image files in ' +
    '`images`, the first is the main image. This operation is restricted to privileged users. ' +
    'The images are checked by their content; they become the images of the product only when ' +
    'the product is written, a refused request leaves no files. A new product has no stock: it ' +
    'comes with a delivery, POST /api/products/stock/deliveries. It needs the safety and origin ' +
    'data of the EU GPSR as text fields: the name, the postal and electronic address and the ' +
    'country of the manufacturer (`safety.manufacturer.*`), a person responsible in the EU for a ' +
    'manufacturer outside it (`safety.responsiblePerson.*`), the warnings (`safety.warnings`). ' +
    'The description keeps them with its text; the card gives them apart, as `safety`.',

  response: {
    201: {
      description: 'Product was created successfully.',
      $ref: 'productResponseSchema#',
      examples: [productAdminResponseExample],
    },

    400: {
      description:
        'Invalid product form: not a form (MULTIPART_REQUIRED), no images ' +
        '(PRODUCT_IMAGES_REQUIRED), a missing field (BODY_NOT_FULL), a wrong name, price ' +
        'or category id (PRODUCT_NAME_INVALID, PRODUCT_PRICE_INVALID, CATEGORY_ID_INVALID), a ' +
        'stock (PRODUCT_STOCK_NOT_ALLOWED), an article number over 64 signs (PRODUCT_SKU_TOO_LONG), ' +
        'the safety data of the manufacturer missing (PRODUCT_SAFETY_REQUIRED, `details.fields`) ' +
        'or wrong (PRODUCT_SAFETY_INVALID, `details.fields`), a manufacturer outside the EU ' +
        'without a person responsible in the EU (PRODUCT_EU_RESPONSIBLE_REQUIRED), an empty image (PRODUCT_IMAGE_STREAM_ERROR), more than 10 images (PRODUCT_IMAGES_TOO_MANY, `details.max`), a file that is not a jpeg, png or webp image by its content, whatever type the form names (IMAGE_TYPE_NOT_ALLOWED), an image Cloudinary cannot read (IMAGE_INVALID), or a text of the form with a NUL sign (TEXT_NUL_FORBIDDEN).',
      $ref: 'errorResponseSchema#',
    },
    401: {
      description: 'Authentication is required to create a product.',
      $ref: 'errorResponseSchema#',
    },
    404: {
      description: 'The category named does not exist (CATEGORY_NOT_FOUND).',
      $ref: 'errorResponseSchema#',
    },
    403: {
      description: 'The authenticated user is not allowed to create products.',
      $ref: 'errorResponseSchema#',
    },
    409: {
      description:
        'Another product of the catalog has the article number, whatever the case of its ' +
        'letters (PRODUCT_SKU_TAKEN). Nothing was created.',
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
    'a rating or a comment that is already set never changes.',

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
      description: 'Invalid product review request.',
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
    'Updates product details by product id. This operation is restricted to privileged users. ' +
    'The stock is not changed here (PRODUCT_STOCK_NOT_ALLOWED): it changes only with a delivery ' +
    'or a write-off, POST /api/products/stock/deliveries and /write-offs. Takes a JSON body, or a multipart form when ' +
    'it carries images: the images of a form replace all images of the product in their order, ' +
    'the first is the main one, and the files the product no longer has are deleted. A JSON body ' +
    'has no images. A refused request leaves the images as they were. A new price of a product ' +
    'with a sale that is on says in `sale` what happens to the sale: `keep`, null (`remove` in a ' +
    'form) to take it off, or a new sale (JSON only) that takes the old one off and is put on ' +
    'from the new price. The steps go one by one with every line of the logs: the old sale off, ' +
    'the price, the new sale; all of them or none.',

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
      description: 'Product was updated successfully.',
      $ref: 'productResponseSchema#',
      examples: [
        {
          ...productAdminResponseExample,
          name: 'Wireless headphones Pro',
          description: 'Updated product description.',
          price: 59.99,
          updatedAt: '2026-01-02T10:00:00.000Z',
        },
      ],
    },

    400: {
      description:
        'Invalid product update request: nothing to change (NO_FIELDS_TO_UPDATE), a wrong field ' +
        '(VALIDATION_ERROR for a JSON body, PRODUCT_NAME_INVALID, PRODUCT_PRICE_INVALID, ' +
        'CATEGORY_ID_INVALID, POPULARITY_OVERRIDE_INVALID, PRODUCT_SKU_TOO_LONG for an article ' +
        'number of a form over 64 signs, safety data that are not whole or wrong in a form ' +
        '(PRODUCT_SAFETY_REQUIRED, PRODUCT_SAFETY_INVALID, `details.fields`), a manufacturer ' +
        'outside the EU without a person responsible in the EU (PRODUCT_EU_RESPONSIBLE_REQUIRED), ' +
        'POPULARITY_OVERRIDE_UNTIL_INVALID for an end that is not ahead), a popularity override ' +
        'without its end or an end without an override after the change ' +
        '(POPULARITY_OVERRIDE_UNTIL_REQUIRED, POPULARITY_OVERRIDE_REQUIRED), a word on the sale ' +
        'without a price (PRODUCT_SALE_REQUIRES_PRICE), a stock (PRODUCT_STOCK_NOT_ALLOWED), ' +
        'another word on the sale in a form ' +
        '(PRODUCT_SALE_ACTION_INVALID), a new sale that does not fit the new price ' +
        '(PRODUCT_SALE_AMOUNT_TOO_HIGH, PRODUCT_SALE_TOO_SMALL, PRODUCT_SALE_ENDS_AT_INVALID), an empty image (PRODUCT_IMAGE_STREAM_ERROR), more than 10 images (PRODUCT_IMAGES_TOO_MANY, `details.max`), a file that is not a jpeg, png or webp image by its content, whatever type the form names (IMAGE_TYPE_NOT_ALLOWED), or an image Cloudinary cannot read (IMAGE_INVALID).',
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
        '`PRODUCT_NOT_FOUND`: there is no product with this id, or it is removed from the catalog ' +
        '(a new sale goes on a product of the catalog only); `CATEGORY_NOT_FOUND`: the category named does not exist.',
      $ref: 'errorResponseSchema#',
    },
    409: {
      description:
        'Product update conflicts with existing data. A new price of a product with a sale that is on without a word on the sale ' +
        '(PRODUCT_SALE_DECISION_REQUIRED, `details`: the sale price and its end), or keep for a ' +
        'price down to the sale price or below (PRODUCT_SALE_NOT_BELOW_PRICE); another product ' +
        'of the catalog has the article number (PRODUCT_SKU_TAKEN); nothing is changed.',
      $ref: 'errorResponseSchema#',
    },
    413: {
      description: `An image is over ${MAX_IMAGE_MB} MB (PAYLOAD_TOO_LARGE). Nothing was changed.`,
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
    'PATCH /api/products/{productId}, with the same checks, the same words on the sale and every ' +
    'line of the logs; the fields left out stay, there are no images. All of them or none: the ' +
    'fields of every product are checked first, then every product as it is, then the article ' +
    'numbers of all of them, and nothing is written while one is refused. A refusal names in ' +
    '`details.products` every product refused the same way, `{ productId }` with the details ' +
    'PATCH of one product gives; a product refused another way shows once the request is fixed. ' +
    'Two products of the request can swap their article numbers. The rows are locked by id, so ' +
    'two such requests over the same products wait for each other. Answers the cards of an ' +
    'admin in the order of the items.',

  body: {
    $ref: 'updateProductsBatchBodySchema#',
    examples: [
      {
        items: [
          { productId: 10, price: 519, sale: 'keep' },
          { productId: 11, sku: 'CASE-11', categoryId: 4 },
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
        'wrong field (PRODUCT_NAME_INVALID, PRODUCT_PRICE_INVALID, CATEGORY_ID_INVALID, ' +
        'POPULARITY_OVERRIDE_INVALID, POPULARITY_OVERRIDE_UNTIL_INVALID, PRODUCT_SKU_TOO_LONG, ' +
        'safety data that are not whole or wrong: PRODUCT_SAFETY_REQUIRED, PRODUCT_SAFETY_INVALID ' +
        'with `fields`, PRODUCT_EU_RESPONSIBLE_REQUIRED), a popularity override without its end ' +
        'or an end without an override after the change (POPULARITY_OVERRIDE_UNTIL_REQUIRED, ' +
        'POPULARITY_OVERRIDE_REQUIRED), a word on the sale without a price ' +
        '(PRODUCT_SALE_REQUIRES_PRICE), a stock (PRODUCT_STOCK_NOT_ALLOWED), a new sale that does ' +
        'not fit the new price (PRODUCT_SALE_AMOUNT_TOO_HIGH with `price`, PRODUCT_SALE_TOO_SMALL, ' +
        'PRODUCT_SALE_ENDS_AT_INVALID): `details.products` names them.',
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
        '`PRODUCT_NOT_FOUND`: a product is not there, or a new sale goes on a product removed ' +
        'from the catalog; `CATEGORY_NOT_FOUND`: the category named does not exist. ' +
        '`details.products` names them, nothing was changed.',
      $ref: 'errorResponseSchema#',
    },
    409: {
      description:
        'A change conflicts with a product, nothing was changed: a new price of a product with a ' +
        'sale that is on without a word on the sale (PRODUCT_SALE_DECISION_REQUIRED with ' +
        '`salePrice` and `saleEndsAt`), keep for a price down to the sale price or below ' +
        '(PRODUCT_SALE_NOT_BELOW_PRICE with `salePrice` and `price`), an article number another ' +
        'product of the catalog has after the change or two products of the request take ' +
        '(PRODUCT_SKU_TAKEN); `details.products` names them. The products are busy with another ' +
        'change (RESOURCE_BUSY, try again).',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while updating products.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// Schema for admin product sale
const patchProductSaleRouterSchema = {
  operationId: 'setProductSale',
  summary: 'Put a product on sale or take its sale off',
  description:
    'Puts a product on sale until `endsAt`, a time in the future: the sale starts right away. ' +
    'The discount is a percent of the price (`percent`, above 0 and up to 100) or an amount of ' +
    'money off it (`amount`, above 0 and up to the price); the server keeps the sale price, ' +
    'rounded to cents (a half cent up) and below the price, 0 gives the product away. While the ' +
    'sale lasts the product sells at the sale price: the cart, the confirm and its smallest ' +
    'payment, the sort and the price filters of the catalog take it, and every answer with the ' +
    'product shows `salePrice` and `saleEndsAt` next to the usual `price`. A sale past its end ' +
    'is left out of the answers. A new sale writes over the one there is. `sale: null` takes the ' +
    'sale off. A price changed down to the sale price or below ends the sale. The log of prices ' +
    'gets the start of a sale (mode `percent` or `fixed` as the discount was given, the value ' +
    'negative: the percent, or the amount it came to in cents; the end in `endsAt`) and a sale ' +
    'taken off while it was on (`fixed`, from the sale price back to the price). The admin log ' +
    'gets every sale as `PRODUCT_SALE`: the event (`start`, `change`, `removed`; ' +
    '`ended_by_price` when a price down to it ends it), the price, the sale before and after ' +
    'and the discount. The same sale again, or taking off a sale there is not (one that is ' +
    'over is none), is 409 and writes nothing. This operation is restricted to privileged users.',

  params: {
    $ref: 'productIdParamSchema#',
    examples: [productIdParamsExample],
  },

  body: {
    $ref: 'productSaleBodySchema#',
    examples: [
      { sale: { percent: 20, endsAt: '2026-12-01T00:00:00.000Z' } },
      { sale: { amount: 5, endsAt: '2026-12-01T00:00:00.000Z' } },
      { sale: null },
    ],
  },

  response: {
    200: {
      description: 'The sale was set or taken off; the product as its answers show it.',
      $ref: 'productResponseSchema#',
      examples: [
        {
          ...productAdminResponseExample,
          salePrice: 39.99,
          saleEndsAt: '2026-12-01T00:00:00.000Z',
        },
      ],
    },

    400: {
      description:
        'Invalid sale: a wrong body (VALIDATION_ERROR: a percent of 0 or over 100, an amount of ' +
        '0 or less, both or neither, no end), an amount above the price ' +
        '(PRODUCT_SALE_AMOUNT_TOO_HIGH, `details.price`), a discount that rounds to nothing or a ' +
        'free product (PRODUCT_SALE_TOO_SMALL), an end that is not in the future ' +
        '(PRODUCT_SALE_ENDS_AT_INVALID).',
      $ref: 'errorResponseSchema#',
    },
    401: {
      description: 'Authentication is required to put a product on sale.',
      $ref: 'errorResponseSchema#',
    },
    403: {
      description: 'The current actor is not admin or root (INSUFFICIENT_ROLE).',
      $ref: 'errorResponseSchema#',
    },
    404: {
      description: 'The product does not exist or is removed from the catalog (PRODUCT_NOT_FOUND).',
      $ref: 'errorResponseSchema#',
    },
    409: {
      description:
        'Done already, nothing is written: the same sale (the same sale price and end) is on ' +
        '(PRODUCT_SALE_ALREADY_SET), there is no sale that is on to take off ' +
        '(PRODUCT_SALE_ALREADY_REMOVED). Or the product is being changed by another request ' +
        '(RESOURCE_BUSY), try again.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while changing the sale.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// Schema for admin bulk product price update
const patchProductsBulkPriceRouterSchema = {
  operationId: 'bulkUpdateProductPrices',
  summary: 'Bulk update product prices',
  description:
    'Updates product prices in bulk using selected filters and update mode. ' +
    'The server always sets scope.deleted to false unless the request says otherwise, ' +
    'so deleted products are changed only with scope.deleted: true. ' +
    'Without scope every product that is not deleted is changed. The prices of the scope and of ' +
    'the change are the usual prices, not the sale prices. The sales that are on in the scope ' +
    'get one word in `sale`: keep them, or remove them the way it goes for one product (the sale ' +
    'off with its lines, then the price); a new sale is set product by product.',

  body: {
    $ref: 'bulkUpdateProductsPriceBodySchema#',
    examples: [bulkUpdateProductsPriceBodyExample],
  },

  response: {
    200: {
      description: 'Product prices were updated successfully.',
      $ref: 'bulkUpdateProductsPriceResponseSchema#',
      examples: [bulkUpdateProductsPriceResponseExample],
    },

    400: {
      description: 'Invalid bulk price update request.',
      $ref: 'errorResponseSchema#',
    },
    401: {
      description: 'Authentication is required to update product prices.',
      $ref: 'errorResponseSchema#',
    },
    403: {
      description: 'The authenticated user is not allowed to update product prices.',
      $ref: 'errorResponseSchema#',
    },
    409: {
      description:
        'Bulk price update conflicts with product state: products of the scope are on sale and ' +
        'there is no word on the sales (PRODUCT_SALE_DECISION_REQUIRED, `details.products`), or ' +
        'keep for new prices down to their sale prices (PRODUCT_SALE_NOT_BELOW_PRICE, ' +
        '`details.products`). No product is changed.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while updating product prices.',
      $ref: 'errorResponseSchema#',
    },
    501: {
      description: 'Bulk price update mode is not implemented.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// Schema for admin product deletion
const deleteProductByIdRouterSchema = {
  operationId: 'deleteProductById',
  summary: 'Delete product by id',
  description:
    'Deletes or soft-deletes a product by product id. This operation is restricted to privileged users.',

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

// Schema for sales of many products at once
const postProductSalesRouterSchema = {
  operationId: 'postProductSales',
  summary: 'Put many products on sale',
  description:
    'Puts sales on many products at once, all of them or none: `items` gives each product a ' +
    'sale of its own, or `categoryId` with `sale` gives one sale to the products of the catalog ' +
    'of the category and of the categories below it (`branch=false`: only of the category ' +
    'itself). Each sale is the one of `PATCH /api/products/{productId}/sale`: it starts right ' +
    'away, writes over a sale that is on, keeps every line of the logs and names the lowest ' +
    'price of the 30 days before it. A product that has the same sale already stays as it is ' +
    '(`status: unchanged`). There is no planned sale yet. Admin and root only.',

  body: {
    $ref: 'productSalesBodySchema#',
    examples: [
      {
        items: [
          { productId: 10, sale: { percent: 20, endsAt: '2026-12-01T00:00:00.000Z' } },
          { productId: 11, sale: { amount: 5, endsAt: '2026-12-15T00:00:00.000Z' } },
        ],
      },
      { categoryId: 1, sale: { percent: 10, endsAt: '2026-12-01T00:00:00.000Z' } },
    ],
  },

  response: {
    200: {
      description: 'The sales are on; each product of the request with its sale.',
      $ref: 'productSalesResponseSchema#',
      examples: [
        {
          products: [
            {
              id: 10,
              name: 'Wireless headphones',
              price: 49.99,
              salePrice: 39.99,
              saleEndsAt: '2026-12-01T00:00:00.000Z',
              salePriorPrice: 49.99,
              status: 'set',
            },
          ],
        },
      ],
    },
    400: {
      description:
        'Invalid request: a wrong body (VALIDATION_ERROR: neither items nor a category with a ' +
        'sale, or both, no items or more than 100), a product named twice ' +
        '(SALE_PRODUCTS_REPEATED, `details.productIds`), an end that is not ahead ' +
        '(PRODUCT_SALE_ENDS_AT_INVALID, `details.productIds` for items), a sale that does not ' +
        'fit a price: an amount above it (PRODUCT_SALE_AMOUNT_TOO_HIGH, `details.products`: ' +
        'productId, price), a discount that rounds to nothing or a product for 0 ' +
        '(PRODUCT_SALE_TOO_SMALL, `details.products`). Nothing is put on.',
      $ref: 'errorResponseSchema#',
    },
    401: {
      description: 'Authentication is required to put products on sale.',
      $ref: 'errorResponseSchema#',
    },
    403: {
      description: 'The current actor is not admin or root (INSUFFICIENT_ROLE).',
      $ref: 'errorResponseSchema#',
    },
    404: {
      description:
        'A product does not exist or is removed from the catalog (PRODUCT_NOT_FOUND, ' +
        '`details.productIds`), or the category does not exist (CATEGORY_NOT_FOUND). Nothing ' +
        'is put on.',
      $ref: 'errorResponseSchema#',
    },
    409: {
      description: 'The products are busy with another change (RESOURCE_BUSY), try again.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while putting the products on sale.',
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
    'one without an image (admin and root get it).',

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
    'Each change of the price of a product, the newest first, with who made it: a change of the ' +
    'price, the start of a sale (with its end) and a sale taken off, in the mode it was given ' +
    'and its size, below 0 for a change down. A product taken out of the catalog keeps its ' +
    'history. Admin and root only.',

  params: {
    $ref: 'productIdParamSchema#',
    examples: [productIdParamsExample],
  },
  querystring: { $ref: 'priceHistoryQuerySchema#' },

  response: {
    200: {
      description: 'The changes of the price of the page.',
      $ref: 'priceHistoryResponseSchema#',
    },
    400: {
      description: 'Invalid product id or a cursor of another list (CURSOR_INVALID).',
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
      description: 'Product was not found (PRODUCT_NOT_FOUND).',
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
    'again. The admin log keeps the change of deletedAt (PRODUCT_UPDATE). Admin and root only; ' +
    'they find the products taken out with `GET /api/products?deleted=true`.',

  params: {
    $ref: 'productIdParamSchema#',
    examples: [productIdParamsExample],
  },

  response: {
    200: {
      description: 'The product is back in the catalog: its card as an admin sees it.',
      $ref: 'productResponseSchema#',
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
        'The product is in the catalog (PRODUCT_NOT_DELETED), or another product of the ' +
        'catalog took its article number meanwhile (PRODUCT_SKU_TAKEN).',
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
    'An author deletes own reviews, an admin or root deletes any review.',

  params: {
    $ref: 'deleteProductReviewParamsSchema#',
    examples: [deleteProductReviewParamsExample],
  },

  response: {
    200: {
      description: 'Product review was deleted successfully.',
      $ref: 'messageResponseSchema#',
      examples: [messageResponseExample],
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
          category: { id: 2, name: 'Earbuds', slug: 'earbuds' },
          updatedAt: '2026-01-02T10:00:00.000Z',
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
    'Takes in a batch of each item: its units at its cost of a unit, in the currency of the ' +
    'shop, an optional last good day and the number the supplier gave it. The stock of each ' +
    'product grows by its batches; this is the only way the stock grows, besides a cancel of a ' +
    'paid order that puts its units back. `source` says where the goods come from: `supplier`, ' +
    '`surplus` (an inventory found more than the stock says) or `customer_return` (a buyer ' +
    'brought goods back); the admin gives the cost they count at. The admin log keeps a line ' +
    '`STOCK_DELIVERY` for each item in the name of the admin, with the delivery, the supplier, ' +
    'the invoice and the note. All of the items or none. A sale takes the batch that ends ' +
    'first, then the ones without an end, the oldest first. This operation is restricted to ' +
    'privileged users.',

  body: {
    $ref: 'stockDeliveryBodySchema#',
    examples: [
      {
        source: 'supplier',
        supplier: 'Acme',
        document: 'INV-1024',
        items: [
          {
            productId: 1,
            quantity: 20,
            unitCost: 31.5,
            expiresAt: '2027-06-30',
            supplierBatchNumber: 'LOT-77',
          },
        ],
      },
    ],
  },

  response: {
    201: {
      description: 'The batches were taken in; the stock of each product after them.',
      $ref: 'stockDeliveryResponseSchema#',
      examples: [
        {
          deliveryId: '2f6a2c3e-6c7b-4d1e-9a51-3b8f0f1d2c4a',
          batches: [
            {
              id: 12,
              productId: 1,
              source: 'supplier',
              supplierBatchNumber: 'LOT-77',
              unitCost: 31.5,
              quantity: 20,
              remaining: 20,
              expiresAt: '2027-06-30',
              createdAt: '2026-10-22T10:00:00.000Z',
            },
          ],
          products: [{ id: 1, stock: 35, totalStock: 38, reservedStock: 3 }],
        },
      ],
    },
    400: {
      description:
        'Invalid delivery: a wrong body (VALIDATION_ERROR: no items or more than 100, a wrong ' +
        'source, units or cost, a day that is not a day, a text too long), a cost finer than a ' +
        'cent (BATCH_UNIT_COST_INVALID), a last good day that is over (BATCH_EXPIRES_AT_INVALID). ' +
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
        'A product does not exist or is removed from the catalog (PRODUCT_NOT_FOUND, ' +
        '`details.productId`), or no product of the catalog has an article number named ' +
        '(PRODUCT_NOT_FOUND, `details.skus`: every such number). Nothing is taken in.',
      $ref: 'errorResponseSchema#',
    },
    409: {
      description: 'The products are busy with another change (RESOURCE_BUSY), try again.',
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
    'batches in the order of a sale, the one that ends first, then the oldest. The units the ' +
    'waiting orders hold are not written off. A batch named gives its units before the units of ' +
    'the same product without one. A product removed from the catalog keeps its units until ' +
    'they are written off. The reason: `damaged`, `defective`, `expired`, `shortage` (an ' +
    'inventory did not find them), `returned_to_supplier`, `other` (with a note). The admin log ' +
    'keeps a line `STOCK_WRITE_OFF` for each item in the name of the admin, with the reason, ' +
    'the batches and their costs, the write-off and the note. All of the items or none. This ' +
    'operation is restricted to privileged users.',

  body: {
    $ref: 'stockWriteOffBodySchema#',
    examples: [
      { reason: 'damaged', note: 'Wet box', items: [{ productId: 1, batchId: 12, quantity: 2 }] },
      { reason: 'shortage', items: [{ productId: 1, quantity: 1 }] },
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
            { productId: 1, quantity: 2, batches: [{ batchId: 12, quantity: 2, unitCost: 31.5 }] },
          ],
          products: [{ id: 1, stock: 33, totalStock: 36, reservedStock: 3 }],
        },
      ],
    },
    400: {
      description:
        'Invalid write-off: a wrong body (VALIDATION_ERROR: no items or more than 100, a wrong ' +
        'reason or units, a note too long), the reason other without a note ' +
        '(WRITE_OFF_NOTE_REQUIRED). Nothing is written off.',
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
        'A product does not exist (PRODUCT_NOT_FOUND, `details.productId`), no product of the ' +
        'catalog has an article number named (PRODUCT_NOT_FOUND, `details.skus`), or a batch is ' +
        'not a batch of the product (BATCH_NOT_FOUND, `details.batchId`). Nothing is written off.',
      $ref: 'errorResponseSchema#',
    },
    409: {
      description:
        'Not enough free units: every product short of them (INSUFFICIENT_AVAILABLE_STOCK, ' +
        '`details.products`: productId, available, requested, the lines of a product counted ' +
        'together), or every batch short of units (BATCH_INSUFFICIENT, `details.batches`: ' +
        'batchId, remaining, requested); the products are busy with another change ' +
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
