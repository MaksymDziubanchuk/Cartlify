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
}

// DELETE /current/items/:itemId
export interface CurrentDeleteItemDto {
  itemId: number;
  actorId: UserId;
  actorRole: Role;
}

// POST /current/confirm
export interface ConfirmCurrentOrderBodyDto {
  orderId: OrderId;
  // required for an order that has no shipping address yet
  shippingAddress?: string;
}

export interface ConfirmCurrentOrderDto extends ConfirmCurrentOrderBodyDto {
  actorId: UserId;
  actorRole: Role;
}

// GET /
export type OrdersSortBy = 'updatedAt' | 'total' | 'shippingAddress';
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
