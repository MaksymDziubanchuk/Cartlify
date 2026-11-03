import { withdrawalRightOf, type WithdrawalRuleName } from '@helpers/withdrawal.js';
import { BadRequestError } from '@utils/errors.js';

import type { Prisma } from '@prisma/client';

type OrderItemRow = { id: number; quantity: number; withdrawal: WithdrawalRuleName };

// the units of the items that statements hold, by item. A row whose money was refused holds none;
// with overManual neither does an open row of a statement of the form without the code that no
// admin accepted yet (its goods still expected, no money back): a statement of the account or of
// the code takes those units over (create_return gives them up with the code stated_again)
export async function unitsHeldOf(
  db: Prisma.TransactionClient,
  itemIds: number[],
  overManual: boolean,
): Promise<Map<number, number>> {
  const held = await db.orderReturnItem.groupBy({
    by: ['orderItemId'],
    where: {
      orderItemId: { in: itemIds },
      money: { not: 'refused' },
      ...(overManual
        ? {
            NOT: {
              return: { source: 'form_manual', closedAt: null, acceptedAt: null },
              goods: 'expected',
              money: 'not_refunded',
            },
          }
        : {}),
    },
    _sum: { quantity: true },
  });
  return new Map(held.map((one) => [one.orderItemId, one._sum.quantity ?? 0]));
}

// the units a buyer withdraws from: the ones named, or, when none are, whatever is left of the order
// that has a right of withdrawal (the units that other statements hold are not left, see
// unitsHeldOf). RETURN_ITEMS_REQUIRED when nothing is left
export async function withdrawalItemsOf(
  db: Prisma.TransactionClient,
  order: { items: OrderItemRow[] },
  named: Array<{ orderItemId: number; quantity: number }> | undefined,
  overManual: boolean,
): Promise<Array<{ orderItemId: number; quantity: number }>> {
  if (named) return named;

  const taken = await unitsHeldOf(
    db,
    order.items.map((item) => item.id),
    overManual,
  );

  const units = order.items
    .filter((item) => withdrawalRightOf(item.withdrawal) !== 'none')
    .map((item) => ({
      orderItemId: item.id,
      quantity: item.quantity - (taken.get(item.id) ?? 0),
    }))
    .filter((one) => one.quantity > 0);

  if (!units.length) throw new BadRequestError('RETURN_ITEMS_REQUIRED');

  return units;
}
