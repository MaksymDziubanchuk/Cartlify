import { Prisma } from '@prisma/client';

import { tx } from '@db/client.js';
import { setAdminContext } from '@db/dbContext.service.js';
import { settleHandRefund } from '@routes/api/payments/services/helpers/handRefunds.helper.js';
import { settleMoneyRefund } from '@routes/api/payments/services/helpers/settleMoneyRefund.helper.js';

import { amountOfCents } from './stripeCheckout.helper.js';
import { refundAnswerOf } from './stripeRefund.helper.js';

import type Stripe from 'stripe';
import type { PaymentRefundMailLogger } from '@routes/api/payments/services/helpers/paymentRefundMails.helper.js';

// why a refund event was taken without anything done:
// UNKNOWN_REFUND - the key has the form of the app, but no refund of the app has it or the id
// NOT_AN_ORDER - a refund made by hand of a payment that is none of the shop's (another tool in the
//   same account)
export type RefundEventSkip = 'UNKNOWN_REFUND' | 'NOT_AN_ORDER';

// Stripe tells a refund was made, changed or ended (refund.created, .updated, .failed). A refund of
// the app carries the key of its request in the metadata (metadata.transfer): the lines of the key
// are settled by the state of the refund (settleMoneyRefund: the id is kept, the money is sent, or
// it failed), once, whatever the order of the events and the number of their deliveries. A refund
// made by hand in the dashboard carries none: it is a line of its own with what it means for its
// payment (settleHandRefund). Either way the number the bank of the card gives the refund, some days
// after the money is sent, is kept on its lines once
export async function settleStripeRefundEvent(
  refund: Stripe.Refund,
  log: PaymentRefundMailLogger,
): Promise<{ skipped?: RefundEventSkip }> {
  const key = refund.metadata?.transfer || null;
  const answer = refundAnswerOf(refund);

  if (key) {
    const settled = await settleMoneyRefund({ key, answer }, log);
    if (settled.purpose === undefined) return { skipped: 'UNKNOWN_REFUND' };
  } else {
    const payment = refund.payment_intent;
    const settled = await settleHandRefund(
      {
        provider: 'stripe',
        refundId: refund.id,
        paymentId: typeof payment === 'string' ? payment : (payment?.id ?? null),
        amount: amountOfCents(refund.amount),
        currency: refund.currency,
        answer,
      },
      log,
    );
    if (settled.skipped) return { skipped: settled.skipped };
  }

  if (answer.bankReference) await keepBankReference(refund.id, answer.bankReference);
  return {};
}

// the number of the bank goes on every line of the refund that has none yet; a second number
// changes nothing (record_refund_bank_reference, db/05)
async function keepBankReference(refundId: string, reference: string): Promise<void> {
  await tx(async (db) => {
    await setAdminContext(db);
    await db.$queryRaw(Prisma.sql`
      select cartlify.record_refund_bank_reference(
        ${refundId}::text, ${reference.slice(0, 100)}::text
      ) as kept
    `);
  });
}
