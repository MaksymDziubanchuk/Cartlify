import env from '@config/env.js';
import { shopSettings } from '@config/shopSettings.js';
import { prisma } from '@db/client.js';
import { setAdminContext } from '@db/dbContext.service.js';
import { mailLocaleOf } from '@helpers/locale.js';
import { webPageUrl } from '@helpers/webOrigin.js';
import { buildOrderPaymentRefundedTemplate } from '@services/email/templates/orders/orderPaymentRefunded.template.js';
import { sendEmail } from '@routes/api/auth/services/helpers/sendEmail.helper.js';

import type { PayOrderRefundReason } from './orderPaymentTx.helper.js';

export type PaymentRefundedMailLogger = {
  error: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
};

type SendPaymentRefundedEmailArgs = {
  orderId: number;
  // the buyer the refund is recorded for: the owner of the order, or the one of the payment page
  // when the order is gone
  userId: number;
  amount: string;
  currency: string;
  reason: PayOrderRefundReason;
};

// frontend page of an order (WEB_PAGE_ORDER)
const orderPage = (orderId: number) => webPageUrl(env.WEB_PAGE_ORDER, { id: orderId });

// mails the buyer that a payment the order could not take went back: the return page of the
// provider says paid, without the mail the buyer waits for an order that never comes. The refund
// is done before this runs, so a mail that fails is only logged, with the order id and not the
// address. A deleted account gets no mail: its address is not the person's any more
export async function sendPaymentRefundedEmail(
  args: SendPaymentRefundedEmailArgs,
  log: PaymentRefundedMailLogger,
): Promise<void> {
  try {
    const user = await prisma.$transaction(async (tx) => {
      await setAdminContext(tx);
      return tx.user.findUnique({
        where: { id: args.userId },
        select: { email: true, name: true, locale: true, deletedAt: true },
      });
    });

    if (!user || user.deletedAt) return;

    const { subject, text, html } = buildOrderPaymentRefundedTemplate({
      // the name of the shop the mail is from
      appName: shopSettings().shopName,
      orderId: args.orderId,
      orderUrl: orderPage(args.orderId),
      amount: args.amount,
      currency: args.currency,
      reason: args.reason,
      ...(user.name ? { userName: user.name } : {}),
      logoUrl: shopSettings().logoUrl,
      locale: mailLocaleOf(user.locale),
    });

    await sendEmail({
      to: user.email,
      subject,
      text,
      html,
    });
  } catch (err) {
    log.error({ err, orderId: args.orderId }, 'payment refunded mail was not sent');
  }
}
