import pickDefined from '@helpers/parameterNormalize.js';
import { paymentsServices } from './payments.services.js';

import type { ControllerRouter } from 'types/controller.js';
import type { UserEntity } from 'types/user.js';
import type {
  CreateCheckoutSessionBodyDto,
  CreateCheckoutSessionDto,
  CheckoutSessionResponseDto,
  GetPaymentRefundsQueryDto,
  GetPaymentRefundsResponseDto,
  MarkPaymentRefundOutsideBodyDto,
  MarkPaymentRefundOutsideParamsDto,
  PaymentRefundOutsideDto,
  GiveCompensationBodyDto,
  MoneyDecisionBodyDto,
  PaymentRefundItemDto,
  MoneyDecisionDto,
  MoneyLineParamsDto,
  DisputeCardDto,
  GetDisputeParamsDto,
  GetDisputesQueryDto,
  GetDisputesResponseDto,
} from 'types/dto/payments.dto.ts';

const postCheckoutSession: ControllerRouter<
  {},
  CreateCheckoutSessionBodyDto,
  {},
  CheckoutSessionResponseDto
> = async (req, reply) => {
  const { id: actorId, role: actorRole } = req.user as UserEntity;
  const { orderId, provider } = req.body;

  const args = pickDefined<CreateCheckoutSessionDto>({ actorId, actorRole, orderId, provider }, {});

  const result = await paymentsServices.createCheckoutSession(args);
  return reply.code(201).send(result);
};

const getRefunds: ControllerRouter<
  {},
  {},
  GetPaymentRefundsQueryDto,
  GetPaymentRefundsResponseDto
> = async (req, reply) => {
  const { id: actorId, role: actorRole } = req.user as UserEntity;
  const { limit, from, to, ...filters } = req.query;

  const result = await paymentsServices.listPaymentRefunds({
    ...filters,
    actorId,
    actorRole,
    limit: limit ?? 20,
    // the schema let through a date-time only
    from: from ? new Date(from) : undefined,
    to: to ? new Date(to) : undefined,
  });
  return reply.code(200).send(result);
};

const postRefundOutside: ControllerRouter<
  MarkPaymentRefundOutsideParamsDto,
  MarkPaymentRefundOutsideBodyDto,
  {},
  PaymentRefundOutsideDto
> = async (req, reply) => {
  const { id: actorId, role: actorRole } = req.user as UserEntity;

  const result = await paymentsServices.markPaymentRefundOutside({
    ...req.body,
    refundId: Number(req.params.refundId),
    actorId,
    actorRole,
    log: req.log,
  });
  return reply.code(200).send(result);
};

const postCompensation: ControllerRouter<
  {},
  GiveCompensationBodyDto,
  {},
  PaymentRefundItemDto
> = async (req, reply) => {
  const { id: actorId, role: actorRole } = req.user as UserEntity;

  const result = await paymentsServices.giveCompensation({
    orderId: req.body.orderId,
    amount: req.body.amount,
    note: req.body.note,
    actorId,
    actorRole,
    log: req.log,
  });
  return reply.code(200).send(result);
};

const postMoneyDecision: ControllerRouter<
  MoneyLineParamsDto,
  MoneyDecisionBodyDto,
  {},
  MoneyDecisionDto
> = async (req, reply) => {
  const { id: actorId, role: actorRole } = req.user as UserEntity;

  const result = await paymentsServices.decideMoneyUse({
    items: req.body.items,
    ...(req.body.delivery !== undefined ? { delivery: req.body.delivery } : {}),
    note: req.body.note,
    moneyLogId: Number(req.params.moneyLogId),
    actorId,
    actorRole,
    log: req.log,
  });
  return reply.code(200).send(result);
};

const getDisputes: ControllerRouter<{}, {}, GetDisputesQueryDto, GetDisputesResponseDto> = async (
  req,
  reply,
) => {
  const { id: actorId, role: actorRole } = req.user as UserEntity;
  const { status, open, toAnswer, closedFrom, orderId, moneyUndecided, limit, cursor } = req.query;

  const result = await paymentsServices.listDisputes({
    actorId,
    actorRole,
    // the schema let through known states only
    statuses: status ? (status.split(',') as never) : undefined,
    open,
    toAnswer,
    moneyUndecided,
    closedFrom: closedFrom ? new Date(closedFrom) : undefined,
    orderId,
    limit: limit ?? 20,
    cursor,
  });
  return reply.code(200).send(result);
};

const getDispute: ControllerRouter<GetDisputeParamsDto, {}, {}, DisputeCardDto> = async (
  req,
  reply,
) => {
  const { id: actorId, role: actorRole } = req.user as UserEntity;

  const result = await paymentsServices.getDispute({
    actorId,
    actorRole,
    disputeId: Number(req.params.disputeId),
  });
  return reply.code(200).send(result);
};

export const paymentsController = {
  postCheckoutSession,
  getRefunds,
  postRefundOutside,
  postCompensation,
  postMoneyDecision,
  getDisputes,
  getDispute,
};
