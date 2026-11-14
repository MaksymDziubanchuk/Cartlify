import { Prisma } from '@prisma/client';

import env from '@config/env.js';
import { shopSettings } from '@config/shopSettings.js';
import { getPgMessage, tx } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { writeAdminAuditLog } from '@db/adminAudit.helper.js';
import { failureOf } from '@helpers/failureOf.js';
import { assertAdminActor } from '@helpers/roleGuard.js';
import { returnErrorOf } from '@routes/api/returns/services/helpers/returnErrors.helper.js';
import { sendReturnByShopEmail } from '@routes/api/returns/services/helpers/sendReturnByShopEmail.helper.js';
import { sendWaitingStatements } from '@routes/api/payments/services/helpers/statementsByThemselves.helper.js';
import { giveMoneyBack } from '@routes/api/returns/services/refundReturn.service.js';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  InternalError,
  NotFoundError,
} from '@utils/errors.js';

import { findById } from './findById.service.js';

import type { FastifyBaseLogger } from 'fastify';
import type { DecideOrderHoldDto, OrderResponseDto } from 'types/dto/orders.dto.js';

// Root decides on what holds a paid order from its sending and is root's to let go:
// a refund made by hand in the dashboard of the provider of part of the
// payment (hand_refund) and an early warning of fraud of the network of the card (fraud_warning). The
// database takes the hold away (decide_order_hold, db/05; the other holds stay):
// - ship: the order may be sent; the refunds made by hand are compensations;
// - cancel: what is left of the order is cancelled by a statement of the shop from root (shop_cancel:
//   the goods back to the stock at once, the order cancelled), the refunds made by hand are tied to
//   it in the same transaction (they are money the buyer has back), and after the commit the buyer
//   gets the usual mails of a cancel by the shop and the rest of the money goes back through the
//   provider (a transfer that cannot start is logged, the rows wait for an admin).
// The journal of the admins gets order.hold_decide (and return.create for the statement); the answer
// is the order as an admin sees it

// what decide_order_hold answers
type Decided = {
  orderId: number;
  reason: string;
  decision: 'ship' | 'cancel';
  moneyLogIds: number[];
  held: boolean;
  note: string;
};

// the refusals of the database functions, as the answers of the route
const REFUSALS: Record<string, () => Error> = {
  ORDER_HOLD_NOT_FOUND: () => new NotFoundError('ORDER_HOLD_NOT_FOUND'),
  ORDER_HOLD_NOTE_REQUIRED: () => new BadRequestError('ORDER_HOLD_NOTE_REQUIRED'),
  ORDER_HOLD_DECISION_INVALID: () => new BadRequestError('ORDER_HOLD_DECISION_INVALID'),
  ORDER_HOLD_FORBIDDEN: () => new ForbiddenError('ORDER_HOLD_FORBIDDEN'),
  HAND_REFUND_DECIDED: () => new ConflictError('HAND_REFUND_DECIDED'),
};

const TX_OPTIONS = {
  maxRetries: 3,
  isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
  maxWait: 1500,
  timeout: 10_000,
};

// the units of the order no statement holds (a row whose money was refused gives its units back)
const restOfOrderSql = (orderId: number) => Prisma.sql`
  select coalesce(
    jsonb_agg(
      jsonb_build_object('orderItemId', oi.id, 'quantity', oi.quantity - t.taken) order by oi.id
    ),
    '[]'::jsonb
  ) as items
  from cartlify.order_items as oi
  cross join lateral (
    select coalesce(sum(i.quantity), 0)::int as taken
    from cartlify.return_items as i
    where i."orderItemId" = oi.id and i.money <> 'refused'::cartlify."ReturnMoney"
  ) as t
  where oi."orderId" = ${orderId}::int and oi.quantity > t.taken
`;

