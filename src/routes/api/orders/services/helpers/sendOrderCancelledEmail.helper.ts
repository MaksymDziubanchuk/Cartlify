import { readFile } from 'node:fs/promises';
import path from 'node:path';

import env from '@config/env.js';
import { prisma } from '@db/client.js';
import { setAdminContext } from '@db/dbContext.service.js';
import { webUrl } from '@helpers/webOrigin.js';
import { buildOrderCancelledTemplate } from '@services/email/templates/orders/orderCancelled.template.js';
import { sendEmail } from '@routes/api/auth/services/helpers/sendEmail.helper.js';
import { currencyOf } from '@routes/api/payments/providers/index.js';

export type OrderCancelLogger = {
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
};

// frontend page of an order, a placeholder until the frontend fixes its routes
const orderPage = (orderId: number) => `/orders/${orderId}`;

// the order with what the mail shows; it is sent after the cancel, as the system
function loadOrder(orderId: number) {
  return prisma.$transaction(async (tx) => {
    await setAdminContext(tx);

    return tx.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        total: true,
        paymentProvider: true,
        user: { select: { email: true, name: true, deletedAt: true } },
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
      orderUrl: webUrl(orderPage(order.id)),
      items: order.items.map((item) => ({
        // the name the product had when the order was confirmed
        name: item.productName ?? item.product.name,
        quantity: item.quantity,
        totalPrice: item.totalPrice.toString(),
      })),
      total: order.total.toString(),
      // the money of the provider that took it
      currency: currencyOf(order.paymentProvider),
      ...(order.user.name ? { userName: order.user.name } : {}),
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
    log.error({ err, orderId }, 'order cancelled mail was not sent');
  }
}
