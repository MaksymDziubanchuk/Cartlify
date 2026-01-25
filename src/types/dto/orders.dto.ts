import type { UserId, ProductId, OrderId } from 'types/ids.js';
import type { Role } from 'types/user.js';

export type OrderStatus = 'pending' | 'paid' | 'shipped' | 'delivered' | 'cancelled';
export type ConfirmedStatus = true | false;

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

export interface CreateOrderItemBodyDto {
  productId: ProductId;
  quantity: number;
}
export interface CreateOrderBodyDto {
  items: CreateOrderItemBodyDto[];
  note?: string;
  shippingAddress: string;
}

export interface CreateOrderDto extends CreateOrderBodyDto {
  userId: UserId;
}

export type CreateOrderResponseDto = OrderResponseDto;

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

export type ConfirmOrderParamsDto = UpdateOrderStatusParamsDto;

export interface ConfirmOrderDto {
  orderId: OrderId;
}

export type UpdateOrderStatusResponseDto = OrderResponseDto;

export interface DeleteOrderParamsDto {
  orderId: OrderId;
}

export interface DeleteOrderDto {
  actorId: UserId;
  orderId: OrderId;
}
