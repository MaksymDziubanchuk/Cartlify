import type { ControllerRouter } from 'types/controller.js';
import type { MessageResponseDto } from 'types/common.js';
import type { UserEntity } from 'types/user.js';
import type {
  GetOrdersQueryDto,
  FindOrdersDto,
  GetOrderByIdParamsDto,
  FindOrderByIdDto,
  CreateOrderBodyDto,
  CreateOrderDto,
  UpdateOrderStatusParamsDto,
  UpdateOrderStatusBodyDto,
  UpdateOrderStatusDto,
} from 'types/dto/orders.dto.js';
import pickDefined from '@helpers/parameterNormalize.js';
import { ordersServices } from './orders.services.js';

const getOrders: ControllerRouter<{}, {}, GetOrdersQueryDto, MessageResponseDto> = async (
  req,
  reply,
) => {
  const { id } = req.user as UserEntity;
  const { page: qp, limit: ql, status } = req.query;
  const page = qp ? Number(qp) : 1;
  const limit = ql ? Number(ql) : 10;

  const args = pickDefined<FindOrdersDto>({ userId: id, page, limit }, { status });

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

const postOrder: ControllerRouter<{}, CreateOrderBodyDto, {}, MessageResponseDto> = async (
  req,
  reply,
) => {
  const { id } = req.user as UserEntity;
  const { items, note, shippingAddress } = req.body;

  const args = pickDefined<CreateOrderDto>({ userId: id, items, shippingAddress }, { note });

  const result = await ordersServices.createOrder(args);
  return reply.code(201).send(result);
};

const putOrderStatus: ControllerRouter<
  UpdateOrderStatusParamsDto,
  UpdateOrderStatusBodyDto,
  {},
  MessageResponseDto
> = async (req, reply) => {
  const { id } = req.user as UserEntity;
  const { orderId } = req.params;
  const { status } = req.body;

  const args = pickDefined<UpdateOrderStatusDto>({ actorId: id, orderId, status }, {});

  const result = await ordersServices.updateOrderStatus(args);
  return reply.code(200).send(result);
};

export const ordersController = {
  getOrders,
  getOrderById,
  postOrder,
  putOrderStatus,
};
