import { PHONE_PATTERN, PROFILE_TEXT_MAX_LENGTH } from '@helpers/profileText.js';
import { MAX_ID, idPathParam } from '@schemas/idPathParam.js';

// an id or a quantity in the body: a whole number from 1 to the largest int of the database.
// A plain number type lets 1.5 through and the database cuts it to 1, another product or another
// quantity than sent; a bigger number is an error of the database, not of the request
const wholeNumberField = (description: string) =>
  ({
    type: 'integer',
    minimum: 1,
    maximum: MAX_ID,
    description: `${description}: a whole number from 1 to ${MAX_ID}.`,
  }) as const;

// the statuses of the list, for the pattern of a list of them
const LIST_STATUSES = 'waiting|unconfirmed|paid|shipped|delivered|cancelled';

// the longest shipping address and note, in characters
const SHIPPING_TEXT_MAX_LENGTH = 500;

const ordersOrderItemProductSchema = {
  $id: 'ordersOrderItemProductSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'integer' },
    name: { type: 'string' },
    categoryId: { type: 'integer' },

    images: {
      type: 'object',
      nullable: true,
      additionalProperties: false,
      description: 'The primary image of the product; null for a product without one.',
      properties: {
        url200: { type: 'string' },
        url400: { type: 'string' },
        url800: { type: 'string' },
      },
      required: ['url200', 'url400', 'url800'],
    },

    // computed in API: stock - reservedStock (clamp to 0)
    availableStock: { type: 'integer', minimum: 0 },

    deletedAt: { anyOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }] },

    // an order that is not paid (a cart, unconfirmed, waiting for its payment)
    price: {
      type: 'number',
      description:
        'The price of the product now, for an order that is not paid; a paid order shows what ' +
        'it was paid at in unitPrice.',
    },
    salePrice: {
      type: 'number',
      description: 'The sale price of the product while its sale lasts, for an order not paid.',
    },
    saleEndsAt: { type: 'string', format: 'date-time', description: 'The end of that sale.' },
    salePriorPrice: {
      type: 'number',
      description: 'The lowest price of the 30 days before that sale.',
    },
  },
  required: ['id', 'name', 'categoryId', 'images', 'availableStock'],
} as const;

const ordersOrderItemSchema = {
  $id: 'ordersOrderItemSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    // order item id, used as itemId in cart item routes
    id: { type: 'integer' },
    productId: { type: 'integer' },
    name: {
      type: 'string',
      description:
        'The name of the item: the one the product had when the order was confirmed, kept after ' +
        'a rename; the name the product has now for a cart or an unconfirmed order.',
    },
    product: { $ref: 'ordersOrderItemProductSchema#' },

    quantity: { type: 'number' },
    unitPrice: { type: 'number' },
    totalPrice: { type: 'number' },
  },
  required: ['id', 'productId', 'name', 'product', 'quantity', 'unitPrice', 'totalPrice'],
} as const;

const ordersOrderResponseSchema = {
  $id: 'ordersOrderResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'number' },
    userId: { type: 'number' },
    status: {
      type: 'string',
      enum: ['pending', 'unconfirmed', 'waiting', 'paid', 'shipped', 'delivered', 'cancelled'],
    },
    items: { type: 'array', items: { $ref: 'ordersOrderItemSchema#' } },
    total: { type: 'number' },
    // the list of an admin names the buyer of each order
    buyer: {
      type: 'object',
      additionalProperties: false,
      description:
        'Admin and root, in the list: the buyer of the order; a deleted account keeps its id, ' +
        'the name Guest and no email.',
      properties: {
        id: { type: 'integer' },
        name: { type: ['string', 'null'] },
        email: { type: ['string', 'null'] },
        deleted: { type: 'boolean' },
      },
      required: ['id', 'name', 'email', 'deleted'],
    },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
    reservationExpiresAt: {
      type: 'string',
      format: 'date-time',
      description:
        'Until when the stock is held for the payment, only while the order waits for it.',
    },
    paidAt: {
      type: 'string',
      format: 'date-time',
      description: 'When the payment was recorded, only once the order is paid; it stays.',
    },
    cancelledAt: {
      type: 'string',
      format: 'date-time',
      description: 'When an admin cancelled the paid order, only for a cancelled order.',
    },
    note: { type: 'string' },
    shippingAddress: {
      type: 'string',
      description: 'Shipping address, an empty string while the order has none.',
    },
    recipientFirstName: { type: 'string' },
    recipientLastName: { type: 'string' },
    recipientPhone: { type: 'string' },
    confirmed: { type: 'boolean' },
  },
  required: [
    'id',
    'userId',
    'status',
    'items',
    'total',
    'createdAt',
    'updatedAt',
    'shippingAddress',
    'confirmed',
  ],
} as const;

