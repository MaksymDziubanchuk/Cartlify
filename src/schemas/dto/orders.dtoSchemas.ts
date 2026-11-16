import { buyerPaidField } from '@schemas/parcelFields.js';
import { MoneyPart, MoneyPurpose, MoneyState } from '@prisma/client';

import { DELIVERY_METHOD_NAMES } from '@config/deliveryMethods.js';
import { MONEY_LOG_EVENTS } from '@config/journalEvents.js';
import { ORDER_HOLD_REASONS } from '@helpers/orderHolds.js';
import { PARCEL_CASES } from '@routes/api/orders/services/helpers/parcelCases.helper.js';
import { PHONE_PATTERN, PROFILE_TEXT_MAX_LENGTH } from '@helpers/profileText.js';
import {
  RETURN_BASES,
  RETURN_DESCRIPTION_MAX,
  RETURN_MONEY,
  RETURN_NOT_ACCEPTED_REASONS,
  OUTSIDE_METHODS,
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

// the reasons that hold an order from its sending, for the pattern of a list of them
const HOLD_REASON_NAMES = ORDER_HOLD_REASONS.join('|');

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
    method: { type: 'string', enum: [...DELIVERY_METHOD_NAMES] },
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
    shipments: {
      type: 'array',
      description:
        'The parcels a carrier took, each from the moment it took it, the first one first: who ' +
        'carries each, how to follow it and where it stands; none before.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          carrier: { type: ['string', 'null'] },
          trackingNumber: { type: ['string', 'null'] },
          trackingUrl: { type: ['string', 'null'] },
          boxNumbers: {
            type: 'array',
            items: { type: 'string' },
            description:
              'The numbers of its boxes at the carrier; only when the carrier numbers each box.',
          },
          state: {
            ...{
              type: 'string',
              enum: [
                'created',
                'void_pending',
                'voided',
                'sent',
                'delivered',
                'returning',
                'returned',
                'lost',
              ],
            },
            description:
              'sent: the carrier has it; delivered; returning, returned: on its way back to the ' +
              'shop, back; lost: the carrier lost it.',
          },
        },
        required: ['carrier', 'trackingNumber', 'trackingUrl', 'state'],
      },
    },
  },
  required: ['method', 'price', 'recipient', 'address', 'note', 'pickup', 'shipments'],
} as const;

