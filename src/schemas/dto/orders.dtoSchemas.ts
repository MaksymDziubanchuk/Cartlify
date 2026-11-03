import { PHONE_PATTERN, PROFILE_TEXT_MAX_LENGTH } from '@helpers/profileText.js';
import {
  RETURN_BASES,
  RETURN_DESCRIPTION_MAX,
  RETURN_MONEY,
  RETURN_NOT_ACCEPTED_REASONS,
  RETURN_OUTSIDE_METHODS,
  RETURN_REASONS,
  RETURN_SOURCES,
  RETURN_STATUSES,
} from '@helpers/returns.js';
import { WITHDRAWAL_RULES } from '@helpers/withdrawal.js';
import { returnStatusField } from './returns.dtoSchemas.js';
import { MAX_ID, idPathParam } from '@schemas/idPathParam.js';

// an id or a quantity in the body: a whole number from 1 to the largest int of the database.
// A plain number type lets 1.5 through and the database cuts it to 1, another variant or another
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

// the same for the statuses of the statements of return an order has
const RETURN_STATUS_NAMES = RETURN_STATUSES.join('|');

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
  description: 'The product of the position; the variant that is bought is in variant.',
  properties: {
    id: { type: 'integer' },
    name: { type: 'string' },
    categoryId: { type: 'integer' },
  },
  required: ['id', 'name', 'categoryId'],
} as const;

