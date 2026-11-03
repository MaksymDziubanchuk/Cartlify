import env from '@config/env.js';
import { prisma } from '@db/client.js';
import { setAdminContext } from '@db/dbContext.service.js';
import { deliveryMailParts } from '@helpers/deliveryText.js';
import { webPageUrl } from '@helpers/webOrigin.js';
import { withdrawalLinkOf } from '@helpers/withdrawalCode.js';
import { buildOrderShippedTemplate } from '@services/email/templates/orders/orderShipped.template.js';
import { buildOrderDeliveredTemplate } from '@services/email/templates/orders/orderDelivered.template.js';
import { sendEmail } from '@routes/api/auth/services/helpers/sendEmail.helper.js';
import { sendOrderNoticeEmail } from './sendOrderNoticeEmail.helper.js';
import { currencyOf } from '@routes/api/payments/providers/index.js';
import { SHOP_LOGO_CID, shopLogoAttachment } from '@services/email/shopLogo.js';
import { itemNameOf } from './itemName.helper.js';
import { withdrawalEndsOf, withdrawalPeriodDaysOf } from './withdrawal.helper.js';

export type OrderStatusMailLogger = {
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
};

// the statuses an admin moves an order to, each with its mail
export type ShippingStatus = 'shipped' | 'delivered';

const TEMPLATES = {
  shipped: buildOrderShippedTemplate,
  delivered: buildOrderDeliveredTemplate,
} satisfies Record<ShippingStatus, unknown>;

// frontend page of an order (WEB_PAGE_ORDER)
const orderPage = (orderId: number) => webPageUrl(env.WEB_PAGE_ORDER, { id: orderId });

// the reviews of a product on its page, where a buyer rates it (WEB_PAGE_PRODUCT_REVIEWS)
const reviewsPage = (productId: number) =>
  webPageUrl(env.WEB_PAGE_PRODUCT_REVIEWS, { id: productId });

// the order with what the mail shows; it is sent after the status change, as the system
function loadOrder(orderId: number) {
  return prisma.$transaction(async (tx) => {
    await setAdminContext(tx);

    // a query reads at most two relations side by side (the relations of one query run at once on
    // the one connection of a transaction), so the buyer and the send are read apart, one after
    // the other
    const order = await tx.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        userId: true,
        total: true,
        paymentProvider: true,
        deliveredAt: true,
        withdrawalDays: true,
        delivery: {
          select: {
            method: true,
            recipientFirstName: true,
            recipientLastName: true,
            recipientPhone: true,
            price: true,
            country: true,
            postalCode: true,
            city: true,
            street: true,
            house: true,
            apartment: true,
          },
        },
        items: {
          orderBy: { id: 'asc' },
          select: {
            id: true,
            quantity: true,
            unitPrice: true,
            totalPrice: true,
            productName: true,
            variantId: true,
            withdrawal: true,
            product: { select: { id: true, name: true } },
          },
        },
      },
    });
    if (!order) return null;

    const user = await tx.user.findUniqueOrThrow({
      where: { id: order.userId },
      select: { email: true, name: true, deletedAt: true },
    });

    // the send on its way: the latest that was not rolled back
    const send = await tx.orderShipment.findFirst({
      where: { orderId, rolledBackAt: null },
      orderBy: [{ shippedAt: 'desc' }, { id: 'desc' }],
      select: { carrier: true, trackingNumber: true, trackingUrl: true },
    });

    // the end of the period of a delivered order, as the contract says it (the grace is not told)
    const endsAt = (await withdrawalEndsOf(tx, [order], 0)).get(order.id) ?? null;

    // the units statements brought back to the shop (on the shelf, written off, lost): a unit
    // withdrawn from before the sending does not travel
    const back = await tx.orderReturnItem.findMany({
      where: {
        orderItem: { orderId },
        goods: { in: ['to_stock', 'written_off', 'lost'] },
      },
      select: { orderItemId: true, quantity: true },
    });
    const backOf = new Map<number, number>();
    for (const row of back) {
      backOf.set(row.orderItemId, (backOf.get(row.orderItemId) ?? 0) + row.quantity);
    }

    return { ...order, user, endsAt, backOf, shipments: send ? [send] : [] };
  });
}

