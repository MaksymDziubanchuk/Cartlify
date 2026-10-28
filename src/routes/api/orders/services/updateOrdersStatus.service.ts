import { isAppError } from '@utils/errors.js';

import { updateOrderStatus } from './updateOrderStatus.service.js';
import type { OrderStatusMailLogger } from './helpers/sendOrderStatusEmail.helper.js';

import type {
  OrderStatus,
  UpdateOrdersStatusDto,
  UpdateOrdersStatusResponseDto,
  UpdateOrdersStatusResultDto,
} from 'types/dto/orders.dto.js';

// one step of shipping for many orders (POST /api/orders/status): each order goes on its own, in a
// transaction of its own, with every line of the step of one order and its mail. A mail cannot
// be taken back, so one order that cannot take the step does not stop the others: each order gets
// its answer, in the order of the request
export async function updateOrdersStatus(
  dto: UpdateOrdersStatusDto,
  log: OrderStatusMailLogger,
): Promise<UpdateOrdersStatusResponseDto> {
  const results: UpdateOrdersStatusResultDto[] = [];

  for (const { orderId, shipment, keepShippingCost } of dto.orders) {
    try {
      const order = await updateOrderStatus(
        {
          actorId: dto.actorId,
          actorRole: dto.actorRole,
          orderId,
          status: dto.status,
          bulk: true,
          ...(shipment !== undefined ? { shipment } : {}),
          ...(keepShippingCost !== undefined ? { keepShippingCost } : {}),
        },
        log,
      );
      results.push({ orderId, ok: true, status: order.status as OrderStatus });
    } catch (err) {
      // a refusal names the order; anything else is a failure of the server, for every order
      if (!isAppError(err) || err.statusCode >= 500) throw err;
      results.push({
        orderId,
        ok: false,
        errorCode: err.errorCode,
        ...(err.details ? { details: err.details as Record<string, unknown> } : {}),
      });
    }
  }

  return { results };
}