const ordersUpdateStatusParamsSchema = {
  $id: 'ordersUpdateStatusParamsSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    orderId: idPathParam('the order'),
  },
  required: ['orderId'],
} as const;

const ordersCurrentAddItemBodySchema = {
  $id: 'ordersCurrentAddItemBodySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    productId: wholeNumberField('Id of the product'),
    quantity: wholeNumberField('Units to add'),
  },
  required: ['productId', 'quantity'],
} as const;

const ordersCurrentItemIdParamsSchema = {
  $id: 'ordersCurrentItemIdParamsSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    itemId: idPathParam('the order item'),
  },
  required: ['itemId'],
} as const;

const ordersCurrentUpdateItemBodySchema = {
  $id: 'ordersCurrentUpdateItemBodySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    quantity: wholeNumberField('Units of the item'),
  },
  required: ['quantity'],
} as const;

const recipientNameField = (what: string) =>
  ({
    type: 'string',
    minLength: 1,
    maxLength: PROFILE_TEXT_MAX_LENGTH,
    description:
      `${what} of the recipient, up to ${PROFILE_TEXT_MAX_LENGTH} characters, with at least one ` +
      'letter and no digits. Spaces around it are cut. Required when the order has none yet.',
  }) as const;

const ordersCurrentConfirmBodySchema = {
  $id: 'ordersCurrentConfirmBodySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    orderId: wholeNumberField('Id of the order to confirm'),
    shippingAddress: {
      type: 'string',
      minLength: 1,
      maxLength: SHIPPING_TEXT_MAX_LENGTH,
      description:
        `Shipping address, up to ${SHIPPING_TEXT_MAX_LENGTH} characters. Spaces around it are ` +
        'cut. Required when the order has none yet.',
    },
    recipientFirstName: recipientNameField('First name'),
    recipientLastName: recipientNameField('Last name'),
    recipientPhone: {
      type: 'string',
      maxLength: 16,
      pattern: `^${PHONE_PATTERN}$`,
      description:
        'Phone of the recipient in the international format: a plus sign and 8 to 15 digits, ' +
        'the first one not zero, for example +380501234567. No spaces, brackets or dashes. ' +
        'Required when the order has none yet.',
    },
    note: {
      type: 'string',
      maxLength: SHIPPING_TEXT_MAX_LENGTH,
      description:
        `A note for the delivery, optional, up to ${SHIPPING_TEXT_MAX_LENGTH} characters. ` +
        'Spaces around it are cut; an empty value removes the note.',
    },
  },
  required: ['orderId'],
} as const;

const ordersGetQuerySchema = {
  $id: 'ordersGetQuerySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    limit: { type: 'integer', minimum: 1, maximum: 100 },
    cursor: {
      type: 'string',
      minLength: 1,
      pattern: '^[A-Za-z0-9_-]+$',
      description:
        'nextCursor of the previous page, with the same sortBy and sortDir. A changed cursor, or ' +
        'one from another sort, is CURSOR_INVALID.',
    },

    // filters; the cart (pending) is not in the list, GET /api/orders/current gives it
    status: {
      type: 'string',
      enum: ['waiting', 'unconfirmed', 'paid', 'shipped', 'delivered', 'cancelled'],
    },
    statuses: {
      type: 'string',
      pattern: `^(${LIST_STATUSES})(,(${LIST_STATUSES}))*$`,
      description: 'A few statuses separated by commas, for example paid,shipped.',
    },
    productId: {
      type: 'integer',
      minimum: 1,
      maximum: MAX_ID,
      description: 'Only the orders that hold the product.',
    },
    userId: {
      type: 'integer',
      minimum: 1,
      maximum: MAX_ID,
      description: 'Admin and root only (FILTER_FORBIDDEN for a buyer): the orders of the account.',
    },
    q: {
      type: 'string',
      minLength: 1,
      maxLength: 100,
      description:
        'Admin and root only (FILTER_FORBIDDEN for a buyer): a whole number is the number of an ' +
        'order; any other text a part of the email of the buyer, of the name or the phone of ' +
        'the recipient, whatever the case of its letters.',
    },
    format: {
      type: 'string',
      enum: ['json', 'csv'],
      description:
        'Admin and root only (FILTER_FORBIDDEN for a buyer): csv gives every order of the ' +
        'filters as a file for the courier, without pages.',
    },
    confirmed: { type: 'boolean' },
    paidFrom: {
      type: 'string',
      format: 'date-time',
      description:
        'Only the orders paid at this time or later; with paidTo it has to come before it ' +
        '(PAID_PERIOD_INVALID).',
    },
    paidTo: {
      type: 'string',
      format: 'date-time',
      description: 'Only the orders paid before this time.',
    },
    updatedFrom: {
      type: 'string',
      format: 'date-time',
      description:
        'Only the orders changed last at this time or later; with updatedTo it has to come ' +
        'before it (UPDATED_PERIOD_INVALID).',
    },
    updatedTo: {
      type: 'string',
      format: 'date-time',
      description:
        'Only the orders changed last before this time: the shipped orders that wait for the ' +
        'delivery longest.',
    },

    // sorting
    sortBy: {
      type: 'string',
      enum: ['createdAt', 'updatedAt', 'total', 'shippingAddress', 'paidAt'],
      description:
        'createdAt by default, newest first. paidAt lists only the orders that are paid.',
    },
    sortDir: {
      type: 'string',
      enum: ['asc', 'desc'],
    },
  },
} as const;

