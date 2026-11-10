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
  const { limit, to, ...filters } = req.query;

  const result = await paymentsServices.listPaymentRefunds({
    ...filters,
    actorId,
    actorRole,
    limit: limit ?? 20,
    // the schema let through a date-time only
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
    refundId: req.params.refundId,
    actorId,
    actorRole,
    log: req.log,
  });
  return reply.code(200).send(result);
};

export const paymentsController = {
  postCheckoutSession,
  getRefunds,
  postRefundOutside,
};
