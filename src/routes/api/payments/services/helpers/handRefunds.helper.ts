import { Prisma } from '@prisma/client';

import { tx } from '@db/client.js';
import { setAdminContext } from '@db/dbContext.service.js';
import { failureOf } from '@helpers/failureOf.js';
import { sendReturnMoneyEmail } from '@routes/api/returns/services/helpers/returnMoneyMail.helper.js';
import {
  beginReturnTransfer,
  finishReturnTransfer,
} from '@routes/api/returns/services/refundReturn.service.js';

import { getPaymentProvider } from '../../providers/index.js';
import { readLatePayment } from './latePayments.helper.js';
import { sendWhatIsLeft } from './orderPaymentRefund.helper.js';
import {
  sendPaymentRefundFailedEmail,
  type PaymentRefundMailLogger,
} from './paymentRefundMails.helper.js';
import { mailLateRefundSent, settleMoneyRefund } from './settleMoneyRefund.helper.js';
import { cancelBySystem } from './systemCancel.helper.js';

import type { PaymentProviderName, RefundAnswer, RefundFailure } from '../../providers/types.js';
import type { StartedRefund } from '@routes/api/returns/services/helpers/returnRefund.helper.js';

// The refunds made by hand in the dashboard of the provider. The provider tells of one with the
// events of a refund that carry no key of the app; each is one line of the money journal
// (record_hand_refund, db/05), and what it means comes from the payment it gave back:
// A - a payment the order could not take: the line of our refund in transit of the same sum takes
//     it (the buyer is told when the money is sent); else it is a line of its own and the app sends
//     what is left of the payment itself;
// B - an order not sent without a statement, all of its payment back by hand: the system cancels
//     the order by a statement of its own (stripe_refund) and shares every such refund among the
//     items and the delivery (share_money_line), which pays the rows of the statement at once with
//     nothing asked of the provider; the buyer is mailed that the order is cancelled and the money
//     sent;
// V - an order not sent, part of it back: the order stays held (the database holds it with the
//     line) until root decides (POST /api/orders/:orderId/holds/hand_refund/decision);
// G - a statement of the order is open: nothing is decided by itself, the transfers of the order
//     wait (RETURN_HAND_REFUND_PENDING) until root says what the refund was for (the decision,
//     decide_money_use: the items and the delivery it gave back, the rest a compensation);
// D - an order sent, delivered or cancelled with no statement open: root says what it was for.
// All of the payment back by hand with no other money of the buyer before it is shared among the
// items and the delivery by the system, whatever the order is: an order not sent with nothing open is cancelled with it (B); in G and D the
// rows of the open statements it pays get their money at once and their buyer is mailed.
// The later events of the refund settle its line as the events of a refund of the app do
// (settle_money_refund by the id of the refund); a failure of it is told to the buyer when the buyer
// was told the money is sent (A, B, the cancel root decided); every failure is in the alert
// hand_refunds_failed until root sends the money another way.

// a refund the provider tells of without the key of the app, as the event gives it
export type HandRefund = {
  provider: PaymentProviderName;
  refundId: string;
  // the payment it gave money of; none for a charge without one (not a payment of the app)
  paymentId: string | null;
  // digits with two decimals, and the currency of the payment
  amount: string;
  currency: string;
  // where it stands, as the event says
  answer: RefundAnswer;
};

// NOT_AN_ORDER - the payment is none of the shop's: no order has it and the order of no late payment
export type HandRefundSkip = 'NOT_AN_ORDER';

// what record_hand_refund (db/05) answers
type Recorded = {
  id?: number;
  created: boolean;
  attached: boolean;
  ignored: boolean;
  state?: 'in_transit' | 'sent';
  late?: boolean;
  orderId?: number | null;
  orderStatus?: string | null;
  orderTotal?: string | null;
  userId?: number | null;
  left?: string;
  openReturns?: number;
  // all of the payment with no other money between the shop and the buyer before it
  // (money_line_is_whole, db/05): the system shares it by itself
  whole?: boolean;
};

// the failures the buyer is not told of: the money went back another way already, or the bank
// settles a dispute of the payment
const UNTOLD_FAILURES: ReadonlySet<RefundFailure> = new Set(['already_refunded', 'disputed']);

const TX_OPTIONS = {
  maxRetries: 3,
  isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
  maxWait: 1500,
  timeout: 10_000,
};

