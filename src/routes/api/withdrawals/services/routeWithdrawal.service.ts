import { prisma } from '@db/client.js';
import { setAdminContext } from '@db/dbContext.service.js';
import { isWithdrawalCode } from '@helpers/withdrawalCode.js';
import {
  withdrawalEndsOf,
  withdrawalOpenOf,
} from '@routes/api/orders/services/helpers/withdrawal.helper.js';

import type {
  WithdrawalRouteBodyDto,
  WithdrawalRouteResponseDto,
} from 'types/dto/withdrawals.dto.js';

// Where the page of a mail sends the visitor, decided by the server at the moment of the click (the
// mail may have come before the account was deleted): to the account when the code is the code of
// the order, the period of withdrawal is open and the account is alive; to the public form when
// the account is deleted; to the notice that the period is over when it is. A code that is not the
// code of the order, a missing one and an order there is not all answer the same, the form, which
// the admin checks by hand: nothing tells a visitor whether an order exists
export async function routeWithdrawal({
  orderId,
  code,
}: WithdrawalRouteBodyDto): Promise<WithdrawalRouteResponseDto> {
  if (!isWithdrawalCode(orderId, code)) return { where: 'form' };

  return prisma.$transaction(async (tx) => {
    await setAdminContext(tx);

    const order = await tx.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        status: true,
        deliveredAt: true,
        withdrawalDays: true,
        user: { select: { deletedAt: true } },
      },
    });
    if (!order) return { where: 'form' as const };

    const ends = (await withdrawalEndsOf(tx, [order])).get(order.id);
    if (!withdrawalOpenOf(order.status, ends, Date.now())) return { where: 'closed' as const };

    return { where: order.user.deletedAt ? ('form' as const) : ('account' as const) };
  });
}
