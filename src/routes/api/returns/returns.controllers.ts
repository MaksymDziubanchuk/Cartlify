import type { ControllerRouter } from 'types/controller.js';
import type { User } from 'types/user.js';
import type {
  CloseReturnBodyDto,
  GetReturnsQueryDto,
  GetReturnsResponseDto,
  RecordReturnShipmentBodyDto,
  ReturnShipmentParamsDto,
  SetReturnShipmentCostBodyDto,
  CreateReturnBodyDto,
  ReceiveReturnItemsBodyDto,
  RecordMoneyReceivedBodyDto,
  RecordOverpaidReceivedBodyDto,
  LoseOverpaidBodyDto,
  KeepReturnGoodsBodyDto,
  RefundReturnBodyDto,
  RefundReturnOutsideBodyDto,
  ReturnDto,
  ReturnParamsDto,
  ReturnParcelConfirmDto,
  SplitReturnBodyDto,
} from 'types/dto/returns.dto.js';

import { returnsServices } from './returns.services.js';

const getReturns: ControllerRouter<{}, {}, GetReturnsQueryDto, GetReturnsResponseDto> = async (
  req,
  reply,
) => {
  const { id: actorId, role: actorRole } = req.user as User;
  const { format, limit, sortBy, sortDir, cursor, ...filters } = req.query;
  const date = (value: string | undefined) => (value ? new Date(value) : undefined);

  const args = {
    actorId,
    actorRole,
    limit: limit ?? 20,
    sortBy: sortBy ?? ('statedAt' as const),
    sortDir: sortDir ?? ('desc' as const),
    cursor,
    ...filters,
    // the schema let through date-times only
    statedFrom: date(filters.statedFrom),
    statedTo: date(filters.statedTo),
    closedFrom: date(filters.closedFrom),
    closedTo: date(filters.closedTo),
    refundedFrom: date(filters.refundedFrom),
    refundedTo: date(filters.refundedTo),
  };

  // every statement of the filter as a file
  if (format === 'csv') {
    const file = await returnsServices.listReturnsCsv(args);
    return reply
      .code(200)
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="${file.fileName}"`)
      .send(file.body as never);
  }

  const result = await returnsServices.listReturns(args);
  return reply.code(200).send(result);
};

const postReturn: ControllerRouter<{}, CreateReturnBodyDto, {}, ReturnDto> = async (req, reply) => {
  const { id: actorId, role: actorRole } = req.user as User;

  const result = await returnsServices.createReturn({
    ...req.body,
    actorId,
    actorRole,
    log: req.log,
  });
  return reply.code(201).send(result);
};

const getReturn: ControllerRouter<ReturnParamsDto, {}, {}, ReturnDto> = async (req, reply) => {
  const { id: actorId, role: actorRole } = req.user as User;

  const result = await returnsServices.getReturn({
    actorId,
    actorRole,
    returnId: Number(req.params.returnId),
  });
  return reply.code(200).send(result);
};

const postReceiveItems: ControllerRouter<
  ReturnParamsDto,
  ReceiveReturnItemsBodyDto,
  {},
  ReturnDto
> = async (req, reply) => {
  const { id: actorId, role: actorRole } = req.user as User;

  const result = await returnsServices.receiveReturnItems({
    actorId,
    actorRole,
    returnId: Number(req.params.returnId),
    results: req.body.results,
    ...(req.body.parcel ? { parcel: req.body.parcel } : {}),
    log: req.log,
  });
  return reply.code(200).send(result);
};

const postRefund: ControllerRouter<ReturnParamsDto, RefundReturnBodyDto, {}, ReturnDto> = async (
  req,
  reply,
) => {
  const { id: actorId, role: actorRole } = req.user as User;

  const result = await returnsServices.refundReturn({
    ...req.body,
    actorId,
    actorRole,
    returnId: Number(req.params.returnId),
    log: req.log,
  });
  return reply.code(200).send(result);
};

const postMoneyReceived: ControllerRouter<
  ReturnParamsDto,
  RecordMoneyReceivedBodyDto,
  {},
  ReturnDto
> = async (req, reply) => {
  const { id: actorId, role: actorRole } = req.user as User;

  const result = await returnsServices.recordMoneyReceived({
    ...req.body,
    actorId,
    actorRole,
    returnId: Number(req.params.returnId),
  });
  return reply.code(200).send(result);
};

const postOverpaidReceived: ControllerRouter<
  ReturnParamsDto,
  RecordOverpaidReceivedBodyDto,
  {},
  ReturnDto
> = async (req, reply) => {
  const { id: actorId, role: actorRole } = req.user as User;

  const result = await returnsServices.recordOverpaidReceived({
    ...req.body,
    actorId,
    actorRole,
    returnId: Number(req.params.returnId),
  });
  return reply.code(200).send(result);
};

const postOverpaidLost: ControllerRouter<
  ReturnParamsDto,
  LoseOverpaidBodyDto,
  {},
  ReturnDto
> = async (req, reply) => {
  const { id: actorId, role: actorRole } = req.user as User;

  const result = await returnsServices.loseOverpaid({
    ...req.body,
    actorId,
    actorRole,
    returnId: Number(req.params.returnId),
  });
  return reply.code(200).send(result);
};

const postKeep: ControllerRouter<ReturnParamsDto, KeepReturnGoodsBodyDto, {}, ReturnDto> = async (
  req,
  reply,
) => {
  const { id: actorId, role: actorRole } = req.user as User;

  const result = await returnsServices.keepReturnGoods({
    ...req.body,
    actorId,
    actorRole,
    returnId: Number(req.params.returnId),
    log: req.log,
  });
  return reply.code(200).send(result);
};

const postRefundOutside: ControllerRouter<
  ReturnParamsDto,
  RefundReturnOutsideBodyDto,
  {},
  ReturnDto
> = async (req, reply) => {
  const { id: actorId, role: actorRole } = req.user as User;

  const result = await returnsServices.markReturnRefundedOutside({
    ...req.body,
    actorId,
    actorRole,
    returnId: Number(req.params.returnId),
    log: req.log,
  });
  return reply.code(200).send(result);
};

const postClose: ControllerRouter<ReturnParamsDto, CloseReturnBodyDto, {}, ReturnDto> = async (
  req,
  reply,
) => {
  const { id: actorId, role: actorRole } = req.user as User;

  const result = await returnsServices.closeReturnRows({
    ...req.body,
    actorId,
    actorRole,
    returnId: Number(req.params.returnId),
    log: req.log,
  });
  return reply.code(200).send(result);
};

const postConfirmProof: ControllerRouter<
  ReturnParamsDto,
  ReturnParcelConfirmDto | undefined,
  {},
  ReturnDto
> = async (req, reply) => {
  const { id: actorId, role: actorRole } = req.user as User;
  const body = req.body ?? {};

  const result = await returnsServices.confirmReturnProof({
    actorId,
    actorRole,
    returnId: Number(req.params.returnId),
    ...(body.buyerPaid !== undefined ? { buyerPaid: body.buyerPaid } : {}),
    ...(body.cost !== undefined ? { cost: body.cost } : {}),
  });
  return reply.code(200).send(result);
};

const postAccept: ControllerRouter<ReturnParamsDto, {}, {}, ReturnDto> = async (req, reply) => {
  const { id: actorId, role: actorRole } = req.user as User;

  const result = await returnsServices.acceptReturn({
    actorId,
    actorRole,
    returnId: Number(req.params.returnId),
  });
  return reply.code(200).send(result);
};

const postSplit: ControllerRouter<ReturnParamsDto, SplitReturnBodyDto, {}, ReturnDto> = async (
  req,
  reply,
) => {
  const { id: actorId, role: actorRole } = req.user as User;

  const result = await returnsServices.splitReturn({
    ...req.body,
    actorId,
    actorRole,
    returnId: Number(req.params.returnId),
    log: req.log,
  });
  return reply.code(201).send(result);
};

const postShipment: ControllerRouter<
  ReturnParamsDto,
  RecordReturnShipmentBodyDto,
  {},
  ReturnDto
> = async (req, reply) => {
  const { id: actorId, role: actorRole } = req.user as User;

  const result = await returnsServices.recordReturnShipment({
    ...req.body,
    actorId,
    actorRole,
    returnId: Number(req.params.returnId),
    log: req.log,
  });
  return reply.code(201).send(result);
};

const patchShipmentCost: ControllerRouter<
  ReturnShipmentParamsDto,
  SetReturnShipmentCostBodyDto,
  {},
  ReturnDto
> = async (req, reply) => {
  const { id: actorId, role: actorRole } = req.user as User;

  const result = await returnsServices.setReturnShipmentCost({
    ...req.body,
    actorId,
    actorRole,
    returnId: Number(req.params.returnId),
    shipmentId: Number(req.params.shipmentId),
  });
  return reply.code(200).send(result);
};

export const returnsController = {
  getReturns,
  postReturn,
  getReturn,
  postReceiveItems,
  postConfirmProof,
  postAccept,
  postRefund,
  postRefundOutside,
  postMoneyReceived,
  postOverpaidReceived,
  postOverpaidLost,
  postKeep,
  postClose,
  postShipment,
  patchShipmentCost,
  postSplit,
};
