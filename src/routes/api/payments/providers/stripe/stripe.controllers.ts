import pickDefined from '@helpers/parameterNormalize.js';
import { BadRequestError } from '@utils/errors.js';

import { handleStripeWebhook } from './services/handleStripeWebhook.service.js';
import { getStripeCheckoutSession } from './services/getStripeCheckoutSession.service.js';

import type { ControllerRouter } from 'types/controller.js';
import type { UserEntity } from 'types/user.js';
import type {
  CheckoutSessionReadResponseDto,
  GetCheckoutSessionByIdParamsDto,
  GetCheckoutSessionByIdDto,
  HandleStripeWebhookDto,
  StripeWebhookResponseDto,
} from 'types/dto/payments.dto.ts';

const getCheckoutSessionById: ControllerRouter<
  GetCheckoutSessionByIdParamsDto,
  {},
  {},
  CheckoutSessionReadResponseDto
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

  const result = await getStripeCheckoutSession(args);

  return reply.code(200).send(result);
};

const postWebhook: ControllerRouter<{}, {}, {}, StripeWebhookResponseDto> = async (req, reply) => {
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

  const result = await handleStripeWebhook(args, req.log);

  return reply.code(200).send(result);
};

export const stripeController = {
  getCheckoutSessionById,
  postWebhook,
};
