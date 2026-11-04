import { Prisma } from '@prisma/client';

import { writeAdminAuditLog } from '@db/adminAudit.helper.js';
import { setAdminContext, setUserContext } from '@db/dbContext.service.js';
import { InternalError } from '@utils/errors.js';

import type { Role } from 'types/user.js';

type Db = Prisma.TransactionClient;

// what settle_return_dispute (db/05) did
export type SettledDispute = {
  orderId: number;
  itemIds: number[];
  returnIds: number[];
  won: boolean;
  amount: string;
};

// The end of a dispute of the payment of an order at the bank, in the transaction given: lost (the
// bank gave the buyer the money, the rows are refunded by chargeback on the day it closed) or won (the
// rows lose the mark and their money is sent again the usual way). Root acts from the card of a
// statement; the webhook of the provider, which tells the end of a dispute of a payment, acts as the
// system (actor null) and the line of the log then names the buyer of the order, as a payment given
// back late does. No mail: the bank told the buyer
export async function settleReturnDisputeIn(
  db: Db,
  args: {
    orderId: number;
    won: boolean;
    note: string;
    at?: Date | undefined;
    actor: { id: number; role: Role } | null;
  },
): Promise<SettledDispute> {
  if (args.actor) await setUserContext(db, { userId: args.actor.id, role: args.actor.role });
  else await setAdminContext(db);

  const [row] = await db.$queryRaw<{ done: SettledDispute }[]>(Prisma.sql`
    select cartlify.settle_return_dispute(
      ${args.orderId}::int,
      ${args.won}::boolean,
      ${args.note}::text,
      (${args.at ? args.at.toISOString() : null}::timestamptz AT TIME ZONE 'UTC')
    ) as done
  `);
  const done = row!.done;

  const owner = args.actor
    ? null
    : await db.order.findUnique({ where: { id: args.orderId }, select: { userId: true } });
  if (!args.actor && !owner) {
    throw new InternalError({ reason: 'RETURN_ORDER_OWNER_MISSING', orderId: args.orderId });
  }

  await writeAdminAuditLog(db, {
    actorId: args.actor ? args.actor.id : owner!.userId,
    actorRole: args.actor ? args.actor.role : 'USER',
    entityType: 'order',
    entityId: args.orderId,
    action: 'OTHER',
    event: 'return.dispute_settle',
    changes: [
      ...done.returnIds.map((id) => ({ field: 'returnId', old: null, new: id })),
      {
        field: 'dispute',
        old: null,
        new: {
          outcome: done.won ? 'won' : 'lost',
          itemIds: done.itemIds,
          amount: done.amount,
          ...(args.at ? { at: args.at.toISOString() } : {}),
          initiator: args.actor ? 'admin' : 'system',
        },
      },
      // the note is a field of its own: the anonymizer of the dev copy blanks the notes by name
      { field: 'note', old: null, new: args.note },
    ],
  });

  return done;
}
