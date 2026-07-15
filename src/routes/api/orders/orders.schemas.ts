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

const ordersListQueryExample = {
  limit: 20,
  status: 'pending',
  confirmed: false,
  sortBy: 'updatedAt',
  sortDir: 'desc',
};

const ordersListResponseExample = {
  items: [orderExample],
  limit: 20,
  nextCursor: null,
  total: 1,
};

const addCurrentOrderItemBodyExample = {
  productId: 10,
  quantity: 2,
};

const currentOrderItemParamsExample = {
  itemId: 1,
};

const updateCurrentOrderItemBodyExample = {
  quantity: 3,
};

const confirmCurrentOrderBodyExample = {
  orderId: 1,
};

const orderIdParamsExample = {
  orderId: 1,
};

const updateOrderStatusBodyExample = {
  status: 'shipped',
};

// Schema for current user order lookup
const getCurrentOrderSchema = {
  operationId: 'getCurrentOrder',
  summary: 'Get current order',
  description: 'Returns the current authenticated user order or cart state.',

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
      description: 'Current order was not found.',
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
  description: 'Adds a product item to the current authenticated user order.',

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
      description: 'Product or current order was not found.',
      $ref: 'errorResponseSchema#',
    },
    409: {
      description: 'Order state or product stock does not allow adding this item.',
      $ref: 'errorResponseSchema#',
    },
    422: {
      description: 'Add item payload failed validation.',
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
  description: 'Updates quantity for an item in the current authenticated user order.',

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
      description: 'Current order item was not found.',
      $ref: 'errorResponseSchema#',
    },
    409: {
      description: 'Order state or product stock does not allow updating this item.',
      $ref: 'errorResponseSchema#',
    },
    422: {
      description: 'Update item payload failed validation.',
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
  description: 'Removes an item from the current authenticated user order.',

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
      description: 'Current order item was not found.',
      $ref: 'errorResponseSchema#',
    },
    409: {
      description: 'Order state does not allow deleting this item.',
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
  description: 'Confirms the current order, reserves stock and prepares it for checkout.',

  body: {
    $ref: 'ordersCurrentConfirmBodySchema#',
    examples: [confirmCurrentOrderBodyExample],
  },

  response: {
    200: {
      description: 'Current order was confirmed successfully.',
      $ref: 'ordersOrderResponseSchema#',
      examples: [
        {
          ...orderExample,
          status: 'waiting',
          confirmed: true,
        },
      ],
    },

    400: {
      description: 'Invalid confirm order request.',
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
      description: 'Current order or order items were not found.',
      $ref: 'errorResponseSchema#',
    },
    409: {
      description: 'Order state or product stock does not allow confirmation.',
      $ref: 'errorResponseSchema#',
    },
    422: {
      description: 'Confirm order payload failed validation.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while confirming order.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// Schema for order list lookup
const getOrdersSchema = {
  operationId: 'getOrders',
  summary: 'Get orders',
  description: 'Returns orders visible to the authenticated user, admin or root role.',

  querystring: {
    $ref: 'ordersGetQuerySchema#',
    examples: [ordersListQueryExample],
  },

  response: {
    200: {
      description: 'Orders were returned successfully.',
      $ref: 'ordersListResponseSchema#',
      examples: [ordersListResponseExample],
    },

    400: {
      description: 'Invalid orders query parameters.',
      $ref: 'errorResponseSchema#',
    },
    401: {
      description: 'Authentication is required to read orders.',
      $ref: 'errorResponseSchema#',
    },
    403: {
      description: 'The authenticated user is not allowed to read these orders.',
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
  description: 'Returns one order by id if it is visible to the authenticated user.',

  params: {
    $ref: 'ordersGetByIdParamsSchema#',
    examples: [orderIdParamsExample],
  },

  response: {
    200: {
      description: 'Order was returned successfully.',
      $ref: 'ordersOrderResponseSchema#',
      examples: [orderExample],
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
      description: 'Order was not found.',
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
  description: 'Updates order status by order id. This operation is restricted to privileged users.',

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
      examples: [
        {
          ...orderExample,
          status: 'shipped',
          confirmed: true,
        },
      ],
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
      description: 'Order was not found.',
      $ref: 'errorResponseSchema#',
    },
    409: {
      description: 'Order state does not allow this status transition.',
      $ref: 'errorResponseSchema#',
    },
    422: {
      description: 'Order status update payload failed validation.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while updating order status.',
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
  },
  'orders',
);

// Add access token security to all order routes
export const ordersSchema = withOpenApiSecurity(taggedOrdersSchema, openApiSecurity.accessTokenCookie);