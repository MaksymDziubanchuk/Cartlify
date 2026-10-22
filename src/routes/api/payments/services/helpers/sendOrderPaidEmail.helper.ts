import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { prisma } from '@db/client.js';
import { setAdminContext } from '@db/dbContext.service.js';
import { webUrl } from '@helpers/webOrigin.js';
import { buildOrderPaidTemplate } from '@services/email/templates/orders/orderPaid.template.js';
import { sendEmail } from '@routes/api/auth/services/helpers/sendEmail.helper.js';

import { currencyOf } from '../../providers/index.js';

export type OrderMailLogger = {
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
};

// frontend page of an order, a placeholder until the frontend fixes its routes
const orderPage = (orderId: number) => `/orders/${orderId}`;

// the order with what the mail shows; the payment event runs as the system, so admin context
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
        paidAt: true,
        user: { select: { email: true, name: true } },
        items: {
          orderBy: { id: 'asc' },
          select: {
            quantity: true,
            unitPrice: true,
            totalPrice: true,
            product: { select: { name: true } },
          },
        },
      },
    });
  });
}

// mails the buyer that the order is paid. The payment is recorded before this runs, so a mail
// that fails is only logged: the webhook still answers the provider with success, or it would
// deliver the event again. The log keeps the order id, not the address of the buyer
export async function sendOrderPaidEmail(orderId: number, log: OrderMailLogger): Promise<void> {
  try {
    const order = await loadOrder(orderId);

    if (!order) {
      log.warn({ orderId }, 'order paid mail skipped: the order is gone');
      return;
    }

    // the mail names the time of the payment; an order without one was never paid
    if (!order.paidAt) {
      log.warn({ orderId }, 'order paid mail skipped: the order is not paid');
      return;
    }
    const { paidAt } = order;

    const { subject, text, html } = buildOrderPaidTemplate({
      orderId: order.id,
      orderUrl: webUrl(orderPage(order.id)),
      items: order.items.map((item) => ({
        name: item.product.name,
        quantity: item.quantity,
        unitPrice: item.unitPrice.toString(),
        totalPrice: item.totalPrice.toString(),
      })),
      total: order.total.toString(),
      // the money of the provider that took it
      currency: currencyOf(order.paymentProvider),
      paidAt,
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
    log.error({ err, orderId }, 'order paid mail was not sent');
  }
}
