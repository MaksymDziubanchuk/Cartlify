import type { UserId, ProductId, OrderId, CategoryId, IdParam } from 'types/ids.js';
import type { Role } from 'types/user.js';

// types
export type OrderStatus =
  | 'pending'
  | 'unconfirmed'
  | 'waiting'
  | 'paid'
  | 'shipped'
  | 'delivered'
  | 'cancelled';
export type ConfirmedStatus = true | false;

// shared response shapes
export interface OrderItemProductDto {
  id: ProductId;
  name: string;
  categoryId: CategoryId;

  // the primary image; null for a product without one
  images: {
    url200: string;
    url400: string;
    url800: string;
  } | null;

  availableStock: number;
  deletedAt?: Date | null;

  // an order that is not paid: the price of the product now and its sale while it lasts, the
  // way the catalog shows them
  price?: number;
  salePrice?: number;
  saleEndsAt?: string;
  salePriorPrice?: number;
}

export interface OrderItemDto {
  // order item id, used as itemId in PATCH/DELETE /current/items/:itemId
  id: number;
  productId: ProductId;
  // the name of the item: the one the product had when the order was confirmed, the one of now
  // for a cart
  name: string;
  product: OrderItemProductDto;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
}

export interface OrderResponseDto {
  id: OrderId;
  userId: UserId;
  status: OrderStatus;
  confirmed: ConfirmedStatus;
  items: OrderItemDto[];
  total: number;
  shippingAddress: string;

  createdAt: Date;
  updatedAt: Date;

  // left out while the order does not have them
  reservationExpiresAt?: Date;
  recipientFirstName?: string;
  recipientLastName?: string;
  recipientPhone?: string;
  note?: string;
  // when the payment was recorded and when an admin cancelled the paid order
  paidAt?: Date;
  cancelledAt?: Date;
}

// GET /current
export interface GetCurrentOrderDto {
  actorId: UserId;
  actorRole: Role;
}

// POST /current/items
export interface CurrentAddItemBodyDto {
  productId: ProductId;
  quantity: number;
}

export interface CurrentAddItemDto extends CurrentAddItemBodyDto {
  actorId: UserId;
  actorRole: Role;
  // an own unconfirmed order instead of the cart (POST /:orderId/items)
  orderId?: OrderId;
}

// PATCH /current/items/:itemId
export interface CurrentItemIdParamsDto {
  itemId: IdParam;
}

export interface CurrentUpdateItemBodyDto {
  quantity: number;
}

export interface CurrentUpdateItemDto extends CurrentUpdateItemBodyDto {
  itemId: number;
  actorId: UserId;
  actorRole: Role;
  // an own unconfirmed order instead of the cart (PATCH /:orderId/items/:itemId)
  orderId?: OrderId;
}

// DELETE /current/items/:itemId
export interface CurrentDeleteItemDto {
  itemId: number;
  actorId: UserId;
  actorRole: Role;
  // an own unconfirmed order instead of the cart (DELETE /:orderId/items/:itemId)
  orderId?: OrderId;
}

// /:orderId/items/:itemId
export interface OrderItemParamsDto {
  orderId: IdParam;
  itemId: IdParam;
}

// POST /:orderId/cancel-payment and POST /:orderId/cancel
export interface CancelOrderDto {
  actorId: UserId;
  actorRole: Role;
  orderId: OrderId;
}

// the answer of an admin cancel: the order with how to reach its buyer
export interface CancelledOrderResponseDto extends OrderResponseDto {
  user: {
    id: UserId;
    deleted: boolean;
    // only while the account is not deleted
    email?: string;
  };
}

// POST /current/confirm
export interface ConfirmCurrentOrderBodyDto {
  orderId: OrderId;
  // the address and the recipient are required for an order that does not have them yet
  shippingAddress?: string;
  recipientFirstName?: string;
  recipientLastName?: string;
  recipientPhone?: string;
  // optional; an empty one removes the note
  note?: string;
}

export interface ConfirmCurrentOrderDto extends ConfirmCurrentOrderBodyDto {
  actorId: UserId;
  actorRole: Role;
}

// GET /
export type OrdersSortBy = 'createdAt' | 'updatedAt' | 'total' | 'shippingAddress' | 'paidAt';
export type OrdersSortDir = 'asc' | 'desc';

export interface GetOrdersQueryDto {
  limit?: number;
  cursor?: string;

  status?: OrderStatus;
  // a few statuses, separated by commas
  statuses?: string;
  confirmed?: ConfirmedStatus;
  // the orders paid from paidFrom and before paidTo, iso date-times
  paidFrom?: string;
  paidTo?: string;
  // the orders changed last from updatedFrom and before updatedTo, iso date-times
  updatedFrom?: string;
  updatedTo?: string;
  // the orders that hold the product
  productId?: number;

  // the desk of an admin: the orders of a buyer, a text of a buyer or a recipient, a csv
  userId?: number;
  q?: string;
  format?: 'json' | 'csv';

  sortBy?: OrdersSortBy;
  sortDir?: OrdersSortDir;
}

export interface FindOrdersDto {
  actorId: UserId;
  actorRole: Role;
  limit: number;
  cursor?: string;

  status?: OrderStatus;
  statuses?: string;
  confirmed?: ConfirmedStatus;
  paidFrom?: Date;
  paidTo?: Date;
  updatedFrom?: Date;
  updatedTo?: Date;
  productId?: number;
  userId?: number;
  q?: string;
  format?: 'json' | 'csv';

  sortBy: OrdersSortBy;
  sortDir: OrdersSortDir;
}

// the buyer of an order in the list of an admin; a deleted account has no email
export interface OrderBuyerDto {
  id: UserId;
  name: string | null;
  email: string | null;
  deleted: boolean;
}

export interface GetOrdersResponseDto {
  items: Array<OrderResponseDto & { buyer?: OrderBuyerDto }>;
  limit: number;
  nextCursor: string | null;
  total: number;
}

// GET /:orderId
export interface GetOrderByIdParamsDto {
  orderId: IdParam;
}

export interface FindOrderByIdDto {
  actorId: UserId;
  actorRole: Role;
  orderId: OrderId;
}

export type GetOrderByIdResponseDto = OrderResponseDto;

// PATCH /:orderId/status
export interface UpdateOrderStatusParamsDto {
  orderId: IdParam;
}

export interface UpdateOrderStatusBodyDto {
  status: OrderStatus;
}

export interface UpdateOrderStatusDto {
  actorId: UserId;
  actorRole: Role;
  orderId: OrderId;
  status: OrderStatus;
}

export type UpdateOrderStatusResponseDto = OrderResponseDto;

// one step of shipping for many orders, each in a transaction of its own with its own answer
export interface UpdateOrdersStatusBodyDto {
  orderIds: OrderId[];
  status: 'shipped' | 'delivered';
}

export interface UpdateOrdersStatusDto extends UpdateOrdersStatusBodyDto {
  actorId: UserId;
  actorRole: Role;
}

export type UpdateOrdersStatusResultDto =
  | { orderId: OrderId; ok: true; status: OrderStatus }
  | { orderId: OrderId; ok: false; errorCode: string; details?: Record<string, unknown> };

export interface UpdateOrdersStatusResponseDto {
  results: UpdateOrdersStatusResultDto[];
}
