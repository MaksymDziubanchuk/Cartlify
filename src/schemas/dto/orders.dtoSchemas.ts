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

// the longest note for the courier, in characters
const SHIPPING_TEXT_MAX_LENGTH = 500;

// where the order goes, as an order answers with it
const deliveryPersonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    firstName: { type: 'string' },
    lastName: { type: 'string' },
    phone: { type: 'string', description: 'International form, +380501234567.' },
  },
  required: ['firstName', 'lastName', 'phone'],
} as const;

const deliveryAddressProperties = {
  country: { type: 'string', description: 'ISO code of two capital letters.' },
  postalCode: { type: ['string', 'null'], description: 'In the form its country writes it.' },
  city: { type: 'string' },
  street: { type: 'string' },
  house: {
    type: 'string',
    description: 'The number of the house, its name or both; s/n for a house without a number.',
  },
  apartment: { type: ['string', 'null'], description: 'Apartment, office, entrance.' },
} as const;

const deliveryAddressRequired = [
  'country',
  'postalCode',
  'city',
  'street',
  'house',
  'apartment',
] as const;

const orderDeliverySchema = {
  type: ['object', 'null'],
  additionalProperties: false,
  description:
    'Where and to whom the order goes; empty while the order has none (a cart of a buyer who has ' +
    'not chosen yet).',
  properties: {
    method: { type: 'string', enum: ['manual', 'pickup'] },
    price: {
      type: 'number',
      description:
        'What the buyer pays for the delivery: fixed when the order is confirmed, the price of ' +
        'now before that.',
    },
    recipient: deliveryPersonSchema,
    address: {
      type: ['object', 'null'],
      additionalProperties: false,
      description: 'The address of the manual method, empty for a pickup.',
      properties: deliveryAddressProperties,
      required: deliveryAddressRequired,
    },
    note: { type: ['string', 'null'], description: 'A word for the courier.' },
    pickup: {
      type: ['object', 'null'],
      additionalProperties: false,
      description: 'Where and when to collect the order, the pickup only.',
      properties: { address: { type: 'string' }, hours: { type: 'string' } },
      required: ['address', 'hours'],
    },
    shipment: {
      type: ['object', 'null'],
      additionalProperties: false,
      description: 'The send on its way, once the order is shipped.',
      properties: {
        carrier: { type: ['string', 'null'] },
        trackingNumber: { type: ['string', 'null'] },
        trackingUrl: { type: ['string', 'null'] },
      },
      required: ['carrier', 'trackingNumber', 'trackingUrl'],
    },
  },
  required: ['method', 'price', 'recipient', 'address', 'note', 'pickup', 'shipment'],
} as const;

const orderDeliveryQuotesSchema = {
  type: 'array',
  description: 'An order that is not confirmed: what each method the shop has enabled costs now.',
  items: {
    type: 'object',
    additionalProperties: false,
    properties: {
      method: { type: 'string', enum: ['manual', 'pickup'] },
      price: { type: 'number' },
      freeFrom: {
        type: ['number', 'null'],
        description: 'The sum of the items from which it is free.',
      },
      remainingToFree: {
        type: ['number', 'null'],
        description: 'What the items still lack of it, 0 once the delivery is free.',
      },
    },
    required: ['method', 'price', 'freeFrom', 'remainingToFree'],
  },
} as const;

const orderDeliverySuggestionSchema = {
  type: 'object',
  additionalProperties: false,
  description:
    'A cart: the delivery of the last order of the buyer, for the page to start from; the buyer ' +
    'corrects it and confirms.',
  properties: {
    method: { type: 'string', enum: ['manual', 'pickup'] },
    recipient: deliveryPersonSchema,
    address: {
      type: ['object', 'null'],
      additionalProperties: false,
      properties: deliveryAddressProperties,
      required: deliveryAddressRequired,
    },
  },
  required: ['method', 'recipient', 'address'],
} as const;

