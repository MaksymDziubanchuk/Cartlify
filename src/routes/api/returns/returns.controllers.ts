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
  RefundReturnBodyDto,
  RefundReturnOutsideBodyDto,
  RecordReturnReimbursementBodyDto,
  SettleReturnDisputeBodyDto,
  ReturnDto,
  ReturnParamsDto,
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

const postReimbursement: ControllerRouter<
  ReturnParamsDto,
  RecordReturnReimbursementBodyDto,
  {},
  ReturnDto
> = async (req, reply) => {
  const { id: actorId, role: actorRole } = req.user as User;

  const result = await returnsServices.recordReturnReimbursement({
    ...req.body,
    actorId,
    actorRole,
    returnId: Number(req.params.returnId),
    log: req.log,
  });
  return reply.code(200).send(result);
};

const postDispute: ControllerRouter<
  ReturnParamsDto,
  SettleReturnDisputeBodyDto,
  {},
  ReturnDto
> = async (req, reply) => {
  const { id: actorId, role: actorRole } = req.user as User;

  const result = await returnsServices.settleReturnDispute({
    ...req.body,
    actorId,
    actorRole,
    returnId: Number(req.params.returnId),
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

const postConfirmProof: ControllerRouter<ReturnParamsDto, {}, {}, ReturnDto> = async (
  req,
  reply,
) => {
  const { id: actorId, role: actorRole } = req.user as User;

  const result = await returnsServices.confirmReturnProof({
    actorId,
    actorRole,
    returnId: Number(req.params.returnId),
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
  postReimbursement,
  postDispute,
  postClose,
  postShipment,
  patchShipmentCost,
};
