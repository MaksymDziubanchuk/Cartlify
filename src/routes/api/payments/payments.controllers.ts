import type { ControllerRouter } from 'types/controller.js';
import type { UserEntity } from 'types/user.js';
import type {
  CreateCheckoutSessionBodyDto,
  CreateCheckoutSessionDto,
  CheckoutSessionResponseDto,
} from 'types/dto/payments.dto.ts';

import pickDefined from '@helpers/parameterNormalize.js';
import { paymentsServices } from './payments.services.js';

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

export const paymentsController = {
  postCheckoutSession,
};