const orderDeliveryQuotesSchema = {
  type: 'array',
  description:
    'An order that is not confirmed: what each method the shop has enabled costs now, to the ' +
    'country of the delivery the order has.',
  items: {
    type: 'object',
    additionalProperties: false,
    properties: {
      method: { type: 'string', enum: [...DELIVERY_METHOD_NAMES] },
      price: {
        type: ['number', 'null'],
        description:
          'Empty while the order names no country the method goes to, and for a carrier: its ' +
          'price comes with the carriers for the address (POST ' +
          '/api/orders/current/delivery-options).',
      },
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
    method: { type: 'string', enum: [...DELIVERY_METHOD_NAMES] },
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
  description:
    'Admin and root: every parcel of the order, the latest first: the sends of a manual order and ' +
    'the parcels of the delivery provider, the voided ones and the ones taken back too.',
  items: {
    type: 'object',
    additionalProperties: false,
    properties: {
      id: { type: 'integer' },
      state: {
        ...{
          type: 'string',
          enum: [
            'created',
            'void_pending',
            'voided',
            'sent',
            'delivered',
            'returning',
            'returned',
            'lost',
          ],
        },
        description:
          'created: a parcel of the provider made, its label printed, the carrier has not taken it; ' +
          'void_pending: waiting for its void; voided; sent: the carrier has it; delivered; ' +
          'returning, returned; lost. A send of a manual order is sent from the start.',
      },
      labelUrl: {
        type: ['string', 'null'],
        description: 'The label of a parcel of the provider to print, none for a manual send.',
      },
      boxes: {
        type: 'array',
        description: 'The boxes of the parcel and what is in each.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            number: { type: 'integer' },
            weightGrams: { type: ['integer', 'null'] },
            lengthMm: { type: ['integer', 'null'] },
            widthMm: { type: ['integer', 'null'] },
            heightMm: { type: ['integer', 'null'] },
            trackingNumber: { type: ['string', 'null'] },
            labelUrl: { type: ['string', 'null'] },
            items: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: { orderItemId: { type: 'integer' }, quantity: { type: 'integer' } },
                required: ['orderItemId', 'quantity'],
              },
            },
          },
          required: [
            'number',
            'weightGrams',
            'lengthMm',
            'widthMm',
            'heightMm',
            'trackingNumber',
            'labelUrl',
            'items',
          ],
        },
      },
      carrier: { type: ['string', 'null'] },
      trackingNumber: { type: ['string', 'null'] },
      trackingUrl: { type: ['string', 'null'] },
      cost: {
        type: ['number', 'null'],
        description:
          'What the shop pays the carrier: the sum of the lines of the money journal of the send ' +
          '(the cost and its corrections), empty until a cost above 0 is written.',
      },
      expense: {
        type: 'boolean',
        description: 'false when the shop owes the carrier nothing for this send.',
      },
      shippedAt: {
        type: ['string', 'null'],
        format: 'date-time',
        description:
          'When the parcel was sent; empty while the carrier has not taken a parcel of the ' +
          'delivery provider.',
      },
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
      'state',
      'labelUrl',
      'boxes',
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
    holds: {
      type: 'array',
      description:
        'Admin and root: what keeps the order from its sending, the oldest first; the step to ' +
        'shipped is refused while the list is not empty (ORDER_ON_HOLD). Only a paid order is ' +
        'held: a dispute of its payment and a review of it by the provider until they end, a ' +
        'refund made by hand in the dashboard of the provider and an early warning of fraud until ' +
        'root decides.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          reason: { type: 'string', enum: [...ORDER_HOLD_REASONS] },
          since: { type: 'string', format: 'date-time', description: 'When it was put.' },
          ref: {
            type: ['string', 'integer'],
            description:
              'What put it: the id of the dispute (dispute) or of the line of the money journal ' +
              '(hand_refund), the id of the warning or of the review at the provider.',
          },
        },
        required: ['reason', 'since', 'ref'],
      },
    },
    fraudWarnedAt: {
      type: 'string',
      format: 'date-time',
      description:
        'Admin and root, only for an order the provider warned of after it was sent: when the ' +
        'warning that its payment may be fraud came (a paid order is held instead).',
    },
    money: {
      type: 'array',
      description:
        'Admin and root: the money of the order from the money journal, a line at a time, the ' +
        'oldest first: its payment, the refunds, the money of its statements, a late payment, ' +
        'the money of a dispute, what the shop paid the carriers. The whole lines are ' +
        'GET /api/admin/money-log?orderId=.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'integer', description: 'The line of the money journal.' },
          event: { type: 'string', enum: [...MONEY_LOG_EVENTS] },
          purpose: { type: 'string', enum: Object.values(MoneyPurpose) },
          part: { type: 'string', enum: Object.values(MoneyPart) },
          amount: {
            type: 'number',
            description: 'Above 0 to the shop, below 0 from it.',
          },
          state: {
            type: ['string', 'null'],
            enum: [...Object.values(MoneyState), null],
            description:
              'Where a refund stands (a line money.refund only; a failure is a line of its own).',
          },
          createdAt: { type: 'string', format: 'date-time' },
        },
        required: ['id', 'event', 'purpose', 'part', 'amount', 'state', 'createdAt'],
      },
    },
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
          description:
            'The money that went back to the buyer by the statements in all, the delivery with it ' +
            '(the sum of their refundedTotal, counted by the database from the money journal).',
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
          parcels: {
            type: 'array',
            description:
              'The parcels of the statement: the one the goods went back to the shop in (told by ' +
              'the buyer or sent by the shop), the ones the shop sent the goods it did not accept ' +
              'back in.',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                direction: { type: 'string', enum: ['to_shop', 'to_buyer'] },
                carrier: { type: ['string', 'null'] },
                trackingNumber: { type: ['string', 'null'] },
                trackingUrl: { type: ['string', 'null'] },
                shippedAt: { type: 'string', format: 'date-time' },
                confirmed: {
                  type: 'boolean',
                  description: 'A parcel to the shop: whether the shop confirmed it.',
                },
                buyerPaid: {
                  type: ['number', 'null'],
                  description: 'What the buyer paid the carrier for a parcel to the shop, as told.',
                },
              },
              required: [
                'direction',
                'carrier',
                'trackingNumber',
                'trackingUrl',
                'shippedAt',
                'confirmed',
                'buyerPaid',
              ],
            },
          },
          refundedTotal: {
            type: 'number',
            description:
              'How much went back to the buyer by this statement in all: what was sent or is on ' +
              'its way less what failed, the money sent another way, the way back paid back.',
          },
          refunds: {
            type: 'array',
            description:
              'The money the statement sent back, a movement at a time, the oldest first: a ' +
              'transfer to the way the buyer paid (payment), or money the shop sent another way ' +
              '(outside, with the way).',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                way: { type: 'string', enum: ['payment', 'outside'] },
                method: { type: ['string', 'null'], enum: [...OUTSIDE_METHODS, null] },
                state: {
                  type: 'string',
                  enum: ['in_transit', 'sent', 'failed'],
                  description:
                    'in_transit: the provider has not told it sent yet; sent; failed: it did not ' +
                    'reach the buyer (the shop writes about another way).',
                },
                goods: { type: 'number', description: 'What the units give back.' },
                delivery: {
                  type: 'number',
                  description: 'The delivery that goes back with them, 0 for none.',
                },
                deduction: {
                  type: 'number',
                  description:
                    'The cost of sending the goods back taken off (the contract says the buyer ' +
                    'pays it), 0 for none.',
                },
                wayBack: {
                  type: 'number',
                  description:
                    'What the buyer paid the carrier to send the goods back, given back when the ' +
                    'shop pays the way back, 0 for none.',
                },
                amount: {
                  type: 'number',
                  description:
                    'What the buyer gets: the goods, the delivery and the way back less the ' +
                    'deduction.',
                },
                at: {
                  type: 'string',
                  format: 'date-time',
                  description:
                    'When it was sent; while in transit, when it was asked; when it failed.',
                },
                bankReference: {
                  type: ['string', 'null'],
                  description:
                    'The number the bank gives to follow a transfer to the way the buyer paid ' +
                    '(ARN), to ask the bank about it; null until the provider tells it, and for ' +
                    'money sent another way.',
                },
              },
              required: [
                'way',
                'method',
                'state',
                'goods',
                'delivery',
                'deduction',
                'wayBack',
                'amount',
                'at',
                'bankReference',
              ],
            },
          },
          items: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: {
                  type: 'integer',
                  description: 'The row of the statement: the parcel of the buyer may name it.',
                },
                orderItemId: { type: 'integer' },
                quantity: { type: 'integer' },
                amount: { type: 'number', description: 'What the units cost.' },
                money: { type: 'string', enum: [...RETURN_MONEY] },
                refundedAt: {
                  type: ['string', 'null'],
                  format: 'date-time',
                  description: 'When the money of the units was sent.',
                },
                refusal: {
                  type: ['string', 'null'],
                  enum: [...RETURN_NOT_ACCEPTED_REASONS, 'not_arrived', null],
                  description:
                    'Why the money was refused: the shop did not accept the goods (the reason) or ' +
                    'they never came.',
                },
              },
              required: [
                'id',
                'orderItemId',
                'quantity',
                'amount',
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
          'parcels',
          'refundedTotal',
          'refunds',
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
    paymentCheck: {
      type: 'boolean',
      description:
        'The buyer: the payment came and the shop checks it once more before the order is sent ' +
        '(a warning of the network of the card, or a review of the payment provider); the shop ' +
        'writes when the order is sent or the money goes back.',
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

// a carrier of the delivery provider as a line of its prices names it
const deliveryCarrierSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 100, description: 'The carrier.' },
    service: { type: 'string', minLength: 1, maxLength: 100, description: 'Its service.' },
    connection: {
      type: 'string',
      minLength: 1,
      maxLength: 100,
      description: 'Its connection at the delivery provider.',
    },
  },
  required: ['name', 'service', 'connection'],
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
      enum: [...DELIVERY_METHOD_NAMES],
      description:
        'manual: the shop sends the order to an address; pickup: the buyer collects it at the ' +
        'shop; carrier: a carrier of the delivery provider sends it to an address, the one of ' +
        '`carrier`. A method the shop has not enabled is DELIVERY_METHOD_NOT_AVAILABLE.',
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
    carrier: {
      ...deliveryCarrierSchema,
      description:
        'The method carrier only (DELIVERY_CARRIER_REQUIRED without it, DELIVERY_CARRIER_NOT_ALLOWED ' +
        'with another method): the carrier the buyer picked, as a line of POST ' +
        '/api/orders/current/delivery-options names it.',
    },
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