const orderShipmentsSchema = {
  type: 'array',
  description: 'Admin and root: every send of the order, the latest first.',
  items: {
    type: 'object',
    additionalProperties: false,
    properties: {
      id: { type: 'integer' },
      carrier: { type: ['string', 'null'] },
      trackingNumber: { type: ['string', 'null'] },
      trackingUrl: { type: ['string', 'null'] },
      cost: {
        type: ['number', 'null'],
        description: 'What the shop pays the carrier, empty until it is written.',
      },
      expense: {
        type: 'boolean',
        description: 'false when the shop owes the carrier nothing for this send.',
      },
      shippedAt: { type: 'string', format: 'date-time' },
      rolledBackAt: {
        type: ['string', 'null'],
        format: 'date-time',
        description: 'When the status went back from shipped; the send stays as history.',
      },
    },
    required: [
      'id',
      'carrier',
      'trackingNumber',
      'trackingUrl',
      'cost',
      'expense',
      'shippedAt',
      'rolledBackAt',
    ],
  },
} as const;

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
    itemsTotal: { type: 'number', description: 'What the items cost.' },
    total: {
      type: 'number',
      description: 'What the buyer pays: the items and the delivery.',
    },
    delivery: orderDeliverySchema,
    deliveryQuotes: orderDeliveryQuotesSchema,
    deliverySuggestion: orderDeliverySuggestionSchema,
    shipments: orderShipmentsSchema,
    weight: {
      type: 'object',
      additionalProperties: false,
      description:
        'Admin and root: what the order weighs in grams (the items that have a weight), whole ' +
        'only when every item has one.',
      properties: { grams: { type: 'integer' }, complete: { type: 'boolean' } },
      required: ['grams', 'complete'],
    },
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
    confirmed: { type: 'boolean' },
  },
  required: [
    'id',
    'userId',
    'status',
    'items',
    'itemsTotal',
    'total',
    'delivery',
    'createdAt',
    'updatedAt',
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
      'letter and no digits. Spaces around it are cut.',
  }) as const;

const confirmDeliveryAddressSchema = {
  type: 'object',
  additionalProperties: false,
  description:
    'The address of the manual method. A buyer is a person: no company. Spaces around the text ' +
    'are cut.',
  properties: {
    country: {
      type: 'string',
      pattern: '^[A-Z]{2}$',
      description:
        'ISO code of two capital letters, one of the countries the shop delivers to ' +
        '(GET /api/delivery/methods names them): DELIVERY_COUNTRY_NOT_ALLOWED otherwise.',
    },
    postalCode: {
      type: 'string',
      minLength: 1,
      maxLength: 16,
      description:
        'The postal code in the form its country writes it, checked for it and kept in that form ' +
        '(DELIVERY_POSTAL_CODE_INVALID).',
    },
    city: {
      type: 'string',
      minLength: 1,
      maxLength: 100,
      description: 'With at least one letter.',
    },
    street: {
      type: 'string',
      minLength: 1,
      maxLength: 150,
      description: 'With at least one letter.',
    },
    house: {
      type: 'string',
      minLength: 1,
      maxLength: 20,
      description: 'The number of the house, its name or both; s/n for a house without a number.',
    },
    apartment: {
      type: 'string',
      maxLength: 40,
      description: 'Optional: apartment, office, entrance; empty is none.',
    },
  },
  required: ['country', 'postalCode', 'city', 'street', 'house'],
} as const;

const confirmDeliverySchema = {
  type: 'object',
  additionalProperties: false,
  description:
    'Where and to whom the order goes. Whole when sent: it replaces the delivery of the order. ' +
    'Required for an order that has no delivery yet (DELIVERY_REQUIRED), an order that lost its ' +
    'reservation keeps the one it had.',
  properties: {
    method: {
      type: 'string',
      enum: ['manual', 'pickup'],
      description:
        'manual: the shop sends the order to an address; pickup: the buyer collects it at the ' +
        'shop. A method the shop has not enabled is DELIVERY_METHOD_NOT_AVAILABLE.',
    },
    recipientFirstName: recipientNameField('First name'),
    recipientLastName: recipientNameField('Last name'),
    recipientPhone: {
      type: 'string',
      maxLength: 16,
      pattern: `^${PHONE_PATTERN}$`,
      description:
        'Phone of the recipient in the international format: a plus sign and 8 to 15 digits, ' +
        'the first one not zero, for example +380501234567. No spaces, brackets or dashes.',
    },
    address: confirmDeliveryAddressSchema,
    note: {
      type: 'string',
      maxLength: SHIPPING_TEXT_MAX_LENGTH,
      description:
        `A note for the courier, optional, up to ${SHIPPING_TEXT_MAX_LENGTH} characters. ` +
        'Spaces around it are cut; an empty value is no note.',
    },
  },
  required: ['method', 'recipientFirstName', 'recipientLastName', 'recipientPhone'],
} as const;

