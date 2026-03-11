import type { ControllerRouter } from 'types/controller.js';
import type { MessageResponseDto } from 'types/common.js';
import type { UserEntity } from 'types/user.js';
import type {
  CurrentAddItemBodyDto,
  CurrentAddItemDto,
  CurrentItemIdParamsDto,
  CurrentUpdateItemBodyDto,
  CurrentUpdateItemDto,
  CurrentDeleteItemDto,
  GetOrdersQueryDto,
  FindOrdersDto,
  GetOrderByIdParamsDto,
  FindOrderByIdDto,
  UpdateOrderStatusParamsDto,
  UpdateOrderStatusBodyDto,
  UpdateOrderStatusDto,
  OrderResponseDto,
} from 'types/dto/orders.dto.js';
import pickDefined from '@helpers/parameterNormalize.js';
import { ordersServices } from './orders.services.js';

const postCurrentItems: ControllerRouter<{}, CurrentAddItemBodyDto, {}, OrderResponseDto> = async (
  req,
  reply,
) => {
  const { id: actorId, role: actorRole } = req.user as UserEntity;
  const { productId, quantity } = req.body;

  const args = pickDefined<CurrentAddItemDto>({ actorId, actorRole, productId, quantity }, {});

  const result = await ordersServices.addCurrentItem(args);
  return reply.code(200).send(result);
};

const patchCurrentItems: ControllerRouter<
  CurrentItemIdParamsDto,
  CurrentUpdateItemBodyDto,
  {},
  OrderResponseDto
> = async (req, reply) => {
  const { id: actorId, role: actorRole } = req.user as UserEntity;
  const { itemId } = req.params;
  const { quantity } = req.body;

  const args = pickDefined<CurrentUpdateItemDto>({ actorId, actorRole, itemId, quantity }, {});

  const result = await ordersServices.updateCurrentItem(args);
  return reply.code(200).send(result);
};

const deleteCurrentItems: ControllerRouter<
  CurrentItemIdParamsDto,
  {},
  {},
  OrderResponseDto
> = async (req, reply) => {
  const { id: actorId, role: actorRole } = req.user as UserEntity;
  const { itemId } = req.params;

  const args = pickDefined<CurrentDeleteItemDto>({ actorId, actorRole, itemId }, {});

  const result = await ordersServices.deleteCurrentItem(args);
  return reply.code(200).send(result);
};

const getOrders: ControllerRouter<{}, {}, GetOrdersQueryDto, MessageResponseDto> = async (
  req,
  reply,
) => {
  const { id } = req.user as UserEntity;
  const { page: qp, limit: ql, status, confirmed } = req.query;
  const page = qp ? Number(qp) : 1;
  const limit = ql ? Number(ql) : 10;

  const args = pickDefined<FindOrdersDto>({ userId: id, page, limit }, { status, confirmed });

  const result = await ordersServices.findOrders(args);
  return reply.code(200).send(result);
};

const getOrderById: ControllerRouter<GetOrderByIdParamsDto, {}, {}, MessageResponseDto> = async (
  req,
  reply,
) => {
  const { id } = req.user as UserEntity;
  const { orderId } = req.params;

  const args = pickDefined<FindOrderByIdDto>({ userId: id, orderId }, {});

  const result = await ordersServices.findOrderById(args);
  return reply.code(200).send(result);
};

const putOrderStatus: ControllerRouter<
  UpdateOrderStatusParamsDto,
  UpdateOrderStatusBodyDto,
  {},
  MessageResponseDto
> = async (req, reply) => {
  const { id: actorId, role: actorRole } = req.user as UserEntity;
  const { orderId } = req.params;
  const { status } = req.body;

  const args = pickDefined<UpdateOrderStatusDto>({ actorId, actorRole, orderId, status }, {});

  const result = await ordersServices.updateOrderStatus(args);
  return reply.code(200).send(result);
};

export const ordersController = {
  postCurrentItems,
  patchCurrentItems,
  deleteCurrentItems,

  getOrders,
  getOrderById,
  putOrderStatus,
};
