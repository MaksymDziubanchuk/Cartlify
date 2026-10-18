import type { ControllerRouter } from 'types/controller.js';
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
  OrderItemParamsDto,
  CancelOrderDto,
  CancelledOrderResponseDto,
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

  const args = pickDefined<CurrentAddItemDto>(
    { actorId, actorRole, productId, quantity },
    { orderId: undefined },
  );

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
  const itemId = Number(req.params.itemId);
  const { quantity } = req.body;

  const args = pickDefined<CurrentUpdateItemDto>(
    { actorId, actorRole, itemId, quantity },
    { orderId: undefined },
  );

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
  const itemId = Number(req.params.itemId);

  const args = pickDefined<CurrentDeleteItemDto>(
    { actorId, actorRole, itemId },
    { orderId: undefined },
  );

  const result = await ordersServices.deleteCurrentItem(args);
  return reply.code(200).send(result);
};

const postConfirm: ControllerRouter<{}, ConfirmCurrentOrderBodyDto, {}, OrderResponseDto> = async (
  req,
  reply,
) => {
  const { id: actorId, role: actorRole } = req.user as UserEntity;
  const { orderId, shippingAddress, recipientFirstName, recipientLastName, recipientPhone, note } =
    req.body;

  const args = pickDefined<ConfirmCurrentOrderDto>(
    { actorId, actorRole, orderId },
    { shippingAddress, recipientFirstName, recipientLastName, recipientPhone, note },
  );

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
  const orderId = Number(req.params.orderId);

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
  const orderId = Number(req.params.orderId);
  const { status } = req.body;

  const args = pickDefined<UpdateOrderStatusDto>({ actorId, actorRole, orderId, status }, {});

  const result = await ordersServices.updateOrderStatus(args);
  return reply.code(200).send(result);
};

// items of an own order that lost its reservation (unconfirmed), the same as the cart items
const postOrderItems: ControllerRouter<
  GetOrderByIdParamsDto,
  CurrentAddItemBodyDto,
  {},
  OrderResponseDto
> = async (req, reply) => {
  const { id: actorId, role: actorRole } = req.user as UserEntity;
  const orderId = Number(req.params.orderId);
  const { productId, quantity } = req.body;

  const args = pickDefined<CurrentAddItemDto>(
    { actorId, actorRole, productId, quantity },
    { orderId },
  );

  const result = await ordersServices.addCurrentItem(args);
  return reply.code(200).send(result);
};

const patchOrderItems: ControllerRouter<
  OrderItemParamsDto,
  CurrentUpdateItemBodyDto,
  {},
  OrderResponseDto
> = async (req, reply) => {
  const { id: actorId, role: actorRole } = req.user as UserEntity;
  const orderId = Number(req.params.orderId);
  const itemId = Number(req.params.itemId);
  const { quantity } = req.body;

  const args = pickDefined<CurrentUpdateItemDto>(
    { actorId, actorRole, itemId, quantity },
    { orderId },
  );

  const result = await ordersServices.updateCurrentItem(args);
  return reply.code(200).send(result);
};

const deleteOrderItems: ControllerRouter<OrderItemParamsDto, {}, {}, OrderResponseDto> = async (
  req,
  reply,
) => {
  const { id: actorId, role: actorRole } = req.user as UserEntity;
  const orderId = Number(req.params.orderId);
  const itemId = Number(req.params.itemId);

  const args = pickDefined<CurrentDeleteItemDto>({ actorId, actorRole, itemId }, { orderId });

  const result = await ordersServices.deleteCurrentItem(args);
  return reply.code(200).send(result);
};

const postCancelPayment: ControllerRouter<GetOrderByIdParamsDto, {}, {}, OrderResponseDto> = async (
  req,
  reply,
) => {
  const { id: actorId, role: actorRole } = req.user as UserEntity;
  const orderId = Number(req.params.orderId);

  const args = pickDefined<CancelOrderDto>({ actorId, actorRole, orderId }, {});

  const result = await ordersServices.cancelOrderPayment(args, req.log);
  return reply.code(200).send(result);
};

const postCancelOrder: ControllerRouter<
  GetOrderByIdParamsDto,
  {},
  {},
  CancelledOrderResponseDto
> = async (req, reply) => {
  const { id: actorId, role: actorRole } = req.user as UserEntity;
  const orderId = Number(req.params.orderId);

  const args = pickDefined<CancelOrderDto>({ actorId, actorRole, orderId }, {});

  const result = await ordersServices.cancelPaidOrder(args, req.log);
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

  postOrderItems,
  patchOrderItems,
  deleteOrderItems,
  postCancelPayment,
  postCancelOrder,
};
