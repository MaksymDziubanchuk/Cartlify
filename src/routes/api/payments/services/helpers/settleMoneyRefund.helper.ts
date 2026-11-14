import { Prisma } from '@prisma/client';

import { tx } from '@db/client.js';
import { setAdminContext, setUserContext } from '@db/dbContext.service.js';
import {
  sendReturnMoneyEmail,
  sendReturnRefundFailedEmail,
  sendReturnReimbursedEmail,
} from '@routes/api/returns/services/helpers/returnMoneyMail.helper.js';

import { paymentProviders } from '../../providers/index.js';
import { readLatePayment } from './latePayments.helper.js';
import {
  sendCompensationSentEmail,
  sendPaymentRefundedEmail,
  sendPaymentRefundFailedEmail,
  type PaymentRefundMailLogger,
} from './paymentRefundMails.helper.js';

import type { RefundAnswer, RefundFailure } from '../../providers/types.js';
import type { UserId } from 'types/ids.js';
import type { Role } from 'types/user.js';

// who settles a refund: the admin or root whose request it is, or the system (the webhook, the
// worker, a refund the system started) when the provider tells the end later
export type MoneyActor = { id: UserId; role: Role } | null;

// what settle_money_refund (db/05) says it did; changed is false when nothing was settled, and the
// refund is none of the app's when the answer names no purpose (no line has the key or the id)
export type SettledMoneyRefund = {
  changed: boolean;
  status: RefundAnswer['status'];
  purpose?: 'return' | 'late_payment' | 'hand' | 'compensation';
  orderId?: number | null;
  returnId?: number | null;
  userId?: number | null;
  paymentId?: string;
  transferKey?: string | null;
  // the sum of the refund, digits with two decimals
  amount?: string;
  // the money had been sent and the bank of the buyer sent it back
  sentBack?: boolean;
  // the rows of a statement that became refunded, or failed
  itemIds?: number[];
  // the lines of the refund in the journal
  lineIds?: number[];
};

// the failures the buyer is not told of: the money of the payment went back already another way,
// or the bank settles a dispute of it
const UNTOLD_FAILURES: ReadonlySet<RefundFailure> = new Set(['already_refunded', 'disputed']);

const failureOf = (answer: RefundAnswer): RefundFailure | null =>
  answer.status === 'failed' ? (answer.failure ?? 'unknown') : null;

// Settles a refund of the app by what the provider answered: the one end of every refund, of a
// statement or of a late payment (settle_money_refund, db/05). The key of our request finds its
// lines, the id of the provider when there is no key. Its state changes once in the journal, the
// buyer is mailed once after the commit: the money is sent, or it failed (a reason that is the
// buyer's to know). Repeating it changes nothing and mails nothing, so the answer to the request,
// the webhook and the worker may all meet
export async function settleMoneyRefund(
  args: { key: string | null; answer: RefundAnswer; actor?: MoneyActor; byDashboard?: boolean },
  log: PaymentRefundMailLogger,
): Promise<SettledMoneyRefund> {
  const { answer } = args;

  const settled = await tx(
    async (db) => {
      if (args.actor) await setUserContext(db, { userId: args.actor.id, role: args.actor.role });
      else await setAdminContext(db);
      await db.$executeRawUnsafe(`SET LOCAL lock_timeout = '1500ms'`);

      const [row] = await db.$queryRaw<{ settled: SettledMoneyRefund }[]>(Prisma.sql`
        select cartlify.settle_money_refund(
          ${args.key}::text,
          ${answer.refundId}::text,
          ${answer.status}::text,
          ${failureOf(answer)}::cartlify."RefundFailure",
          ${answer.status === 'failed' ? (answer.failureText ?? null) : null}::text,
          ${args.byDashboard ?? false}::boolean
        ) as settled
      `);

      return row!.settled;
    },
    {
      maxRetries: 3,
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      maxWait: 1500,
      timeout: 10_000,
    },
  );

  if (settled.changed) await mailSettled(settled, answer, log);

  return settled;
}

// the mail of a change, after its commit: a statement is told its money is back, or that the card
// cannot take it; the buyer of a late payment that the money is sent, or that it failed; the buyer
// of a compensation that it is sent (its failure is not mailed: root sends it another way)
async function mailSettled(
  settled: SettledMoneyRefund,
  answer: RefundAnswer,
  log: PaymentRefundMailLogger,
): Promise<void> {
  // the way back left alone went by a transfer of its own: no row to tell of, the mail of the way back
  if (settled.purpose === 'return' && settled.returnId && !settled.itemIds?.length) {
    if (settled.status === 'succeeded' && settled.transferKey) {
      await sendReturnReimbursedEmail(settled.returnId, log, settled.transferKey);
    }
    return;
  }

  if (settled.purpose === 'return' && settled.returnId && settled.itemIds?.length) {
    if (settled.status === 'succeeded') {
      await sendReturnMoneyEmail(settled.returnId, settled.itemIds, log);
    } else if (settled.status === 'failed' && failureOf(answer) === 'card_unavailable') {
      await sendReturnRefundFailedEmail(
        settled.returnId,
        settled.itemIds,
        log,
        settled.sentBack === true,
      );
    }
    return;
  }

  if (settled.purpose === 'compensation') {
    if (settled.status === 'succeeded' && settled.orderId && settled.userId && settled.amount) {
      await sendCompensationSentEmail(
        {
          orderId: settled.orderId,
          userId: settled.userId,
          amount: settled.amount,
          currency: paymentProviders[0]!.currency,
        },
        log,
      );
    }
    return;
  }

  if (settled.purpose !== 'late_payment' || !settled.paymentId || !settled.amount) return;

  if (settled.status === 'succeeded') {
    await mailLateRefundSent(settled.paymentId, settled.amount, log);
  } else if (settled.status === 'failed' && !UNTOLD_FAILURES.has(failureOf(answer)!)) {
    await mailLateRefundFailed(
      settled.paymentId,
      settled.amount,
      failureOf(answer)!,
      settled.sentBack === true,
      log,
    );
  }
}

// the buyer of a late payment and what the mails tell; none for a buyer the journal cannot name
async function latePaymentOf(paymentId: string) {
  const late = await tx(async (db) => {
    await setAdminContext(db);
    return readLatePayment(db, paymentId);
  });

  return late && late.orderId !== null && late.userId !== null && late.currency
    ? { ...late, orderId: late.orderId, userId: late.userId, currency: late.currency }
    : null;
}

// the money of a late payment is sent (amount, what this refund sent): the return page of the
// provider said paid, without the mail the buyer waits for an order that never comes
export async function mailLateRefundSent(
  paymentId: string,
  amount: string,
  log: PaymentRefundMailLogger,
): Promise<void> {
  const late = await latePaymentOf(paymentId);
  if (!late) return;

  await sendPaymentRefundedEmail(
    {
      orderId: late.orderId,
      userId: late.userId,
      amount,
      currency: late.currency,
      reason: late.reason,
    },
    log,
  );
}

// the refund of a late payment failed, also after its money was sent: the shop writes about another
// way
async function mailLateRefundFailed(
  paymentId: string,
  amount: string,
  failure: RefundFailure,
  sentBack: boolean,
  log: PaymentRefundMailLogger,
): Promise<void> {
  const late = await latePaymentOf(paymentId);
  if (!late) return;

  await sendPaymentRefundFailedEmail(
    {
      orderId: late.orderId,
      userId: late.userId,
      amount,
      currency: late.currency,
      failure,
      sentBack,
    },
    log,
  );
}
