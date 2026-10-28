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
  CancelOrderBodyDto,
  CancelOrderDto,
  CancelledOrderResponseDto,
  UpdateShipmentParamsDto,
  UpdateShipmentBodyDto,
  UpdateOrderDeliveryBodyDto,
  UpdateOrdersStatusBodyDto,
  UpdateOrdersStatusResponseDto,
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
  const { orderId, delivery, expectedDeliveryPrice } = req.body;

  const args = pickDefined<ConfirmCurrentOrderDto>(
    { actorId, actorRole, orderId, expectedDeliveryPrice },
    { delivery },
  );

  const result = await ordersServices.confirmOrder(args);
  return reply.code(200).send(result);
};

const getOrders: ControllerRouter<{}, {}, GetOrdersQueryDto, GetOrdersResponseDto> = async (
  req,
  reply,
) => {
  const { id: actorId, role: actorRole } = req.user as UserEntity;

  const {
    limit,
    cursor,
    status,
    statuses,
    confirmed,
    paidFrom,
    paidTo,
    updatedFrom,
    updatedTo,
    productId,
    userId,
    q,
    format,
    deliveryMethod,
    country,
    carrier,
    shippedWithoutNumber,
    deliveryCharged,
    withoutWeight,
    shippingCostMissing,
    shippedTo,
    sortBy,
    sortDir,
  } = req.query;

  const args = pickDefined<FindOrdersDto>(
    {
      actorId,
      actorRole,
      limit: limit ?? 20,
    },
    {
      // the sort the request names; without one the service takes the one of its filters
      sortBy,
      sortDir,
      cursor,
      status,
      statuses,
      confirmed,
      // the schema let through date-times only
      paidFrom: paidFrom ? new Date(paidFrom) : undefined,
      paidTo: paidTo ? new Date(paidTo) : undefined,
      updatedFrom: updatedFrom ? new Date(updatedFrom) : undefined,
      updatedTo: updatedTo ? new Date(updatedTo) : undefined,
      productId,
      userId,
      q,
      format,
      deliveryMethod,
      country,
      carrier,
      shippedWithoutNumber,
      deliveryCharged,
      withoutWeight,
      shippingCostMissing,
      shippedTo: shippedTo ? new Date(shippedTo) : undefined,
    },
  );

  // every order of the filters as a file for the courier
  if (format === 'csv') {
    const file = await ordersServices.findOrdersCsv(args);
    return reply
      .code(200)
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="${file.fileName}"`)
      .send(file.body as never);
  }

  const result = await ordersServices.findOrders(args);
  return reply.code(200).send(result);
};

// one step of shipping for many orders, each in a transaction of its own
const postOrdersStatus: ControllerRouter<
  {},
  UpdateOrdersStatusBodyDto,
  {},
  UpdateOrdersStatusResponseDto
> = async (req, reply) => {
  const { id: actorId, role: actorRole } = req.user as UserEntity;

  const result = await ordersServices.updateOrdersStatus(
    { actorId, actorRole, orders: req.body.orders, status: req.body.status },
    req.log,
  );
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
  const { status, shipment, keepShippingCost } = req.body;

  const args = pickDefined<UpdateOrderStatusDto>(
    { actorId, actorRole, orderId, status },
    { shipment, keepShippingCost, bulk: undefined },
  );

  const result = await ordersServices.updateOrderStatus(args, req.log);
  return reply.code(200).send(result);
};

// what the shop pays the carrier and the details of a send
const patchShipment: ControllerRouter<
  UpdateShipmentParamsDto,
  UpdateShipmentBodyDto,
  {},
  OrderResponseDto
> = async (req, reply) => {
  const { id: actorId, role: actorRole } = req.user as UserEntity;

  const result = await ordersServices.updateShipment(
    {
      actorId,
      actorRole,
      orderId: Number(req.params.orderId),
      shipmentId: Number(req.params.shipmentId),
      changes: req.body,
    },
    req.log,
  );
  return reply.code(200).send(result);
};

// an admin corrects where a paid order goes
const patchOrderDelivery: ControllerRouter<
  GetOrderByIdParamsDto,
  UpdateOrderDeliveryBodyDto,
  {},
  OrderResponseDto
> = async (req, reply) => {
  const { id: actorId, role: actorRole } = req.user as UserEntity;

  const result = await ordersServices.updateOrderDelivery(
    { actorId, actorRole, orderId: Number(req.params.orderId), changes: req.body },
    req.log,
  );
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

  const args = pickDefined<CancelOrderDto>(
    { actorId, actorRole, orderId },
    { shippingPaid: undefined },
  );

  const result = await ordersServices.cancelOrderPayment(args, req.log);
  return reply.code(200).send(result);
};

const postCancelOrder: ControllerRouter<
  GetOrderByIdParamsDto,
  CancelOrderBodyDto,
  {},
  CancelledOrderResponseDto
> = async (req, reply) => {
  const { id: actorId, role: actorRole } = req.user as UserEntity;
  const orderId = Number(req.params.orderId);

  const args = pickDefined<CancelOrderDto>(
    { actorId, actorRole, orderId },
    { shippingPaid: req.body?.shippingPaid },
  );

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
  postOrdersStatus,
  patchShipment,
  patchOrderDelivery,

  postOrderItems,
  patchOrderItems,
  deleteOrderItems,
  postCancelPayment,
  postCancelOrder,
};
