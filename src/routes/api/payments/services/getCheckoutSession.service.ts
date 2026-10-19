import { prisma } from '@db/client.js';
import stripe from '@config/stripe.js';

import { setUserContext } from '@db/dbContext.service.js';
import {
  ForbiddenError,
  InternalError,
  NotFoundError,
  ServiceUnavailableError,
  isAppError,
} from '@utils/errors.js';

import {
  getOrderIdFromCheckoutSession,
  isOrderCheckoutSession,
  isStripeResourceMissing,
  isStripeUnavailable,
  mapCreatedCheckoutSession,
} from './helpers/checkoutSession.helper.js';

import type Stripe from 'stripe';
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
    let session: Stripe.Checkout.Session;

    try {
      session = await stripe.checkout.sessions.retrieve(sessionId);
    } catch (err) {
      // the page asks the buyer to look again a bit later
      if (isStripeUnavailable(err)) {
        throw new ServiceUnavailableError('PAYMENT_PROVIDER_UNAVAILABLE', undefined, err);
      }

      // the id came from the browser: one stripe never made is no session of an order
      if (isStripeResourceMissing(err)) {
        throw new NotFoundError('CHECKOUT_SESSION_NOT_FOUND', undefined, err);
      }

      throw err;
    }

    // a session of another tool in the same stripe account is no session of an order either
    if (!isOrderCheckoutSession(session)) {
      throw new NotFoundError('CHECKOUT_SESSION_NOT_FOUND');
    }

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
          reservationExpiresAt: true,
        },
      });
    });

    if (!order) {
      throw new NotFoundError('ORDER_NOT_FOUND', { orderId });
    }

    // map stripe session into api dto
    // reservation time is empty once the order is paid or unconfirmed, stripe own expiry is used then
    return mapCreatedCheckoutSession(session, orderId, order.reservationExpiresAt);
  } catch (err) {
    // preserve known app errors
    if (isAppError(err)) throw err;

    throw new InternalError({ reason: 'PAYMENTS_GET_CHECKOUT_SESSION_BY_ID_UNEXPECTED' }, err);
  }
}
