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

  images: {
    url200: string;
    url400: string;
    url800: string;
  };

  availableStock: number;
  deletedAt?: Date | null;
}

export interface OrderItemDto {
  // order item id, used as itemId in PATCH/DELETE /current/items/:itemId
  id: number;
  productId: ProductId;
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
export type OrdersSortBy = 'createdAt' | 'updatedAt' | 'total' | 'shippingAddress';
export type OrdersSortDir = 'asc' | 'desc';

export interface GetOrdersQueryDto {
  limit?: number;
  cursor?: string;

  status?: OrderStatus;
  confirmed?: ConfirmedStatus;

  sortBy?: OrdersSortBy;
  sortDir?: OrdersSortDir;
}

export interface FindOrdersDto {
  actorId: UserId;
  actorRole: Role;
  limit: number;
  cursor?: string;

  status?: OrderStatus;
  confirmed?: ConfirmedStatus;

  sortBy: OrdersSortBy;
  sortDir: OrdersSortDir;
}

export interface GetOrdersResponseDto {
  items: OrderResponseDto[];
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
