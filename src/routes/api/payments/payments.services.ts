import { createCheckoutSession } from './services/createCheckout.service.js';
import { giveCompensation } from './services/giveCompensation.service.js';
import { getDispute, listDisputes } from './services/listDisputes.service.js';
import { listPaymentRefunds } from './services/listPaymentRefunds.service.js';
import { markPaymentRefundOutside } from './services/markPaymentRefundOutside.service.js';
import { decideMoneyUse } from './services/moneyDecision.service.js';

export const paymentsServices = {
  createCheckoutSession,
  listPaymentRefunds,
  markPaymentRefundOutside,
  decideMoneyUse,
  giveCompensation,
  listDisputes,
  getDispute,
};
