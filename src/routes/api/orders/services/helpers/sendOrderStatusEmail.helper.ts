import env from '@config/env.js';
import { prisma } from '@db/client.js';
import { setAdminContext } from '@db/dbContext.service.js';
import { webPageUrl } from '@helpers/webOrigin.js';
import { buildOrderShippedTemplate } from '@services/email/templates/orders/orderShipped.template.js';
import { buildOrderDeliveredTemplate } from '@services/email/templates/orders/orderDelivered.template.js';
import { sendEmail } from '@routes/api/auth/services/helpers/sendEmail.helper.js';
import { currencyOf } from '@routes/api/payments/providers/index.js';
import { SHOP_LOGO_CID, shopLogoAttachment } from '@services/email/shopLogo.js';

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

    return tx.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        total: true,
        paymentProvider: true,
        shippingAddress: true,
        recipientFirstName: true,
        recipientLastName: true,
        recipientPhone: true,
        user: { select: { email: true, name: true, deletedAt: true } },
        items: {
          orderBy: { id: 'asc' },
          select: {
            quantity: true,
            totalPrice: true,
            productName: true,
            product: { select: { id: true, name: true } },
          },
        },
      },
    });
  });
}

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

    const { subject, text, html } = TEMPLATES[status]({
      // the name of the shop the mail is from
      appName: env.SHOP_NAME,
      orderId: order.id,
      orderUrl: orderPage(order.id),
      // a delivered order asks the buyer to rate each product
      items: order.items.map((item) => ({
        // the name the product had when the order was confirmed
        name: item.productName ?? item.product.name,
        quantity: item.quantity,
        totalPrice: item.totalPrice.toString(),
        ...(status === 'delivered' ? { reviewUrl: reviewsPage(item.product.id) } : {}),
      })),
      total: order.total.toString(),
      // the money of the provider that took it
      currency: currencyOf(order.paymentProvider),
      ...(order.user.name ? { userName: order.user.name } : {}),
      shippingAddress: order.shippingAddress,
      recipientName: [order.recipientFirstName, order.recipientLastName].filter(Boolean).join(' '),
      recipientPhone: order.recipientPhone,
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