const ordersDeliveryOptionsBodySchema = {
  $id: 'ordersDeliveryOptionsBodySchema',
  type: 'object',
  additionalProperties: false,
  properties: { address: confirmDeliveryAddressSchema },
  required: ['address'],
} as const;

const ordersDeliveryOptionsResponseSchema = {
  $id: 'ordersDeliveryOptionsResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    currency: {
      type: 'string',
      description: 'The currency of the prices, the one of the catalog.',
    },
    zone: {
      type: 'object',
      additionalProperties: false,
      description: 'The zone of the country of the address.',
      properties: {
        name: { type: 'string' },
        freeFrom: {
          type: ['number', 'null'],
          description: 'From this sum of the items every delivery to the zone is free.',
        },
      },
      required: ['name', 'freeFrom'],
    },
    remainingToFree: {
      type: ['number', 'null'],
      description: 'What the items still lack of the free delivery, 0 once it is free.',
    },
    options: {
      type: 'array',
      description:
        'The ways the cart goes to the address with their prices for its items: the manual ' +
        'delivery (when the zone has a price of it), the pickup, the carriers from the cheapest.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          method: { type: 'string', enum: [...DELIVERY_METHOD_NAMES] },
          price: {
            type: 'number',
            description:
              'What the buyer pays. From the free-from sum of the zone the manual delivery and ' +
              'the cheapest carrier are 0, another carrier costs what it costs above the cheapest.',
          },
          carrier: {
            anyOf: [deliveryCarrierSchema, { type: 'null' }],
            description:
              'The carrier, for the confirmation (delivery.carrier); null for the other methods.',
          },
          label: {
            type: ['string', 'null'],
            description: 'The name of the carrier for the buyer.',
          },
          days: {
            type: ['string', 'null'],
            description: 'How long the carrier takes, the way the shop wrote it ("1-3").',
          },
        },
        required: ['method', 'price', 'carrier', 'label', 'days'],
      },
    },
    carriersUnavailable: {
      type: ['string', 'null'],
      enum: [
        'not_enabled',
        'shipping_data_missing',
        'provider_down',
        'no_carrier_for_parcel',
        null,
      ],
      description:
        'Why no carrier is in the list: the shop sends by none (not_enabled), a variant of the ' +
        'cart has no weight or sizes (shipping_data_missing), the delivery provider does not ' +
        'answer now (provider_down), it answers and prices no carrier for this parcel to this ' +
        'address (no_carrier_for_parcel); null when the carriers are there.',
    },
  },
  required: ['currency', 'zone', 'remainingToFree', 'options', 'carriersUnavailable'],
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
      pattern: `^(${DELIVERY_METHOD_NAMES.join('|')})(,(${DELIVERY_METHOD_NAMES.join('|')}))*$`,
      description: `Admin and root: the orders of these methods (${DELIVERY_METHOD_NAMES.join(', ')}), through commas.`,
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
    holds: {
      type: 'string',
      pattern: `^(any|none|(${HOLD_REASON_NAMES})(,(${HOLD_REASON_NAMES}))*)$`,
      description:
        'Admin and root (FILTER_FORBIDDEN for a buyer): the orders that something holds from ' +
        `their sending for one of these reasons through commas (${ORDER_HOLD_REASONS.join(', ')}), ` +
        'any: for any reason, none: nothing holds them (with statuses=paid, the paid orders that ' +
        'wait only for the shop to send them).',
    },
    fraudWarnedFrom: {
      type: 'string',
      format: 'date-time',
      description:
        'Admin and root (FILTER_FORBIDDEN for a buyer): the orders the provider warned of after ' +
        'they were sent, at this time or later.',
    },
    parcels: {
      type: 'string',
      enum: [...PARCEL_CASES],
      description:
        'Admin and root (FILTER_FORBIDDEN for a buyer): the orders whose parcels of the delivery ' +
        'provider wait for an admin, the cases of the alerts parcels_*. not_collected: a parcel ' +
        'made and not taken by the carrier; void_pending: a parcel waiting for its void; ' +
        'coming_back: a parcel going back to the shop or back at it with units no statement ' +
        'holds; lost: a parcel the carrier lost with units no statement holds; ahead: a cancelled ' +
        'order a parcel of went to the buyer after the cancel, a paid order something holds the ' +
        'carrier took a parcel of, or a paid order the carrier has every live parcel of and that ' +
        'is not shipped; none: a paid order of the carrier with no live parcel yet.',
    },
    parcelsMadeTo: {
      type: 'string',
      format: 'date-time',
      description:
        'Admin and root (FILTER_FORBIDDEN for a buyer): with parcels=not_collected, only the ' +
        'parcels made before this time.',
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
// a box of a parcel as the admin lays it out: the four sizes together or none
// (SHIPMENT_BOX_SIZES_INVALID), the items of the order in it
const shipmentBoxInputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    weightGrams: { type: ['integer', 'null'], minimum: 1, maximum: 1000000 },
    lengthMm: { type: ['integer', 'null'], minimum: 1, maximum: 10000 },
    widthMm: { type: ['integer', 'null'], minimum: 1, maximum: 10000 },
    heightMm: { type: ['integer', 'null'], minimum: 1, maximum: 10000 },
    items: {
      type: 'array',
      minItems: 1,
      maxItems: 1000,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          orderItemId: { type: 'integer', minimum: 1, maximum: MAX_ID },
          quantity: { type: 'integer', minimum: 1, maximum: 1000000 },
        },
        required: ['orderItemId', 'quantity'],
      },
      description: 'The items of the order in the box, each once, with its units.',
    },
  },
  required: ['items'],
} as const;