// the line of a refund of the provider in the money journal, and whether the payment is the shop's
async function knownOf(refund: HandRefund) {
  return tx(async (db) => {
    await setAdminContext(db);

    const [line] = await db.$queryRaw<{ id: number }[]>(Prisma.sql`
      select l.id from cartlify.money_log as l
      where l.event = 'money.refund' and l."refundId" = ${refund.refundId}
      order by l.id
      limit 1
    `);
    if (line || !refund.paymentId) return { line: line ?? null, ours: line !== undefined };

    const order = await db.order.findFirst({
      where: { paymentId: refund.paymentId },
      select: { id: true },
    });
    const late = order ? null : await readLatePayment(db, refund.paymentId);

    return { line: null, ours: order !== null || late !== null };
  }, TX_OPTIONS);
}

// Takes a refund the provider tells of without the key of the app: a later event of one the journal
// has settles its line, a new one is written and means what its situation says. Repeating it changes
// nothing: the line is there, the cancel is made once (the order is no longer paid)
export async function settleHandRefund(
  refund: HandRefund,
  log: PaymentRefundMailLogger,
): Promise<{ skipped?: HandRefundSkip }> {
  const known = await knownOf(refund);
  if (!known.ours) return { skipped: 'NOT_AN_ORDER' };

  if (known.line) {
    await settleKnown(refund, log);
    return {};
  }

  await recordNew(refund, log);
  return {};
}

// a later event of a refund the journal has: its line is settled by the id; a failure is told to a
// buyer who was told the money went
async function settleKnown(refund: HandRefund, log: PaymentRefundMailLogger): Promise<void> {
  const settled = await settleMoneyRefund({ key: null, answer: refund.answer }, log);

  // a refund of the app the refund made by hand took the place of mails by itself (A)
  if (settled.purpose !== 'hand' || !settled.changed || settled.status !== 'failed') return;

  const failure = refund.answer.failure ?? 'unknown';
  if (UNTOLD_FAILURES.has(failure) || settled.orderId == null || settled.userId == null) return;

  // the buyer was not told the money went: the alert hand_refunds_failed tells root
  if (!(await toldSent(settled.paymentId!, settled.lineIds ?? []))) return;

  await sendPaymentRefundFailedEmail(
    {
      orderId: settled.orderId,
      userId: settled.userId,
      amount: settled.amount!,
      currency: refund.currency,
      failure,
      sentBack: settled.sentBack === true,
    },
    log,
  );
}

// the buyer was told the money of a refund made by hand is theirs: the refund of a late payment (the
// money of a payment the order never took), or money a statement took as what the buyer has back
// (its parts covered name the refund: the cancel of the system or of root, a decision of root that
// gave it to the goods), whose mail told the buyer the money is back
async function toldSent(paymentId: string, lineIds: number[]): Promise<boolean> {
  return tx(async (db) => {
    await setAdminContext(db);
    if (await readLatePayment(db, paymentId)) return true;
    if (lineIds.length === 0) return false;

    const used = await db.moneyLog.count({
      where: {
        part: 'covered',
        event: { not: 'money.refund_failed' },
        coversId: { in: lineIds },
        returnId: { not: null },
      },
    });
    return used > 0;
  }, TX_OPTIONS);
}

// a refund the journal does not have: its state is read from the provider (an event may come before
// an earlier one), it is written, and its situation follows
async function recordNew(refund: HandRefund, log: PaymentRefundMailLogger): Promise<void> {
  const now = await getPaymentProvider(refund.provider).getRefund(refund.refundId);

  const recorded = await tx(async (db) => {
    await setAdminContext(db);
    await db.$executeRawUnsafe(`SET LOCAL lock_timeout = '1500ms'`);

    const [row] = await db.$queryRaw<{ recorded: Recorded }[]>(Prisma.sql`
      select cartlify.record_hand_refund(
        ${refund.provider}::cartlify."PaymentProvider",
        ${refund.paymentId}::text,
        ${refund.refundId}::text,
        ${refund.amount}::numeric,
        ${now.status}::text,
        ${refund.currency}::text
      ) as recorded
    `);
    return row!.recorded;
  }, TX_OPTIONS);

  if (recorded.ignored) return;

  // A: the refund of the app in transit was this one: its money is the buyer's
  if (recorded.attached) {
    if (recorded.state === 'sent') await mailLateRefundSent(refund.paymentId!, refund.amount, log);
    return;
  }

  if (!recorded.created) return;

  // A: a part of a late payment, or money of it after a refund of the app failed: the app sends what
  // is left
  if (recorded.late) {
    const late = await tx(async (db) => {
      await setAdminContext(db);
      return readLatePayment(db, refund.paymentId!);
    });
    if (late) await sendWhatIsLeft(late, log);
    return;
  }

  // G and D: root says what the refund was for (the alert hand_refunds_to_explain), unless it is all
  // of the payment with nothing before it; V: the order stays held for root (hand_refunds_to_decide)
  if ((recorded.openReturns ?? 0) > 0 || recorded.orderStatus !== 'paid') {
    if (recorded.whole && recorded.id !== undefined) await shareWhole(recorded.id, log);
    return;
  }

  await cancelIfAllBack(refund.paymentId!, recorded.orderId!, log);
}

