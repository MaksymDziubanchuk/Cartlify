import pickDefined from '@helpers/parameterNormalize.js';
import { paymentsServices } from './payments.services.js';
import { BadRequestError } from '@utils/errors.js';

import type { ControllerRouter } from 'types/controller.js';
import type { UserEntity } from 'types/user.js';
import type {
  CreateCheckoutSessionBodyDto,
  CreateCheckoutSessionDto,
  CheckoutSessionResponseDto,
  GetCheckoutSessionByIdParamsDto,
  GetCheckoutSessionByIdDto,
  HandleStripeWebhookDto,
  StripeWebhookResponseDto,
} from 'types/dto/payments.dto.ts';

const postCheckoutSession: ControllerRouter<
  {},
  CreateCheckoutSessionBodyDto,
  {},
  CheckoutSessionResponseDto
> = async (req, reply) => {
  const { id: actorId, role: actorRole } = req.user as UserEntity;
  const { orderId } = req.body;

  const args = pickDefined<CreateCheckoutSessionDto>({ actorId, actorRole, orderId }, {});

  const result = await paymentsServices.createCheckoutSession(args);
  return reply.code(201).send(result);
};

const getCheckoutSessionById: ControllerRouter<
  GetCheckoutSessionByIdParamsDto,
  {},
  {},
  CheckoutSessionResponseDto
> = async (req, reply) => {
  const { id: actorId, role: actorRole } = req.user as UserEntity;
  const { sessionId } = req.params;

  const args = pickDefined<GetCheckoutSessionByIdDto>(
    {
      actorId,
      actorRole,
      sessionId,
    },
    {},
  );

  const result = await paymentsServices.getCheckoutSessionById(args);

  return reply.code(200).send(result);
};

const postStripeWebhook: ControllerRouter<{}, {}, {}, StripeWebhookResponseDto> = async (
  req,
  reply,
) => {
  const stripeSignature = req.headers['stripe-signature'];
  const { rawBody } = req;

  if (typeof stripeSignature !== 'string' || !stripeSignature.trim()) {
    throw new BadRequestError('STRIPE_SIGNATURE_REQUIRED');
  }

  if (
    !(typeof rawBody === 'string' && rawBody.length > 0) &&
    !(Buffer.isBuffer(rawBody) && rawBody.length > 0)
  ) {
    throw new BadRequestError('STRIPE_RAW_BODY_REQUIRED');
  }

  const args = pickDefined<HandleStripeWebhookDto>(
    {
      stripeSignature,
      rawBody,
    },
    {},
  );

  const result = await paymentsServices.handleStripeWebhook(args);

  return reply.code(200).send(result);
};

export const paymentsController = {
  postCheckoutSession,
  getCheckoutSessionById,
  postStripeWebhook,
};
