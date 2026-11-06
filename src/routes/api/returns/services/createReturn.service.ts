import { Prisma } from '@prisma/client';

import env from '@config/env.js';
import { shopSettings } from '@config/shopSettings.js';
import { tx } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { writeAdminAuditLog } from '@db/adminAudit.helper.js';
import { assertAdminActor } from '@helpers/roleGuard.js';
import { failureOf } from '@helpers/failureOf.js';
import { BadRequestError, InternalError, NotFoundError } from '@utils/errors.js';

import { readReturnCard } from './helpers/returnCard.helper.js';
import { returnErrorOf } from './helpers/returnErrors.helper.js';
import { sendReturnByShopEmail } from './helpers/sendReturnByShopEmail.helper.js';
import { refundReturn } from './refundReturn.service.js';

import type { CreateReturnDto, ReturnDto } from 'types/dto/returns.dto.js';

// an admin or a root makes a statement for the items of a paid, shipped or delivered order: a
// withdrawal the buyer made outside the shop (a parcel refused at the door), or a return outside
// the withdrawal (a defect, a wrong item, damage, goodwill, a cancel by the shop). The database makes
// it and checks all of it (create_return, db/05); the name and the email the answers go to are the
// buyer's. The buyer is mailed that the shop registered a return, once the statement is kept.
// The reasons shop_cancel (a paid order that was not sent) and refused (a parcel the buyer refused)
// are the cancels of the order: shop_cancel takes the goods back to the stock and cancels the order
// in the database, and its money goes back at once, in the three steps of a refund; a refusal waits
// for the parcel and then for its money. A refund that cannot be started is logged and the card
// answers with the rows waiting: the admin gives the money back by hand
export async function createReturn({
  actorId,
  actorRole,
  orderId,
  items,
  basis,
  reason,
  description,
  statedAt,
  extendsId,
  log,
}: CreateReturnDto): Promise<ReturnDto> {
  assertAdminActor(actorId, actorRole);

  // a moment is a time of the past; the database refuses one of the future
  const stated = statedAt === undefined ? null : new Date(statedAt);
  if (stated !== null && Number.isNaN(stated.getTime())) {
    throw new BadRequestError('RETURN_STATED_AT_INVALID');
  }

  let card: ReturnDto;
  try {
    card = await tx(async (db) => {
      await setUserContext(db, { userId: actorId, role: actorRole });

      // the answers go to the buyer of the order: their name, or their email when they gave none
      const order = await db.order.findUnique({
        where: { id: orderId },
        select: { userId: true, status: true },
      });
      if (!order) throw new NotFoundError('RETURN_ORDER_NOT_FOUND');
      const buyer = await db.user.findUniqueOrThrow({
        where: { id: order.userId },
        select: { name: true, email: true },
      });

      const [made] = await db.$queryRaw<{ id: number }[]>(Prisma.sql`
        select cartlify.create_return(
          ${orderId}::int,
          ${JSON.stringify(items)}::jsonb,
          'admin'::cartlify."ReturnSource",
          ${basis}::cartlify."ReturnBasis",
          ${reason ?? null}::cartlify."ReturnReason",
          ${description ?? null}::text,
          ${(buyer.name?.trim() || buyer.email).slice(0, 200)}::text,
          ${buyer.email}::text,
          (${stated ? stated.toISOString() : null}::timestamptz AT TIME ZONE 'UTC'),
          ${extendsId ?? null}::int,
          ${shopSettings().withdrawalGraceDays}::int,
          ${env.SHOP_TIME_ZONE}::text
        ) as id
      `);
      if (!made) throw new InternalError({ reason: 'RETURN_NOT_MADE' });

      const read = await readReturnCard(db, made.id, actorRole);
      if (!read) throw new InternalError({ reason: 'RETURN_NOT_FOUND_AFTER_CREATE' });

      await writeAdminAuditLog(db, {
        actorId,
        actorRole,
        entityType: 'order',
        entityId: orderId,
        action: 'OTHER',
        event: 'return.create',
        changes: [
          { field: 'returnId', old: null, new: made.id },
          { field: 'basis', old: null, new: basis },
          ...(reason ? [{ field: 'reason', old: null, new: reason }] : []),
          ...(extendsId ? [{ field: 'extendsId', old: null, new: extendsId }] : []),
          { field: 'items', old: null, new: items },
          // the statement can cancel the order (shop_cancel): the log says who cancelled it
          ...(read.order.status !== order.status
            ? [{ field: 'status', old: order.status, new: read.order.status }]
            : []),
          ...(description ? [{ field: 'description', old: null, new: description }] : []),
        ],
      });

      // the card again: its history ends with the line just written
      return (await readReturnCard(db, made.id, actorRole))!;
    });
  } catch (err) {
    throw returnErrorOf(err);
  }

  // after the commit: a mail that fails is only logged, the statement stands
  await sendReturnByShopEmail(card.id, log);

  // the cancel of a paid order gives the money back at once
  if (reason === 'shop_cancel') {
    try {
      return await refundReturn({ actorId, actorRole, returnId: card.id, log });
    } catch (err) {
      log.error({ ...failureOf(err), returnId: card.id }, 'return refund was not started');
    }
  }

  return card;
}
