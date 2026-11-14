import { randomUUID } from 'node:crypto';

import { Prisma } from '@prisma/client';

import { getPgMessage, tx } from '@db/client.js';
import { setAdminContext, setUserContext } from '@db/dbContext.service.js';
import { writeAdminAuditLog } from '@db/adminAudit.helper.js';
import { assertAdminActor } from '@helpers/roleGuard.js';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  InternalError,
  NotFoundError,
} from '@utils/errors.js';

import { getPaymentProvider, paymentProviders } from '../providers/index.js';
import {
  MONEY_REFUNDS,
  moneyRefundById,
  type MoneyRefundRow,
} from './helpers/moneyRefunds.helper.js';
import { settleMoneyRefund } from './helpers/settleMoneyRefund.helper.js';
import { refundItemOf } from './listPaymentRefunds.service.js';

import type { PaymentProviderName } from '../providers/types.js';
import type { GiveCompensationDto, PaymentRefundItemDto } from 'types/dto/payments.dto.js';

// Root, or an admin root allowed to handle the money, gives the buyer of an order a compensation by
// the button of the app: the steps of every refund of the app. The line in
// transit is written with the key of the request (begin_compensation, db/05) and the line of the
// actor in the journal of the admins with the note, in one transaction; the provider is asked after
// the commit, and its answer settles the line (settleMoneyRefund: the buyer is mailed once it is
// sent; a failure is not mailed, root sends it another way, POST /api/payments/refunds/:id/outside).
// No answer leaves it in transit for the worker, which asks again with the same key. The answer is
// the refund as the list of the refunds shows it

// what begin_compensation (db/05) answers
type Begun = {
  id: number;
  created: boolean;
  provider: PaymentProviderName;
  paymentId: string;
  amount: string;
};

// the refusals of the database function, as the answers of the route
const REFUSALS: Record<string, () => Error> = {
  COMPENSATION_ORDER_INVALID: () => new NotFoundError('COMPENSATION_ORDER_INVALID'),
  COMPENSATION_AMOUNT_INVALID: () => new BadRequestError('COMPENSATION_AMOUNT_INVALID'),
  COMPENSATION_EXCEEDS_PAID: () => new ConflictError('COMPENSATION_EXCEEDS_PAID'),
  COMPENSATION_DISPUTED: () => new ConflictError('COMPENSATION_DISPUTED'),
  COMPENSATION_IN_TRANSIT: () => new ConflictError('COMPENSATION_IN_TRANSIT'),
  COMPENSATION_FORBIDDEN: () => new ForbiddenError('COMPENSATION_FORBIDDEN'),
};

const TX_OPTIONS = {
  maxRetries: 3,
  isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
  maxWait: 1500,
  timeout: 10_000,
};

async function refundOf(moneyLogId: number): Promise<MoneyRefundRow> {
  return tx(async (db) => {
    await setAdminContext(db);
    const [refund] = await db.$queryRaw<MoneyRefundRow[]>(Prisma.sql`
      select t.* from ${MONEY_REFUNDS} as t where ${moneyRefundById(moneyLogId)}
    `);
    if (!refund) throw new InternalError({ reason: 'COMPENSATION_NOT_FOUND_AFTER_BEGIN' });
    return refund;
  }, TX_OPTIONS);
}

export async function giveCompensation({
  actorId,
  actorRole,
  orderId,
  amount,
  note,
  log,
}: GiveCompensationDto): Promise<PaymentRefundItemDto> {
  assertAdminActor(actorId, actorRole);
  // root, or an admin root allowed to handle the money: the guard of the route asks the database,
  // and the function of the database checks it again
  if (actorRole !== 'ADMIN' && actorRole !== 'ROOT') throw new ForbiddenError('FORBIDDEN_ROLE');

  const trimmed = note.trim();
  if (!trimmed) throw new BadRequestError('COMPENSATION_NOTE_REQUIRED');

  const key = `compensation:${randomUUID()}`;
  const actor = { id: actorId, role: actorRole };

  let begun: Begun;
  try {
    begun = await tx(async (db) => {
      await setUserContext(db, { userId: actorId, role: actorRole });
      await db.$executeRawUnsafe(`SET LOCAL lock_timeout = '1500ms'`);

      const [row] = await db.$queryRaw<{ begun: Begun }[]>(Prisma.sql`
        select cartlify.begin_compensation(
          ${orderId}::int,
          ${key}::text,
          ${amount}::numeric,
          ${paymentProviders[0]!.currency}::text
        ) as begun
      `);
      const one = row!.begun;

      await writeAdminAuditLog(db, {
        actorId,
        actorRole,
        entityType: 'order',
        entityId: orderId,
        action: 'OTHER',
        event: 'payment.compensation',
        changes: [
          { field: 'moneyLogId', old: null, new: one.id },
          { field: 'amount', old: null, new: one.amount },
          // the note is a field of its own: the anonymizer of the dev copy blanks the notes by name
          { field: 'note', old: null, new: trimmed },
        ],
      });

      return one;
    }, TX_OPTIONS);
  } catch (err) {
    const refusal = REFUSALS[String(getPgMessage(err) ?? '')];
    throw refusal ? refusal() : err;
  }

  const answer = await getPaymentProvider(begun.provider).refundPayment({
    orderId,
    paymentId: begun.paymentId,
    amount: begun.amount,
    key,
  });

  // silence leaves the line in transit: the worker asks again with the same key
  if (!(answer.status === 'pending' && answer.refundId === null)) {
    await settleMoneyRefund({ key, answer, actor }, log);
  }

  return refundItemOf(await refundOf(begun.id));
}