const shipmentInputSchema = {
  type: 'object',
  additionalProperties: false,
  description:
    'A parcel, with the step to shipped of a manual order, each part only if known. A number and ' +
    'a link each need the carrier (SHIPMENT_CARRIER_REQUIRED); a link may come without a number. A ' +
    'pickup has none (SHIPMENT_NOT_ALLOWED).',
  properties: {
    boxes: {
      type: 'array',
      minItems: 1,
      maxItems: 100,
      items: shipmentBoxInputSchema,
      description:
        'The boxes of the parcel and what is in each. The boxes of all the parcels hold every unit ' +
        'that travels (the units statements brought back before do not), no more and no less ' +
        '(PARCEL_ITEMS_MISMATCH, `details.items` `{ orderItemId, units, packed }`). The one ' +
        'parcel of an order may come without them: one box with every unit, its weight and sizes ' +
        'when every variant has them.',
    },
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
        'What the shop pays the carrier, a line of the money journal of the send; 0 or none ' +
        'writes no line (a cost of nothing and a cost not known yet are the same), left out until ' +
        'the admin writes it (PATCH /api/orders/{orderId}/shipments/{shipmentId}).',
    },
  },
} as const;

// the parcels of a manual order with the step to shipped; none: one parcel, nothing known of it
const shipmentsInputSchema = {
  type: 'array',
  minItems: 1,
  maxItems: 20,
  items: shipmentInputSchema,
  description:
    'The parcels of a manual order with the step to shipped (an order of a carrier of the delivery ' +
    'provider is sent with the parcels the app made for it, PARCELS_REQUIRED without them; a pickup ' +
    'has none, SHIPMENT_NOT_ALLOWED). None: one parcel of every unit, nothing known of it. Several: ' +
    'each with its boxes.',
} as const;

