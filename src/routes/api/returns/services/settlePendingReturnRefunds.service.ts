import { Prisma } from '@prisma/client';

import { tx } from '@db/client.js';
import { setAdminContext } from '@db/dbContext.service.js';
import { failureOf } from '@helpers/failureOf.js';
import { getPaymentProvider } from '@routes/api/payments/providers/index.js';

import { settleReturnRefund } from './helpers/returnRefund.helper.js';

import type { PaymentProviderName, RefundAnswer } from '@routes/api/payments/providers/types.js';
import type { ReturnMailLogger } from './helpers/sendReturnByShopEmail.helper.js';

type WorkerLogger = ReturnMailLogger & { info: (obj: unknown, msg?: string) => void };

// a transfer is left alone this long after the last change: a request that is waiting for the
// provider is not the worker's to settle
export const PENDING_REFUND_AGE_MS = 2 * 60_000;

// a transfer still on its way after this long is a line in the log for somebody to look at
export const PENDING_REFUND_WARN_MS = 60 * 60_000;

// a transfer the provider never answered is given up after this long: the provider forgets a key
// after a day, and asking again later could make a second refund. 20 hours leaves the margin
export const PENDING_REFUND_GIVE_UP_MS = 20 * 60 * 60_000;

type PendingTransfer = {
  key: string;
  refundId: string | null;
  orderId: number;
  provider: string;
  paymentId: string;
  amount: string;
  // how long since the transfer last changed
  ageMs: number;
};

// Settles the transfers that stayed on their way: the provider did not answer (no id yet: the
// refund it may have made for the key is looked for, and when there is none the provider is asked
// again with the same key, which gives the one refund; after 20 hours it is not asked again and the
// transfer fails for a root to decide) or has not decided (asked where the refund stands). A
// transfer the provider still holds is left for the next run, and logged when it holds it for
// long. One that cannot be asked now (the provider out of reach) is logged and left too. Returns how
// many were settled. returnId limits the run to the transfers of one statement
export async function settlePendingReturnRefunds(
  log: WorkerLogger,
  opts: {
    limit?: number;
    olderThanMs?: number;
    warnAfterMs?: number;
    giveUpAfterMs?: number;
    returnId?: number;
  } = {},
): Promise<number> {
  const limit = opts.limit ?? 50;
  const olderThanMs = opts.olderThanMs ?? PENDING_REFUND_AGE_MS;
  const warnAfterMs = opts.warnAfterMs ?? PENDING_REFUND_WARN_MS;
  const giveUpAfterMs = opts.giveUpAfterMs ?? PENDING_REFUND_GIVE_UP_MS;

  const transfers = await tx(async (db) => {
    await setAdminContext(db);

    return db.$queryRaw<PendingTransfer[]>(Prisma.sql`
      select i."refundKey"::text as key,
             min(i."refundId") as "refundId",
             min(r."orderId") as "orderId",
             min(o."paymentProvider"::text) as provider,
             min(o."paymentId") as "paymentId",
             to_char(sum(i.amount + i."deliveryShare" - i."shippingDeduction"), 'FM99999999990.00') as amount,
             (extract(epoch from (now() at time zone 'UTC') - min(i."updatedAt")) * 1000)::float8 as "ageMs"
      from cartlify.return_items as i
      join cartlify.returns as r on r.id = i."returnId"
      join cartlify.orders as o on o.id = r."orderId"
      where i.money = 'pending'
        and (${opts.returnId ?? null}::int is null or r.id = ${opts.returnId ?? null}::int)
      group by i."refundKey"
      -- a transfer is asked again as a whole: its key once stood for all of its rows, so none of them
      -- may be young (a row whose goods just came back still belongs to the transfer)
      having max(i."updatedAt") < (now() at time zone 'UTC') - (${olderThanMs}::int * interval '1 millisecond')
      order by min(i."updatedAt")
      limit ${limit}::int
    `);
  });

  let settled = 0;

  for (const transfer of transfers) {
    try {
      const provider = getPaymentProvider(transfer.provider as PaymentProviderName);
      const key = `refund:${transfer.key}`;

      if (transfer.ageMs >= warnAfterMs) {
        log.warn(
          {
            key: transfer.key,
            orderId: transfer.orderId,
            ageMinutes: Math.round(transfer.ageMs / 60_000),
          },
          'return refund is still pending',
        );
      }

      let answer: RefundAnswer;
      if (transfer.refundId) {
        answer = await provider.getRefund(transfer.refundId);
      } else {
        // the refund may exist already, the answer to the request that made it lost
        const found = await provider.findRefund({ paymentId: transfer.paymentId, key });

        if (found) {
          answer = found;
        } else if (transfer.ageMs >= giveUpAfterMs) {
          // the provider forgets the key about now: asking again could make a second refund
          answer = {
            refundId: null,
            status: 'failed',
            failure: 'unknown',
            failureText: 'the provider did not answer for hours',
          };
        } else {
          answer = await provider.refundPayment({
            orderId: transfer.orderId,
            paymentId: transfer.paymentId,
            amount: transfer.amount,
            key,
          });
        }
      }

      // still on its way and nothing new to keep (the id the provider just gave is new)
      if (
        answer.status === 'pending' &&
        (answer.refundId === null || answer.refundId === transfer.refundId)
      ) {
        continue;
      }

      const finished = await settleReturnRefund({ key: transfer.key, answer, actor: null, log });
      if (finished.changed) settled += 1;
    } catch (err) {
      log.error({ ...failureOf(err), key: transfer.key }, 'return refund check failed');
    }
  }

  return settled;
}
