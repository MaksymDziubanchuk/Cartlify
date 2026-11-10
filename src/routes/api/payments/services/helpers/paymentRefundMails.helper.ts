import env from '@config/env.js';
import { shopSettings } from '@config/shopSettings.js';
import { prisma } from '@db/client.js';
import { setAdminContext } from '@db/dbContext.service.js';
import { mailLocaleOf } from '@helpers/locale.js';
import { webPageUrl } from '@helpers/webOrigin.js';
import { buildOrderPaymentRefundedTemplate } from '@services/email/templates/orders/orderPaymentRefunded.template.js';
import { buildOrderPaymentRefundFailedTemplate } from '@services/email/templates/orders/orderPaymentRefundFailed.template.js';
import { buildOrderPaymentRefundOutsideTemplate } from '@services/email/templates/orders/orderPaymentRefundOutside.template.js';
import { sendEmail } from '@routes/api/auth/services/helpers/sendEmail.helper.js';

import type { RefundFailure } from '../../providers/types.js';
import type { PayOrderRefundReason } from './orderPaymentTx.helper.js';

// The mails of the refund of a payment the order could not take, to the buyer: the money is sent,
// the refund failed, root sent the money another way. The state is kept before each of them goes,
// so a mail that fails is only logged, with the order id and not the address. A deleted account
// gets none: its address is not the person's any more

export type PaymentRefundMailLogger = {
  error: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
};

type PaymentRefundMailArgs = {
  orderId: number;
  // the buyer the refund is recorded for: the owner of the order, or the one of the payment page
  // when the order is gone
  userId: number;
  amount: string;
  currency: string;
};

// frontend page of an order (WEB_PAGE_ORDER)
const orderPage = (orderId: number) => webPageUrl(env.WEB_PAGE_ORDER, { id: orderId });

// the buyer to write to, none when the account is gone
async function buyerOf(userId: number) {
  const user = await prisma.$transaction(async (tx) => {
    await setAdminContext(tx);
    return tx.user.findUnique({
      where: { id: userId },
      select: { email: true, name: true, locale: true, deletedAt: true },
    });
  });

  return user && !user.deletedAt ? user : null;
}

// what the three mails have in common: the shop, the order, the language of the buyer
const common = (
  args: PaymentRefundMailArgs,
  user: { name: string | null; locale: string | null },
) => ({
  // the name of the shop the mail is from
  appName: shopSettings().shopName,
  orderId: args.orderId,
  orderUrl: orderPage(args.orderId),
  amount: args.amount,
  currency: args.currency,
  ...(user.name ? { userName: user.name } : {}),
  logoUrl: shopSettings().logoUrl,
  locale: mailLocaleOf(user.locale),
});

// the money of the payment is sent: the return page of the provider said paid, without the mail the
// buyer waits for an order that never comes
export async function sendPaymentRefundedEmail(
  args: PaymentRefundMailArgs & { reason: PayOrderRefundReason },
  log: PaymentRefundMailLogger,
): Promise<void> {
  try {
    const user = await buyerOf(args.userId);
    if (!user) return;

    const { subject, text, html } = buildOrderPaymentRefundedTemplate({
      ...common(args, user),
      reason: args.reason,
    });

    await sendEmail({ to: user.email, subject, text, html });
  } catch (err) {
    log.error({ err, orderId: args.orderId }, 'payment refunded mail was not sent');
  }
}

// the refund failed, also after the money was sent: the shop writes about another way
export async function sendPaymentRefundFailedEmail(
  args: PaymentRefundMailArgs & { failure: RefundFailure; sentBack: boolean },
  log: PaymentRefundMailLogger,
): Promise<void> {
  try {
    const user = await buyerOf(args.userId);
    if (!user) return;

    const { subject, text, html } = buildOrderPaymentRefundFailedTemplate({
      ...common(args, user),
      failure: args.failure,
      sentBack: args.sentBack,
      supportEmail: shopSettings().emailReplyTo,
    });

    await sendEmail({ to: user.email, subject, text, html });
  } catch (err) {
    log.error({ err, orderId: args.orderId }, 'payment refund failed mail was not sent');
  }
}

// root sent the money another way, on the day it really went
export async function sendPaymentRefundOutsideEmail(
  args: PaymentRefundMailArgs & { method: string; sentOn: Date },
  log: PaymentRefundMailLogger,
): Promise<void> {
  try {
    const user = await buyerOf(args.userId);
    if (!user) return;

    const { subject, text, html } = buildOrderPaymentRefundOutsideTemplate({
      ...common(args, user),
      method: args.method,
      sentOn: args.sentOn,
      timeZone: env.SHOP_TIME_ZONE,
      supportEmail: shopSettings().emailReplyTo,
    });

    await sendEmail({ to: user.email, subject, text, html });
  } catch (err) {
    log.error({ err, orderId: args.orderId }, 'payment refund outside mail was not sent');
  }
}
