import { Prisma } from '@prisma/client';

import { tx } from '@db/client.js';
import { setAdminContext } from '@db/dbContext.service.js';
import { failureOf } from '@helpers/failureOf.js';

import { getPaymentProvider } from '../../providers/index.js';
import { centsOfAmount, lateRefundKeyOf } from './lateRefundKey.helper.js';
import { paidLeftOf } from './latePayments.helper.js';
import { mailLateRefundSent, settleMoneyRefund } from './settleMoneyRefund.helper.js';

import type { PaymentProviderName, PaymentRefund, RefundAnswer } from '../../providers/types.js';
import type { PaymentRefundMailLogger } from './paymentRefundMails.helper.js';
import type { PayOrderRefundReason } from './orderPaymentTx.helper.js';

// The refund of a payment the order could not take, in the money journal (db/05): the late payment
// and the line of its refund in transit are written first, in one transaction, under the key of the
// request (refund:<payment>); the provider is asked outside any transaction with that key; its answer
// settles the line (settle_money_refund). A provider that does not answer leaves the line in transit
// for the worker (moneyRefund.worker.ts), never an error answer of the event: asking again is the
// worker's, with the same key. Money given back by hand in the dashboard meanwhile is not sent twice

type RefundLatePaymentArgs = {
  // who took the money and the id of the payment there
  provider: PaymentProviderName;
  paymentId: string;
  orderId: number;
  // the owner of the order from the payment page, for an order that is gone
  fallbackUserId: number | null;
  reason: PayOrderRefundReason;
  // digits with two decimals, and the currency of the payment
  amount: string;
  currency: string;
};

// a refund of a late payment in transit: what the line of it holds
export type LateRefundInTransit = {
  provider: PaymentProviderName;
  paymentId: string;
  orderId: number | null;
  currency: string | null;
  // our key of the request, and the sum of it (digits with two decimals)
  key: string;
  amount: string;
};

type BegunRefund = { id: number; created: boolean; state: string; amount: string };

const TX_OPTIONS = {
  maxRetries: 3,
  isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
  maxWait: 1500,
  timeout: 10_000,
};

// the line of a refund of the payment in transit, under a key (begin_payment_refund: the same key
// answers the line that is there)
const beginRefundSql = (paymentId: string, key: string, amount: string, currency: string | null) =>
  Prisma.sql`
    select cartlify.begin_payment_refund(
      ${paymentId}::text, ${key}::text, ${amount}::numeric, ${currency}::text
    ) as begun
  `;

// return money for a payment that the order could not take: it is recorded as late, the refund of
// all of it goes out in transit and the provider is asked; the buyer is mailed once the money is
// sent, or once it failed (settleMoneyRefund)
export async function refundLatePayment(
  args: RefundLatePaymentArgs,
  log: PaymentRefundMailLogger,
): Promise<void> {
  const key = lateRefundKeyOf(args.paymentId);

  // two deliveries of the event at the same time wait for each other at the lock of the payment
  // (db/05): the second finds the lines of the first
  const begun = await tx(async (db) => {
    await setAdminContext(db);
    await db.$executeRawUnsafe(`SET LOCAL lock_timeout = '1500ms'`);

    await db.$queryRaw(Prisma.sql`
      select cartlify.record_late_payment(
        ${args.provider}::cartlify."PaymentProvider",
        ${args.paymentId}::text,
        ${args.orderId}::int,
        ${args.fallbackUserId}::int,
        ${args.amount}::numeric,
        ${args.currency}::text,
        ${args.reason}::text
      ) as late
    `);

    const [row] = await db.$queryRaw<{ begun: BegunRefund }[]>(
      beginRefundSql(args.paymentId, key, args.amount, args.currency),
    );
    return row!.begun;
  }, TX_OPTIONS);

  // the money of it is sent already: nothing to ask
  if (begun.state === 'sent') return;

  const refund: LateRefundInTransit = {
    provider: args.provider,
    paymentId: args.paymentId,
    orderId: args.orderId,
    currency: args.currency,
    key,
    amount: begun.amount,
  };

  await askLateRefund(refund, log);
}

// asks the provider for the refund of the line, with its key and sum, and settles the line by the
// answer
async function askLateRefund(
  refund: LateRefundInTransit,
  log: PaymentRefundMailLogger,
  again = false,
): Promise<void> {
  const answer = await getPaymentProvider(refund.provider).refundPayment({
    orderId: refund.orderId ?? 0,
    paymentId: refund.paymentId,
    amount: refund.amount,
    key: refund.key,
  });

  await answerLateRefund(refund, answer, log, again);
}

