import type { UserId, ProductId, OrderId } from 'types/ids.js';
import type { Role } from 'types/user.js';

export type OrderStatus = 'pending' | 'waiting' | 'paid' | 'shipped' | 'delivered' | 'cancelled';
export type ConfirmedStatus = true | false;

export interface CurrentAddItemBodyDto {
  productId: ProductId;
  quantity: number;
}

export interface CurrentAddItemDto extends CurrentAddItemBodyDto {
  actorId: UserId;
  actorRole: Role;
}

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

export interface OrderItemDto {
  productId: ProductId;
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

export interface GetOrdersResponseDto {
  items: OrderResponseDto[];
  page?: number;
  limit?: number;
  total?: number;
}

export interface GetOrderByIdParamsDto {
  orderId: OrderId;
}

export interface FindOrderByIdDto {
  userId: UserId;
  orderId: OrderId;
}

export type GetOrderByIdResponseDto = OrderResponseDto;

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
