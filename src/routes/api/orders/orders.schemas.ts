import type { FastifySchema } from 'fastify';

import { openApiSecurity } from '@config/openapi.js';
import { withOpenApiSecurity } from '@helpers/withOpenApiSecurity.js';
import { withOpenApiTag } from '@helpers/withOpenApiTag.js';

const orderProductExample = {
  id: 10,
  name: 'Wireless headphones',
  categoryId: 1,
  images: {
    url200: 'https://example.com/products/headphones-200.webp',
    url400: 'https://example.com/products/headphones-400.webp',
    url800: 'https://example.com/products/headphones-800.webp',
  },
  availableStock: 15,
  deletedAt: null,
};

const orderItemExample = {
  id: 1,
  productId: 10,
  product: orderProductExample,
  quantity: 2,
  unitPrice: 49.99,
  totalPrice: 99.98,
};

const orderExample = {
  id: 1,
  userId: 1,
  status: 'pending',
  items: [orderItemExample],
  total: 99.98,
  createdAt: '2026-01-01T10:00:00.000Z',
  updatedAt: '2026-01-01T10:00:00.000Z',
  note: 'Leave near the door.',
  shippingAddress: 'Example shipping address',
  confirmed: false,
};

const recipientExample = {
  recipientFirstName: 'Anna',
  recipientLastName: 'Koval',
  recipientPhone: '+380501234567',
};

// a confirmed order waits for the payment until reservationExpiresAt
const waitingOrderExample = {
  ...orderExample,
  ...recipientExample,
  status: 'waiting',
  confirmed: true,
  reservationExpiresAt: '2026-01-01T10:15:00.000Z',
};

