import type {
  FindOrdersDto,
  FindOrderByIdDto,
  CreateOrderDto,
  UpdateOrderStatusDto,
} from 'types/dto/orders.dto.js';
import type { MessageResponseDto } from 'types/common.js';

async function findOrders({
  userId,
  page,
  limit,
  status,
}: FindOrdersDto): Promise<MessageResponseDto> {
  return { message: 'orders list not implemented' };
}

async function findOrderById({ userId, orderId }: FindOrderByIdDto): Promise<MessageResponseDto> {
  return { message: 'order by id not implemented' };
}

async function createOrder({
  userId,
  items,
  note,
  shippingAddress,
}: CreateOrderDto): Promise<MessageResponseDto> {
  return { message: 'create order not implemented' };
}

async function updateOrderStatus({
  actorId,
  orderId,
  status,
}: UpdateOrderStatusDto): Promise<MessageResponseDto> {
  return { message: 'update order status not implemented' };
}

export const ordersServices = {
  findOrders,
  findOrderById,
  createOrder,
  updateOrderStatus,
};
