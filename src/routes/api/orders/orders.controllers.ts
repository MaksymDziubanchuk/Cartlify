import type { ControllerRouter } from 'types/controller.js';
import type { MessageResponseDto } from 'types/common.js';
import type { UserEntity } from 'types/user.js';
import type {
  GetCurrentOrderDto,
  CurrentAddItemBodyDto,
  CurrentAddItemDto,
  CurrentItemIdParamsDto,
  CurrentUpdateItemBodyDto,
  CurrentUpdateItemDto,
  CurrentDeleteItemDto,
  ConfirmCurrentOrderBodyDto,
  ConfirmCurrentOrderDto,
  GetOrdersQueryDto,
  FindOrdersDto,
  GetOrdersResponseDto,
  GetOrderByIdParamsDto,
  FindOrderByIdDto,
  UpdateOrderStatusParamsDto,
  UpdateOrderStatusBodyDto,
  UpdateOrderStatusDto,
  OrderResponseDto,
} from 'types/dto/orders.dto.js';
import pickDefined from '@helpers/parameterNormalize.js';
import { ordersServices } from './orders.services.js';

const getCurrentOrder: ControllerRouter<{}, {}, {}, OrderResponseDto> = async (req, reply) => {
  const { id: actorId, role: actorRole } = req.user as UserEntity;

  const args = pickDefined<GetCurrentOrderDto>({ actorId, actorRole }, {});

  const result = await ordersServices.getCurrent(args);
  return reply.code(200).send(result);
};

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

const postConfirm: ControllerRouter<{}, ConfirmCurrentOrderBodyDto, {}, OrderResponseDto> = async (
  req,
  reply,
) => {
  const { id: actorId, role: actorRole } = req.user as UserEntity;
  const { orderId } = req.body;

  const args = pickDefined<ConfirmCurrentOrderDto>({ actorId, actorRole, orderId }, {});

  const result = await ordersServices.confirmOrder(args);
  return reply.code(200).send(result);
};

const getOrders: ControllerRouter<{}, {}, GetOrdersQueryDto, GetOrdersResponseDto> = async (
  req,
  reply,
) => {
  const { id: actorId, role: actorRole } = req.user as UserEntity;

  const { limit, cursor, status, confirmed, sortBy, sortDir } = req.query;

  const args = pickDefined<FindOrdersDto>(
    {
      actorId,
      actorRole,
      limit: limit ?? 20,
      sortBy: sortBy ?? 'updatedAt',
      sortDir: sortDir ?? 'desc',
    },
    { cursor, status, confirmed },
  );

  const result = await ordersServices.findOrders(args);
  return reply.code(200).send(result);
};

const getOrderById: ControllerRouter<GetOrderByIdParamsDto, {}, {}, OrderResponseDto> = async (
  req,
  reply,
) => {
  const { id: actorId, role: actorRole } = req.user as UserEntity;
  const { orderId } = req.params;

  const args = pickDefined<FindOrderByIdDto>({ actorId, actorRole, orderId }, {});

  const result = await ordersServices.findById(args);
  return reply.code(200).send(result);
};

const putOrderStatus: ControllerRouter<
  UpdateOrderStatusParamsDto,
  UpdateOrderStatusBodyDto,
  {},
  OrderResponseDto
> = async (req, reply) => {
  const { id: actorId, role: actorRole } = req.user as UserEntity;
  const { orderId } = req.params;
  const { status } = req.body;

  const args = pickDefined<UpdateOrderStatusDto>({ actorId, actorRole, orderId, status }, {});

  const result = await ordersServices.updateOrderStatus(args);
  return reply.code(200).send(result);
};

export const ordersController = {
  getCurrentOrder,
  postCurrentItems,
  patchCurrentItems,
  deleteCurrentItems,
  postConfirm,

  getOrders,
  getOrderById,
  putOrderStatus,
};
