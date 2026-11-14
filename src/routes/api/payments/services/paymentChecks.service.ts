import { Prisma } from '@prisma/client';

import env from '@config/env.js';
import { shopSettings } from '@config/shopSettings.js';
import { tx } from '@db/client.js';
import { setAdminContext } from '@db/dbContext.service.js';
import { mailLocaleOf } from '@helpers/locale.js';
import { webPageUrl } from '@helpers/webOrigin.js';
import { sendEmail } from '@routes/api/auth/services/helpers/sendEmail.helper.js';
import { buildOrderPaymentCheckTemplate } from '@services/email/templates/orders/orderPaymentCheck.template.js';

import type { PaymentRefundMailLogger } from './helpers/paymentRefundMails.helper.js';

// The checks of a payment the provider asks the shop for:
// an early warning of fraud of the network
// of the card (radar.early_fraud_warning.*) and a review of the payment by the provider (review.*).
// The database holds an order not sent (hold_fraud_warning, hold_payment_review, db/05) and marks one
// already sent with the warning (for the alert of root); the review closed lets the order go
// (release_payment_review), a warning is root's to decide on (POST /api/orders/:orderId/holds/
// fraud_warning/decision). The buyer is mailed once, when the order is first held for a check:
// the money came and is checked once more before the order goes, without a word of fraud (a warning
// can be wrong)

// NOT_AN_ORDER - the payment is not the payment of an order of the shop
export type PaymentCheckSkip = 'NOT_AN_ORDER';

type Held = {
  found: boolean;
  orderId?: number;
  userId?: number;
  status?: string;
  added?: boolean;
  warned?: boolean;
  firstCheck?: boolean;
};

const TX_OPTIONS = {
  maxRetries: 3,
  isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
  maxWait: 1500,
  timeout: 10_000,
};

async function call(sql: Prisma.Sql): Promise<Held> {
  return tx(async (db) => {
    await setAdminContext(db);
    await db.$executeRawUnsafe(`SET LOCAL lock_timeout = '1500ms'`);
    const [row] = await db.$queryRaw<{ result: Held }[]>(sql);
    return row!.result;
  }, TX_OPTIONS);
}

// an early warning the shop can still act on (Stripe says actionable): an order not sent is held,
// one sent is marked; the buyer is told the payment is checked when it is the first check
export async function followFraudWarning(
  warning: { id: string; paymentId: string; actionable: boolean },
  log: PaymentRefundMailLogger,
): Promise<{ skipped?: PaymentCheckSkip }> {
  // the payment was refunded or disputed: nothing is left to act on
  if (!warning.actionable) return {};

  const held = await call(Prisma.sql`
    select cartlify.hold_fraud_warning(${warning.paymentId}::text, ${warning.id}::text) as result
  `);
  if (!held.found) return { skipped: 'NOT_AN_ORDER' };

  // root sees the order in the alerts fraud_warnings (held) or fraud_warnings_shipped (marked)
  if (held.firstCheck) await sendPaymentCheckEmail(held.orderId!, held.userId!, log);
  return {};
}

// a review of the provider opened (the order not sent is held until it closes) or closed
export async function followPaymentReview(
  review: { id: string; paymentId: string; open: boolean },
  log: PaymentRefundMailLogger,
): Promise<{ skipped?: PaymentCheckSkip }> {
  if (!review.open) {
    const released = await call(Prisma.sql`
      select cartlify.release_payment_review(${review.paymentId}::text, ${review.id}::text) as result
    `);
    return released.found ? {} : { skipped: 'NOT_AN_ORDER' };
  }

  const held = await call(Prisma.sql`
    select cartlify.hold_payment_review(${review.paymentId}::text, ${review.id}::text) as result
  `);
  if (!held.found) return { skipped: 'NOT_AN_ORDER' };

  // root sees the order held in the alert payment_reviews until the review closes
  if (held.firstCheck) await sendPaymentCheckEmail(held.orderId!, held.userId!, log);
  return {};
}

// the payment of the order is checked before it is sent; a deleted account gets no mail, a mail that
// fails is only logged
async function sendPaymentCheckEmail(
  orderId: number,
  userId: number,
  log: PaymentRefundMailLogger,
): Promise<void> {
  try {
    const user = await tx(async (db) => {
      await setAdminContext(db);
      return db.user.findUnique({
        where: { id: userId },
        select: { email: true, name: true, locale: true, deletedAt: true },
      });
    });
    if (!user || user.deletedAt) return;

    const { subject, text, html } = buildOrderPaymentCheckTemplate({
      appName: shopSettings().shopName,
      orderId,
      orderUrl: webPageUrl(env.WEB_PAGE_ORDER, { id: orderId }),
      ...(user.name ? { userName: user.name } : {}),
      logoUrl: shopSettings().logoUrl,
      supportEmail: shopSettings().emailReplyTo,
      locale: mailLocaleOf(user.locale),
    });

    await sendEmail({ to: user.email, subject, text, html });
  } catch (err) {
    log.error({ err, orderId }, 'payment check mail was not sent');
  }
}