export async function decideOrderHold(
  { actorId, actorRole, orderId, reason, decision, note }: DecideOrderHoldDto,
  log: FastifyBaseLogger,
): Promise<OrderResponseDto> {
  assertAdminActor(actorId, actorRole);
  // root, or an admin root allowed to handle the money: the guard of the route asks the database,
  // and the function of the database checks it again
  if (actorRole !== 'ADMIN' && actorRole !== 'ROOT') throw new ForbiddenError('FORBIDDEN_ROLE');

  let returnId: number | null;
  try {
    returnId = await tx(async (db) => {
      await setUserContext(db, { userId: actorId, role: actorRole });
      await db.$executeRawUnsafe(`SET LOCAL lock_timeout = '1500ms'`);

      const [row] = await db.$queryRaw<{ decided: Decided }[]>(Prisma.sql`
        select cartlify.decide_order_hold(
          ${orderId}::int, ${reason}::text, ${decision}::text, ${note}::text
        ) as decided
      `);
      const decided = row!.decided;

      const made = decision === 'cancel' ? await cancelOrder(db, decided) : null;

      await writeAdminAuditLog(db, {
        actorId,
        actorRole,
        entityType: 'order',
        entityId: orderId,
        action: 'OTHER',
        event: 'order.hold_decide',
        changes: [
          { field: 'reason', old: null, new: reason },
          { field: 'decision', old: null, new: decision },
          { field: 'moneyLogIds', old: null, new: decided.moneyLogIds },
          ...(made ? [{ field: 'returnId', old: null, new: made.returnId }] : []),
          // the note is a field of its own: the anonymizer of the dev copy blanks the notes by name
          { field: 'note', old: null, new: decided.note },
        ],
      });

      if (made) {
        await writeAdminAuditLog(db, {
          actorId,
          actorRole,
          entityType: 'order',
          entityId: orderId,
          action: 'OTHER',
          event: 'return.create',
          changes: [
            { field: 'returnId', old: null, new: made.returnId },
            { field: 'basis', old: null, new: 'other' },
            { field: 'reason', old: null, new: 'shop_cancel' },
            { field: 'items', old: null, new: made.items },
            { field: 'status', old: 'paid', new: made.status },
          ],
        });
      }

      return made?.returnId ?? null;
    }, TX_OPTIONS);
  } catch (err) {
    const refusal = REFUSALS[String(getPgMessage(err) ?? '')];
    throw refusal ? refusal() : returnErrorOf(err);
  }

  if (returnId !== null) {
    // after the commit: a mail that fails is only logged, the statement stands
    await sendReturnByShopEmail(returnId, log);
    try {
      await giveMoneyBack({ returnId, actor: { id: actorId, role: actorRole }, log });
    } catch (err) {
      log.error({ ...failureOf(err), returnId }, 'return refund was not started');
    }
  }

  // the statements of the order whose money goes by itself waited for the decision: they go on
  await sendWaitingStatements(orderId, log);

  return findById({ actorId, actorRole, orderId });
}

// the statement of the shop for what is left of the order (decide_order_hold shared the refunds made
// by hand among the items and the delivery, so its transfer takes them first); none when nothing is
// left (all of it is in statements)
async function cancelOrder(db: Prisma.TransactionClient, decided: Decided) {
  const [rest] = await db.$queryRaw<{ items: { orderItemId: number; quantity: number }[] }[]>(
    restOfOrderSql(decided.orderId),
  );
  const items = rest?.items ?? [];
  if (items.length === 0) return null;

  // the answers go to the buyer of the order: their name, or their email when they gave none
  const order = await db.order.findUniqueOrThrow({
    where: { id: decided.orderId },
    select: { user: { select: { name: true, email: true } } },
  });
  const buyer = order.user;

  const [made] = await db.$queryRaw<{ id: number }[]>(Prisma.sql`
    select cartlify.create_return(
      ${decided.orderId}::int,
      ${JSON.stringify(items)}::jsonb,
      'admin'::cartlify."ReturnSource",
      'other'::cartlify."ReturnBasis",
      'shop_cancel'::cartlify."ReturnReason",
      null::text,
      ${(buyer.name?.trim() || buyer.email).slice(0, 200)}::text,
      ${buyer.email}::text,
      null::timestamp,
      null::int,
      ${shopSettings().withdrawalGraceDays}::int,
      ${env.SHOP_TIME_ZONE}::text
    ) as id
  `);
  if (!made) throw new InternalError({ reason: 'RETURN_NOT_MADE' });

  const after = await db.order.findUniqueOrThrow({
    where: { id: decided.orderId },
    select: { status: true },
  });

  return { returnId: made.id, items, status: after.status };
}
