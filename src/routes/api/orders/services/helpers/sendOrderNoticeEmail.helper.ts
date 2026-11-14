import env from '@config/env.js';
import { shopSettings } from '@config/shopSettings.js';
import { prisma } from '@db/client.js';
import { setAdminContext } from '@db/dbContext.service.js';
import { addressLineOf, pickupPlaceOf, recipientNameOf } from '@helpers/deliveryText.js';
import { mailLocaleOf } from '@helpers/locale.js';
import { webPageUrl } from '@helpers/webOrigin.js';
import { sendEmail } from '@routes/api/auth/services/helpers/sendEmail.helper.js';
import { buildOrderNoticeTemplate } from '@services/email/templates/orders/orderNotice.template.js';

import { ORDER_NOTICE_LABELS, orderNoticeOf, type OrderNoticeKind } from './orderNotices.helper.js';
import type { OrderStatusMailLogger } from './sendOrderStatusEmail.helper.js';

// frontend page of an order (WEB_PAGE_ORDER)
const orderPage = (orderId: number) => webPageUrl(env.WEB_PAGE_ORDER, { id: orderId });

// the order with what a notice names; it is sent after the change, as the system
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
        delivery: {
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
        },
      },
    });
    if (!order) return null;

    const user = await tx.user.findUniqueOrThrow({
      where: { id: order.userId },
      select: { email: true, name: true, locale: true, deletedAt: true },
    });

    // the send on its way: the latest that was not rolled back
    const send = await tx.orderShipment.findFirst({
      where: { orderId, returnId: null, rolledBackAt: null },
      orderBy: [{ shippedAt: 'desc' }, { id: 'desc' }],
      select: { carrier: true, trackingNumber: true, trackingUrl: true },
    });

    return { ...order, user, shipments: send ? [send] : [] };
  });
}

// mails the buyer an event of the order: a pickup that is ready, new shipping details, a step of
// the status taken back, the data of the delivery corrected. The change is committed before this
// runs, so a mail that fails is only logged, with the order id and not the address. A deleted
// account gets no mail
export async function sendOrderNoticeEmail(
  orderId: number,
  kind: OrderNoticeKind,
  log: OrderStatusMailLogger,
): Promise<void> {
  const label = ORDER_NOTICE_LABELS[kind];

  try {
    const order = await loadOrder(orderId);

    if (!order) {
      log.warn({ orderId }, `order ${label} mail skipped: the order is gone`);
      return;
    }
    if (order.user.deletedAt) return;

    const delivery = order.delivery;
    const send = order.shipments[0];
    const locale = mailLocaleOf(order.user.locale);

    const notice = orderNoticeOf(kind, {
      appName: shopSettings().shopName,
      orderId: order.id,
      pickup: delivery?.method === 'pickup' ? pickupPlaceOf(locale) : '',
      carrier: send?.carrier ?? '',
      trackingNumber: send?.trackingNumber ?? '',
      trackingUrl: send?.trackingUrl ?? '',
      recipient: delivery ? `${recipientNameOf(delivery)}, ${delivery.recipientPhone}` : '',
      shippingAddress: delivery ? addressLineOf(delivery, locale) : '',
      locale,
    });

    const { subject, text, html } = buildOrderNoticeTemplate({
      appName: shopSettings().shopName,
      orderId: order.id,
      orderUrl: orderPage(order.id),
      subject: notice.subject,
      heading: notice.heading,
      paragraphs: notice.paragraphs,
      details: notice.details,
      ...(order.user.name ? { userName: order.user.name } : {}),
      logoUrl: shopSettings().logoUrl,
      locale,
    });

    await sendEmail({
      to: order.user.email,
      subject,
      text,
      html,
    });
  } catch (err) {
    log.error({ err, orderId }, `order ${label} mail was not sent`);
  }
}
