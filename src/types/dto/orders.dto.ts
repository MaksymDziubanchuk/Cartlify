import type { UserId, ProductId, OrderId, CategoryId } from 'types/ids.js';
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
  itemId: number;
}

export interface CurrentUpdateItemBodyDto {
  quantity: number;
}

export interface CurrentUpdateItemDto extends CurrentItemIdParamsDto, CurrentUpdateItemBodyDto {
  actorId: UserId;
  actorRole: Role;
}

// DELETE /current/items/:itemId
export interface CurrentDeleteItemDto extends CurrentItemIdParamsDto {
  actorId: UserId;
  actorRole: Role;
}

// POST /current/confirm
export interface ConfirmCurrentOrderBodyDto {
  orderId: OrderId;
}

export interface ConfirmCurrentOrderDto extends ConfirmCurrentOrderBodyDto {
  actorId: UserId;
  actorRole: Role;
}

// GET /
export interface GetOrdersQueryDto {
  page?: number;
  limit?: number;
  status?: OrderStatus;
  confirmed?: ConfirmedStatus;
}

export interface FindOrdersDto {
  userId: UserId;
  page: number;
  limit: number;
  status?: OrderStatus;
  confirmed?: ConfirmedStatus;
}

export interface GetOrdersResponseDto {
  items: OrderResponseDto[];
  page?: number;
  limit?: number;
  total?: number;
}

// GET /:orderId
export interface GetOrderByIdParamsDto {
  orderId: OrderId;
}

export interface FindOrderByIdDto {
  userId: UserId;
  orderId: OrderId;
}

export type GetOrderByIdResponseDto = OrderResponseDto;

// PATCH /:orderId/status
export interface UpdateOrderStatusParamsDto {
  orderId: OrderId;
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