const ordersListResponseSchema = {
  $id: 'ordersListResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    items: { type: 'array', items: { $ref: 'ordersOrderResponseSchema#' } },
    limit: { type: 'integer', minimum: 1, maximum: 100 },
    nextCursor: {
      anyOf: [{ type: 'string', minLength: 1, pattern: '^[A-Za-z0-9_-]+$' }, { type: 'null' }],
    },
    total: { type: 'integer', minimum: 0 },
  },
  required: ['items', 'limit', 'total'],
} as const;

const ordersGetByIdParamsSchema = {
  $id: 'ordersGetByIdParamsSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    orderId: idPathParam('the order'),
  },
  required: ['orderId'],
} as const;

// one step of shipping for many orders
const ordersBulkStatusBodySchema = {
  $id: 'ordersBulkStatusBodySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    orderIds: {
      type: 'array',
      minItems: 1,
      maxItems: 100,
      uniqueItems: true,
      items: { type: 'integer', minimum: 1, maximum: MAX_ID },
    },
    status: { type: 'string', enum: ['shipped', 'delivered'] },
  },
  required: ['orderIds', 'status'],
} as const;

const ordersBulkStatusResponseSchema = {
  $id: 'ordersBulkStatusResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    results: {
      type: 'array',
      description: 'An answer for each order, in the order of the request.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          orderId: { type: 'integer' },
          ok: { type: 'boolean' },
          status: { type: 'string', description: 'With ok: the status of the order now.' },
          errorCode: {
            type: 'string',
            description:
              'Without ok: why the order did not take the step, the code PATCH ' +
              '/api/orders/{orderId}/status would answer (ORDER_NOT_FOUND, ' +
              'ORDER_STATUS_TRANSITION_INVALID, ORDER_STATUS_CHANGED, RESOURCE_BUSY).',
          },
          details: { type: 'object', additionalProperties: true },
        },
        required: ['orderId', 'ok'],
      },
    },
  },
  required: ['results'],
} as const;

const ordersUpdateStatusBodySchema = {
  $id: 'ordersUpdateStatusBodySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    status: {
      type: 'string',
      enum: ['shipped', 'delivered'],
      description:
        'A cancel returns the money and the stock, it is POST /api/orders/{orderId}/cancel.',
    },
  },
  required: ['status'],
} as const;

const ordersUpdateStatusResponseSchema = {
  $id: 'ordersUpdateStatusResponseSchema',
  allOf: [{ $ref: 'ordersOrderResponseSchema#' }],
} as const;

const ordersOrderItemParamsSchema = {
  $id: 'ordersOrderItemParamsSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    orderId: idPathParam('the order'),
    itemId: idPathParam('the order item'),
  },
  required: ['orderId', 'itemId'],
} as const;

// the answer of an admin cancel: the order and how to reach its buyer; the order itself holds the
// address, the recipient and the phone, also when the account is deleted
const ordersCancelledResponseSchema = {
  $id: 'ordersCancelledResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    ...ordersOrderResponseSchema.properties,
    user: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'number' },
        deleted: { type: 'boolean' },
        email: { type: 'string', description: 'Only while the account is not deleted.' },
      },
      required: ['id', 'deleted'],
    },
  },
  required: [...ordersOrderResponseSchema.required, 'user'],
} as const;

export const ordersDtoSchemas = [
  ordersCurrentAddItemBodySchema,
  ordersCurrentItemIdParamsSchema,
  ordersCurrentUpdateItemBodySchema,
  ordersCurrentConfirmBodySchema,

  ordersGetQuerySchema,
  ordersGetByIdParamsSchema,
  ordersOrderItemProductSchema,
  ordersOrderItemSchema,
  ordersOrderResponseSchema,
  ordersUpdateStatusParamsSchema,
  ordersBulkStatusBodySchema,
  ordersBulkStatusResponseSchema,
  ordersUpdateStatusBodySchema,
  ordersUpdateStatusResponseSchema,
  ordersListResponseSchema,
  ordersOrderItemParamsSchema,
  ordersCancelledResponseSchema,
];
