import { Prisma } from '@prisma/client';

import { getPgMessage, tx } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { writeAdminAuditLog } from '@db/adminAudit.helper.js';
import { assertAdminActor } from '@helpers/roleGuard.js';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  InternalError,
  NotFoundError,
} from '@utils/errors.js';

import { readReturnCard } from './helpers/returnCard.helper.js';
import { returnErrorOf } from './helpers/returnErrors.helper.js';
import { sendReturnMoneyEmail } from './helpers/returnMoneyMail.helper.js';

import type { FastifyBaseLogger } from 'fastify';
import type {
  KeepReturnGoodsDto,
  LoseOverpaidDto,
  RecordOverpaidReceivedDto,
  ReturnDto,
} from 'types/dto/returns.dto.js';
import type { Role } from 'types/user.js';
import type { UserId } from 'types/ids.js';

// Money already with the buyer for goods no statement of the order owes any more: root, or an admin root allowed to handle the
// money, works it from the card of a statement of the order (the alert returns_money_overpaid names
// them). The buyer gave it back outside the app (record_overpaid_received), the shop gives it up as
// a compensation or a loss (lose_overpaid), or the shop keeps the goods it did not accept that are
// still with it (keep_return_goods, db/05), and the money already there pays their rows. A line of
// the actor in the journal of the admins; the answer is the card of the statement

const REFUSALS: Record<string, () => Error> = {
  MONEY_RECEIVED_NOT_FOUND: () => new NotFoundError('MONEY_RECEIVED_NOT_FOUND'),
  MONEY_RECEIVED_INVALID: () => new BadRequestError('MONEY_RECEIVED_INVALID'),
  MONEY_RECEIVED_NOTE_REQUIRED: () => new BadRequestError('MONEY_RECEIVED_NOTE_REQUIRED'),
  MONEY_RECEIVED_AT_INVALID: () => new BadRequestError('MONEY_RECEIVED_AT_INVALID'),
  MONEY_RECEIVED_EXCEEDS: () => new ConflictError('MONEY_RECEIVED_EXCEEDS'),
  MONEY_RECEIVED_FORBIDDEN: () => new ForbiddenError('MONEY_RECEIVED_FORBIDDEN'),
  MONEY_OVERPAID_NOT_FOUND: () => new NotFoundError('MONEY_OVERPAID_NOT_FOUND'),
  MONEY_OVERPAID_NONE: () => new ConflictError('MONEY_OVERPAID_NONE'),
  MONEY_OVERPAID_FORBIDDEN: () => new ForbiddenError('MONEY_OVERPAID_FORBIDDEN'),
};

function refusalOf(err: unknown): unknown {
  const refusal = REFUSALS[String(getPgMessage(err) ?? '')];
  return refusal ? refusal() : returnErrorOf(err);
}

function assertMoneyActor(actorId: UserId, actorRole: Role) {
  assertAdminActor(actorId, actorRole);
  // root, or an admin root allowed to handle the money: the guard of the route asks the database,
  // and the function of the database checks it again
  if (actorRole !== 'ADMIN' && actorRole !== 'ROOT') throw new ForbiddenError('FORBIDDEN_ROLE');
}

// the order of a statement, read in the transaction of the step
async function orderOfStatement(
  db: Prisma.TransactionClient,
  returnId: number,
  missing: string,
): Promise<number> {
  const statement = await db.orderReturn.findUnique({
    where: { id: returnId },
    select: { orderId: true },
  });
  if (!statement) throw new NotFoundError(missing);
  return statement.orderId;
}

async function cardOf(db: Prisma.TransactionClient, returnId: number, actorRole: Role) {
  const card = await readReturnCard(db, returnId, actorRole);
  if (!card) throw new InternalError({ reason: 'RETURN_NOT_FOUND_AFTER_OVERPAID' });
  return card;
}