const shippedOrderExample = {
  ...orderExample,
  ...recipientExample,
  status: 'shipped',
  confirmed: true,
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

// an order that lost its reservation: it keeps its items and shipping data
const unconfirmedOrderExample = {
  ...orderExample,
  ...recipientExample,
  status: 'unconfirmed',
  confirmed: false,
};

// what an admin cancel answers: the order and how to reach its buyer
const cancelledOrderExample = {
  ...shippedOrderExample,
  status: 'cancelled',
  cancelledAt: '2026-01-02T09:30:00.000Z',
  user: { id: 1, deleted: false, email: 'anna@example.com' },
};

const ordersListResponseExample = {
  items: [shippedOrderExample],
  limit: 20,
  nextCursor: null,
  total: 1,
};

const addCurrentOrderItemBodyExample = {
  productId: 10,
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
  shippingAddress: 'Example shipping address',
  ...recipientExample,
  note: 'Leave near the door.',
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
    'Returns the current authenticated user order or cart state. Item prices are brought to current product prices before the order is returned, and the items of products deleted from the catalog are removed from the cart for good: the page shows only what can be confirmed.',

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
    'Adds a product item to the current authenticated user order. The answer is the cart at current prices, without the items of products deleted from the catalog: they are removed from it for good.',

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
        '`PRODUCT_NOT_FOUND`: the product does not exist or is removed from the catalog, `details.productId`.',
      $ref: 'errorResponseSchema#',
    },
    409: {
      description:
        '`OUT_OF_STOCK`: fewer free units than the cart would hold, `details: { productId, available, requested }`. ' +
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
    'Updates quantity for an item in the current authenticated user order. The answer is the cart at current prices, without the items of products deleted from the catalog: they are removed from it for good.',

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
        '`PRODUCT_NOT_FOUND`: the product of the item was removed from the catalog, remove the item.',
      $ref: 'errorResponseSchema#',
    },
    409: {
      description:
        '`OUT_OF_STOCK`: fewer free units than the new quantity, `details: { productId, available, requested }`. ' +
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
    'Removes an item from the current authenticated user order. The answer is the cart at current prices, without the items of products deleted from the catalog: they are removed from it for good.',

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
    'The shipping address and the recipient (`recipientFirstName`, `recipientLastName`, `recipientPhone`) are stored on the order and are required when the order does not have them yet. A field that is not sent keeps what the order has: an order that lost its reservation (`unconfirmed`) keeps them, so confirming it again needs only `orderId`; a confirmation that fails stores nothing. ' +
    'A page can take the first name and the phone from the profile, the last name is asked from the person. `note` is optional. ' +
    'After the confirmation the order keeps these fields as they are. ' +
    'When an item price differs from the current product price, the order is not confirmed and `ORDER_PRICES_CHANGED` is returned: reload the order to get fresh prices and confirm again.',

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
        'Invalid confirm order request. `VALIDATION_ERROR`: a field breaks the request schema (length, phone format). ' +
        '`SHIPPING_ADDRESS_INVALID`, `RECIPIENT_FIRST_NAME_INVALID`, `RECIPIENT_LAST_NAME_INVALID`: an address of spaces, a name without a letter or with a digit. ' +
        '`SHIPPING_ADDRESS_REQUIRED`, `RECIPIENT_FIRST_NAME_REQUIRED`, `RECIPIENT_LAST_NAME_REQUIRED`, `RECIPIENT_PHONE_REQUIRED`: the order has no such field and the request did not bring it. ' +
        '`ORDER_ITEMS_REQUIRED`: the order is empty. ' +
        '`ORDER_TOTAL_BELOW_MINIMUM`: the total at the prices of the catalog is below the smallest payment any payment provider takes, nothing is reserved; `details` has the smallest total (`minimum`) and its `currency`.',
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
        '`ORDER_NOT_FOUND`: there is no cart, or no own unconfirmed order with the `orderId` of the body. ' +
        '`PRODUCT_NOT_FOUND`: a product of the order is gone from the catalog.',
      $ref: 'errorResponseSchema#',
    },
    409: {
      description:
        'Order state, product stock or changed item prices do not allow confirmation. ' +
        '`ORDER_ITEMS_UNAVAILABLE`: some items cannot be confirmed, `details.items` names each: ' +
        '`{ itemId, productId, reason: deleted | out_of_stock, available, requested }`; the owner removes or changes them and confirms again. ' +
        'The same code names the items when another buyer took the last free units at the same moment. ' +
        '`ORDER_PRICES_CHANGED`: reload the order and confirm again. `ORDER_ALREADY_CONFIRMED`: the order is confirmed already, it waits for its payment or is paid, shipped, delivered or cancelled. ' +
        '`ORDER_STATUS_NOT_ALLOWED`: the order is not a cart nor an unconfirmed order.',
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
    'A paid order shows the prices it was paid with; an unconfirmed order of the user shows current prices, the items of products deleted from the catalog are removed from it. ' +
    '`paidFrom` and `paidTo` keep the orders paid in that period, from its start and before its end, cancelled ones too (`cancelledAt` says when); `sortBy=paidAt` lists the paid orders by the time of their payment. ' +
    '`statuses` takes a few statuses, `productId` the orders that hold a product. The desk of an admin: `userId` (the orders of a buyer) and `q` (a number of an order, or a part of the email of the buyer, the name or the phone of the recipient), each row names its `buyer`; `format=csv` gives every order of the filters as a file for the courier, without pages.',

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
              'Order, Status, Paid at, Buyer email, Recipient, Phone, Address, Items, Total.',
          },
        },
      },
    },

    400: {
      description:
        'Invalid orders query parameters, including `CURSOR_INVALID` (a cursor of another sort or direction too), a status the list has not (`STATUS_INVALID`) a period of the payment that does not end after it starts (`PAID_PERIOD_INVALID`) and such a period of the last change (`UPDATED_PERIOD_INVALID`).',
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
    'Returns one order by id if it is visible to the authenticated user. For the owner of an order that is not confirmed (the cart or an order that lost its reservation, `unconfirmed`), item prices are brought to current product prices before the order is returned, ' +
    'and the order loses the items of products deleted from the catalog; an order waiting for its payment keeps them, its payment page names them. ' +
    'Each item shows `product.availableStock`, so the page can mark the items there is not enough of before the order is confirmed again.',

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
    'Updates order status by order id: a paid order becomes shipped or delivered, a shipped one delivered. ' +
    'This operation is restricted to privileged users. A cancel returns the money and the stock, it is POST /api/orders/{orderId}/cancel. ' +
    'A shipped or delivered order mails the buyer, unless the account is deleted; a mail that fails is only logged and never undoes the status.',

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
      description: 'Invalid order status update request.',
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
        '(shipped only from paid, delivered from paid or shipped). `ORDER_STATUS_CHANGED`: another request changed the order meanwhile, reload it. `RESOURCE_BUSY`: try again.',
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
    'Moves many orders one step: shipped (from paid) or delivered (from paid or shipped). Each ' +
    'order goes on its own, in a transaction of its own, the way `PATCH /api/orders/{orderId}/status` ' +
    'moves one: the admin log and the mail of each. A mail cannot be taken back, so an order that ' +
    'cannot take the step does not stop the others: each order gets its answer. Admin and root only.',

  body: {
    $ref: 'ordersBulkStatusBodySchema#',
    examples: [{ orderIds: [41, 42], status: 'shipped' }],
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
        'Invalid request (VALIDATION_ERROR): no orders or more than 100, an order named twice, ' +
        'a status other than shipped or delivered.',
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
  'The answer is the order at current prices, without items of products deleted from the catalog; confirm it again with POST /api/orders/current/confirm and its `orderId`.';

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
      '`OUT_OF_STOCK` with `details { productId, available, requested }`: not enough free stock. ' +
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
  description: `Adds a product item to an own unconfirmed order. ${UNCONFIRMED_ITEMS}`,

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
        '`ORDER_NOT_FOUND`: no own unconfirmed order with this id. `PRODUCT_NOT_FOUND`: the product is not in the catalog.',
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
        '`ORDER_ITEM_NOT_FOUND`: no such item in an own unconfirmed order with this id. `PRODUCT_NOT_FOUND`: the product of the item was deleted from the catalog, remove the item.',
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
    'The payment page is closed first at its payment provider, so no payment can come for it any more; then the reservation is released and the order becomes `unconfirmed` with its items and shipping data. ' +
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

// Schema for an admin cancelling a paid order
const postCancelOrderSchema = {
  operationId: 'cancelOrder',
  summary: 'Cancel a paid order',
  description:
    'An admin or root cancels a paid or shipped order, for example one that cannot be delivered. The payment is refunded in full by the payment provider that took it, ' +
    'the stock of its items comes back and the buyer gets a mail, unless the account is deleted. The order is cancelled only together with its refund: ' +
    'when the provider refuses the refund nothing changes. A delivered order is not cancelled. ' +
    'The answer gives how to reach the buyer: the order holds the address, the recipient and the phone, `user` tells whether the account is deleted and its email while it is not.',

  params: {
    $ref: 'ordersGetByIdParamsSchema#',
    examples: [orderIdParamsExample],
  },

  response: {
    200: {
      description: 'The order is cancelled and its payment refunded.',
      $ref: 'ordersCancelledResponseSchema#',
      examples: [cancelledOrderExample],
    },
    400: {
      description: 'Invalid order id (VALIDATION_ERROR).',
      $ref: 'errorResponseSchema#',
    },
    401: {
      description: 'Authentication is required to cancel an order.',
      $ref: 'errorResponseSchema#',
    },
    403: {
      description: 'Only an admin or root cancels orders (INSUFFICIENT_ROLE).',
      $ref: 'errorResponseSchema#',
    },
    404: {
      description: 'Order was not found (ORDER_NOT_FOUND).',
      $ref: 'errorResponseSchema#',
    },
    409: {
      description:
        '`ORDER_ALREADY_DELIVERED`, `ORDER_ALREADY_CANCELLED`, `ORDER_NOT_PAID`: the order cannot be cancelled. ' +
        '`ORDER_STATUS_CHANGED`: its status changed meanwhile, reload it. `ORDER_PAYMENT_ID_MISSING`: the order holds no payment to refund. `RESOURCE_BUSY`: try again.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description:
        'INTERNAL_ERROR: the refund at the payment provider failed or another server error; nothing was changed (the reason is in the server log only).',
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
    postOrderItemsSchema,
    patchOrderItemsSchema,
    deleteOrderItemsSchema,
    postCancelPaymentSchema,
    postCancelOrderSchema,
  },
  'orders',
);

// Add access token security to all order routes
export const ordersSchema = withOpenApiSecurity(
  taggedOrdersSchema,
  openApiSecurity.accessTokenCookie,
);
