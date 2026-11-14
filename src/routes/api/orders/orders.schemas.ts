import type { FastifySchema } from 'fastify';

import { openApiSecurity } from '@config/openapi.js';
import { withOpenApiSecurity } from '@helpers/withOpenApiSecurity.js';
import { withOpenApiTag } from '@helpers/withOpenApiTag.js';

const orderProductExample = {
  id: 10,
  name: 'Wireless headphones',
  categoryId: 1,
};

// the variant that is bought, with its own price, free units and main picture
const orderVariantExample = {
  id: 21,
  position: 2,
  name: 'Wireless headphones',
  price: 49.99,
  stock: 15,
  image: {
    url200: 'https://example.com/products/headphones-black-200.webp',
    url400: 'https://example.com/products/headphones-black-400.webp',
    url800: 'https://example.com/products/headphones-black-800.webp',
  },
  forSale: true,
};

const orderItemExample = {
  id: 1,
  product: orderProductExample,
  variant: orderVariantExample,
  quantity: 2,
  unitPrice: 49.99,
  totalPrice: 99.98,
  withdrawal: { rule: 'allowed', right: 'full' },
};

// where and to whom a confirmed order goes
const deliveryExample = {
  method: 'manual',
  price: 4.99,
  recipient: { firstName: 'Anna', lastName: 'Koval', phone: '+380501234567' },
  address: {
    country: 'UA',
    postalCode: '01001',
    city: 'Kyiv',
    street: 'Khreshchatyk',
    house: '1',
    apartment: '12',
  },
  note: 'Leave near the door.',
  pickup: null,
  shipment: null,
};

// a cart: nothing chosen yet, the shop quotes each method it has enabled
const orderExample = {
  id: 1,
  userId: 1,
  status: 'pending',
  items: [orderItemExample],
  itemsTotal: 99.98,
  total: 99.98,
  delivery: null,
  deliveryQuotes: [
    { method: 'manual', price: 4.99, freeFrom: 150, remainingToFree: 50.02 },
    { method: 'pickup', price: 0, freeFrom: null, remainingToFree: null },
  ],
  createdAt: '2026-01-01T10:00:00.000Z',
  updatedAt: '2026-01-01T10:00:00.000Z',
  confirmed: false,
  withdrawalOpen: false,
  returnStatus: 'none',
};

// a confirmed order waits for the payment until reservationExpiresAt
const waitingOrderExample = {
  ...orderExample,
  status: 'waiting',
  confirmed: true,
  total: 104.97,
  delivery: deliveryExample,
  deliveryQuotes: undefined,
  reservationExpiresAt: '2026-01-01T10:15:00.000Z',
};

const shippedOrderExample = {
  ...waitingOrderExample,
  status: 'shipped',
  withdrawalOpen: true,
  reservationExpiresAt: undefined,
  delivery: {
    ...deliveryExample,
    shipment: {
      carrier: 'DHL',
      trackingNumber: 'JD0146000123',
      trackingUrl: 'https://track.example.com/JD0146000123',
    },
  },
  paidAt: '2026-01-01T10:05:00.000Z',
};

const ordersListQueryExample = {
  limit: 20,
  status: 'unconfirmed',
  sortBy: 'createdAt',
  sortDir: 'desc',
};

const orderItemParamsExample = {
  orderId: '1',
  itemId: '1',
};

// an order that lost its reservation: it keeps its items and where it goes, and costs its items
// again until it is confirmed
const unconfirmedOrderExample = {
  ...orderExample,
  status: 'unconfirmed',
  confirmed: false,
  delivery: deliveryExample,
};

const ordersListResponseExample = {
  items: [shippedOrderExample],
  limit: 20,
  nextCursor: null,
  total: 1,
};

const addCurrentOrderItemBodyExample = {
  variantId: 21,
  quantity: 2,
};

const currentOrderItemParamsExample = {
  itemId: '1',
};

const updateCurrentOrderItemBodyExample = {
  quantity: 3,
};

const confirmCurrentOrderBodyExample = {
  orderId: 1,
  delivery: {
    method: 'manual',
    recipientFirstName: 'Anna',
    recipientLastName: 'Koval',
    recipientPhone: '+380501234567',
    address: {
      country: 'UA',
      postalCode: '01001',
      city: 'Kyiv',
      street: 'Khreshchatyk',
      house: '1',
      apartment: '12',
    },
    note: 'Leave near the door.',
  },
  expectedDeliveryPrice: 4.99,
};

const orderIdParamsExample = {
  orderId: '1',
};

const updateOrderStatusBodyExample = {
  status: 'shipped',
};

