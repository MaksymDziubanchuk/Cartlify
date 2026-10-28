import type { Prisma } from '@prisma/client';

import type { OrderDeliverySuggestionDto } from 'types/dto/orders.dto.js';

// the delivery of the last order of the buyer, for the cart to start from: the person and where it
// went, never the note for that courier. Read under the context of the buyer, so only their own
// orders are there. The shop may not make that delivery any more (a method or a country it dropped):
// the page shows it all the same and the confirmation says what is refused
export async function deliverySuggestionOf(
  db: Prisma.TransactionClient,
  userId: number,
): Promise<OrderDeliverySuggestionDto | null> {
  const last = await db.orderDelivery.findFirst({
    where: { order: { userId } },
    orderBy: [{ createdAt: 'desc' }, { orderId: 'desc' }],
    select: {
      method: true,
      recipientFirstName: true,
      recipientLastName: true,
      recipientPhone: true,
      country: true,
      postalCode: true,
      city: true,
      street: true,
      house: true,
      apartment: true,
    },
  });
  if (!last) return null;

  return {
    method: last.method,
    recipient: {
      firstName: last.recipientFirstName,
      lastName: last.recipientLastName,
      phone: last.recipientPhone,
    },
    address:
      last.method === 'manual' && last.country && last.city && last.street && last.house
        ? {
            country: last.country,
            postalCode: last.postalCode,
            city: last.city,
            street: last.street,
            house: last.house,
            apartment: last.apartment,
          }
        : null,
  };
}
