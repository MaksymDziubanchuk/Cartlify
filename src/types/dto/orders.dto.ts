import type { UserId, ProductId, OrderId } from 'types/ids.js';

export type OrderStatus = 'pending' | 'paid' | 'shipped' | 'delivered' | 'cancelled';

export interface GetOrdersQueryDto {
  page?: number;
  limit?: number;
  status?: OrderStatus;
}

export interface FindOrdersDto {
  userId: UserId;
  page: number;
  limit: number;
  status?: OrderStatus;
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
  items: OrderItemDto[];
  subtotal: number;
  shipping?: number;
  discount?: number;
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
  orderId: OrderId;
  status: OrderStatus;
}

export type UpdateOrderStatusResponseDto = OrderResponseDto;

export interface DeleteOrderParamsDto {
  orderId: OrderId;
}

export interface DeleteOrderDto {
  actorId: UserId;
  orderId: OrderId;
}
