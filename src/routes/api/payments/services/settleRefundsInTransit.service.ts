import { Prisma } from '@prisma/client';

import { tx } from '@db/client.js';
import { setAdminContext } from '@db/dbContext.service.js';
import { failureOf } from '@helpers/failureOf.js';

import { getPaymentProvider } from '../providers/index.js';
import { settleHandRefund } from './helpers/handRefunds.helper.js';
import { answerLateRefund } from './helpers/orderPaymentRefund.helper.js';
import { settleMoneyRefund } from './helpers/settleMoneyRefund.helper.js';

import type { PaymentProviderName, RefundAnswer } from '../providers/types.js';
import type { PaymentRefundMailLogger } from './helpers/paymentRefundMails.helper.js';

type WorkerLogger = PaymentRefundMailLogger & { info: (obj: unknown, msg?: string) => void };

// a refund is left alone this long after it was asked: a request that is waiting for the provider is
// not the worker's to settle
export const IN_TRANSIT_AGE_MS = 2 * 60_000;

// a refund made by hand the provider still holds, one line of the money journal
type HandInTransit = {
  provider: PaymentProviderName;
  refundId: string;
  paymentId: string | null;
  currency: string | null;
  // digits with two decimals
  amount: string;
};

// a refund still in transit after this long is a line in the log for somebody to look at
export const IN_TRANSIT_WARN_MS = 60 * 60_000;

// a refund of the app in transit, the lines of one key in the money journal
type InTransit = {
  key: string;
  purpose: 'return' | 'late_payment' | 'compensation';
  refundId: string | null;
  // the order the refund is for: the row, or the number a late payment keeps for an order gone
  orderId: number | null;
  provider: PaymentProviderName;
  paymentId: string;
  currency: string | null;
  // all of its parts, what the provider is asked for, digits with two decimals
  amount: string;
  // how long since it was asked
  ageMs: number;
};

