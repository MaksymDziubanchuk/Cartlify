import type {
  CurrentAddItemDto,
  FindOrdersDto,
  FindOrderByIdDto,
  UpdateOrderStatusDto,
} from 'types/dto/orders.dto.js';
import type { MessageResponseDto } from 'types/common.js';

import { addCurrentItem } from './services/addCurrentItem.service.js';

import { updateCurrentItem } from './services/updateCurrentItem.service.js';

import { deleteCurrentItem } from './services/deleteCurrentItem.service.js';

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

async function updateOrderStatus({
  actorId,
  orderId,
  status,
}: UpdateOrderStatusDto): Promise<MessageResponseDto> {
  return { message: 'update order status not implemented' };
}

export const ordersServices = {
  addCurrentItem,
  updateCurrentItem,
  deleteCurrentItem,

  findOrders,
  findOrderById,
  updateOrderStatus,
};