const ordersOrderItemSchema = {
  $id: 'ordersOrderItemSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    // order item id, used as itemId in cart item routes
    id: { type: 'integer' },
    product: { $ref: 'ordersOrderItemProductSchema#' },
    variant: {
      $ref: 'variantOfItemSchema#',
      description:
        'The variant that is bought, with its own price, free units, main picture and forSale. ' +
        'Its name is the one the variant had when the order was confirmed, kept after a rename ' +
        '(the name of now for a cart or an unconfirmed order). While the order is not paid the ' +
        'price and the sale are the ones of now; a paid order shows the price it was bought at ' +
        'and no sale. forSale is false for a variant that is not for sale any more: a confirmed ' +
        'order keeps it as history (a cart and an unconfirmed order drop it).',
    },

    quantity: { type: 'number' },
    unitPrice: { type: 'number' },
    totalPrice: { type: 'number' },
    withdrawal: {
      type: 'object',
      additionalProperties: false,
      description:
        'The rule of withdrawal of the product the page words, and the kind it makes. A cart and ' +
        'an unconfirmed order show the rule of now; the confirmation fixes the rule of that ' +
        'moment, and the order keeps it whatever is changed after.',
      properties: {
        rule: { type: 'string', enum: [...WITHDRAWAL_RULES] },
        right: {
          type: 'string',
          enum: ['full', 'conditional', 'none'],
          description:
            'full: taken back freely; conditional: only while the seal is unbroken; none: not ' +
            'taken back at all.',
        },
      },
      required: ['rule', 'right'],
    },
  },
  required: ['id', 'product', 'variant', 'quantity', 'unitPrice', 'totalPrice', 'withdrawal'],
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
        'Admin and root: what the order weighs in grams (the weights of the variants times the ' +
        'units ordered), whole only when every variant has a weight.',
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
      description:
        'When the order became cancelled (its statements of return took all of it back), only for ' +
        'a cancelled order.',
    },
    deliveredAt: {
      type: 'string',
      format: 'date-time',
      description: 'When the order was delivered, only while it is delivered.',
    },
    withdrawalEndsAt: {
      type: 'string',
      format: 'date-time',
      description:
        'Until when the buyer may withdraw from the order by the contract, only once it is ' +
        'delivered: the end of the last day (in the time zone of the shop) of the days of the ' +
        'contract the order kept (14 when none was published at its confirmation), counted after ' +
        'the day of the delivery. The date to show; the shop forgives a few days more (its grace), ' +
        'so the button goes by withdrawalOpen, not by this date.',
    },
    withdrawalOpen: {
      type: 'boolean',
      description:
        'Whether the buyer may withdraw from the order now: a paid or shipped order always (the ' +
        'period starts with the delivery), a delivered one until withdrawalEndsAt and the days of ' +
        'grace of the shop after it, any other order never. The button of withdrawal goes by it.',
    },
    returnStatus: returnStatusField,
    returns: {
      type: 'array',
      description:
        'Admin and root only: the statements of withdrawal and of return of the order, the oldest ' +
        'first; the card of each is GET /api/returns/{returnId}.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'integer' },
          code: { type: 'string', description: 'The code of the statement: W42-2 or R42-1.' },
          statedAt: { type: 'string', format: 'date-time' },
          source: { type: 'string', enum: [...RETURN_SOURCES] },
          basis: { type: 'string', enum: [...RETURN_BASES] },
          reason: { type: ['string', 'null'], enum: [...RETURN_REASONS, null] },
          extendsId: { type: ['integer', 'null'] },
          closedAt: { type: ['string', 'null'], format: 'date-time' },
        },
        required: ['id', 'code', 'statedAt', 'source', 'basis', 'reason', 'extendsId', 'closedAt'],
      },
    },
    returnUnits: {
      type: 'object',
      additionalProperties: false,
      description:
        'Admin and root, only for an order with statements: what they did to each item they ' +
        'touched, and the money in sum. A unit with the shop (on the shelf, written off or lost on ' +
        'its way back) is not to be sent.',
      properties: {
        items: {
          type: 'array',
          description: 'The items the statements touched, in the order of the items.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              orderItemId: { type: 'integer' },
              quantity: { type: 'integer', description: 'The units the order bought.' },
              refunded: { type: 'integer', description: 'The units whose money went back.' },
              refused: { type: 'integer', description: 'The units whose money was refused.' },
              waiting: {
                type: 'integer',
                description:
                  'The units in statements whose money is not settled yet (or on its way).',
              },
              withShop: {
                type: 'integer',
                description:
                  'The units the shop has back: on the shelf, written off or lost on their way back.',
              },
              toShip: {
                type: 'integer',
                description:
                  'The units of the item still to send: quantity less withShop. For an order not ' +
                  'sent yet it is what goes in the parcel.',
              },
            },
            required: [
              'orderItemId',
              'quantity',
              'refunded',
              'refused',
              'waiting',
              'withShop',
              'toShip',
            ],
          },
        },
        refundedTotal: {
          type: 'number',
          description: 'The money that went back to the buyer, the delivery with it.',
        },
        netTotal: {
          type: 'number',
          description: 'What the order is worth now: the total paid less the money that went back.',
        },
      },
      required: ['items', 'refundedTotal', 'netTotal'],
    },
    withdrawals: {
      type: 'array',
      description:
        'The buyer: their statements of withdrawal of the order, the oldest first, with the path of ' +
        'each (step: received, proof_provided, proof_confirmed, closed) and the money of each row ' +
        '(never what became of the goods).',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'integer' },
          code: {
            type: 'string',
            description: 'The code of the statement in the mails: W42-2 (a withdrawal) or R42-1.',
          },
          statedAt: { type: 'string', format: 'date-time' },
          source: { type: 'string', enum: [...RETURN_SOURCES] },
          basis: { type: 'string', enum: [...RETURN_BASES] },
          reason: { type: ['string', 'null'], enum: [...RETURN_REASONS, null] },
          step: {
            type: 'string',
            enum: ['received', 'proof_provided', 'proof_confirmed', 'closed'],
          },
          closedAt: { type: ['string', 'null'], format: 'date-time' },
          proof: {
            type: ['object', 'null'],
            additionalProperties: false,
            description: 'How the buyer sent the goods back, none until they wrote it.',
            properties: {
              carrier: { type: 'string' },
              trackingNumber: { type: 'string' },
              trackingUrl: { type: ['string', 'null'] },
              providedAt: { type: 'string', format: 'date-time' },
              confirmed: { type: 'boolean', description: 'Whether the shop confirmed it.' },
            },
            required: ['carrier', 'trackingNumber', 'trackingUrl', 'providedAt', 'confirmed'],
          },
          shippingReimbursement: {
            type: ['object', 'null'],
            additionalProperties: false,
            description:
              'What the shop paid back for sending the goods back, outside the app, none until it did.',
            properties: {
              amount: { type: 'number' },
              at: { type: 'string', format: 'date-time' },
              method: { type: 'string', enum: [...RETURN_OUTSIDE_METHODS] },
            },
            required: ['amount', 'at', 'method'],
          },
          items: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                orderItemId: { type: 'integer' },
                quantity: { type: 'integer' },
                amount: { type: 'number', description: 'What the units cost.' },
                deliveryAmount: {
                  type: 'number',
                  description: 'The part of the delivery that goes back with them.',
                },
                shippingDeduction: {
                  type: 'number',
                  description:
                    'The cost of sending the goods back taken off (the contract says the buyer ' +
                    'pays it), 0 for none.',
                },
                money: { type: 'string', enum: [...RETURN_MONEY] },
                refundedAt: { type: ['string', 'null'], format: 'date-time' },
                refusal: {
                  type: ['string', 'null'],
                  enum: [...RETURN_NOT_ACCEPTED_REASONS, 'not_arrived', null],
                  description:
                    'Why the money was refused: the shop did not accept the goods (the reason) or ' +
                    'they never came.',
                },
              },
              required: [
                'orderItemId',
                'quantity',
                'amount',
                'deliveryAmount',
                'shippingDeduction',
                'money',
                'refundedAt',
                'refusal',
              ],
            },
          },
        },
        required: [
          'id',
          'code',
          'statedAt',
          'source',
          'basis',
          'reason',
          'step',
          'closedAt',
          'proof',
          'shippingReimbursement',
          'items',
        ],
      },
    },
    withdrawable: {
      type: 'array',
      description:
        'The buyer: the units of each item they can still state (the order can be withdrawn from ' +
        'and the item has the right of withdrawal).',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { orderItemId: { type: 'integer' }, quantity: { type: 'integer' } },
        required: ['orderItemId', 'quantity'],
      },
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
    'withdrawalOpen',
    'returnStatus',
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
    variantId: wholeNumberField('Id of the variant'),
    quantity: wholeNumberField('Units to add'),
  },
  required: ['variantId', 'quantity'],
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
        'nextCursor of the previous page, with the same sortBy and sortDir. A changed cursor, or ' +
        'one from another sort, is CURSOR_INVALID.',
    },

    // filters; the cart (pending) is not in the list, GET /api/orders/current gives it
    status: {
      type: 'string',
      enum: ['waiting', 'unconfirmed', 'paid', 'shipped', 'delivered', 'cancelled'],
      description: 'Only the orders in this status.',
    },
    statuses: {
      type: 'string',
      pattern: `^(${LIST_STATUSES})(,(${LIST_STATUSES}))*$`,
      description: 'A few statuses separated by commas, for example paid,shipped.',
    },
    returnStatuses: {
      type: 'string',
      pattern: `^(${RETURN_STATUS_NAMES})(,(${RETURN_STATUS_NAMES}))*$`,
      description:
        'A few statuses of the statements of return separated by commas, for example ' +
        `open,open_partial: ${RETURN_STATUSES.join(', ')}.`,
    },
    productId: {
      type: 'integer',
      minimum: 1,
      maximum: MAX_ID,
      description: 'Only the orders that hold a variant of the product.',
    },
    variantId: {
      type: 'integer',
      minimum: 1,
      maximum: MAX_ID,
      description: 'Only the orders that hold the variant.',
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
    confirmed: {
      type: 'boolean',
      description:
        'true: only the orders that were confirmed (they have a reservation or a payment).',
    },
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
      description: 'Admin and root: true lists the orders that hold a variant without a weight.',
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
        'returnStatus',
        'shippingCostMissingSince',
      ],
      description:
        'createdAt by default, newest first. paidAt lists only the orders that are paid. ' +
        'returnStatus sorts by the status of the statements of return, in the order of the ' +
        `list ${RETURN_STATUSES.join(', ')}. ` +
        'destination sorts by the country and then the city and lists only the orders that go to ' +
        'an address. shippingCostMissingSince sorts by the oldest send of each order the shop ' +
        'owes the carrier for and has written no cost of, with shippingCostMissing only ' +
        '(SORT_SHIPPING_COST_MISSING_REQUIRES_FILTER); it is the sort of that filter by default, ' +
        'the oldest first.',
    },
    sortDir: {
      type: 'string',
      enum: ['asc', 'desc'],
      description: 'The direction of sortBy, desc (the newest first) by default.',
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

const deliveredAtSchema = {
  type: 'string',
  format: 'date-time',
  description:
    'With the step to delivered: the moment the carrier delivered the order (a pickup: it was ' +
    'collected), when the admin marks it later; not before the order was sent (a pickup: paid) and ' +
    'never of the future (ORDER_DELIVERED_AT_INVALID). Now when none is given. The period of ' +
    'withdrawal counts from it. Not allowed with another step (DELIVERED_AT_NOT_ALLOWED).',
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
          deliveredAt: deliveredAtSchema,
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
          returnStatus: {
            ...returnStatusField,
            description:
              'With ok: where the order stands as to its statements; any but none tells that ' +
              'statements changed its items (GET /api/orders/{orderId} says how).',
          },
          errorCode: {
            type: 'string',
            description:
              'Without ok: why the order did not take the step, the code PATCH ' +
              '/api/orders/{orderId}/status would answer (ORDER_NOT_FOUND, ' +
              'ORDER_STATUS_TRANSITION_INVALID, ORDER_HAS_OPEN_REFUSAL, ORDER_STATUS_CHANGED, RESOURCE_BUSY, ' +
              'SHIPMENT_NOT_ALLOWED, SHIPMENT_CARRIER_REQUIRED, ' +
              'SHIPMENT_CARRIER_INVALID, SHIPMENT_NUMBER_INVALID, KEEP_SHIPPING_COST_REQUIRED, ' +
              'KEEP_SHIPPING_COST_NOT_ALLOWED, DELIVERED_AT_NOT_ALLOWED, ORDER_DELIVERED_AT_INVALID).',
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
        '(collected), and one step back: delivered to shipped, shipped to paid. A cancel is a ' +
        'statement of return: POST /api/returns with the reason shop_cancel or refused.',
    },
    shipment: shipmentInputSchema,
    keepShippingCost: keepShippingCostSchema,
    deliveredAt: deliveredAtSchema,
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

const ordersWithdrawBodySchema = {
  $id: 'ordersWithdrawBodySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    items: {
      type: 'array',
      minItems: 1,
      maxItems: 100,
      description:
        'The units to withdraw from, each item of the order once. Without it: whatever is left of ' +
        'the order that has the right of withdrawal.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          orderItemId: wholeNumberField('Id of the item of the order'),
          quantity: wholeNumberField('Units of it'),
        },
        required: ['orderItemId', 'quantity'],
      },
    },
    description: {
      type: 'string',
      minLength: 1,
      maxLength: RETURN_DESCRIPTION_MAX,
      description: "The buyer's own words, for the shop.",
    },
  },
} as const;

const ordersReturnProofParamsSchema = {
  $id: 'ordersReturnProofParamsSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    orderId: idPathParam('the order'),
    returnId: idPathParam('the statement of the order'),
  },
  required: ['orderId', 'returnId'],
} as const;

const ordersReturnProofBodySchema = {
  $id: 'ordersReturnProofBodySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    carrier: {
      type: 'string',
      minLength: 1,
      maxLength: 100,
      description: 'Who carries the parcel.',
    },
    trackingNumber: {
      type: 'string',
      minLength: 1,
      maxLength: 100,
      description: 'The number of the parcel.',
    },
    trackingUrl: {
      type: 'string',
      maxLength: 500,
      pattern: '^https://[^\\s]+$',
      description: 'A link to follow the parcel (https).',
    },
  },
  required: ['carrier', 'trackingNumber'],
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

export const ordersDtoSchemas = [
  ordersWithdrawBodySchema,
  ordersReturnProofParamsSchema,
  ordersReturnProofBodySchema,
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
  ordersUpdateStatusResponseSchema,
  ordersListResponseSchema,
  ordersOrderItemParamsSchema,
];
