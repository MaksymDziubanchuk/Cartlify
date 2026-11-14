import { Prisma } from '@prisma/client';

import { getPgMessage, tx } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { writeAdminAuditLog } from '@db/adminAudit.helper.js';
import { assertAdminActor } from '@helpers/roleGuard.js';
import { returnErrorOf } from '@routes/api/returns/services/helpers/returnErrors.helper.js';
import { sendReturnMoneyEmail } from '@routes/api/returns/services/helpers/returnMoneyMail.helper.js';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '@utils/errors.js';

import { sendWaitingStatements } from './helpers/statementsByThemselves.helper.js';

import type { Role } from 'types/user.js';
import type { DecideMoneyUseDto, MoneyDecisionDto } from 'types/dto/payments.dto.js';

// Root, or an admin root allowed to handle the money, says what a line of money given back by hand
// in the dashboard of the provider, or taken by a bank for a dispute the shop lost, was for
// (decide_money_use, db/05): the items of the order and the delivery it gave back, the rest a
// compensation (by hand) or a loss of the shop (the bank). Again while no statement took its shares
// (the new split takes the place of the old one, which the journal keeps); a hold the refund put on
// the order goes. The rows of the open statements of the order whose money the shares cover all of
// are paid with it at once, nothing asked of the provider, and their buyer is mailed after the
// commit. A line of the actor in the journal of the admins; the answer is the decision

// the refusals of the database functions, as the answers of the route
const REFUSALS: Record<string, () => Error> = {
  MONEY_DECISION_NOT_FOUND: () => new NotFoundError('MONEY_DECISION_NOT_FOUND'),
  MONEY_DECISION_DONE: () => new ConflictError('MONEY_DECISION_DONE'),
  MONEY_DECISION_DISPUTE_NOT_LOST: () => new ConflictError('MONEY_DECISION_DISPUTE_NOT_LOST'),
  MONEY_DECISION_EXCEEDS: () => new ConflictError('MONEY_DECISION_EXCEEDS'),
  MONEY_DECISION_INVALID: () => new BadRequestError('MONEY_DECISION_INVALID'),
  MONEY_DECISION_NOTE_REQUIRED: () => new BadRequestError('MONEY_DECISION_NOTE_REQUIRED'),
  MONEY_DECISION_FORBIDDEN: () => new ForbiddenError('MONEY_DECISION_FORBIDDEN'),
};

// the split a decision redone took the place of (decide_money_use), null the first time
type Previous = {
  use: string;
  items: Array<{ orderItemId: number; quantity: number; amount: number }>;
  delivery: number | string;
} | null;

const TX_OPTIONS = {
  maxRetries: 3,
  isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
  maxWait: 1500,
  timeout: 10_000,
};

function refusalOf(err: unknown): unknown {
  const refusal = REFUSALS[String(getPgMessage(err) ?? '')];
  return refusal ? refusal() : returnErrorOf(err);
}

function assertMoneyActor(actorId: unknown, actorRole: Role) {
  assertAdminActor(actorId, actorRole);
  // root, or an admin root allowed to handle the money: the guard of the route asks the database,
  // and the function of the database checks it again
  if (actorRole !== 'ADMIN' && actorRole !== 'ROOT') throw new ForbiddenError('FORBIDDEN_ROLE');
}

export async function decideMoneyUse({
  actorId,
  actorRole,
  moneyLogId,
  items,
  delivery,
  note,
  log,
}: DecideMoneyUseDto): Promise<MoneyDecisionDto> {
  assertMoneyActor(actorId, actorRole);

  let decided: MoneyDecisionDto;
  try {
    decided = await tx(async (db) => {
      await setUserContext(db, { userId: actorId, role: actorRole });
      await db.$executeRawUnsafe(`SET LOCAL lock_timeout = '1500ms'`);

      const [row] = await db.$queryRaw<{ decided: MoneyDecisionDto & { previous: Previous } }[]>(
        Prisma.sql`
          select cartlify.decide_money_use(
            ${moneyLogId}::int,
            ${JSON.stringify(items)}::jsonb,
            ${delivery ?? 0}::numeric,
            ${note}::text
          ) as decided
        `,
      );
      // the split a decision redone took the place of is for the journal, not for the answer
      const { previous, ...answer } = row!.decided;

      await writeAdminAuditLog(db, {
        actorId,
        actorRole,
        entityType: 'order',
        entityId: answer.orderId,
        action: 'OTHER',
        event: 'payment.money_decision',
        changes: [
          { field: 'moneyLogId', old: null, new: answer.moneyLogId },
          { field: 'use', old: previous?.use ?? null, new: answer.use },
          { field: 'items', old: previous?.items ?? null, new: items },
          {
            field: 'delivery',
            old: previous ? Number(previous.delivery) : null,
            new: delivery ?? 0,
          },
          { field: 'rest', old: null, new: answer.rest },
          ...(answer.covered.length ? [{ field: 'covered', old: null, new: answer.covered }] : []),
          // the note is a field of its own: the anonymizer of the dev copy blanks the notes by name
          { field: 'note', old: null, new: answer.note },
        ],
      });

      return answer;
    }, TX_OPTIONS);
  } catch (err) {
    throw refusalOf(err);
  }

  // the rows paid with the shares: their buyer is told the money is back
  for (const one of decided.covered) {
    await sendReturnMoneyEmail(one.returnId, one.itemIds, log);
  }

  // the statements of the order whose money goes by itself waited for the decision: they go on,
  // the shares first
  await sendWaitingStatements(decided.orderId, log);

  return decided;
}