// the buyer gave back outside the app money of what is overpaid, on the day it really came: a line
// money.received for each share it pays back
export async function recordOverpaidReceived({
  actorId,
  actorRole,
  returnId,
  amount,
  method,
  note,
  at,
}: RecordOverpaidReceivedDto): Promise<ReturnDto> {
  assertMoneyActor(actorId, actorRole);

  const day = new Date(at);
  if (Number.isNaN(day.getTime())) throw new BadRequestError('MONEY_RECEIVED_AT_INVALID');

  try {
    return await tx(async (db) => {
      await setUserContext(db, { userId: actorId, role: actorRole });
      await db.$executeRawUnsafe(`SET LOCAL lock_timeout = '1500ms'`);
      const orderId = await orderOfStatement(db, returnId, 'MONEY_RECEIVED_NOT_FOUND');

      const [row] = await db.$queryRaw<
        { received: { orderId: number; amount: string; overpaid: string } }[]
      >(Prisma.sql`
        select cartlify.record_overpaid_received(
          ${orderId}::int,
          ${amount}::numeric,
          ${method}::cartlify."OutsideMethod",
          ${note}::text,
          (${day.toISOString()}::timestamptz AT TIME ZONE 'UTC')
        ) as received
      `);
      const received = row!.received;

      await writeAdminAuditLog(db, {
        actorId,
        actorRole,
        entityType: 'order',
        entityId: orderId,
        action: 'OTHER',
        event: 'return.overpaid_received',
        changes: [
          { field: 'returnId', old: null, new: returnId },
          {
            field: 'received',
            old: null,
            new: { method, at: day.toISOString(), amount: received.amount },
          },
          { field: 'overpaid', old: null, new: received.overpaid },
          // the note is a field of its own: the anonymizer of the dev copy blanks the notes by name
          { field: 'note', old: null, new: note },
        ],
      });

      return cardOf(db, returnId, actorRole);
    });
  } catch (err) {
    throw refusalOf(err);
  }
}

// the shop gives what is overpaid up: a compensation of money given back by hand, a loss of what a
// bank took
export async function loseOverpaid({
  actorId,
  actorRole,
  returnId,
  note,
}: LoseOverpaidDto): Promise<ReturnDto> {
  assertMoneyActor(actorId, actorRole);

  try {
    return await tx(async (db) => {
      await setUserContext(db, { userId: actorId, role: actorRole });
      await db.$executeRawUnsafe(`SET LOCAL lock_timeout = '1500ms'`);
      const orderId = await orderOfStatement(db, returnId, 'MONEY_OVERPAID_NOT_FOUND');

      const [row] = await db.$queryRaw<{ lost: { orderId: number; moved: string } }[]>(
        Prisma.sql`select cartlify.lose_overpaid(${orderId}::int) as lost`,
      );

      await writeAdminAuditLog(db, {
        actorId,
        actorRole,
        entityType: 'order',
        entityId: orderId,
        action: 'OTHER',
        event: 'return.overpaid_lost',
        changes: [
          { field: 'returnId', old: null, new: returnId },
          { field: 'moved', old: null, new: row!.lost.moved },
          { field: 'note', old: null, new: note },
        ],
      });

      return cardOf(db, returnId, actorRole);
    });
  } catch (err) {
    throw refusalOf(err);
  }
}

// the shop keeps goods it did not accept that are still with it: they come back on the shelf or are
// written off, and the money already with the buyer pays their rows; the buyer of a row paid at once
// is told the money is back
export async function keepReturnGoods({
  actorId,
  actorRole,
  returnId,
  items,
  note,
  log,
}: KeepReturnGoodsDto & { log: FastifyBaseLogger }): Promise<ReturnDto> {
  assertMoneyActor(actorId, actorRole);

  let kept: { card: ReturnDto; covered: { returnId: number; itemIds: number[] }[] };
  try {
    kept = await tx(async (db) => {
      await setUserContext(db, { userId: actorId, role: actorRole });
      await db.$executeRawUnsafe(`SET LOCAL lock_timeout = '1500ms'`);

      const [row] = await db.$queryRaw<
        {
          kept: { orderId: number; covered: { returnId: number; itemIds: number[] }[] };
        }[]
      >(Prisma.sql`
        select cartlify.keep_return_goods(${returnId}::int, ${JSON.stringify(items)}::jsonb) as kept
      `);
      const answer = row!.kept;

      await writeAdminAuditLog(db, {
        actorId,
        actorRole,
        entityType: 'order',
        entityId: answer.orderId,
        action: 'OTHER',
        event: 'return.goods_kept',
        changes: [
          { field: 'returnId', old: null, new: returnId },
          { field: 'items', old: null, new: items },
          ...(answer.covered.length ? [{ field: 'covered', old: null, new: answer.covered }] : []),
          { field: 'note', old: null, new: note },
        ],
      });

      return { card: await cardOf(db, returnId, actorRole), covered: answer.covered };
    });
  } catch (err) {
    throw refusalOf(err);
  }

  for (const one of kept.covered) {
    await sendReturnMoneyEmail(one.returnId, one.itemIds, log);
  }
  return kept.card;
}