const ordersCurrentConfirmBodySchema = {
  $id: 'ordersCurrentConfirmBodySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    orderId: wholeNumberField('Id of the order to confirm'),
    delivery: confirmDeliverySchema,
    expectedDeliveryPrice: {
      type: 'number',
      minimum: 0,
      maximum: 99999999.99,
      multipleOf: 0.01,
      description:
        'Required: the price of the delivery the page showed the buyer (the quote of the method ' +
        'chosen, `deliveryQuotes` of the order). Another price now refuses the confirmation ' +
        '(DELIVERY_PRICE_CHANGED, with the price now) and nothing is confirmed: the page shows the ' +
        'price now and the buyer confirms again.',
    },
  },
  required: ['orderId', 'expectedDeliveryPrice'],
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
        'the recipient, of the city or the postal code of the address, or a tracking number, ' +
        'whatever the case of its letters.',
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

    // the delivery filters of the desk of an admin
    deliveryMethod: {
      type: 'string',
      pattern: '^(manual|pickup)(,(manual|pickup))*$',
      description: 'Admin and root: the orders of these methods, one or both through commas.',
    },
    country: {
      type: 'string',
      pattern: '^[A-Z]{2}(,[A-Z]{2})*$',
      description:
        'Admin and root: the orders that go to these countries (ISO codes through commas).',
    },
    carrier: {
      type: 'string',
      minLength: 1,
      maxLength: 100,
      description:
        'Admin and root: the orders whose send on its way names this carrier, a part of the name ' +
        'without the case. A send that was rolled back does not count.',
    },
    shippedWithoutNumber: {
      type: 'boolean',
      description:
        'Admin and root: true lists the shipped orders whose send on its way has no tracking number.',
    },
    deliveryCharged: {
      type: 'boolean',
      description:
        'Admin and root: true lists the orders whose delivery the buyer pays for, false the ones ' +
        'where the shop pays (a free delivery, a pickup).',
    },
    withoutWeight: {
      type: 'boolean',
      description: 'Admin and root: true lists the orders that hold a product without a weight.',
    },
    shippingCostMissing: {
      type: 'boolean',
      description:
        'Admin and root: true lists the orders with a send the shop owes something for and has ' +
        'not written the cost of. With shippedTo it is the same send that was sent before it.',
    },
    shippedTo: {
      type: 'string',
      format: 'date-time',
      description:
        'Admin and root: only the orders with a send that was sent before this time (a send ' +
        'taken back too); with shippingCostMissing, the send that lacks its cost.',
    },

    // sorting
    sortBy: {
      type: 'string',
      enum: [
        'createdAt',
        'updatedAt',
        'total',
        'paidAt',
        'deliveryMethod',
        'destination',
        'deliveryPrice',
        'shippingCostMissingSince',
      ],
      description:
        'createdAt by default, newest first. paidAt lists only the orders that are paid. ' +
        'destination sorts by the country and then the city and lists only the orders that go to ' +
        'an address. shippingCostMissingSince sorts by the oldest send of each order the shop ' +
        'owes the carrier for and has written no cost of, with shippingCostMissing only ' +
        '(SORT_SHIPPING_COST_MISSING_REQUIRES_FILTER); it is the sort of that filter by default, ' +
        'the oldest first.',
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

// the send of the shipped step: who carries the order, the number, the link, what the shop pays
const shipmentInputSchema = {
  type: 'object',
  additionalProperties: false,
  description:
    'The send, with the step to shipped of a manual order, each part only if known. A number and a ' +
    'link each need the carrier (SHIPMENT_CARRIER_REQUIRED); a link may come without a number. A ' +
    'pickup has none (SHIPMENT_NOT_ALLOWED).',
  properties: {
    carrier: {
      type: 'string',
      minLength: 1,
      maxLength: 100,
      description: 'The carrier the shop sent it with, as the admin names it.',
    },
    trackingNumber: { type: 'string', minLength: 1, maxLength: 100 },
    trackingUrl: {
      type: 'string',
      maxLength: 500,
      pattern: '^https://\\S+$',
      description: 'The page to follow the parcel on, https.',
    },
    cost: {
      type: ['number', 'null'],
      minimum: 0,
      maximum: 99999999.99,
      multipleOf: 0.01,
      description:
        'What the shop pays the carrier, 0 is possible; left out until the admin writes it ' +
        '(PATCH /api/orders/{orderId}/shipments/{shipmentId}).',
    },
  },
} as const;

const keepShippingCostSchema = {
  type: 'boolean',
  description:
    'With the step back to paid of a manual order that was shipped: true keeps the cost of the ' +
    'send as owed (the carrier was used), false makes it 0 (the shipping was a mistake; the cost ' +
    'it had stays in the admin log). Needed ' +
    'then (KEEP_SHIPPING_COST_REQUIRED), not allowed otherwise (KEEP_SHIPPING_COST_NOT_ALLOWED).',
} as const;

// one step for many orders
const ordersBulkStatusBodySchema = {
  $id: 'ordersBulkStatusBodySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { type: 'string', enum: ['paid', 'shipped', 'delivered'] },
    orders: {
      type: 'array',
      minItems: 1,
      maxItems: 100,
      uniqueItems: false,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          orderId: { type: 'integer', minimum: 1, maximum: MAX_ID },
          shipment: shipmentInputSchema,
          keepShippingCost: keepShippingCostSchema,
        },
        required: ['orderId'],
      },
    },
  },
  required: ['orders', 'status'],
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
              'ORDER_STATUS_TRANSITION_INVALID, ORDER_STATUS_CHANGED, RESOURCE_BUSY, ' +
              'SHIPMENT_NOT_ALLOWED, SHIPMENT_CARRIER_REQUIRED, ' +
              'SHIPMENT_CARRIER_INVALID, SHIPMENT_NUMBER_INVALID, KEEP_SHIPPING_COST_REQUIRED, ' +
              'KEEP_SHIPPING_COST_NOT_ALLOWED).',
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
      enum: ['paid', 'shipped', 'delivered'],
      description:
        'The steps go on from paid to shipped (a pickup: ready to be collected) and to delivered ' +
        '(collected), and one step back: delivered to shipped, shipped to paid. A cancel returns ' +
        'the money and the stock, it is POST /api/orders/{orderId}/cancel.',
    },
    shipment: shipmentInputSchema,
    keepShippingCost: keepShippingCostSchema,
  },
  required: ['status'],
} as const;

