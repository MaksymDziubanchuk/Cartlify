import { Prisma } from '@prisma/client';

import { tx } from '@db/client.js';
import { setAdminContext } from '@db/dbContext.service.js';
import { failureOf } from '@helpers/failureOf.js';
import { sendReturnMoneyEmail } from '@routes/api/returns/services/helpers/returnMoneyMail.helper.js';

import { getPaymentProvider } from '../providers/index.js';
import { disputeEvidenceOf, disputeFactsOf } from './helpers/disputeEvidence.helper.js';
import { readLatePayment } from './helpers/latePayments.helper.js';
import { sendWhatIsLeft } from './helpers/orderPaymentRefund.helper.js';
import {
  goesByItselfSql,
  sendStatementMoney,
  sendWaitingStatements,
  waitingStatementsOf,
} from './helpers/statementsByThemselves.helper.js';
import { cancelBySystem } from './helpers/systemCancel.helper.js';

import type { PaymentDispute, PaymentProviderName } from '../providers/types.js';
import type { PaymentRefundMailLogger } from './helpers/paymentRefundMails.helper.js';

// The disputes of a payment at the bank, an inquiry of the bank included.
// Every event of a dispute (and the
// worker, for a dispute whose step did not finish) reads the dispute from the provider and follows
// it in the database (sync_payment_dispute, db/05: the state, the lines of the money it moved, the
// hold of an order not sent; what the bank took for a lost dispute of an order not sent is shared
// among its items and its delivery, and pays the rows of the open statements it covers all of), then
// takes the steps of its state. Each step looks at the state, so a sync again takes none twice:
// - open, no draft of the evidence, nothing submitted: the draft is put on it (never submitted: a
//   person reads it in the dashboard and submits it), and marked once it lay;
// - won: the statements of the order go on where the dispute stopped them: the app sends the money
//   of those whose money goes by itself (the goods still in the shop: a withdrawal or a cancel of an
//   order not handed over), an admin the rest; the payment an order
//   could not take is sent back again (its refund failed for the dispute);
// - lost: the buyer of the rows the money of the bank paid at once is mailed; the statements whose
//   money goes by itself are paid with the money of the bank first; an order not sent with no
//   statement open is cancelled by a statement of the system (dispute_lost) whose transfer takes the
//   money of the bank first and sends the rest of the payment; the rest of a late payment goes back.
//   What the bank took of an order sent waits for root to say what it was for (decide_money_use),
//   and the transfers of the order with it.
// The buyer is never mailed that a dispute opened or was won: only the cancel and the money of a
// statement have their mails

type WorkerLogger = PaymentRefundMailLogger & { info?: (obj: unknown, msg?: string) => void };

// NOT_AN_ORDER - the payment of the dispute is none of the shop's: no order has it, no late payment
export type DisputeSkip = 'NOT_AN_ORDER';

// what sync_payment_dispute answers
type Synced =
  | { foreign: true }
  | {
      foreign: false;
      id: number;
      created: boolean;
      stale: boolean;
      status: PaymentDispute['status'];
      open: boolean;
      drafted: boolean;
      late: boolean;
      orderId: number | null;
      userId: number | null;
      orderStatus: string | null;
      held: boolean;
      lineIds: number[];
      withdrawn: string;
      // every line of what the bank took has its decision
      shared: boolean;
      // the rows of open statements this sync paid at once with the money of the bank
      covered: { returnId: number; itemIds: number[] }[];
    };

type Kept = Extract<Synced, { foreign: false }>;

const TX_OPTIONS = {
  maxRetries: 3,
  isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
  maxWait: 1500,
  timeout: 10_000,
};

const utc = (at: Date | null) => (at ? at.toISOString() : null);