// the boxes of the parcels of an order of a carrier: the box of the draft and of the answers
const parcelBoxDataSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    weightGrams: { type: ['integer', 'null'] },
    lengthMm: { type: ['integer', 'null'] },
    widthMm: { type: ['integer', 'null'] },
    heightMm: { type: ['integer', 'null'] },
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { orderItemId: { type: 'integer' }, quantity: { type: 'integer' } },
        required: ['orderItemId', 'quantity'],
      },
    },
  },
  required: ['weightGrams', 'lengthMm', 'widthMm', 'heightMm', 'items'],
} as const;

const ordersParcelsBodySchema = {
  $id: 'ordersParcelsBodySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    parcels: {
      type: 'array',
      minItems: 1,
      maxItems: 20,
      description:
        'The parcels and the boxes of each, every unit left laid out once (PARCEL_ITEMS_MISMATCH); ' +
        'every box with its weight and sizes (PARCEL_BOX_SIZES_REQUIRED). None: the draft, one ' +
        'parcel of one box of every unit.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          boxes: { type: 'array', minItems: 1, maxItems: 100, items: shipmentBoxInputSchema },
        },
        required: ['boxes'],
      },
    },
  },
} as const;

const ordersCarriersResponseSchema = {
  $id: 'ordersCarriersResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    carriers: {
      type: 'array',
      description:
        'The carriers of the delivery provider for the order to its address now, the cheapest first.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          carrier: deliveryCarrierSchema,
          label: { type: ['string', 'null'], description: 'The name of the carrier.' },
          days: { type: ['string', 'null'], description: 'How long the carrier takes ("1-3").' },
          price: {
            type: 'number',
            description:
              'What the provider counts for the parcel now: the cost of the shop, not what the ' +
              'buyer paid.',
          },
        },
        required: ['carrier', 'label', 'days', 'price'],
      },
    },
  },
  required: ['carriers'],
  examples: [
    {
      carriers: [
        {
          carrier: { name: 'Correos', service: 'Standard', connection: '6001' },
          label: 'Correos Standard',
          days: '2-4',
          price: 4.5,
        },
      ],
    },
  ],
} as const;

