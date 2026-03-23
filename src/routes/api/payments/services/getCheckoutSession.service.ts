import { prisma } from '@db/client.js';
import stripe from '@config/stripe.js';

import { setUserContext } from '@db/dbContext.service.js';
import { ForbiddenError, InternalError, NotFoundError, isAppError } from '@utils/errors.js';

import {
  getOrderIdFromCheckoutSession,
  mapCreatedCheckoutSession,
} from './helpers/checkoutSession.helper.js';

import type {
  GetCheckoutSessionByIdDto,
  CheckoutSessionResponseDto,
} from 'types/dto/payments.dto.js';

export async function getCheckoutSessionById({
  actorId,
  actorRole,
  sessionId,
}: GetCheckoutSessionByIdDto): Promise<CheckoutSessionResponseDto> {
  // enforce user-only checkout read
  if (actorRole !== 'USER') throw new ForbiddenError('FORBIDDEN_ROLE');

  try {
    // load checkout session from stripe
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    // get linked order id from session metadata
    const orderId = getOrderIdFromCheckoutSession(session);

    const order = await prisma.$transaction(async (db) => {
      // set rls session context
      await setUserContext(db, { userId: actorId, role: actorRole });

      // ensure current user can access linked order
      return db.order.findUnique({
        where: { id: orderId },
        select: {
          id: true,
        },
      });
    });

    if (!order) {
      throw new NotFoundError('ORDER_NOT_FOUND', { orderId });
    }

    // map stripe session into api dto
    return mapCreatedCheckoutSession(session, orderId);
  } catch (err) {
    // preserve known app errors
    if (isAppError(err)) throw err;

    throw new InternalError({ reason: 'PAYMENTS_GET_CHECKOUT_SESSION_BY_ID_UNEXPECTED' }, err);
  }
}