// the dispute as the database follows it, in the transaction of the caller (the context of the
// system set)
async function syncOf(
  db: Prisma.TransactionClient,
  provider: PaymentProviderName,
  dispute: PaymentDispute,
): Promise<Synced> {
  const transactions = dispute.transactions.map((one) => ({
    id: one.id,
    amount: Number(one.amount),
    currency: one.currency,
  }));

  const [row] = await db.$queryRaw<{ synced: Synced }[]>(Prisma.sql`
    select cartlify.sync_payment_dispute(
      ${provider}::cartlify."PaymentProvider",
      ${dispute.id}::text,
      ${dispute.paymentId}::text,
      ${dispute.status}::cartlify."DisputeStatus",
      ${dispute.reason.slice(0, 60)}::text,
      (${utc(dispute.evidenceDueBy)}::timestamptz AT TIME ZONE 'UTC'),
      ${dispute.hasEvidence}::boolean,
      ${dispute.submissionCount}::int,
      ${dispute.isChargeRefundable}::boolean,
      (${utc(dispute.openedAt)}::timestamptz AT TIME ZONE 'UTC'),
      null::timestamp,
      ${JSON.stringify(transactions)}::jsonb
    ) as synced
  `);
  return row!.synced;
}

// Follows a dispute as the provider has it now: the webhook for every event of a dispute, the
// worker for a dispute whose step did not finish. The provider out of reach is an error (the event
// comes again); a payment of no order and of no late payment is skipped
export async function followDispute(
  provider: PaymentProviderName,
  disputeId: string,
  log: WorkerLogger,
): Promise<{ skipped?: DisputeSkip }> {
  const dispute = await getPaymentProvider(provider).getDispute(disputeId);
  if (!dispute.paymentId) return { skipped: 'NOT_AN_ORDER' };

  const synced = await tx(async (db) => {
    await setAdminContext(db);
    await db.$executeRawUnsafe(`SET LOCAL lock_timeout = '1500ms'`);
    return syncOf(db, provider, dispute);
  }, TX_OPTIONS);
  if (synced.foreign) return { skipped: 'NOT_AN_ORDER' };

  if (synced.open && !synced.drafted && dispute.submissionCount === 0) {
    await draftEvidence(provider, dispute, synced, log);
  }

  if (synced.status === 'won') await afterWon(provider, dispute, synced, log);
  if (synced.status === 'lost') await afterLost(provider, dispute, synced, log);

  return {};
}

// the draft of the evidence, from what the shop knows of the order; the provider that does not take
// it now leaves the dispute without a draft for the worker
async function draftEvidence(
  provider: PaymentProviderName,
  dispute: PaymentDispute,
  synced: Kept,
  log: WorkerLogger,
): Promise<void> {
  const facts = await tx(async (db) => {
    await setAdminContext(db);
    return disputeFactsOf(db, {
      orderId: synced.orderId,
      paymentId: dispute.paymentId!,
      late: synced.late,
      currency: dispute.currency,
    });
  }, TX_OPTIONS);

  let put: Awaited<ReturnType<ReturnType<typeof getPaymentProvider>['putDisputeEvidence']>>;
  try {
    put = await getPaymentProvider(provider).putDisputeEvidence(
      dispute.id,
      disputeEvidenceOf(facts),
    );
  } catch (err) {
    log.warn(
      { ...failureOf(err), disputeId: dispute.id },
      'the draft of the evidence of a dispute was not put',
    );
    return;
  }

  if (put.status === 'refused') {
    // the dispute ended or a person submitted meanwhile: the next sync knows it
    log.warn(
      { disputeId: dispute.id, refusal: put.refusalText },
      'the draft of the evidence of a dispute was not put',
    );
    return;
  }

  await tx(async (db) => {
    await setAdminContext(db);
    await db.$queryRaw(
      Prisma.sql`select cartlify.mark_dispute_drafted(${synced.id}::int) as marked`,
    );
  }, TX_OPTIONS);
}

// a transfer of a statement the system starts: a refusal that only means nothing can go now is
// left, any other is logged for a person
// the late payment of a dispute, for the rest of it to go back
async function lateOf(paymentId: string) {
  return tx(async (db) => {
    await setAdminContext(db);
    return readLatePayment(db, paymentId);
  }, TX_OPTIONS);
}

// the shop won: the money is the shop's again, what waited for it goes on where it stopped
async function afterWon(
  _provider: PaymentProviderName,
  dispute: PaymentDispute,
  synced: Kept,
  log: WorkerLogger,
): Promise<void> {
  if (synced.late) {
    const late = await lateOf(dispute.paymentId!);
    if (late) await sendWhatIsLeft(late, log);
    return;
  }

  if (synced.orderId === null) return;
  for (const returnId of await waitingStatementsOf(synced.orderId)) {
    await sendStatementMoney(returnId, log);
  }
}