// all of the payment back by hand with no other money before it: the system shares it among the
// items and the delivery; the rows of the open statements it pays get their money at once, and their
// buyer is told after the commit. A refund that cannot be shared now stays for root
async function shareWhole(lineId: number, log: PaymentRefundMailLogger): Promise<void> {
  let covered: { returnId: number; itemIds: number[] }[];
  try {
    covered = await tx(async (db) => {
      await setAdminContext(db);
      await db.$executeRawUnsafe(`SET LOCAL lock_timeout = '1500ms'`);
      const [row] = await db.$queryRaw<
        { shared: { covered: { returnId: number; itemIds: number[] }[] } | null }[]
      >(Prisma.sql`select cartlify.share_money_line(${lineId}::int) as shared`);
      return row?.shared?.covered ?? [];
    }, TX_OPTIONS);
  } catch (err) {
    log.error(
      { ...failureOf(err), lineId },
      'the refund by hand of all of the payment was not shared',
    );
    return;
  }

  for (const one of covered) {
    await sendReturnMoneyEmail(one.returnId, one.itemIds, log);
  }
}

// B: the refunds made by hand of an order not sent, that nobody decided on, gave all of its payment
// back: the system cancels the order by a statement of its own and shares them among the items and
// the delivery, in one transaction; the shares pay the rows of the statement at once (the money
// went, nothing is asked of the provider), and the buyer is mailed that its rows are refunded. A row
// the shares do not cover goes by a transfer. Less than all of it holds the order for root (V)
async function cancelIfAllBack(
  paymentId: string,
  orderId: number,
  log: PaymentRefundMailLogger,
): Promise<void> {
  let done: { returnId: number; itemIds: number[]; started: StartedRefund | null } | null;
  try {
    done = await tx(async (db) => {
      await setAdminContext(db);
      await db.$executeRawUnsafe(`SET LOCAL lock_timeout = '1500ms'`);

      const [order] = await db.$queryRaw<{ total: string }[]>(Prisma.sql`
        select o.total::text as total from cartlify.orders as o where o.id = ${orderId}::int
      `);
      const refunds = await undecidedRefundsOf(db, paymentId);
      const back = refunds.reduce((sum, one) => sum + cents(one.amount), 0);
      if (!order || refunds.length === 0 || back < cents(order.total)) return null;

      const returnId = await cancelBySystem(db, orderId, 'stripe_refund');
      if (returnId === null) return null;

      for (const one of refunds) {
        await db.$queryRaw(Prisma.sql`select cartlify.share_money_line(${one.id}::int) as shared`);
      }

      const rows = await db.orderReturnItem.findMany({
        where: { returnId },
        select: { id: true, money: true },
        orderBy: { id: 'asc' },
      });
      const owed = rows.some((row) => row.money === 'not_refunded' || row.money === 'failed');

      return {
        returnId,
        itemIds: rows.map((row) => row.id),
        started: owed ? await beginReturnTransfer(db, { returnId, actor: null }) : null,
      };
    }, TX_OPTIONS);
  } catch (err) {
    // the refunds stay as they are, the order held: root decides on it
    log.error(
      { ...failureOf(err), orderId },
      'the order was not cancelled after its refunds by hand',
    );
    return;
  }

  if (!done) return;
  if (done.started) await finishReturnTransfer(done.started, null, log);
  else await sendReturnMoneyEmail(done.returnId, done.itemIds, log);
}

// cents of a sum the database gives (digits with two decimals) without float math
function cents(amount: string): number {
  const [whole, part = ''] = amount.replace('-', '').split('.');
  const value = Number(whole) * 100 + Number(part.padEnd(2, '0').slice(0, 2));
  return amount.startsWith('-') ? -value : value;
}

// the refunds made by hand of the payment of an order that wait for a decision: no use, not failed;
// with what each gave back
async function undecidedRefundsOf(db: Prisma.TransactionClient, paymentId: string) {
  return db.$queryRaw<{ id: number; amount: string }[]>(Prisma.sql`
    select l.id, to_char(-l.amount, 'FM99999999990.00') as amount
    from cartlify.money_log as l
    where l."paymentId" = ${paymentId}
      and l.event = 'money.refund'
      and l.purpose = 'hand'
      and l."moneyUse" is null
      and not exists (
        select 1 from cartlify.money_log as f
        where f.event = 'money.refund_failed' and f."coversId" = l.id
      )
    order by l.id
  `);
}