// Settles the refunds of the app that stayed in transit (moneyRefund.worker.ts): the transfers of
// the statements and the refunds of the late payments asked longer ago than the age. One the
// provider made is asked where it stands; one without an id (the answer was lost) is looked for by
// its key among the refunds of the payment, and when there is none the provider is asked again with
// the same key and sum, which gives the one refund. That is safe after the provider forgot the key:
// the refund is found by the key in its metadata, so a silent refund stays in transit as long as it
// takes, never a failure the app made up (the alert of the refunds in transit tells a person). A
// refund the provider still holds, or that it cannot be asked about now, is left for the next run.
// Returns how many changed. returnId and paymentId limit the run (the tests)
export async function settleRefundsInTransit(
  log: WorkerLogger,
  opts: {
    limit?: number;
    olderThanMs?: number;
    warnAfterMs?: number;
    returnId?: number;
    paymentId?: string;
  } = {},
): Promise<number> {
  const limit = opts.limit ?? 50;
  const olderThanMs = opts.olderThanMs ?? IN_TRANSIT_AGE_MS;
  const warnAfterMs = opts.warnAfterMs ?? IN_TRANSIT_WARN_MS;

  const refunds = await tx(async (db) => {
    await setAdminContext(db);

    return db.$queryRaw<InTransit[]>(Prisma.sql`
      with refunds as (
        select l."transferKey" as key,
          (array_agg(l.purpose::text order by l.id))[1] as purpose,
          max(l."refundId") as "refundId",
          (array_agg(l."orderId" order by l.id))[1] as "orderId",
          (array_agg(l.provider::text order by l.id))[1] as provider,
          (array_agg(l."paymentId" order by l.id))[1] as "paymentId",
          (array_agg(l.currency order by l.id))[1] as currency,
          (array_agg(l."returnId" order by l.id))[1] as "returnId",
          to_char(-sum(l.amount), 'FM99999999990.00') as amount,
          bool_or(l.state = 'in_transit'::cartlify."MoneyState") as "inTransit",
          min(l."createdAt") as "askedAt",
          array_agg(l.id) as "lineIds"
        from cartlify.money_log as l
        where l.event = 'money.refund'
          and l."transferKey" is not null
          and l.purpose in (
            'return'::cartlify."MoneyPurpose",
            'late_payment'::cartlify."MoneyPurpose",
            'compensation'::cartlify."MoneyPurpose"
          )
        group by l."transferKey"
      )
      select r.key, r.purpose, r."refundId", r.provider, r."paymentId", r.currency, r.amount,
        coalesce(r."orderId", (
          select (e.value->>'new')::int
          from cartlify.money_log as p
          cross join lateral jsonb_array_elements(coalesce(p.meta, '[]'::jsonb)) as e (value)
          where p.event = 'money.late_payment' and p."paymentId" = r."paymentId"
            and e.value->>'field' = 'orderRef'
          limit 1
        )) as "orderId",
        (extract(epoch from (now() at time zone 'UTC') - r."askedAt") * 1000)::float8 as "ageMs"
      from refunds as r
      where r."inTransit"
        and not exists (
          select 1 from cartlify.money_log as f
          where f.event = 'money.refund_failed' and f."coversId" = any (r."lineIds")
        )
        and r."askedAt" < (now() at time zone 'UTC') - (${olderThanMs}::int * interval '1 millisecond')
        and (${opts.returnId ?? null}::int is null or r."returnId" = ${opts.returnId ?? null}::int)
        and (${opts.paymentId ?? null}::text is null or r."paymentId" = ${opts.paymentId ?? null}::text)
      order by r."askedAt"
      limit ${limit}::int
    `);
  });

  let settled = 0;

  for (const refund of refunds) {
    try {
      if (refund.ageMs >= warnAfterMs) {
        log.warn(
          {
            key: refund.key,
            orderId: refund.orderId,
            ageMinutes: Math.round(refund.ageMs / 60_000),
          },
          'refund is still in transit',
        );
      }

      const provider = getPaymentProvider(refund.provider);

      let answer: RefundAnswer;
      if (refund.refundId) {
        answer = await provider.getRefund(refund.refundId);
      } else {
        // the refund may exist already, the answer to the request that made it lost
        answer =
          (await provider.findRefund({ paymentId: refund.paymentId, key: refund.key })) ??
          (await provider.refundPayment({
            orderId: refund.orderId ?? 0,
            paymentId: refund.paymentId,
            amount: refund.amount,
            key: refund.key,
          }));
      }

      // still on its way and nothing new to keep (the id the provider just gave is new)
      if (
        answer.status === 'pending' &&
        (answer.refundId === null || answer.refundId === refund.refundId)
      ) {
        continue;
      }

      const changed =
        refund.purpose === 'late_payment'
          ? await answerLateRefund(
              {
                provider: refund.provider,
                paymentId: refund.paymentId,
                orderId: refund.orderId,
                currency: refund.currency,
                key: refund.key,
                amount: refund.amount,
              },
              answer,
              log,
            )
          : (await settleMoneyRefund({ key: refund.key, answer }, log)).changed;

      if (changed) settled += 1;
    } catch (err) {
      log.error({ ...failureOf(err), key: refund.key }, 'refund check failed');
    }
  }

  // the refunds made by hand the provider keeps pending: the later event of one may be lost, so each
  // is asked where it stands and its line follows as the event would make it (settleHandRefund)
  const byHand = await tx(async (db) => {
    await setAdminContext(db);

    return db.$queryRaw<HandInTransit[]>(Prisma.sql`
      select l.provider::text as provider, l."refundId", l."paymentId", l.currency,
        to_char(-l.amount, 'FM99999999990.00') as amount
      from cartlify.money_log as l
      where l.event = 'money.refund'
        and l.purpose = 'hand'::cartlify."MoneyPurpose"
        and l.state = 'in_transit'::cartlify."MoneyState"
        and l."refundId" is not null
        and not exists (
          select 1 from cartlify.money_log as f
          where f.event = 'money.refund_failed' and f."coversId" = l.id
        )
        and l."createdAt" < (now() at time zone 'UTC') - (${olderThanMs}::int * interval '1 millisecond')
        and (${opts.returnId ?? null}::int is null or l."returnId" = ${opts.returnId ?? null}::int)
        and (${opts.paymentId ?? null}::text is null or l."paymentId" = ${opts.paymentId ?? null}::text)
      order by l.id
      limit ${limit}::int
    `);
  });

  for (const one of byHand) {
    try {
      const answer = await getPaymentProvider(one.provider).getRefund(one.refundId);
      if (answer.status === 'pending') continue;

      await settleHandRefund(
        {
          provider: one.provider,
          refundId: one.refundId,
          paymentId: one.paymentId,
          amount: one.amount,
          currency: one.currency ?? '',
          answer,
        },
        log,
      );
      settled += 1;
    } catch (err) {
      log.error({ ...failureOf(err), refundId: one.refundId }, 'refund check failed');
    }
  }

  return settled;
}
