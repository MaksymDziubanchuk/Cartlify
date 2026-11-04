import { isWithdrawalCode } from '@helpers/withdrawalCode.js';

import type { Prisma } from '@prisma/client';

// what a visitor gives of the recipient of the order (types/dto/withdrawals.dto.ts)
type Facts = {
  orderId: number;
  recipientName: string;
  code?: string | undefined;
  phone?: string | undefined;
  country?: string | undefined;
  postalCode?: string | undefined;
};

// the same for the order and for the form: lower case, one space between the words
const plain = (text: string) => text.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
// a phone by its digits, a postal code and a country without the spaces and the case
const digits = (text: string) => text.replace(/\D/g, '');
const compact = (text: string) => text.normalize('NFKC').replace(/\s+/g, '').toUpperCase();

type Delivery = {
  method: string;
  recipientFirstName: string;
  recipientLastName: string;
  recipientPhone: string;
  country: string | null;
  postalCode: string | null;
};

// an order a visitor of the public form names: its items, its delivery and whether its account is
// alive; the context of the transaction is the system. Two queries whatever the order, so the time
// does not tell whether it exists
export async function formOrderOf(db: Prisma.TransactionClient, orderId: number) {
  const order = await db.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      userId: true,
      status: true,
      deliveredAt: true,
      withdrawalDays: true,
      items: {
        orderBy: { id: 'asc' },
        select: {
          id: true,
          quantity: true,
          withdrawal: true,
          productName: true,
          variantId: true,
          product: { select: { name: true } },
        },
      },
      delivery: {
        select: {
          method: true,
          recipientFirstName: true,
          recipientLastName: true,
          recipientPhone: true,
          country: true,
          postalCode: true,
        },
      },
    },
  });
  const user = await db.user.findUnique({
    where: { id: order?.userId ?? 0 },
    select: { deletedAt: true },
  });

  return order ? { ...order, accountAlive: user !== null && user.deletedAt === null } : null;
}

// whether the facts a visitor gives are the ones of the delivery of the order. With the code of the
// mail the name of the recipient; without it also the phone (its digits) and, for a delivery to an
// address, the country and the postal code the order has. Every fact is compared whatever the
// others gave, so the time does not tell which one was wrong
export function factsMatch(delivery: Delivery | null, facts: Facts): boolean {
  const viaCode = isWithdrawalCode(facts.orderId, facts.code);
  const first = plain(delivery?.recipientFirstName ?? '');
  const last = plain(delivery?.recipientLastName ?? '');
  const given = plain(facts.recipientName);

  const name = delivery !== null && (given === `${first} ${last}` || given === `${last} ${first}`);
  const phone =
    digits(facts.phone ?? '') !== '' &&
    digits(facts.phone ?? '') === digits(delivery?.recipientPhone ?? '');
  const address =
    delivery?.method === 'pickup' ||
    (compact(facts.country ?? '') === compact(delivery?.country ?? '-') &&
      compact(facts.postalCode ?? '') === compact(delivery?.postalCode ?? ''));

  return viaCode ? name : name && phone && address;
}
