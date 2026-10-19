import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { prisma } from '@db/client.js';
import { setAdminContext } from '@db/dbContext.service.js';
import env from '@config/env.js';
import { webUrl } from '@helpers/webOrigin.js';
import { buildOrderShippedTemplate } from '@services/email/templates/orders/orderShipped.template.js';
import { buildOrderDeliveredTemplate } from '@services/email/templates/orders/orderDelivered.template.js';
import { sendEmail } from '@routes/api/auth/services/helpers/sendEmail.helper.js';

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

// frontend page of an order, a placeholder until the frontend fixes its routes
const orderPage = (orderId: number) => `/orders/${orderId}`;

// the order with what the mail shows; it is sent after the status change, as the system
function loadOrder(orderId: number) {
  return prisma.$transaction(async (tx) => {
    await setAdminContext(tx);

    return tx.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        total: true,
        shippingAddress: true,
        recipientFirstName: true,
        recipientLastName: true,
        recipientPhone: true,
        user: { select: { email: true, name: true, deletedAt: true } },
        items: {
          orderBy: { id: 'asc' },
          select: { quantity: true, totalPrice: true, product: { select: { name: true } } },
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
      orderId: order.id,
      orderUrl: webUrl(orderPage(order.id)),
      items: order.items.map((item) => ({
        name: item.product.name,
        quantity: item.quantity,
        totalPrice: item.totalPrice.toString(),
      })),
      total: order.total.toString(),
      currency: env.STRIPE_CURRENCY,
      ...(order.user.name ? { userName: order.user.name } : {}),
      shippingAddress: order.shippingAddress,
      recipientName: [order.recipientFirstName, order.recipientLastName].filter(Boolean).join(' '),
      recipientPhone: order.recipientPhone,
      logoCid: 'cartlify-logo',
    });

    const logoPath = path.join(process.cwd(), 'src', 'static', 'images', 'logo3.png');
    const logoBase64 = (await readFile(logoPath)).toString('base64');

    await sendEmail({
      to: order.user.email,
      subject,
      text,
      html,
      attachments: [
        {
          content: logoBase64,
          type: 'image/png',
          filename: 'logo3.png',
          disposition: 'inline',
          content_id: 'cartlify-logo',
        },
      ],
    });
  } catch (err) {
    log.error({ err, orderId }, `order ${status} mail was not sent`);
  }
}