const ordersShipmentParamsSchema = {
  $id: 'ordersShipmentParamsSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    orderId: idPathParam('the order'),
    shipmentId: idPathParam('the send'),
  },
  required: ['orderId', 'shipmentId'],
} as const;

const ordersShipmentUpdateBodySchema = {
  $id: 'ordersShipmentUpdateBodySchema',
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  description:
    'What changes, each part only if it does. null clears a part; the send holds together: a ' +
    'number and a link each need the carrier, a link may come without a number.',
  properties: {
    carrier: { type: ['string', 'null'], minLength: 1, maxLength: 100 },
    trackingNumber: { type: ['string', 'null'], minLength: 1, maxLength: 100 },
    trackingUrl: {
      type: ['string', 'null'],
      maxLength: 500,
      pattern: '^https://\\S+$',
      description: 'The page to follow the parcel on, https.',
    },
    cost: {
      type: ['number', 'null'],
      minimum: 0,
      maximum: 99999999.99,
      multipleOf: 0.01,
      description: 'What the shop pays the carrier, 0 is possible.',
    },
  },
} as const;

const ordersDeliveryUpdateBodySchema = {
  $id: 'ordersDeliveryUpdateBodySchema',
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  description:
    'What changes, each part only if it does. The person can be changed alone; an address is ' +
    'sent whole and is checked the way the confirmation checks it. The method and the price stay.',
  properties: {
    recipientFirstName: recipientNameField('First name'),
    recipientLastName: recipientNameField('Last name'),
    recipientPhone: {
      type: 'string',
      maxLength: 16,
      pattern: `^${PHONE_PATTERN}$`,
      description: 'The phone in the international form, +380501234567.',
    },
    address: confirmDeliveryAddressSchema,
    note: {
      type: 'string',
      maxLength: SHIPPING_TEXT_MAX_LENGTH,
      description: 'A note for the courier; an empty one removes it.',
    },
  },
} as const;

const ordersCancelBodySchema = {
  $id: 'ordersCancelBodySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    shippingPaid: {
      type: 'boolean',
      description:
        'The cancel of a manual order that was shipped: true when the carrier was paid already (the ' +
        'cost of the send stays owed, an expense of the shop), false when it was not (the cost of ' +
        'the send becomes 0, the one it had stays in the admin log). Needed then ' +
        '(SHIPPING_PAID_REQUIRED), not allowed otherwise ' +
        '(SHIPPING_PAID_NOT_ALLOWED).',
    },
  },
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
  ordersShipmentParamsSchema,
  ordersShipmentUpdateBodySchema,
  ordersDeliveryUpdateBodySchema,
  ordersCancelBodySchema,
  ordersUpdateStatusResponseSchema,
  ordersListResponseSchema,
  ordersOrderItemParamsSchema,
  ordersCancelledResponseSchema,
];