// the answer of the provider to the request of a refund of a late payment, or what the worker found
// of it: silence leaves the line in transit; a refusal because the money went back already looks for
// the refunds made by hand (settleGivenBack); any other answer settles the line. Whether the journal
// changed
export async function answerLateRefund(
  refund: LateRefundInTransit,
  answer: RefundAnswer,
  log: PaymentRefundMailLogger,
  again = false,
): Promise<boolean> {
  if (answer.status === 'pending' && answer.refundId === null) return false;

  if (answer.status === 'failed' && answer.failure === 'already_refunded') {
    return settleGivenBack(refund, answer, log, again);
  }

  return (await settleMoneyRefund({ key: refund.key, answer }, log)).changed;
}

// The provider says the money of the payment went back already: somebody gave it back by hand in the
// dashboard while the app asked. The refunds made by hand are written first, each once
// (record_hand_refund); one of all the sum of the line, with no id yet, is the refund of the line
// (it takes its id and the mark of the dashboard), and the buyer is told when its money is sent.
// Otherwise the money that went back is counted by the lines made by hand, the request fails as
// given back already (its sum comes back to the shop in the journal), and what is left of the
// payment is sent under a key of its own, once
async function settleGivenBack(
  refund: LateRefundInTransit,
  answer: RefundAnswer,
  log: PaymentRefundMailLogger,
  again: boolean,
): Promise<boolean> {
  const provider = getPaymentProvider(refund.provider);

  let listed: PaymentRefund[];
  try {
    listed = await provider.listRefunds(refund.paymentId);
  } catch (err) {
    // the line stays in transit: the worker asks again
    log.warn(
      { ...failureOf(err), paymentId: refund.paymentId },
      'the refunds of a late payment were not read',
    );
    return false;
  }

  // a refund of this very request is there after all
  const own = listed.find((one) => one.transferKey === refund.key);
  if (own) return (await settleMoneyRefund({ key: refund.key, answer: own }, log)).changed;

  const taken = await tx(async (db) => {
    await setAdminContext(db);
    await db.$executeRawUnsafe(`SET LOCAL lock_timeout = '1500ms'`);

    let attached: { state: string } | null = null;
    for (const hand of listed.filter((one) => one.transferKey === null)) {
      const [row] = await db.$queryRaw<{ recorded: { attached: boolean; state: string } }[]>(
        Prisma.sql`
          select cartlify.record_hand_refund(
            ${refund.provider}::cartlify."PaymentProvider",
            ${refund.paymentId}::text,
            ${hand.refundId}::text,
            ${hand.amount}::numeric,
            ${hand.status}::text,
            ${refund.currency}::text
          ) as recorded
        `,
      );
      if (row?.recorded.attached) attached = row.recorded;
    }

    const [line] = await db.$queryRaw<{ refundId: string | null }[]>(Prisma.sql`
      select l."refundId" as "refundId"
      from cartlify.money_log as l
      where l.event = 'money.refund' and l."transferKey" = ${refund.key}
      order by l.id
      limit 1
    `);

    return { attached, owned: line?.refundId != null };
  }, TX_OPTIONS);

  // a refund made by hand took the line over: its money is the money of the line
  if (taken.owned) {
    if (taken.attached?.state === 'sent') {
      await mailLateRefundSent(refund.paymentId, refund.amount, log);
    }
    return taken.attached !== null;
  }

  await settleMoneyRefund({ key: refund.key, answer }, log);

  // what is left is sent once: a second refusal of it is for a person to look at
  if (again) {
    log.warn(
      { paymentId: refund.paymentId, key: refund.key },
      'what is left of a late payment was given back already',
    );
    return true;
  }

  await sendWhatIsLeft(refund, log);
  return true;
}

// what is left of a late payment after money of it went back another way (by hand in the dashboard
// of the provider, a dispute the bank decided for the buyer, a dispute the shop won after its refund
// failed for it) is sent under a key of its own, once (a second refusal of it is for a person to
// look at). Nothing is sent while nothing is left: a refund of the app still in transit counts as
// gone. Whether something was asked
export async function sendWhatIsLeft(
  late: Pick<LateRefundInTransit, 'provider' | 'paymentId' | 'orderId' | 'currency'>,
  log: PaymentRefundMailLogger,
): Promise<boolean> {
  const left = await tx(async (db) => {
    await setAdminContext(db);
    return paidLeftOf(db, late.paymentId);
  });
  const leftCents = centsOfAmount(left);
  if (leftCents <= 0) return false;

  const key = lateRefundKeyOf(late.paymentId, leftCents);
  const begun = await tx(async (db) => {
    await setAdminContext(db);
    await db.$executeRawUnsafe(`SET LOCAL lock_timeout = '1500ms'`);

    const [row] = await db.$queryRaw<{ begun: BegunRefund }[]>(
      beginRefundSql(late.paymentId, key, left, late.currency),
    );
    return row!.begun;
  }, TX_OPTIONS);

  // the same key answered a line that is there: it was asked before
  if (!begun.created || begun.state === 'sent') return false;

  await askLateRefund({ ...late, key, amount: begun.amount }, log, true);
  return true;
}
