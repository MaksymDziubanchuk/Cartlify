import env from '@config/env.js';
import { prisma } from '@db/client.js';
import { setAdminContext } from '@db/dbContext.service.js';
import { webPageUrl } from '@helpers/webOrigin.js';
import { buildOrderCancelledTemplate } from '@services/email/templates/orders/orderCancelled.template.js';
import { sendEmail } from '@routes/api/auth/services/helpers/sendEmail.helper.js';
import { currencyOf } from '@routes/api/payments/providers/index.js';
import { SHOP_LOGO_CID, shopLogoAttachment } from '@services/email/shopLogo.js';

export type OrderCancelLogger = {
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
};

// frontend page of an order (WEB_PAGE_ORDER)
const orderPage = (orderId: number) => webPageUrl(env.WEB_PAGE_ORDER, { id: orderId });

// the order with what the mail shows; it is sent after the cancel, as the system
function loadOrder(orderId: number) {
  return prisma.$transaction(async (tx) => {
    await setAdminContext(tx);

    // a query reads at most two relations side by side (the relations of one query run at once on
    // the one connection of a transaction), so the buyer is read apart, one after
    // the other
    const order = await tx.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        userId: true,
        total: true,
        paymentProvider: true,
        delivery: { select: { method: true, price: true } },
        items: {
          orderBy: { id: 'asc' },
          select: {
            quantity: true,
            totalPrice: true,
            productName: true,
            product: { select: { name: true } },
          },
        },
      },
    });
    if (!order) return null;

    const user = await tx.user.findUniqueOrThrow({
      where: { id: order.userId },
      select: { email: true, name: true, deletedAt: true },
    });

    return { ...order, user };
  });
}

// mails the buyer that an admin cancelled the paid order and the payment is refunded. The cancel
// is committed before this runs, so a mail that fails is only logged, with the order id and not
// the address. A deleted account gets no mail: its address is not the person's any more
export async function sendOrderCancelledEmail(
  orderId: number,
  log: OrderCancelLogger,
): Promise<void> {
  try {
    const order = await loadOrder(orderId);

    if (!order) {
      log.warn({ orderId }, 'order cancelled mail skipped: the order is gone');
      return;
    }
    if (order.user.deletedAt) return;

    const { subject, text, html } = buildOrderCancelledTemplate({
      // the name of the shop the mail is from
      appName: env.SHOP_NAME,
      orderId: order.id,
      orderUrl: orderPage(order.id),
      items: order.items.map((item) => ({
        // the name the product had when the order was confirmed
        name: item.productName ?? item.product.name,
        quantity: item.quantity,
        totalPrice: item.totalPrice.toString(),
      })),
      // what the buyer paid for the delivery, none for a pickup
      deliveryPrice: order.delivery?.method === 'manual' ? order.delivery.price.toString() : null,
      total: order.total.toString(),
      // the money of the provider that took it
      currency: currencyOf(order.paymentProvider),
      ...(order.user.name ? { userName: order.user.name } : {}),
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
    log.error({ err, orderId }, 'order cancelled mail was not sent');
  }
}
