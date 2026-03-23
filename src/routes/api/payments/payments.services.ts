import { handleStripeWebhook } from './services/handleWebhook.service.js';

import { createCheckoutSession } from './services/createCheckout.service.js';

import { getCheckoutSessionById } from './services/getCheckoutSession.service.js';

export const paymentsServices = {
  createCheckoutSession,
  getCheckoutSessionById,
  handleStripeWebhook,
};
