import { Prisma } from '@prisma/client';

import { returnCodeOf } from '@helpers/returns.js';
import { itemNameOf } from '@routes/api/orders/services/helpers/itemName.helper.js';

import type { DisputeEvidence } from '../../providers/types.js';

// The draft of the evidence the app puts on a dispute of a payment: what was bought, the delivery (the carrier, the
// number, when it was sent and delivered), the refunds of the payment (the day, the sum, the number of
// the provider) and the statements of return of the order (the day, what became of the goods and of
// the money). A person reads it in the dashboard of the provider, adds to it and submits it there.
// Only what the bank needs goes in: no note of the admins, no key, no id of the journals of the shop

export type DisputeFacts = {
  // the number of the order the buyer knows, none when the order of a late payment is gone
  orderId: number | null;
  // the payment is one the order could not take: the shop gives it back
  late: boolean;
  paidAt: Date | null;
  // digits with two decimals; none when the order is gone
  total: string | null;
  currency: string;
  items: { name: string; quantity: number; unitPrice: string }[];
  // what the buyer paid for the delivery, digits with two decimals
  deliveryPrice: string | null;
  customer: { name: string | null; email: string | null };
  // the sends of the order that were not taken back
  shipments: {
    carrier: string | null;
    trackingNumber: string | null;
    shippedAt: Date | null;
    deliveredAt: Date | null;
  }[];
  // the refunds of the payment, ours and the ones made by hand, the oldest first
  refunds: { at: Date; amount: string; refundId: string | null; state: string }[];
  statements: {
    code: string;
    statedAt: Date;
    rows: { name: string; quantity: number; goods: string; money: string }[];
  }[];
};

// the most text Stripe takes in one field of the evidence
const FIELD_MAX = 20_000;

const day = (at: Date) => at.toISOString().slice(0, 10);

const clip = (text: string) =>
  text.length <= FIELD_MAX ? text : `${text.slice(0, FIELD_MAX - 1)}…`;

// what became of the goods and the money of a row of a statement, in the words the bank reads
const GOODS_WORDS: Record<string, string> = {
  expected: 'goods not received yet',
  to_stock: 'goods received',
  written_off: 'goods received and written off',
  lost: 'goods lost on the way back',
  not_arrived: 'goods did not arrive',
  not_accepted: 'goods not accepted',
};

const MONEY_WORDS: Record<string, string> = {
  not_refunded: 'money not sent yet',
  pending: 'money on its way',
  refunded: 'money sent',
  failed: 'money could not be sent',
  refused: 'no money owed',
};

export function disputeEvidenceOf(facts: DisputeFacts): DisputeEvidence {
  const currency = facts.currency.toUpperCase();
  const money = (amount: string) => `${amount} ${currency}`;

  const bought = facts.items.map(
    (item) => `${item.quantity} x ${item.name} at ${money(item.unitPrice)}`,
  );
  const delivery =
    facts.deliveryPrice !== null && Number(facts.deliveryPrice) > 0
      ? [`delivery ${money(facts.deliveryPrice)}`]
      : [];
  const total = facts.total !== null ? [`total ${money(facts.total)}`] : [];
  const head = [
    facts.orderId !== null ? `Order #${facts.orderId}` : 'An order',
    facts.paidAt ? `paid on ${day(facts.paidAt)}` : null,
  ]
    .filter(Boolean)
    .join(', ');

  const sent = facts.shipments.filter((one) => one.shippedAt).at(-1);
  const delivered = facts.shipments.find((one) => one.deliveredAt);

  const lines: string[] = [];
  if (facts.late) {
    lines.push(
      'This payment came after the order could no longer take it: it is not the payment of the order, the shop gives it back.',
    );
  }
  if (delivered?.deliveredAt) lines.push(`Delivered on ${day(delivered.deliveredAt)}.`);
  else if (!sent && !facts.late) lines.push('The order was not sent.');

  lines.push(
    facts.refunds.length
      ? `Refunds of this payment: ${facts.refunds
          .map(
            (one) =>
              `${day(one.at)}, ${money(one.amount)}${one.refundId ? `, ${one.refundId}` : ''} (${one.state})`,
          )
          .join('; ')}.`
      : 'No refund of this payment was made.',
  );

  for (const statement of facts.statements) {
    const rows = statement.rows
      .map(
        (row) =>
          `${row.quantity} x ${row.name}, ${GOODS_WORDS[row.goods] ?? row.goods}, ${
            MONEY_WORDS[row.money] ?? row.money
          }`,
      )
      .join('; ');
    lines.push(`Statement of return ${statement.code} of ${day(statement.statedAt)}: ${rows}.`);
  }

  return {
    productDescription: clip(`${head}: ${[...bought, ...delivery, ...total].join('; ')}.`),
    ...(facts.customer.name ? { customerName: facts.customer.name } : {}),
    ...(facts.customer.email ? { customerEmailAddress: facts.customer.email } : {}),
    ...(sent?.carrier ? { shippingCarrier: sent.carrier } : {}),
    ...(sent?.trackingNumber ? { shippingTrackingNumber: sent.trackingNumber } : {}),
    ...(sent?.shippedAt ? { shippingDate: day(sent.shippedAt) } : {}),
    uncategorizedText: clip(lines.join('\n')),
  };
}