const ordersParcelsDraftResponseSchema = {
  $id: 'ordersParcelsDraftResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    carrier: deliveryCarrierSchema,
    parcels: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { boxes: { type: 'array', items: parcelBoxDataSchema } },
        required: ['boxes'],
      },
    },
  },
  required: ['carrier', 'parcels'],
} as const;

const ordersParcelsResultSchema = {
  $id: 'ordersParcelsResultSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    order: { $ref: 'ordersOrderResponseSchema#' },
    made: {
      type: 'array',
      items: { type: 'integer' },
      description: 'The ids of the parcels made now (shipments of the order).',
    },
    failed: {
      type: ['object', 'null'],
      additionalProperties: false,
      description:
        'The parcel that was not made after others were (its place in the request, from 1), with ' +
        'the code and the reason of the carrier; the parcels made stay, a new request makes the ' +
        'rest. Null when every parcel was made.',
      properties: {
        parcel: { type: 'integer' },
        errorCode: { type: 'string' },
        message: { type: ['string', 'null'] },
      },
      required: ['parcel', 'errorCode', 'message'],
    },
  },
  required: ['order', 'made', 'failed'],
} as const;

const ordersParcelsBulkBodySchema = {
  $id: 'ordersParcelsBulkBodySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    orderIds: {
      type: 'array',
      minItems: 1,
      // each order asks the provider for its labels, one after another: twenty answer in time
      maxItems: 20,
      items: { type: 'integer', minimum: 1, maximum: MAX_ID },
      description: 'The orders, each made by its draft: 20 at most in one request.',
    },
  },
  required: ['orderIds'],
} as const;

const ordersParcelsBulkResultSchema = {
  $id: 'ordersParcelsBulkResultSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          orderId: { type: 'integer' },
          ok: { type: 'boolean' },
          made: { type: 'array', items: { type: 'integer' } },
          errorCode: { type: 'string' },
          message: { type: ['string', 'null'] },
        },
        required: ['orderId', 'ok', 'made'],
      },
    },
  },
  required: ['results'],
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
    'send as owed (the carrier was used), false makes it 0 (the shipping was a mistake: a line of ' +
    'the money journal corrects the cost it had to nothing, the admin log keeps it). Needed ' +
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
          shipments: shipmentsInputSchema,
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
              'ORDER_STATUS_TRANSITION_INVALID, ORDER_HAS_OPEN_REFUSAL, ORDER_ON_HOLD with ' +
              'details.holds, ORDER_STATUS_CHANGED, RESOURCE_BUSY, ' +
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
    shipments: shipmentsInputSchema,
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

const ordersCarrierMoneyBodySchema = {
  $id: 'ordersCarrierMoneyBodySchema',
  type: 'object',
  additionalProperties: false,
  required: ['amount', 'method', 'note', 'at'],
  properties: {
    amount: {
      type: 'number',
      exclusiveMinimum: 0,
      maximum: 99_999_999.99,
      multipleOf: 0.01,
      description: 'What the carrier paid, to the cent.',
    },
    method: {
      type: 'string',
      enum: [...OUTSIDE_METHODS],
      description: 'How the money came: a bank transfer, cash or another way.',
    },
    note: {
      type: 'string',
      minLength: 1,
      maxLength: 500,
      description: 'What the carrier paid for: for the shop.',
    },
    at: {
      type: 'string',
      format: 'date-time',
      description: 'The day the money really came: never of the future, never before the send.',
    },
  },
} as const;