// the bank decided for the buyer: its money pays what the shop owed, an order not sent is cancelled
async function afterLost(
  _provider: PaymentProviderName,
  dispute: PaymentDispute,
  synced: Kept,
  log: WorkerLogger,
): Promise<void> {
  if (synced.late) {
    const late = await lateOf(dispute.paymentId!);
    if (late) await sendWhatIsLeft(late, log);
    return;
  }

  // the rows the money of the bank paid at once: the buyer is told the money is back
  for (const one of synced.covered) {
    await sendReturnMoneyEmail(one.returnId, one.itemIds, log);
  }

  if (synced.orderId === null) return;

  if (synced.orderStatus !== 'paid') {
    for (const returnId of await waitingStatementsOf(synced.orderId)) {
      await sendStatementMoney(returnId, log);
    }
    return;
  }

  // the cancel of the system takes all that is left of the order, the statements open beside it
  // too; the transfers of all the statements that go by themselves take the money of the bank first
  // (a sync again finds the order cancelled). The order stays held until the cancel commits
  await tx(async (db) => {
    await setAdminContext(db);
    await db.$executeRawUnsafe(`SET LOCAL lock_timeout = '1500ms'`);
    return cancelBySystem(db, synced.orderId!, 'dispute_lost');
  }, TX_OPTIONS);

  await sendWaitingStatements(synced.orderId, log);
}

// the days after its end that a dispute is still looked at for the money of its statements
const ENDED_DAYS = 30;

// Follows the disputes whose step did not finish when their event came (moneyRefund.worker.ts): open
// without a draft and with nothing submitted, lost on an order not sent that is still paid, ended
// with a statement of the order whose money goes by itself and waits (after a lost one, once the
// money of the bank has its decision). Each is read from the provider
// and followed as the webhook follows it; one that cannot be followed now is logged and left for the
// next run. Returns how many were followed. paymentId limits the run (the tests)
export async function followDisputes(
  log: WorkerLogger,
  opts: { limit?: number; paymentId?: string } = {},
): Promise<number> {
  const limit = opts.limit ?? 20;

  const due = await tx(async (db) => {
    await setAdminContext(db);
    return db.$queryRaw<{ provider: PaymentProviderName; stripeId: string }[]>(Prisma.sql`
      select d.provider::text as provider, d."stripeId" as "stripeId"
      from cartlify.payment_disputes as d
      left join cartlify.orders as o on o.id = d."orderId" and o."paymentId" = d."paymentId"
      where (${opts.paymentId ?? null}::text is null or d."paymentId" = ${opts.paymentId ?? null}::text)
        and (
          (d.status not in ('warning_closed', 'won', 'lost', 'prevented')
            and d."draftedAt" is null and d."submissionCount" = 0)
          or (d.status = 'lost' and o.status = 'paid'::cartlify."OrderStatus")
          or (
            d.status in ('won', 'lost')
            and o.id is not null
            and d."closedAt" > (now() at time zone 'utc') - make_interval(days => ${ENDED_DAYS}::int)
            and not exists (
              select 1 from cartlify.payment_disputes as other
              where other."paymentId" = d."paymentId"
                and other.status not in ('warning_closed', 'won', 'lost', 'prevented')
                and not other."isChargeRefundable"
            )
            and exists (
              select 1 from cartlify.returns as r where r."orderId" = o.id and ${goesByItselfSql}
            )
            and (d.status = 'won' or not exists (
              select 1 from cartlify.money_log as l
              where l."disputeId" = d.id and l.event = 'money.dispute_withdrawn' and l."moneyUse" is null
            ))
          )
        )
      order by d.id
      limit ${limit}
    `);
  });

  let followed = 0;
  for (const one of due) {
    try {
      await followDispute(one.provider, one.stripeId, log);
      followed += 1;
    } catch (err) {
      log.warn({ ...failureOf(err), disputeId: one.stripeId }, 'a dispute was not followed');
    }
  }

  return followed;
}