// Schema for current user order lookup
const getCurrentOrderSchema = {
  operationId: 'getCurrentOrder',
  summary: 'Get current order',
  description:
    'Returns the current authenticated user order or cart state. Item prices are brought to current variant prices before the order is returned, and the items of variants a buyer does not see (taken out of sale, their product removed, without a picture) are removed from the cart for good: the page shows only what can be confirmed.',

  response: {
    200: {
      description: 'Current order was returned successfully.',
      $ref: 'ordersOrderResponseSchema#',
      examples: [orderExample],
    },

    401: {
      description: 'Authentication is required to read the current order.',
      $ref: 'errorResponseSchema#',
    },
    403: {
      description: 'The authenticated user is not allowed to access this order.',
      $ref: 'errorResponseSchema#',
    },
    404: {
      description: '`CURRENT_ORDER_NOT_FOUND`: the user has no cart yet, the first item makes one.',
      $ref: 'errorResponseSchema#',
    },
    409: {
      description: '`RESOURCE_BUSY`: the order is being changed by another request, try again.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while loading current order.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// Schema for adding item to current order
const postCurrentItemsSchema = {
  operationId: 'addCurrentOrderItem',
  summary: 'Add item to current order',
  description:
    'Adds a variant to the current authenticated user order (the same variant again adds units to its position). The answer is the cart at current prices, without the items of variants a buyer does not see: they are removed from it for good.',

  body: {
    $ref: 'ordersCurrentAddItemBodySchema#',
    examples: [addCurrentOrderItemBodyExample],
  },

  response: {
    200: {
      description: 'Item was added to the current order successfully.',
      $ref: 'ordersOrderResponseSchema#',
      examples: [orderExample],
    },

    400: {
      description: 'Invalid add item request.',
      $ref: 'errorResponseSchema#',
    },
    401: {
      description: 'Authentication is required to add an order item.',
      $ref: 'errorResponseSchema#',
    },
    403: {
      description: 'The authenticated user is not allowed to modify this order.',
      $ref: 'errorResponseSchema#',
    },
    404: {
      description:
        '`VARIANT_NOT_FOUND`: the variant does not exist or a buyer does not see it (taken out of sale, its product removed, no picture), `details.variantId`.',
      $ref: 'errorResponseSchema#',
    },
    409: {
      description:
        '`OUT_OF_STOCK`: fewer free units than the cart would hold, `details: { variantId, available, requested }`. ' +
        '`ORDER_NOT_EDITABLE`: another request confirmed the cart meanwhile. ' +
        '`RESOURCE_BUSY`: the order is being changed by another request, try again.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while adding order item.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// Schema for updating item in current order
const patchCurrentItemsSchema = {
  operationId: 'updateCurrentOrderItem',
  summary: 'Update current order item',
  description:
    'Updates quantity for an item in the current authenticated user order. The answer is the cart at current prices, without the items of variants a buyer does not see: they are removed from it for good.',

  params: {
    $ref: 'ordersCurrentItemIdParamsSchema#',
    examples: [currentOrderItemParamsExample],
  },

  body: {
    $ref: 'ordersCurrentUpdateItemBodySchema#',
    examples: [updateCurrentOrderItemBodyExample],
  },

  response: {
    200: {
      description: 'Current order item was updated successfully.',
      $ref: 'ordersOrderResponseSchema#',
      examples: [
        {
          ...orderExample,
          total: 149.97,
          items: [
            {
              ...orderItemExample,
              quantity: 3,
              totalPrice: 149.97,
            },
          ],
        },
      ],
    },

    400: {
      description: 'Invalid update item request.',
      $ref: 'errorResponseSchema#',
    },
    401: {
      description: 'Authentication is required to update an order item.',
      $ref: 'errorResponseSchema#',
    },
    403: {
      description: 'The authenticated user is not allowed to modify this order.',
      $ref: 'errorResponseSchema#',
    },
    404: {
      description:
        '`ORDER_ITEM_NOT_FOUND`: no such item in the cart, `details.itemId`. ' +
        '`VARIANT_NOT_FOUND`: the variant of the item is not for sale any more, remove the item.',
      $ref: 'errorResponseSchema#',
    },
    409: {
      description:
        '`OUT_OF_STOCK`: fewer free units than the new quantity, `details: { variantId, available, requested }`. ' +
        '`ORDER_NOT_EDITABLE`: another request confirmed the cart meanwhile. ' +
        '`RESOURCE_BUSY`: the order is being changed by another request, try again.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while updating order item.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// Schema for removing item from current order
const deleteCurrentItemsSchema = {
  operationId: 'deleteCurrentOrderItem',
  summary: 'Delete current order item',
  description:
    'Removes an item from the current authenticated user order. The answer is the cart at current prices, without the items of variants a buyer does not see: they are removed from it for good.',

  params: {
    $ref: 'ordersCurrentItemIdParamsSchema#',
    examples: [currentOrderItemParamsExample],
  },

  response: {
    200: {
      description: 'Current order item was removed successfully.',
      $ref: 'ordersOrderResponseSchema#',
      examples: [
        {
          ...orderExample,
          total: 0,
          items: [],
        },
      ],
    },

    400: {
      description: 'Invalid delete item request.',
      $ref: 'errorResponseSchema#',
    },
    401: {
      description: 'Authentication is required to delete an order item.',
      $ref: 'errorResponseSchema#',
    },
    403: {
      description: 'The authenticated user is not allowed to modify this order.',
      $ref: 'errorResponseSchema#',
    },
    404: {
      description: '`ORDER_ITEM_NOT_FOUND`: no such item in the cart, `details.itemId`.',
      $ref: 'errorResponseSchema#',
    },
    409: {
      description:
        '`ORDER_NOT_EDITABLE`: another request confirmed the cart meanwhile. ' +
        '`RESOURCE_BUSY`: the order is being changed by another request, try again.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while deleting order item.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// Schema for confirming current order
const postCurrentConfirmSchema = {
  operationId: 'confirmCurrentOrder',
  summary: 'Confirm current order',
  description:
    'Confirms the current order, reserves stock and prepares it for checkout. ' +
    'The `delivery` says where and to whom the order goes: the method the shop has enabled (`manual`: the shop sends it to an address; `pickup`: the buyer collects it at the shop, GET /api/delivery/methods lists them), the recipient and, for `manual`, the address (a country the shop delivers to, the postal code in the form of its country, the city, the street, the house, the apartment if there is one). A buyer is a person, not a company. It is whole when sent and replaces what the order has; an order that lost its reservation (`unconfirmed`) keeps it, so confirming it again needs only `orderId`. A confirmation that fails stores nothing. ' +
    'A page can take the first name and the phone from the profile, the last name is asked from the person, and the cart offers the delivery of the last order (`deliverySuggestion`) to start from. `note` is optional. After the confirmation the order keeps the delivery as it is. ' +
    'The confirmation fixes the price of the delivery by the rule of the shop (a flat price for `manual`, free from a sum of the items, nothing for `pickup`); `total` is the items and that price. `expectedDeliveryPrice` (required) is the price the page showed: another price now refuses the confirmation (`DELIVERY_PRICE_CHANGED`), the page shows the price now and the buyer confirms again. ' +
    'When an item price differs from the current price of its variant, the order is not confirmed and `ORDER_PRICES_CHANGED` is returned: reload the order to get fresh prices and confirm again.',

  body: {
    $ref: 'ordersCurrentConfirmBodySchema#',
    examples: [confirmCurrentOrderBodyExample],
  },

  response: {
    200: {
      description: 'Current order was confirmed successfully.',
      $ref: 'ordersOrderResponseSchema#',
      examples: [waitingOrderExample],
    },

    400: {
      description:
        'Invalid confirm order request. `VALIDATION_ERROR`: a field breaks the request schema (length, phone format, a country that is not two capital letters, a part of the delivery that is missing). ' +
        '`RECIPIENT_FIRST_NAME_INVALID`, `RECIPIENT_LAST_NAME_INVALID`: a name without a letter or with a digit. `RECIPIENT_PHONE_INVALID`: a phone of another form (the request schema refuses it first, so over HTTP it is `VALIDATION_ERROR`). ' +
        '`DELIVERY_REQUIRED`: the order has no delivery and the request did not bring one. ' +
        '`DELIVERY_METHOD_NOT_AVAILABLE`: the shop has not enabled the method, `details.method`. ' +
        '`DELIVERY_ADDRESS_REQUIRED`: the manual method without an address. `DELIVERY_ADDRESS_NOT_ALLOWED`: a pickup with an address. ' +
        '`DELIVERY_COUNTRY_NOT_ALLOWED`: the shop does not deliver to the country, `details.country`. ' +
        '`DELIVERY_POSTAL_CODE_INVALID`: not a postal code of that country (a typo, a code of another country). ' +
        '`DELIVERY_CITY_INVALID`, `DELIVERY_STREET_INVALID`: no letter in it. `DELIVERY_HOUSE_INVALID`: a house of only spaces. ' +
        '`ORDER_ITEMS_REQUIRED`: the order is empty. ' +
        '`ORDER_TOTAL_BELOW_MINIMUM`: the total, the items at the prices of the catalog and the delivery, is below the smallest payment any payment provider takes, nothing is reserved; `details` has the smallest total (`minimum`) and its `currency`.',
      $ref: 'errorResponseSchema#',
    },
    401: {
      description: 'Authentication is required to confirm an order.',
      $ref: 'errorResponseSchema#',
    },
    403: {
      description: 'The authenticated user is not allowed to confirm this order.',
      $ref: 'errorResponseSchema#',
    },
    404: {
      description:
        '`ORDER_NOT_FOUND`: there is no cart, or no own unconfirmed order with the `orderId` of the body.',
      $ref: 'errorResponseSchema#',
    },
    409: {
      description:
        'Order state, variant stock or changed item prices do not allow confirmation. ' +
        '`ORDER_ITEMS_UNAVAILABLE`: some items cannot be confirmed, `details.items` names each: ' +
        '`{ itemId, variantId, reason: deleted | out_of_stock, available, requested }` (deleted: the variant is not for sale any more, taken out of sale, its product removed or without a picture); the owner removes or changes them and confirms again. ' +
        'The same code names the items when another buyer took the last free units at the same moment. ' +
        '`ORDER_PRICES_CHANGED`: the price of an item is not the price its variant sells at now, `details.items` names them `[{ itemId, variantId, unitPrice, price }]` (`price` is the one now); reload the order and confirm again. ' +
        '`DELIVERY_PRICE_CHANGED`: the price of the delivery the page showed (`expectedDeliveryPrice`) is not the price now, `details.price` is the price now; the page shows it and the buyer confirms again. `ORDER_ALREADY_CONFIRMED`: the order is confirmed already, it waits for its payment or is paid, shipped, delivered or cancelled. ' +
        '`ORDER_STATUS_NOT_ALLOWED`: the order is not a cart nor an unconfirmed order. ' +
        '`LEGAL_ACCEPTANCE_REQUIRED`: the customer did not accept a version in force of the terms ' +
        'or of the contract; `details.kinds` the kinds missing, `details.current` the versions in ' +
        'force `{ id, kind, version, title }`: the page shows a checkbox for each, opens its text ' +
        'with GET /api/legal/documents/:documentId, the customer accepts with POST ' +
        '/api/legal/acceptances and confirms again.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while confirming order.',
      $ref: 'errorResponseSchema#',
    },
    503: {
      description: 'Order confirmation is temporarily unavailable because Redis is down.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// Schema for order list lookup
const getOrdersSchema = {
  operationId: 'getOrders',
  summary: 'Get orders',
  description:
    'Returns orders visible to the authenticated user, admin or root role, newest first by default (`sortBy=createdAt`). ' +
    'The cart (`pending`) is not an order and is not listed, GET /api/orders/current gives it. ' +
    'A paid order shows the prices it was paid with; an unconfirmed order of the user shows current prices, the items of variants a buyer does not see are removed from it. ' +
    '`paidFrom` and `paidTo` keep the orders paid in that period, from its start and before its end, cancelled ones too (`cancelledAt` says when); `sortBy=paidAt` lists the paid orders by the time of their payment. ' +
    '`statuses` takes a few statuses, `productId` the orders that hold a variant of a product, `variantId` the orders that hold the variant. The desk of an admin: `userId` (the orders of a buyer) and `q` (a number of an order, or a part of the email of the buyer, the name or the phone of the recipient, the city or the postal code of the address, a tracking number), each row names its `buyer`; `format=csv` gives every order of the filters as a file for the courier, without pages. What holds the orders from their sending: `holds` (reasons through commas, `any` or `none`; `holds=none&statuses=paid` are the paid orders that wait only for the shop) and `fraudWarnedFrom` (the orders the provider warned of after they were sent); each row of an admin has its `holds`, `fraudWarnedAt` and `money` (the lines of the money journal of the order).',

  querystring: {
    $ref: 'ordersGetQuerySchema#',
    examples: [ordersListQueryExample],
  },

  response: {
    200: {
      description: 'Orders were returned successfully; a csv file with format=csv.',
      content: {
        'application/json': {
          schema: { $ref: 'ordersListResponseSchema#' },
          examples: { orders: { value: ordersListResponseExample } },
        },
        'text/csv': {
          schema: {
            type: 'string',
            description:
              'Order, Status, Paid at, Buyer email, Recipient, Phone, Method, Country, Postal code, City, Street, House, Apartment, Note, Delivery price, Items, Weight g, Weight complete, Total, Carrier, Tracking number, Shipping cost.',
          },
        },
      },
    },

    400: {
      description:
        'Invalid orders query parameters, including `CURSOR_INVALID` (a cursor of another sort or direction too), a status the list has not (`STATUS_INVALID`), a period of the payment that does not end after it starts (`PAID_PERIOD_INVALID`), such a period of the last change (`UPDATED_PERIOD_INVALID`) and the sort by the send without a cost without its filter (`SORT_SHIPPING_COST_MISSING_REQUIRES_FILTER`).',
      $ref: 'errorResponseSchema#',
    },
    401: {
      description: 'Authentication is required to read orders.',
      $ref: 'errorResponseSchema#',
    },
    403: {
      description:
        'The authenticated user is not allowed to read these orders; a filter of the desk of an admin for a buyer (`FILTER_FORBIDDEN`, `details.filter`).',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while loading orders.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// Schema for single order lookup
const getOrderByIdSchema = {
  operationId: 'getOrderById',
  summary: 'Get order by id',
  description:
    'Returns one order by id if it is visible to the authenticated user. For the owner of an order that is not confirmed (the cart or an order that lost its reservation, `unconfirmed`), item prices are brought to current variant prices before the order is returned, ' +
    'and the order loses the items of variants a buyer does not see; an order waiting for its payment keeps them (`variant.forSale: false`), its payment page names the ones taken out of sale. ' +
    'Each item shows `variant.stock`, so the page can mark the items there is not enough of before the order is confirmed again. ' +
    'An admin or root also gets the sends with their cost, the weight, the statements, what holds the order from its sending (`holds`), the warning of the provider about an order already sent (`fraudWarnedAt`) and the money of the order from the money journal (`money`, short: the event, the part, the sum, where a refund stands, when).',

  params: {
    $ref: 'ordersGetByIdParamsSchema#',
    examples: [orderIdParamsExample],
  },

  response: {
    200: {
      description: 'Order was returned successfully.',
      $ref: 'ordersOrderResponseSchema#',
      examples: [waitingOrderExample],
    },

    400: {
      description: 'Invalid order id.',
      $ref: 'errorResponseSchema#',
    },
    401: {
      description: 'Authentication is required to read this order.',
      $ref: 'errorResponseSchema#',
    },
    403: {
      description: 'The authenticated user is not allowed to read this order.',
      $ref: 'errorResponseSchema#',
    },
    404: {
      description: '`ORDER_NOT_FOUND`: no order with this id the user may read.',
      $ref: 'errorResponseSchema#',
    },
    409: {
      description: '`RESOURCE_BUSY`: the order is being changed by another request, try again.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while loading order.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// Schema for admin order status update
const patchOrderStatusSchema = {
  operationId: 'updateOrderStatus',
  summary: 'Update order status',
  description:
    'Takes an order one step: a paid order becomes shipped, a shipped one delivered, and one step back: a delivered order shipped, a shipped one paid. A step over (paid straight to delivered) is not one. ' +
    'Shipping a manual order records the send (`shipment`: the carrier, the tracking number, the link, what the shop pays the carrier, each only if known; a number and a link each need the carrier, a link may come without a number); a pickup is shipped when it is ready to be collected, delivered when it is collected, and has no send. ' +
    'What the shop pays the carrier is a line of the money journal, written in the same transaction (a cost of 0 writes none). An order something holds (`holds`: a dispute of its payment, a refund made by hand root has not decided on, a warning or a review of the provider) is not sent (`ORDER_ON_HOLD`). ' +
    'The step back of a manual order takes the send back (it stays as history) and needs `keepShippingCost`: true keeps its cost as owed to the carrier, false makes it 0 (a mistake: a line of the money journal corrects the cost it had to nothing, the admin log keeps it). ' +
    'Every step is written to the admin log with what it did. The buyer is mailed after each step, unless the account is deleted: a shipped order (a pickup: ready for pickup), a delivered one (a pickup: collected), and a short notice for a step back that says nothing of the reason, the admin explains it in the chat; a mail that fails is only logged and never undoes the status. ' +
    'This operation is restricted to privileged users. A cancel is a statement of return: POST /api/returns with the reason `shop_cancel` for a paid order not sent (or a pickup not collected), `refused` for a parcel the buyer refused.',

  params: {
    $ref: 'ordersUpdateStatusParamsSchema#',
    examples: [orderIdParamsExample],
  },

  body: {
    $ref: 'ordersUpdateStatusBodySchema#',
    examples: [updateOrderStatusBodyExample],
  },

  response: {
    200: {
      description: 'Order status was updated successfully.',
      $ref: 'ordersUpdateStatusResponseSchema#',
      examples: [shippedOrderExample],
    },

    400: {
      description:
        'Invalid order status update request. `VALIDATION_ERROR`: a field breaks the request schema (a link that is not https, a cost with a fraction of a cent, a text too long). ' +
        '`STATUS_INVALID`: not a status an admin sets (the request schema refuses it first). ' +
        '`SHIPMENT_NOT_ALLOWED`: a send with any step but shipped, or for a pickup. ' +
        '`SHIPMENT_CARRIER_REQUIRED`: a number or a link without the carrier. `SHIPMENT_CARRIER_INVALID`, `SHIPMENT_NUMBER_INVALID`: a text of only spaces. ' +
        '`KEEP_SHIPPING_COST_REQUIRED`: the step back of a manual order that was shipped needs the choice. `KEEP_SHIPPING_COST_NOT_ALLOWED`: the choice with any other step, or for a pickup. ' +
        '`DELIVERED_AT_NOT_ALLOWED`: the moment of the delivery with any other step. `ORDER_DELIVERED_AT_INVALID`: a moment before the order was sent (a pickup: paid) or of the future.',
      $ref: 'errorResponseSchema#',
    },
    401: {
      description: 'Authentication is required to update order status.',
      $ref: 'errorResponseSchema#',
    },
    403: {
      description: 'The authenticated user is not allowed to update order status.',
      $ref: 'errorResponseSchema#',
    },
    404: {
      description: '`ORDER_NOT_FOUND`: no order with this id.',
      $ref: 'errorResponseSchema#',
    },
    409: {
      description:
        '`ORDER_STATUS_TRANSITION_INVALID`: the order is there, its status does not allow the step, `details: { status, requested }` ' +
        '(shipped from paid, or back from delivered; delivered from shipped; paid back from shipped). `ORDER_ON_HOLD`: something holds the paid order from its sending, `details: { orderId, holds }` with the reasons (dispute, hand_refund, fraud_warning, payment_review), each once; the order stays paid. `ORDER_HAS_OPEN_REFUSAL`: the buyer refused the parcel and the statement of it is open, the order does not become delivered while the parcel is on its way back. `ORDER_STATUS_CHANGED`: another request changed the order meanwhile, reload it. `RESOURCE_BUSY`: try again.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while updating order status.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// Schema for one step of shipping for many orders
const postOrdersStatusSchema = {
  operationId: 'updateOrdersStatus',
  summary: 'Update the status of many orders',
  description:
    'Moves many orders one step: shipped (from paid), delivered (from shipped), or one step back. ' +
    'Each order comes with its own send (`shipment`) when it is shipped and its own `keepShippingCost` ' +
    'when it goes back to paid, the way `PATCH /api/orders/{orderId}/status` takes them. Each ' +
    'order goes on its own, in a transaction of its own: the admin log and the mail of each. A mail ' +
    'cannot be taken back, so an order that cannot take the step does not stop the others: each ' +
    'order gets its answer. An order named twice is answered twice: the first takes the step, the second answers that the order has taken it already (`ORDER_STATUS_TRANSITION_INVALID`). An order something holds from its sending answers `ORDER_ON_HOLD` with `details.holds` (the reasons) and the others take the step. Admin and root only.',

  body: {
    $ref: 'ordersBulkStatusBodySchema#',
    examples: [
      {
        status: 'shipped',
        orders: [
          { orderId: 41, shipment: { carrier: 'DHL', trackingNumber: 'JD0146000123', cost: 7.5 } },
          { orderId: 42 },
        ],
      },
    ],
  },

  response: {
    200: {
      description: 'Each order with its answer.',
      $ref: 'ordersBulkStatusResponseSchema#',
      examples: [
        {
          results: [
            { orderId: 41, ok: true, status: 'shipped' },
            {
              orderId: 42,
              ok: false,
              errorCode: 'ORDER_STATUS_TRANSITION_INVALID',
              details: { status: 'waiting', requested: 'shipped' },
            },
          ],
        },
      ],
    },
    400: {
      description:
        'Invalid request (VALIDATION_ERROR): no orders or more than 100, a status an admin does not set, ' +
        'a send, a cost choice or an id that breaks the request schema.',
      $ref: 'errorResponseSchema#',
    },
    401: {
      description: 'Authentication is required to update order status.',
      $ref: 'errorResponseSchema#',
    },
    403: {
      description: 'The current actor is not admin or root (INSUFFICIENT_ROLE).',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while updating the orders.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// what the item routes of an unconfirmed order share
const UNCONFIRMED_ITEMS =
  'Works on an own order that lost its reservation (`unconfirmed`), the same way the cart item routes work on the cart. ' +
  'The answer is the order at current prices, without the items of variants a buyer does not see; confirm it again with POST /api/orders/current/confirm and its `orderId`.';

const orderItemsErrorResponses = {
  401: {
    description: 'Authentication is required to change an order.',
    $ref: 'errorResponseSchema#',
  },
  403: {
    description: 'Only a user changes the items of own orders (INSUFFICIENT_ROLE).',
    $ref: 'errorResponseSchema#',
  },
  409: {
    description:
      '`OUT_OF_STOCK` with `details { variantId, available, requested }`: not enough free stock. ' +
      '`ORDER_NOT_EDITABLE`: the order was confirmed by another request meanwhile. `RESOURCE_BUSY`: try again.',
    $ref: 'errorResponseSchema#',
  },
  500: {
    description: 'Unexpected server error while changing the order.',
    $ref: 'errorResponseSchema#',
  },
} as const;

// Schema for adding item to an unconfirmed order
const postOrderItemsSchema = {
  operationId: 'addOrderItem',
  summary: 'Add item to an unconfirmed order',
  description: `Adds a variant to an own unconfirmed order. ${UNCONFIRMED_ITEMS}`,

  params: {
    $ref: 'ordersGetByIdParamsSchema#',
    examples: [orderIdParamsExample],
  },

  body: {
    $ref: 'ordersCurrentAddItemBodySchema#',
    examples: [addCurrentOrderItemBodyExample],
  },

  response: {
    200: {
      description: 'Item was added to the order.',
      $ref: 'ordersOrderResponseSchema#',
      examples: [unconfirmedOrderExample],
    },
    400: {
      description: 'Invalid order id or add item request (VALIDATION_ERROR).',
      $ref: 'errorResponseSchema#',
    },
    404: {
      description:
        '`ORDER_NOT_FOUND`: no own unconfirmed order with this id. `VARIANT_NOT_FOUND`: the variant is not in the catalog or a buyer does not see it.',
      $ref: 'errorResponseSchema#',
    },
    ...orderItemsErrorResponses,
  },
} satisfies FastifySchema;

// Schema for updating item of an unconfirmed order
const patchOrderItemsSchema = {
  operationId: 'updateOrderItem',
  summary: 'Update an item of an unconfirmed order',
  description: `Updates quantity for an item of an own unconfirmed order. ${UNCONFIRMED_ITEMS}`,

  params: {
    $ref: 'ordersOrderItemParamsSchema#',
    examples: [orderItemParamsExample],
  },

  body: {
    $ref: 'ordersCurrentUpdateItemBodySchema#',
    examples: [updateCurrentOrderItemBodyExample],
  },

  response: {
    200: {
      description: 'Order item was updated.',
      $ref: 'ordersOrderResponseSchema#',
      examples: [unconfirmedOrderExample],
    },
    400: {
      description: 'Invalid ids or update item request (VALIDATION_ERROR).',
      $ref: 'errorResponseSchema#',
    },
    404: {
      description:
        '`ORDER_ITEM_NOT_FOUND`: no such item in an own unconfirmed order with this id. `VARIANT_NOT_FOUND`: the variant of the item is not for sale any more, remove the item.',
      $ref: 'errorResponseSchema#',
    },
    ...orderItemsErrorResponses,
  },
} satisfies FastifySchema;

// Schema for removing item from an unconfirmed order
const deleteOrderItemsSchema = {
  operationId: 'deleteOrderItem',
  summary: 'Delete an item of an unconfirmed order',
  description: `Removes an item from an own unconfirmed order. ${UNCONFIRMED_ITEMS}`,

  params: {
    $ref: 'ordersOrderItemParamsSchema#',
    examples: [orderItemParamsExample],
  },

  response: {
    200: {
      description: 'Order item was removed.',
      $ref: 'ordersOrderResponseSchema#',
      examples: [{ ...unconfirmedOrderExample, total: 0, items: [] }],
    },
    400: {
      description: 'Invalid ids (VALIDATION_ERROR).',
      $ref: 'errorResponseSchema#',
    },
    404: {
      description: '`ORDER_ITEM_NOT_FOUND`: no such item in an own unconfirmed order with this id.',
      $ref: 'errorResponseSchema#',
    },
    ...orderItemsErrorResponses,
  },
} satisfies FastifySchema;

// Schema for the owner cancelling the payment of a waiting order
const postCancelPaymentSchema = {
  operationId: 'cancelOrderPayment',
  summary: 'Cancel the payment of an order',
  description:
    'The owner cancels the payment of an own order that waits for it (`waiting`), for example after coming back from the payment page without paying. ' +
    'The payment page is closed first at its payment provider, so no payment can come for it any more; then the reservation is released and the order becomes `unconfirmed` with its items and its delivery. ' +
    'The owner can change its items (POST/PATCH/DELETE /api/orders/{orderId}/items) and confirm it again with POST /api/orders/current/confirm.',

  params: {
    $ref: 'ordersGetByIdParamsSchema#',
    examples: [orderIdParamsExample],
  },

  response: {
    200: {
      description: 'The payment was cancelled, the order is unconfirmed.',
      $ref: 'ordersOrderResponseSchema#',
      examples: [unconfirmedOrderExample],
    },
    400: {
      description: 'Invalid order id (VALIDATION_ERROR).',
      $ref: 'errorResponseSchema#',
    },
    401: {
      description: 'Authentication is required to cancel a payment.',
      $ref: 'errorResponseSchema#',
    },
    403: {
      description: 'Only a user cancels the payment of own orders (INSUFFICIENT_ROLE).',
      $ref: 'errorResponseSchema#',
    },
    404: {
      description: 'No own order with this id (ORDER_NOT_FOUND).',
      $ref: 'errorResponseSchema#',
    },
    409: {
      description:
        '`ORDER_ALREADY_PAID`: the payment came first, the order is paid. `ORDER_PAYMENT_IN_PROGRESS`: the bank is still deciding on the payment. ' +
        '`ORDER_STATUS_NOT_WAITING`: the order does not wait for a payment. `RESOURCE_BUSY`: try again.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while cancelling the payment.',
      $ref: 'errorResponseSchema#',
    },
    503: {
      description:
        '`REDIS_UNAVAILABLE`, or `PAYMENT_PROVIDER_UNAVAILABLE`: the payment provider did not close the payment page, nothing was changed, try again.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// a paid order the buyer withdrew from before it was sent: cancelled, the goods and the money back
const withdrawnOrderExample = {
  ...shippedOrderExample,
  status: 'cancelled',
  cancelledAt: '2026-01-02T09:00:00.000Z',
  returnStatus: 'full',
  withdrawalOpen: false,
  withdrawals: [
    {
      id: 12,
      code: 'W42-1',
      statedAt: '2026-01-02T09:00:00.000Z',
      source: 'account',
      basis: 'withdrawal',
      reason: null,
      step: 'closed',
      closedAt: '2026-01-02T09:00:05.000Z',
      parcels: [],
      refundedTotal: 104.97,
      refunds: [
        {
          way: 'payment',
          method: null,
          state: 'sent',
          goods: 99.98,
          delivery: 4.99,
          deduction: 0,
          wayBack: 0,
          amount: 104.97,
          at: '2026-01-02T09:00:05.000Z',
          bankReference: null,
        },
      ],
      items: [
        {
          id: 31,
          orderItemId: 1,
          quantity: 2,
          amount: 99.98,
          money: 'refunded',
          refundedAt: '2026-01-02T09:00:05.000Z',
          refusal: null,
        },
      ],
    },
  ],
  withdrawable: [],
};

const withdrawalBodyExample = {
  items: [{ orderItemId: 1, quantity: 2 }],
  description: 'It does not fit.',
};

const returnProofParamsExample = { orderId: '1', returnId: '12' };

const returnProofBodyExample = {
  carrier: 'DHL',
  trackingNumber: 'JD0146000123',
  trackingUrl: 'https://track.example.com/JD0146000123',
};

// Schema for the buyer withdrawing from the contract
const postWithdrawalSchema = {
  operationId: 'withdrawFromOrder',
  summary: 'Withdraw from the contract',
  description:
    'The buyer withdraws from the contract of an own paid, shipped or delivered order, from the ' +
    'whole of it or the units named (`items`; without it whatever is left of the order that has the ' +
    'right of withdrawal). A delivered order can be withdrawn from until `withdrawalEndsAt`; a ' +
    'paid or shipped one at any time. An item whose product has no right of withdrawal ' +
    '(perishable, personalised, periodical) is not taken. The shop answers with a mail that the ' +
    'statement was registered, with the date and time of it. For a paid order that was not sent the ' +
    'goods stay with the shop, the order is cancelled when it is all of it, and the money goes ' +
    'back at once (a second mail when it is back). For a sent order the shop waits for the ' +
    'parcel: the buyer writes its carrier and number with ' +
    '`POST /api/orders/{orderId}/returns/{returnId}/proof`. The statement and its path are ' +
    '`withdrawals` of the answer, what can still be stated `withdrawable`. At most ' +
    '`LIMIT_WITHDRAWAL_PER_USER` statements an hour.',

  params: {
    $ref: 'ordersGetByIdParamsSchema#',
    examples: [orderIdParamsExample],
  },
  body: { $ref: 'ordersWithdrawBodySchema#', examples: [withdrawalBodyExample] },

  response: {
    201: {
      description: 'The statement was made: the order with it.',
      $ref: 'ordersOrderResponseSchema#',
      examples: [withdrawnOrderExample],
    },
    400: {
      description:
        'Invalid order id or body (VALIDATION_ERROR); nothing left to withdraw from ' +
        '(RETURN_ITEMS_REQUIRED), an item named twice (RETURN_ITEMS_REPEATED), units that are not ' +
        'whole units above 0 (RETURN_QUANTITY_INVALID).',
      $ref: 'errorResponseSchema#',
    },
    401: {
      description: 'Authentication is required to withdraw.',
      $ref: 'errorResponseSchema#',
    },
    403: {
      description: 'Only a user withdraws from own orders (INSUFFICIENT_ROLE).',
      $ref: 'errorResponseSchema#',
    },
    404: {
      description:
        'No own order with this id (ORDER_NOT_FOUND), or an item is not one of the order ' +
        '(RETURN_ITEM_NOT_FOUND).',
      $ref: 'errorResponseSchema#',
    },
    409: {
      description:
        'The order is not paid, shipped or delivered (RETURN_ORDER_NOT_RETURNABLE); more units ' +
        'than are left (RETURN_QUANTITY_EXCEEDED); an item without the right of withdrawal ' +
        '(RETURN_ITEM_NOT_RETURNABLE); the period of a delivered order is over (RETURN_PERIOD_OVER). ' +
        '`RESOURCE_BUSY`: try again.',
      $ref: 'errorResponseSchema#',
    },
    429: {
      description:
        'Too many requests in an hour (RATE_LIMITED): every request counts, those that were ' +
        'refused too.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while withdrawing.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// Schema for the buyer telling how they sent the goods back
const postReturnProofSchema = {
  operationId: 'provideReturnProof',
  summary: 'Tell how the goods were sent back',
  description:
    'The buyer writes the carrier and the number of the parcel they sent the goods back with (and ' +
    'a link to follow it) for a statement of their own that still waits for its goods. The ' +
    'statement is then in the step `proof_provided` and the shop checks it; the buyer may correct ' +
    'what they wrote until the shop confirms it (`proof_confirmed`). The buyer may tell what they ' +
    'paid the carrier (`buyerPaid`), a hint the shop checks against the receipt. When the goods go ' +
    'back in more than one parcel, the buyer names the rows and the units this parcel carries ' +
    '(`items`): the units that wait and are not named go into a statement of their own, with the ' +
    'next code, mailed to the buyer, for a parcel of their own. A statement for a paid order ' +
    'that was not sent has no goods to send. The answer is the order with its `withdrawals`.',

  params: { $ref: 'ordersReturnProofParamsSchema#', examples: [returnProofParamsExample] },
  body: { $ref: 'ordersReturnProofBodySchema#', examples: [returnProofBodyExample] },

  response: {
    200: {
      description: 'The proof was written: the order.',
      $ref: 'ordersOrderResponseSchema#',
      examples: [shippedOrderExample],
    },
    400: {
      description:
        'Invalid ids or body (VALIDATION_ERROR); a carrier or a number that is empty, or a link ' +
        'that is not https (RETURN_PROOF_INVALID); a sum paid that is not money (RETURN_PARCEL_SUM_INVALID).',
      $ref: 'errorResponseSchema#',
    },
    401: {
      description: 'Authentication is required to write the proof.',
      $ref: 'errorResponseSchema#',
    },
    403: {
      description: 'Only a user writes the proof of own statements (INSUFFICIENT_ROLE).',
      $ref: 'errorResponseSchema#',
    },
    404: {
      description:
        'No statement of an own order with this id (RETURN_NOT_FOUND); a row of `items` is not one ' +
        'of it (RETURN_ITEM_NOT_FOUND).',
      $ref: 'errorResponseSchema#',
    },
    429: {
      description: 'Too many requests in an hour (RATE_LIMITED).',
      $ref: 'errorResponseSchema#',
    },
    409: {
      description:
        'The statement is closed (RETURN_ALREADY_CLOSED); no row of it waits for goods ' +
        '(RETURN_NOTHING_WAITING); the shop confirmed the proof already ' +
        '(RETURN_PROOF_ALREADY_CONFIRMED); the shop recorded the parcel itself, which is the ' +
        "shop's to change (RETURN_PARCEL_EXISTS); a row of `items` whose goods do not wait " +
        '(RETURN_ITEM_NOT_EXPECTED) or holds fewer units (RETURN_QUANTITY_EXCEEDED). `RESOURCE_BUSY`: ' +
        'try again.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while writing the proof.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// Schema for the details of a send and what the shop pays the carrier
const patchShipmentSchema = {
  operationId: 'updateOrderShipment',
  summary: 'Write the cost of a send and correct its details',
  description:
    'An admin or root writes what the shop pays the carrier when the invoice comes and corrects the carrier, the number and the link of a send. ' +
    'The details change only on the send on its way of a shipped order (`SHIPMENT_NOT_EDITABLE` otherwise) and the buyer is mailed all of them, never the cost. ' +
    'The cost is written while the shop owes the carrier for the send, whatever became of the order (`SHIPMENT_COST_NOT_OWED` when it does not: a step back with the cost cleared, a cancel that said the carrier was not paid), and it is not mailed. ' +
    'It is a line of the money journal in the same transaction: the first cost above 0, then each other cost a new line of the difference that names the first one (a past period of the reports does not change); a cost written is corrected, never cleared, and 0 while none is written writes nothing. ' +
    'A request that changes nothing writes no line to the admin log and sends no mail. The answer is the order with its sends.',

  params: { $ref: 'ordersShipmentParamsSchema#' },
  body: {
    $ref: 'ordersShipmentUpdateBodySchema#',
    examples: [{ cost: 7.5 }, { carrier: 'UPS', trackingNumber: '1Z999AA10123456784' }],
  },

  response: {
    200: {
      description: 'The send is changed (or was as asked) and the order is returned.',
      $ref: 'ordersOrderResponseSchema#',
      examples: [shippedOrderExample],
    },
    400: {
      description:
        '`VALIDATION_ERROR`: a field breaks the request schema, nothing is sent. `NO_FIELDS_TO_UPDATE`: only fields the schema does not name. `SHIPMENT_CARRIER_REQUIRED`: a number or a link without the carrier. `SHIPMENT_CARRIER_INVALID`, `SHIPMENT_NUMBER_INVALID`: a text of only spaces.',
      $ref: 'errorResponseSchema#',
    },
    401: {
      description: 'Authentication is required.',
      $ref: 'errorResponseSchema#',
    },
    403: {
      description: 'Only an admin or root changes a send (INSUFFICIENT_ROLE).',
      $ref: 'errorResponseSchema#',
    },
    404: {
      description:
        '`ORDER_NOT_FOUND`: no order with this id. `SHIPMENT_NOT_FOUND`: the order has no send with this id.',
      $ref: 'errorResponseSchema#',
    },
    409: {
      description:
        '`SHIPMENT_NOT_EDITABLE`: the details of a send change only while the order is shipped and the send is on its way. `SHIPMENT_COST_NOT_OWED`: the shop owes the carrier nothing for this send. `RESOURCE_BUSY`: try again.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while changing the send.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// Schema for the correction of where a paid order goes
const patchOrderDeliverySchema = {
  operationId: 'updateOrderDelivery',
  summary: 'Correct where a paid order goes',
  description:
    'An admin or root corrects the recipient, the address or the note of a paid order until it is sent. The method and the price stay: a buyer who wants another method cancels and orders again. ' +
    'The person can be changed alone; an address is sent whole and is checked the way the confirmation checks it (the country the shop delivers to, the postal code of that country), a pickup has none. ' +
    'The change goes to the admin log with the old and the new value of each field and the buyer is mailed the new data, unless the account is deleted. A request that changes nothing writes no line and sends no mail. The answer is the order.',

  params: {
    $ref: 'ordersGetByIdParamsSchema#',
    examples: [orderIdParamsExample],
  },
  body: {
    $ref: 'ordersDeliveryUpdateBodySchema#',
    examples: [
      {
        address: {
          country: 'UA',
          postalCode: '01001',
          city: 'Kyiv',
          street: 'Khreshchatyk',
          house: '1',
          apartment: '12',
        },
      },
    ],
  },

  response: {
    200: {
      description: 'The delivery is corrected (or was as asked) and the order is returned.',
      $ref: 'ordersOrderResponseSchema#',
      examples: [waitingOrderExample],
    },
    400: {
      description:
        '`VALIDATION_ERROR`: a field breaks the request schema, nothing is sent. `NO_FIELDS_TO_UPDATE`: only fields the schema does not name. `RECIPIENT_FIRST_NAME_INVALID`, `RECIPIENT_LAST_NAME_INVALID`: a name without a letter or with a digit. `RECIPIENT_PHONE_INVALID`: a phone of another form (the request schema refuses it first, so over HTTP it is `VALIDATION_ERROR`). ' +
        '`DELIVERY_ADDRESS_NOT_ALLOWED`: an address for a pickup. `DELIVERY_COUNTRY_NOT_ALLOWED`: the shop does not deliver to the country. `DELIVERY_POSTAL_CODE_INVALID`, `DELIVERY_CITY_INVALID`, `DELIVERY_STREET_INVALID`, `DELIVERY_HOUSE_INVALID`: a part of the address that is not one.',
      $ref: 'errorResponseSchema#',
    },
    401: {
      description: 'Authentication is required.',
      $ref: 'errorResponseSchema#',
    },
    403: {
      description: 'Only an admin or root corrects a delivery (INSUFFICIENT_ROLE).',
      $ref: 'errorResponseSchema#',
    },
    404: {
      description: '`ORDER_NOT_FOUND`: no order with this id.',
      $ref: 'errorResponseSchema#',
    },
    409: {
      description:
        '`ORDER_DELIVERY_NOT_EDITABLE`: only a paid order changes, `details.status` is the status it has. `RESOURCE_BUSY`: try again.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while correcting the delivery.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// Schema for the decision of root on what holds a paid order
const postCarrierMoneySchema = {
  operationId: 'recordCarrierMoney',
  summary: 'Record money a carrier paid for a send',
  description:
    'A root (or an admin root allowed to handle the money, `canManageMoney`) records money a carrier ' +
    'paid the shop outside the app for a send of the order it lost or damaged, on the day it really ' +
    'came. The money journal gets one line `money.received` of the purpose `shipping` that names ' +
    'the send: money of the shop, not a cost of the send and counted by no statement; the journal of ' +
    'the admins gets `order.carrier_money`. No mail. The answer is the order.',

  params: { $ref: 'ordersShipmentParamsSchema#' },
  body: {
    $ref: 'ordersCarrierMoneyBodySchema#',
    examples: [
      {
        amount: 25,
        method: 'bank_transfer',
        note: 'The carrier lost the parcel and paid its value.',
        at: '2026-11-12T10:00:00.000Z',
      },
    ],
  },

  response: {
    200: {
      description: 'The money was recorded: the order.',
      $ref: 'ordersOrderResponseSchema#',
      examples: [shippedOrderExample],
    },
    400: {
      description:
        '`VALIDATION_ERROR`: a wrong field. `MONEY_RECEIVED_INVALID`: a sum that is not above 0 to ' +
        'the cent. `MONEY_RECEIVED_NOTE_REQUIRED`: no way or a note of spaces only. ' +
        '`MONEY_RECEIVED_AT_INVALID`: a day of the future or before the send.',
      $ref: 'errorResponseSchema#',
    },
    401: {
      description: 'Authentication is required.',
      $ref: 'errorResponseSchema#',
    },
    403: {
      description:
        '`INSUFFICIENT_ROLE`: only an admin or root; `MONEY_MANAGER_REQUIRED`: only root and an ' +
        'admin root allowed to handle the money; `MONEY_RECEIVED_FORBIDDEN`: the database refused ' +
        'the actor the same way.',
      $ref: 'errorResponseSchema#',
    },
    404: {
      description: '`MONEY_RECEIVED_NOT_FOUND`: the order has no send with this id.',
      $ref: 'errorResponseSchema#',
    },
    409: {
      description: '`RESOURCE_BUSY`: try again.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

const postHoldDecisionSchema = {
  operationId: 'decideOrderHold',
  summary: 'Decide on what holds a paid order',
  description:
    'Root (or an admin root allowed to handle the money, `canManageMoney`) ' +
    'decides on what holds a paid order from its sending and is root to let go: `hand_refund` ' +
    '(part of the payment went back by hand in the dashboard of the provider) or `fraud_warning` ' +
    '(the network of the card warned the payment may be a fraud). The holds of that reason go, the ' +
    'others stay (a dispute and a review of the provider are let go by the system). `ship`: the ' +
    'order may be sent, a refund made by hand is a compensation. `cancel`: what is left of the ' +
    'order is cancelled by a statement of the shop (`shop_cancel`, the goods back to the stock at ' +
    'once), the refunds made by hand are tied to it as money the buyer has back, and the rest goes ' +
    'back through the provider with the usual mails of a cancel by the shop (a transfer that cannot ' +
    'start is logged and the rows wait for an admin, as a cancel by the shop does). The journal of ' +
    'the admins gets `order.hold_decide` with the lines of the money journal decided and the note ' +
    '(not mailed), and `return.create` for the statement. The answer is the order as an admin sees it.',

  params: {
    $ref: 'ordersHoldDecisionParamsSchema#',
    examples: [{ orderId: '1', reason: 'hand_refund' }],
  },
  body: {
    $ref: 'ordersHoldDecisionBodySchema#',
    examples: [
      { decision: 'ship', note: 'The buyer was paid back for a scratch, the rest goes.' },
      { decision: 'cancel', note: 'The buyer asked to cancel.' },
    ],
  },

  response: {
    200: {
      description: 'The decision is kept; the order as it is now.',
      $ref: 'ordersOrderResponseSchema#',
      examples: [{ ...waitingOrderExample, status: 'paid', reservationExpiresAt: undefined }],
    },
    400: {
      description:
        '`VALIDATION_ERROR`: a wrong id, a reason that is not root to decide on (`dispute`, ' +
        '`payment_review`), a decision that is not `ship` or `cancel`, a note missing or longer ' +
        'than 500. `ORDER_HOLD_NOTE_REQUIRED`: a note of spaces only.',
      $ref: 'errorResponseSchema#',
    },
    401: {
      description: 'Authentication is required.',
      $ref: 'errorResponseSchema#',
    },
    403: {
      description:
        '`INSUFFICIENT_ROLE`: only an admin or root reaches the route; `MONEY_MANAGER_REQUIRED`: only root and an admin root allowed to handle the money decide.',
      $ref: 'errorResponseSchema#',
    },
    404: {
      description:
        '`ORDER_HOLD_NOT_FOUND`: no order with this id, or the reason does not hold it (decided ' +
        'already, or never put).',
      $ref: 'errorResponseSchema#',
    },
    409: {
      description:
        'A cancel the statement refuses: `RETURN_ORDER_NOT_RETURNABLE` (the order is not a paid ' +
        'order with its goods on the shelf). `RESOURCE_BUSY`: try again.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while deciding.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// Group order routes under the orders Swagger tag
const taggedOrdersSchema = withOpenApiTag(
  {
    getCurrentOrderSchema,
    postCurrentItemsSchema,
    patchCurrentItemsSchema,
    deleteCurrentItemsSchema,
    postCurrentConfirmSchema,
    getOrdersSchema,
    getOrderByIdSchema,
    patchOrderStatusSchema,
    postOrdersStatusSchema,
    patchShipmentSchema,
    postCarrierMoneySchema,
    patchOrderDeliverySchema,
    postOrderItemsSchema,
    patchOrderItemsSchema,
    deleteOrderItemsSchema,
    postCancelPaymentSchema,
    postWithdrawalSchema,
    postReturnProofSchema,
    postHoldDecisionSchema,
  },
  'orders',
);

// Add access token security to all order routes
export const ordersSchema = withOpenApiSecurity(
  taggedOrdersSchema,
  openApiSecurity.accessTokenCookie,
);