const ordersShipmentUpdateBodySchema = {
  $id: 'ordersShipmentUpdateBodySchema',
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  description:
    'What changes, each part only if it does. null clears a carrier, a number or a link; the send ' +
    'holds together: a number and a link each need the carrier, a link may come without a number.',
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
      description:
        'What the shop pays the carrier, a line of the money journal of the send: the first cost ' +
        'above 0, then each other cost a new line of the difference (a past period of the reports ' +
        'does not change), 0 included. A line is never taken away: null is a cost of 0, the cost ' +
        'written is corrected to nothing. The same cost again, or 0 while none is written, writes ' +
        'nothing.',
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
    'sent whole and is checked the way the confirmation checks it. The price stays; the method stays ' +
    'but for an order of a carrier sent by hand (method manual).',
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
    carrier: {
      ...deliveryCarrierSchema,
      description:
        'An order of a carrier before its parcels are made: another carrier of the delivery ' +
        'provider, one of its prices now for the address and the order (the carriers of POST ' +
        '/api/orders/current/delivery-options for a buyer; DELIVERY_SERVICE_UNAVAILABLE for another).',
    },
    method: {
      type: 'string',
      enum: ['manual'],
      description:
        'An order of a carrier before its parcels are made, sent by hand outside the delivery ' +
        'provider: the method becomes manual, the carrier goes, the price of the buyer stays.',
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
    buyerPaid: buyerPaidField,
    items: {
      type: 'array',
      minItems: 1,
      maxItems: 100,
      description:
        'The rows of the statement and the units the parcel carries (`id` of the rows of the ' +
        'statement in `withdrawals`). The units that wait and are not named go into a statement of ' +
        'their own, to be sent in a parcel of their own. Without it: the parcel carries them all.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          itemId: wholeNumberField('Id of a row of the statement'),
          quantity: wholeNumberField('Units of it in the parcel'),
        },
        required: ['itemId', 'quantity'],
      },
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

// what holds a paid order from its sending and is root's to decide on
export const ROOT_HOLD_REASONS = ['hand_refund', 'fraud_warning'] as const;

const ordersHoldDecisionParamsSchema = {
  $id: 'ordersHoldDecisionParamsSchema',
  type: 'object',
  additionalProperties: false,
  required: ['orderId', 'reason'],
  properties: {
    orderId: idPathParam('the order'),
    reason: {
      type: 'string',
      enum: [...ROOT_HOLD_REASONS],
      description:
        'What holds the order that root decides on: `hand_refund` (a refund made by hand in the ' +
        'dashboard of the provider of part of the payment) or `fraud_warning` (an early warning ' +
        'of fraud of the network of the card). A dispute and a review of the provider are let go ' +
        'by the system only.',
    },
  },
} as const;

const ordersHoldDecisionBodySchema = {
  $id: 'ordersHoldDecisionBodySchema',
  type: 'object',
  additionalProperties: false,
  required: ['decision', 'note'],
  properties: {
    decision: {
      type: 'string',
      enum: ['ship', 'cancel'],
      description:
        'ship: the hold goes and the order may be sent (a refund made by hand is a compensation); ' +
        'cancel: root cancels what is left of the order by a statement of the shop and its money ' +
        'goes back (a refund made by hand is used first).',
    },
    note: {
      type: 'string',
      minLength: 1,
      maxLength: 500,
      description: 'Why: for the journal of the admins, not mailed to the buyer.',
    },
  },
} as const;

export const ordersDtoSchemas = [
  ordersWithdrawBodySchema,
  ordersReturnProofParamsSchema,
  ordersReturnProofBodySchema,
  ordersCurrentAddItemBodySchema,
  ordersCurrentItemIdParamsSchema,
  ordersCurrentUpdateItemBodySchema,
  ordersCurrentConfirmBodySchema,
  ordersDeliveryOptionsBodySchema,
  ordersDeliveryOptionsResponseSchema,
  ordersParcelsBodySchema,
  ordersCarriersResponseSchema,
  ordersParcelsDraftResponseSchema,
  ordersParcelsResultSchema,
  ordersParcelsBulkBodySchema,
  ordersParcelsBulkResultSchema,

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
  ordersCarrierMoneyBodySchema,
  ordersDeliveryUpdateBodySchema,
  ordersUpdateStatusResponseSchema,
  ordersListResponseSchema,
  ordersOrderItemParamsSchema,
  ordersHoldDecisionParamsSchema,
  ordersHoldDecisionBodySchema,
];
