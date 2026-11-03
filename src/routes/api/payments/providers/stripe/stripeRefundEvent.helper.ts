import { tx } from '@db/client.js';
import { setAdminContext } from '@db/dbContext.service.js';
import { settleReturnRefund } from '@routes/api/returns/services/helpers/returnRefund.helper.js';

import { refundAnswerOf } from './stripeRefund.helper.js';

import type Stripe from 'stripe';

type RefundEventLogger = {
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
};

// the key of our transfer is the uuid in the metadata of the refund (refund:<uuid>)
const TRANSFER = /^refund:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

// the transfer a refund belongs to: the key it carries, or, for a refund the app made before the
// key rode with it, the rows that kept its id. None for a refund that is not a transfer of a
// statement (a payment given back late, a refund made by hand at stripe)
async function transferKeyOf(refund: Stripe.Refund): Promise<string | null> {
  const carried = TRANSFER.exec(refund.metadata?.transfer ?? '');
  if (carried) return carried[1]!;

  return tx(async (db) => {
    await setAdminContext(db);

    const rows = await db.orderReturnItem.findMany({
      where: { refundId: refund.id, refundKey: { not: null } },
      select: { refundKey: true },
      take: 1,
    });

    return rows[0]?.refundKey ?? null;
  });
}

// stripe tells a refund ended or changed: the rows of the transfer are settled by it, once (a second
// delivery of the event, or the worker that got there first, changes nothing)
export async function settleStripeRefundEvent(
  refund: Stripe.Refund,
  log: RefundEventLogger,
): Promise<void> {
  const key = await transferKeyOf(refund);
  if (!key) return;

  await settleReturnRefund({ key, answer: refundAnswerOf(refund), actor: null, log });
}