// a sum of money in cents without float math: the string of a decimal of the database
const cents = (value: string) => {
  const [whole, part = ''] = value.split('.');
  return Number(whole) * 100 + Number(part.padEnd(2, '0').slice(0, 2));
};

// mails the buyer that an admin shipped the order or marked it delivered. The status is committed
// before this runs, so a mail that fails is only logged, with the order id and not the address.
// A deleted account gets no mail: its address is not the person's any more
export async function sendOrderStatusEmail(
  orderId: number,
  status: ShippingStatus,
  log: OrderStatusMailLogger,
): Promise<void> {
  try {
    const order = await loadOrder(orderId);

    if (!order) {
      log.warn({ orderId }, `order ${status} mail skipped: the order is gone`);
      return;
    }
    if (order.user.deletedAt) return;

    // a pickup that is shipped is ready to be collected: its mail says where and when
    if (status === 'shipped' && order.delivery?.method === 'pickup') {
      await sendOrderNoticeEmail(orderId, 'pickup_ready', log);
      return;
    }

    // what really travels (7.2): the units of each item less those statements brought back
    // before, the price of the units that stay; an item all of whose units came back is no line
    const sent = order.items
      .map((item) => ({ item, units: item.quantity - (order.backOf.get(item.id) ?? 0) }))
      .filter((line) => line.units > 0);
    const deliveryPrice =
      order.delivery?.method === 'manual' ? order.delivery.price.toString() : null;
    const priceCents = (line: (typeof sent)[number]) =>
      line.units === line.item.quantity
        ? cents(line.item.totalPrice.toString())
        : cents(line.item.unitPrice.toString()) * line.units;
    // the total of an order nothing came back from is what was paid; otherwise what travels
    const total = order.backOf.size
      ? (
          (sent.reduce((sum, line) => sum + priceCents(line), 0) + cents(deliveryPrice ?? '0')) /
          100
        ).toFixed(2)
      : order.total.toString();

    const { subject, text, html } = TEMPLATES[status]({
      // the name of the shop the mail is from
      appName: env.SHOP_NAME,
      orderId: order.id,
      orderUrl: orderPage(order.id),
      // a delivered order asks the buyer to rate each product: a review is of the product, so
      // two variants of one product are one line to rate, named by the product
      items: sent.map(({ item, units }, index) => ({
        // the name the variant had when the order was confirmed
        name: itemNameOf(item),
        quantity: units,
        totalPrice: (priceCents({ item, units }) / 100).toFixed(2),
        // the rule the item kept at the confirmation
        withdrawal: item.withdrawal,
        ...(status === 'delivered' &&
        sent.findIndex((other) => other.item.product.id === item.product.id) === index
          ? { reviewUrl: reviewsPage(item.product.id), reviewName: item.product.name }
          : {}),
      })),
      total,
      // what the buyer paid for the delivery, none for a pickup
      deliveryPrice,
      // the money of the provider that took it
      currency: currencyOf(order.paymentProvider),
      ...(order.user.name ? { userName: order.user.name } : {}),
      ...deliveryMailParts(order.delivery),
      ...(status === 'shipped' && order.shipments[0]
        ? {
            carrier: order.shipments[0].carrier,
            trackingNumber: order.shipments[0].trackingNumber,
            trackingUrl: order.shipments[0].trackingUrl,
          }
        : {}),
      // the link of the page of withdrawal, with the code of the order after the #
      withdrawalUrl: withdrawalLinkOf(order.id),
      withdrawalDays: withdrawalPeriodDaysOf(order.withdrawalDays),
      ...(status === 'delivered' && order.endsAt
        ? { withdrawalEndsAt: order.endsAt, timeZone: env.SHOP_TIME_ZONE }
        : {}),
      logoCid: SHOP_LOGO_CID,
    });

    await sendEmail({
      to: order.user.email,
      subject,
      text,
      html,
      attachments: [await shopLogoAttachment()],
    });
  } catch (err) {
    log.error({ err, orderId }, `order ${status} mail was not sent`);
  }
}
