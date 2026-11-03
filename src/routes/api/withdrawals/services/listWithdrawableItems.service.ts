import { isRetryableTxError, prisma } from '@db/client.js';
import { setAdminContext } from '@db/dbContext.service.js';
import { withdrawalRightOf } from '@helpers/withdrawal.js';
import { isWithdrawalCode } from '@helpers/withdrawalCode.js';
import { itemNameOf } from '@routes/api/orders/services/helpers/itemName.helper.js';
import {
  withdrawalEndsOf,
  withdrawalOpenOf,
} from '@routes/api/orders/services/helpers/withdrawal.helper.js';
import { unitsHeldOf } from '@routes/api/orders/services/helpers/withdrawalItems.helper.js';
import { BadRequestError, ResourceBusyError } from '@utils/errors.js';

import { factsMatch, formOrderOf } from './helpers/formFacts.helper.js';

import type {
  WithdrawalItemsBodyDto,
  WithdrawalItemsResponseDto,
} from 'types/dto/withdrawals.dto.js';

// Any failure is one answer, whatever it was: a visitor learns nothing about orders
const rejected = () => new BadRequestError('WITHDRAWAL_REJECTED');

// The units a visitor of the public form may withdraw from, once they showed the order is theirs:
// with the code of the mail by the name of the recipient, without it by the name, the phone and,
// for a delivery to an address, its country and postal code. Only the units with the right of
// withdrawal that no statement holds, while the period is open; no prices. The same work is done
// whatever was wrong, and every refusal is the same answer
export async function listWithdrawableItems(
  facts: WithdrawalItemsBodyDto,
): Promise<WithdrawalItemsResponseDto> {
  const viaCode = isWithdrawalCode(facts.orderId, facts.code);

  try {
    return await prisma.$transaction(async (tx) => {
      await setAdminContext(tx);

      const order = await formOrderOf(tx, facts.orderId);
      const matches = factsMatch(order?.delivery ?? null, facts);

      const ends = order ? (await withdrawalEndsOf(tx, [order])).get(order.id) : undefined;
      const open = order !== null && withdrawalOpenOf(order.status, ends, Date.now());

      const items = (order?.items ?? []).filter(
        (item) => withdrawalRightOf(item.withdrawal) !== 'none',
      );
      // a statement without the code does not take units over from one waiting for its check
      const taken = await unitsHeldOf(
        tx,
        items.length ? items.map((item) => item.id) : [0],
        viaCode,
      );
      const underReview =
        !viaCode &&
        (await tx.orderReturn.count({
          where: {
            orderId: facts.orderId,
            source: 'form_manual',
            closedAt: null,
            acceptedAt: null,
          },
        })) > 0;

      if (!order || !matches || !open) throw rejected();

      return {
        items: items
          .map((item) => ({
            orderItemId: item.id,
            name: itemNameOf(item),
            quantity: item.quantity - (taken.get(item.id) ?? 0),
          }))
          .filter((one) => one.quantity > 0),
        signIn: order.accountAlive,
        underReview,
      };
    });
  } catch (err) {
    if (isRetryableTxError(err)) throw new ResourceBusyError();
    throw err;
  }
}