// the facts of a dispute of a payment, read in the transaction of the caller (the context of the
// system): the order of the payment or of the late payment, its items, its sends, the refunds of
// the payment and the statements of the order
export async function disputeFactsOf(
  db: Prisma.TransactionClient,
  dispute: { orderId: number | null; paymentId: string; late: boolean; currency: string },
): Promise<DisputeFacts> {
  const order = dispute.orderId
    ? await db.order.findUnique({
        where: { id: dispute.orderId },
        select: {
          id: true,
          paidAt: true,
          total: true,
          deliveredAt: true,
          user: { select: { name: true, email: true } },
          items: {
            orderBy: { id: 'asc' },
            select: {
              quantity: true,
              unitPrice: true,
              productName: true,
              variantId: true,
              product: { select: { name: true } },
            },
          },
        },
      })
    : null;

  // a query reads at most two relations side by side: the delivery and the sends apart
  const delivery = order
    ? await db.orderDelivery.findUnique({ where: { orderId: order.id }, select: { price: true } })
    : null;
  const sends = dispute.orderId
    ? await db.orderShipment.findMany({
        where: { orderId: dispute.orderId, returnId: null, rolledBackAt: null },
        orderBy: { id: 'asc' },
        select: { carrier: true, trackingNumber: true, shippedAt: true },
      })
    : [];
  // the order is delivered once, by its last send
  const shipments = sends.map((one, i) => ({
    ...one,
    deliveredAt: i === sends.length - 1 ? (order?.deliveredAt ?? null) : null,
  }));

  const refunds = await db.$queryRaw<
    { at: Date; amount: string; refundId: string | null; state: string }[]
  >(Prisma.sql`
    select min(l."createdAt") as at,
      to_char(-sum(l.amount), 'FM99999999990.00') as amount,
      max(l."refundId") as "refundId",
      case
        when bool_or(exists (
          select 1 from cartlify.money_log as f
          where f.event = 'money.refund_failed' and f."coversId" = l.id
        )) then 'failed'
        when bool_and(l.state = 'sent'::cartlify."MoneyState") then 'sent'
        else 'on its way'
      end as state
    from cartlify.money_log as l
    where l."paymentId" = ${dispute.paymentId}
      and l.event = 'money.refund'
      and l.part <> 'covered'::cartlify."MoneyPart"
      and (l."transferKey" is not null or l."refundId" is not null)
    group by coalesce(l."transferKey", l.id::text)
    order by min(l.id)
  `);

  const statements =
    dispute.orderId && !dispute.late
      ? await db.orderReturn.findMany({
          where: { orderId: dispute.orderId },
          orderBy: { id: 'asc' },
          select: { id: true, orderId: true, number: true, basis: true, statedAt: true },
        })
      : [];
  const rows = statements.length
    ? await db.orderReturnItem.findMany({
        where: { returnId: { in: statements.map((one) => one.id) } },
        orderBy: { id: 'asc' },
        select: {
          returnId: true,
          quantity: true,
          goods: true,
          money: true,
          orderItem: {
            select: { productName: true, variantId: true, product: { select: { name: true } } },
          },
        },
      })
    : [];

  return {
    orderId: order?.id ?? dispute.orderId,
    late: dispute.late,
    paidAt: dispute.late ? null : (order?.paidAt ?? null),
    total: !dispute.late && order ? order.total.toFixed(2) : null,
    currency: dispute.currency,
    items: dispute.late
      ? []
      : (order?.items ?? []).map((item) => ({
          name: itemNameOf(item),
          quantity: item.quantity,
          unitPrice: item.unitPrice.toFixed(2),
        })),
    deliveryPrice: !dispute.late && delivery ? delivery.price.toFixed(2) : null,
    customer: { name: order?.user?.name ?? null, email: order?.user?.email ?? null },
    shipments,
    refunds,
    statements: statements.map((statement) => ({
      code: returnCodeOf(statement.basis, statement.orderId, statement.number),
      statedAt: statement.statedAt,
      rows: rows
        .filter((row) => row.returnId === statement.id)
        .map((row) => ({
          name: itemNameOf(row.orderItem),
          quantity: row.quantity,
          goods: row.goods,
          money: row.money,
        })),
    })),
  };
}
